'use strict';

/**
 * Bedarfsregelung (Leistungsgrenze "demand") - Rechenkern. Rein: keine Timer, kein Date.now;
 * Uhr, Eingaenge und der bisherige Zustand kommen herein, Ergebnis und neuer Zustand gehen hinaus.
 *
 * Zwei Strategien, getrennt gefuehrt:
 *  - `kennlinie`: Aussentemperatur (gleitendes Mittel 30 min) -> Prozent nach Heiz- bzw.
 *    Kuehlkennlinie, dazu eine Raumkorrektur.
 *  - `vortag`:   Leistung des Vortags (Spitze oder Mittel der Stundenwerte, in Prozent einer
 *    Bezugsleistung) plus Zuschlag in Prozentpunkten. Angelehnt an die "Auto"-Bedarfssteuerung
 *    der Daikin-App, die laut Nutzerberichten den Spitzenverbrauch des Vortags zugrunde legt
 *    (ein Zuschlag ist dort nicht dokumentiert - hier ist er ein eigener Parameter).
 *
 * Gemeinsam fuer beide: Stufung auf 5 %, Untergrenze 40, Regelobergrenze 95; 100 % nur bei einer
 * Abweichung >= 2 K vom Ziel; Abtauen friert den Ausgang ein, danach gilt die normale Rechnung
 * (Nutzerentscheid 20.11.2026: keine Sonderregel nach dem Abtauen); Geraet
 * aus / Entfeuchten / Umluft = neutral (keine Vorgabe).
 */

const fuehler = require('./fuehler');
const kennlinie = require('./kennlinie');

const VORGABEN = {
    strategie: 'kennlinie',
    heizen: kennlinie.VORGABE_HEIZEN,
    kuehlen: kennlinie.VORGABE_KUEHLEN,
    untergrenze: 40,
    obergrenze: 95,
    stufe: 5,
    totband: 0.3,
    prozentProK: 10,
    vollAbK: 2,
    mittelMs: 30 * 60000,
    vortag: { bezug: 'spitze', zuschlag: 10, referenzW: 1000, min: 40, max: 95, mindestStunden: 1 },
};

/**
 * Fuehrt eine (teilweise) Konfiguration mit den Vorgaben zusammen und prueft sie.
 *
 * @param {object} [roh]  Konfiguration
 * @returns {{konfig: object, fehler: string|null}} gepruefte Konfiguration
 */
function konfigPruefen(roh = {}) {
    const k = { ...VORGABEN, ...roh, vortag: { ...VORGABEN.vortag, ...(roh.vortag || {}) } };
    const h = kennlinie.lesen(k.heizen);
    const c = kennlinie.lesen(k.kuehlen);
    k.heizen = h.punkte;
    k.kuehlen = c.punkte;
    const fehler =
        (h.fehler && `Heizkennlinie: ${h.fehler}`) ||
        (c.fehler && `Kühlkennlinie: ${c.fehler}`) ||
        (kennlinie.pruefen(k.heizen, 'fallend') && `Heizkennlinie: ${kennlinie.pruefen(k.heizen, 'fallend')}`) ||
        (kennlinie.pruefen(k.kuehlen, 'steigend') && `Kühlkennlinie: ${kennlinie.pruefen(k.kuehlen, 'steigend')}`) ||
        (!(k.untergrenze >= 30 && k.untergrenze <= k.obergrenze && k.obergrenze <= 100) &&
            `Grenzen ungültig (${k.untergrenze}..${k.obergrenze})`) ||
        (!['kennlinie', 'vortag'].includes(k.strategie) && `Strategie unbekannt: ${k.strategie}`) ||
        (!['spitze', 'mittel'].includes(k.vortag.bezug) && `Vortag-Bezug unbekannt: ${k.vortag.bezug}`) ||
        (!(k.vortag.referenzW > 0) && 'Vortag-Bezugsleistung muss > 0 W sein') ||
        null;
    return { konfig: k, fehler };
}

/** Leerer Zustand je Geraet. */
function neuerZustand() {
    return {
        v: 1,
        aussenVerlauf: [],
        aussenMerker: {},
        raumMerker: {},
        abtauen: false,
        letzterSollwert: null,
    };
}

/**
 * Gleitendes Mittel der Aussentemperatur. Neue Messwerte werden angehaengt (hoechstens einer je
 * Minute), Werte aelter als das Fenster fallen heraus.
 *
 * @param {Array<[number, number]>} verlauf  [[zeit, wert], ...]
 * @param {number|null} wert                gueltiger Aussenwert oder null
 * @param {number} jetzt                    Uhr (ms)
 * @param {number} fensterMs                Fensterlaenge
 * @returns {{verlauf: Array<[number, number]>, mittel: number|null}} neuer Verlauf und Mittel
 */
function aussenMittel(verlauf, wert, jetzt, fensterMs) {
    let v = (verlauf || []).filter(([t]) => jetzt - t <= fensterMs && t <= jetzt);
    if (Number.isFinite(wert)) {
        const letzter = v[v.length - 1];
        if (letzter && jetzt - letzter[0] < 60000) {
            v = [...v.slice(0, -1), [letzter[0], wert]];
        } else {
            v = [...v, [jetzt, wert]];
        }
    }
    if (!v.length) {
        return { verlauf: v, mittel: null };
    }
    const mittel = v.reduce((s, [, w]) => s + w, 0) / v.length;
    return { verlauf: v, mittel: Math.round(mittel * 10) / 10 };
}

/**
 * Richtung aus Betriebsart: 'heizen', 'kuehlen' oder null (neutral).
 *
 * @param {object} e  Eingang
 * @returns {'heizen'|'kuehlen'|null} Richtung
 */
function richtung(e) {
    if (!e.power) {
        return null;
    }
    if (e.mode === 'heat') {
        return 'heizen';
    }
    if (e.mode === 'cool') {
        return 'kuehlen';
    }
    if (e.mode === 'heat_cool' || e.mode === 'auto') {
        return e.heat === false ? 'kuehlen' : 'heizen';
    }
    return null; // dry, fan_only, off
}

/**
 * Raumkorrektur in Prozentpunkten: positiv, wenn der Raum hinter dem Ziel zurueckliegt
 * (Heizen: zu kalt, Kuehlen: zu warm), negativ zum Abregeln. Innerhalb des Totbands 0.
 *
 * @param {number|null} raum   Raumtemperatur
 * @param {number|null} ziel   Sollwert
 * @param {'heizen'|'kuehlen'} r  Richtung
 * @param {object} k           Konfiguration
 * @returns {{korrektur: number, abweichung: number|null}} Korrektur und Abweichung in K
 */
function raumKorrektur(raum, ziel, r, k) {
    if (!Number.isFinite(raum) || !Number.isFinite(ziel)) {
        return { korrektur: 0, abweichung: null };
    }
    const abw = r === 'heizen' ? ziel - raum : raum - ziel; // > 0: Raum liegt zurueck
    if (Math.abs(abw) <= k.totband) {
        return { korrektur: 0, abweichung: abw };
    }
    const jenseits = abw > 0 ? abw - k.totband : abw + k.totband;
    return { korrektur: jenseits * k.prozentProK, abweichung: abw };
}

/**
 * Strategie Kennlinie: Grundwert aus der Aussentemperatur.
 *
 * @param {number} mittel  Aussenmittel
 * @param {'heizen'|'kuehlen'} r  Richtung
 * @param {object} k  Konfiguration
 * @returns {{grund: number, text: string}} Grundwert
 */
function strategieKennlinie(mittel, r, k) {
    const g = kennlinie.wert(r === 'heizen' ? k.heizen : k.kuehlen, mittel);
    return {
        grund: g,
        text: `Kennlinie ${r === 'heizen' ? 'Heizen' : 'Kühlen'} bei ${mittel} °C → ${Math.round(g)} %`,
    };
}

/**
 * Strategie Vortag + Zuschlag: Grundwert aus der Leistung des Vortags.
 *
 * @param {{spitzeW: number, mittelW: number, stunden: number}|null} vortag  Vortagswerte
 * @param {object} k  Konfiguration
 * @returns {{grund: number|null, text: string}} Grundwert (null = keine Daten)
 */
function strategieVortag(vortag, k) {
    const v = k.vortag;
    if (!vortag || !(vortag.stunden >= v.mindestStunden)) {
        return { grund: null, text: 'Vortag: zu wenig Daten (Anlage lief kürzer als 1 h)' };
    }
    const bezugW = v.bezug === 'mittel' ? vortag.mittelW : vortag.spitzeW;
    const prozent = (bezugW / v.referenzW) * 100 + v.zuschlag;
    return {
        grund: prozent,
        text: `Vortag ${v.bezug === 'mittel' ? 'Mittel' : 'Spitze'} ${Math.round(bezugW)} W = ${Math.round((bezugW / v.referenzW) * 100)} % + ${v.zuschlag} Pkt.`,
    };
}

/**
 * Ein Rechenschritt.
 *
 * @param {object} e  Eingang: {power, mode, heat, aussen:{wert,zeit}, aussenGrund, raum:{wert,zeit}, ziel, econo, abtauen, faehig, vortag}
 * @param {object} k  gepruefte Konfiguration (konfigPruefen().konfig)
 * @param {object|null} z  bisheriger Zustand (neuerZustand())
 * @param {number} jetzt  Uhr (ms)
 * @returns {{ergebnis: object, zustand: object}} Ergebnis und neuer Zustand
 */
function berechnen(e, k, z, jetzt) {
    const zustand = { ...neuerZustand(), ...(z || {}) };
    const ergebnis = { sollwert: null, rohwert: null, aussenMittel: null, grund: '', zustand: 'ok', konflikt: null };

    // Fuehler immer weiterfuehren, auch neutral - das Mittel soll beim Einschalten schon stehen.
    const a = fuehler.bewerten(e.aussen, jetzt, fuehler.AUSSEN, zustand.aussenMerker);
    zustand.aussenMerker = a.merker;
    const m = aussenMittel(zustand.aussenVerlauf, a.gueltig ? a.wert : null, jetzt, k.mittelMs);
    zustand.aussenVerlauf = m.verlauf;
    ergebnis.aussenMittel = a.gueltig ? m.mittel : null;
    const raum = fuehler.bewerten(e.raum, jetzt, fuehler.RAUM, zustand.raumMerker);
    zustand.raumMerker = raum.merker;

    if (e.econo) {
        ergebnis.konflikt = 'Econo ist an – die Anlage begrenzt zusätzlich selbst';
    }

    const r = richtung(e);
    if (!r) {
        ergebnis.zustand = 'neutral';
        ergebnis.grund = !e.power ? 'Gerät aus' : `Betriebsart ${e.mode} – keine Vorgabe`;
        zustand.abtauen = false;
        return { ergebnis, zustand };
    }

    // Abtauen: Ausgang einfrieren, danach normale Rechnung.
    if (e.abtauen) {
        zustand.abtauen = true;
        ergebnis.sollwert = zustand.letzterSollwert;
        ergebnis.grund = 'Abtauen – Ausgang eingefroren';
        ergebnis.zustand = 'ok';
        return { ergebnis, zustand };
    }
    zustand.abtauen = false;

    let basis;
    if (k.strategie === 'vortag') {
        basis = strategieVortag(e.vortag, k);
        if (basis.grund === null) {
            ergebnis.sollwert = 100;
            ergebnis.grund = `${basis.text} → Rückfall 100 %`;
            ergebnis.zustand = 'gestört';
            zustand.letzterSollwert = 100;
            return { ergebnis, zustand };
        }
    } else {
        if (!a.gueltig || ergebnis.aussenMittel === null) {
            ergebnis.sollwert = 100;
            ergebnis.grund = `Außenfühler ${e.aussenGrund || a.grund} → Rückfall 100 %`;
            ergebnis.zustand = 'gestört';
            zustand.letzterSollwert = 100;
            return { ergebnis, zustand };
        }
        basis = strategieKennlinie(ergebnis.aussenMittel, r, k);
    }

    const rk = raumKorrektur(raum.gueltig ? raum.wert : null, Number(e.ziel), r, k);
    const roh = basis.grund + rk.korrektur;
    ergebnis.rohwert = Math.round(roh * 10) / 10;

    const teile = [basis.text];
    if (!raum.gueltig) {
        teile.push(`Raumfühler ${raum.grund}, ohne Korrektur`);
    } else if (rk.abweichung !== null) {
        teile.push(
            `Raum ${raum.wert} °C / Ziel ${e.ziel} °C, Korrektur ${rk.korrektur >= 0 ? '+' : ''}${Math.round(rk.korrektur)} Pkt.`,
        );
    }

    let soll;
    const ober = k.strategie === 'vortag' ? Math.min(k.obergrenze, k.vortag.max) : k.obergrenze;
    const unter = k.strategie === 'vortag' ? Math.max(k.untergrenze, k.vortag.min) : k.untergrenze;
    if (rk.abweichung !== null && rk.abweichung >= k.vollAbK) {
        soll = 100;
        teile.push(`${k.vollAbK} K unter Ziel → volle Leistung`);
    } else {
        const gestuft =
            k.strategie === 'vortag' ? Math.ceil(roh / k.stufe) * k.stufe : Math.round(roh / k.stufe) * k.stufe;
        soll = Math.min(ober, Math.max(unter, gestuft));
    }
    ergebnis.sollwert = soll;
    ergebnis.grund = teile.join('; ');
    if (e.faehig === 'nein') {
        ergebnis.zustand = 'nicht fähig';
    }
    zustand.letzterSollwert = soll;
    return { ergebnis, zustand };
}

/**
 * Vortagswerte aus der Stundenreihe des Verbrauchs (consumption.<zweig>.hoursJson):
 * [{hour:"2026-11-19T05", kwh:0.3}, ...]. Gezaehlt werden nur Stunden mit Verbrauch.
 *
 * @param {Array<{hour: string, kwh: number}>} stunden  Stundenreihe
 * @param {string} tag  Datum des Vortags "YYYY-MM-DD" (Ortszeit, vom Aufrufer bestimmt)
 * @returns {{spitzeW: number, mittelW: number, stunden: number}|null} Vortagswerte oder null
 */
function vortagAusStunden(stunden, tag) {
    if (!Array.isArray(stunden)) {
        return null;
    }
    const werte = stunden
        .filter(s => s && typeof s.hour === 'string' && s.hour.startsWith(`${tag}T`) && Number(s.kwh) > 0)
        .map(s => Number(s.kwh) * 1000); // kWh je Stunde = mittlere Leistung in kW
    if (!werte.length) {
        return { spitzeW: 0, mittelW: 0, stunden: 0 };
    }
    return {
        spitzeW: Math.max(...werte),
        mittelW: werte.reduce((a, b) => a + b, 0) / werte.length,
        stunden: werte.length,
    };
}

module.exports = {
    vortagAusStunden,
    VORGABEN,
    konfigPruefen,
    neuerZustand,
    aussenMittel,
    richtung,
    raumKorrektur,
    berechnen,
    strategieVortag,
};
