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
 * Gemeinsam fuer beide: Stufung auf 5 %, Untergrenze 40, Regelobergrenze 100 (Vorgabe seit
 * 21.11.2026, vorher 95); unabhaengig von der Obergrenze 100 % bei einer Abweichung >= 2 K vom Ziel
 * (`ergebnis.voll` - daran erkennt der Koordinator, dass die Hoechstleistung der Temperaturstufe nicht
 * gilt); Mindeststufe 30 %, wenn der Raum 1,5 K ueber das Ziel hinaus ist; Abtauen friert den Ausgang ein, danach gilt die normale Rechnung
 * (Nutzerentscheid 20.11.2026: keine Sonderregel nach dem Abtauen); Geraet
 * aus / Entfeuchten / Umluft = neutral (keine Vorgabe).
 */

const fuehler = require('./fuehler');
const kennlinie = require('./kennlinie');
const texte = require('./texte');

const VORGABEN = {
    strategie: 'kennlinie',
    heizen: kennlinie.VORGABE_HEIZEN,
    kuehlen: kennlinie.VORGABE_KUEHLEN,
    untergrenze: 40,
    obergrenze: 100,
    stufe: 5,
    totband: 0.3,
    prozentProK: 10,
    vollAbK: 2,
    ueberAbK: 1.5, // Ueberheizschutz: so weit ueber dem Ziel (Kuehlen: darunter) gilt die Geraete-Mindeststufe
    mindestStufe: 30,
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
    const hp = kennlinie.pruefen(k.heizen, 'fallend');
    const cp = kennlinie.pruefen(k.kuehlen, 'steigend');
    const fehler =
        (h.fehler && texte.t('bedarf.heizkennlinie', { fehler: h.fehler })) ||
        (c.fehler && texte.t('bedarf.kuehlkennlinie', { fehler: c.fehler })) ||
        (hp && texte.t('bedarf.heizkennlinie', { fehler: hp })) ||
        (cp && texte.t('bedarf.kuehlkennlinie', { fehler: cp })) ||
        (!(k.untergrenze >= 30 && k.untergrenze <= k.obergrenze && k.obergrenze <= 100) &&
            texte.t('bedarf.grenzenUngueltig', { unten: k.untergrenze, oben: k.obergrenze })) ||
        (!['kennlinie', 'vortag'].includes(k.strategie) &&
            texte.t('bedarf.strategieUnbekannt', { wert: k.strategie })) ||
        (!['spitze', 'mittel'].includes(k.vortag.bezug) &&
            texte.t('bedarf.vortagBezugUnbekannt', { wert: k.vortag.bezug })) ||
        (!(k.vortag.referenzW > 0) && texte.t('bedarf.vortagReferenz')) ||
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
        letzterVoll: false, // der letzte Sollwert war eine volle Freigabe (Rueckstand oder Rueckfall)
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
        text:
            r === 'heizen'
                ? texte.t('bedarf.kennlinieHeizen', { temp: mittel, prozent: Math.round(g) })
                : texte.t('bedarf.kennlinieKuehlen', { temp: mittel, prozent: Math.round(g) }),
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
        return { grund: null, text: texte.t('bedarf.vortagZuWenig') };
    }
    const bezugW = v.bezug === 'mittel' ? vortag.mittelW : vortag.spitzeW;
    const prozent = (bezugW / v.referenzW) * 100 + v.zuschlag;
    const werte = {
        watt: Math.round(bezugW),
        prozent: Math.round((bezugW / v.referenzW) * 100),
        zuschlag: v.zuschlag,
    };
    return {
        grund: prozent,
        prozent: werte.prozent,
        zuschlag: werte.zuschlag,
        text: v.bezug === 'mittel' ? texte.t('bedarf.vortagMittel', werte) : texte.t('bedarf.vortagSpitze', werte),
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
    // voll: 100 % als volle Freigabe (Raum >= 2 K hinter dem Ziel, oder Rueckfall ohne Daten) - nicht
    // als gewoehnlicher Wert der Kennlinie. Nur dann gilt die Hoechstleistung der Temperaturstufe nicht.
    const ergebnis = {
        sollwert: null,
        rohwert: null,
        aussenMittel: null,
        grund: '',
        zustand: 'ok',
        konflikt: null,
        voll: false,
        // Rechenweg als Daten (fuer "So entsteht der Wert gerade" der Einstellungsseite); null = neutral
        weg: null,
    };

    // Fuehler immer weiterfuehren, auch neutral - das Mittel soll beim Einschalten schon stehen.
    const a = fuehler.bewerten(e.aussen, jetzt, fuehler.AUSSEN, zustand.aussenMerker);
    zustand.aussenMerker = a.merker;
    const m = aussenMittel(zustand.aussenVerlauf, a.gueltig ? a.wert : null, jetzt, k.mittelMs);
    zustand.aussenVerlauf = m.verlauf;
    ergebnis.aussenMittel = a.gueltig ? m.mittel : null;
    const raum = fuehler.bewerten(e.raum, jetzt, fuehler.RAUM, zustand.raumMerker);
    zustand.raumMerker = raum.merker;

    if (e.econo) {
        ergebnis.konflikt = texte.t('bedarf.econo');
    }

    const r = richtung(e);
    if (!r) {
        ergebnis.zustand = 'neutral';
        ergebnis.grund = !e.power ? texte.t('bedarf.geraetAus') : texte.t('bedarf.keineVorgabe', { mode: e.mode });
        zustand.abtauen = false;
        return { ergebnis, zustand };
    }

    // Abtauen: Ausgang einfrieren, danach normale Rechnung.
    if (e.abtauen) {
        zustand.abtauen = true;
        ergebnis.sollwert = zustand.letzterSollwert;
        ergebnis.voll = zustand.letzterVoll === true;
        ergebnis.grund = texte.t('bedarf.abtauen');
        ergebnis.zustand = 'ok';
        ergebnis.weg = { art: 'abtauen', richtung: r, sollwert: zustand.letzterSollwert };
        return { ergebnis, zustand };
    }
    zustand.abtauen = false;

    let basis;
    if (k.strategie === 'vortag') {
        basis = strategieVortag(e.vortag, k);
        if (basis.grund === null) {
            ergebnis.sollwert = 100;
            ergebnis.voll = true;
            ergebnis.grund = texte.t('bedarf.rueckfall', { text: basis.text });
            ergebnis.zustand = 'fault';
            ergebnis.weg = { art: 'rueckfall', strategie: 'vortag', richtung: r, sollwert: 100 };
            zustand.letzterSollwert = 100;
            zustand.letzterVoll = true;
            return { ergebnis, zustand };
        }
    } else {
        if (!a.gueltig || ergebnis.aussenMittel === null) {
            ergebnis.sollwert = 100;
            ergebnis.voll = true;
            ergebnis.grund = texte.t('bedarf.aussenRueckfall', { grund: e.aussenGrund || a.grund });
            ergebnis.zustand = 'fault';
            ergebnis.weg = { art: 'rueckfall', strategie: 'kennlinie', richtung: r, sollwert: 100 };
            zustand.letzterSollwert = 100;
            zustand.letzterVoll = true;
            return { ergebnis, zustand };
        }
        basis = strategieKennlinie(ergebnis.aussenMittel, r, k);
    }

    const rk = raumKorrektur(raum.gueltig ? raum.wert : null, Number(e.ziel), r, k);
    const roh = basis.grund + rk.korrektur;
    ergebnis.rohwert = Math.round(roh * 10) / 10;

    const teile = [basis.text];
    if (!raum.gueltig) {
        teile.push(texte.t('bedarf.raumfuehlerOhne', { grund: raum.grund }));
    } else if (rk.abweichung !== null) {
        teile.push(
            texte.t('bedarf.raumZiel', {
                raum: raum.wert,
                ziel: e.ziel,
                korr: `${rk.korrektur >= 0 ? '+' : ''}${Math.round(rk.korrektur)}`,
            }),
        );
    }

    let soll;
    // Rechenweg: dieselben (gerundeten) Zahlen wie im Begruendungstext
    const weg = {
        art: 'normal',
        strategie: k.strategie === 'vortag' ? 'vortag' : 'kennlinie',
        richtung: r,
        basis: Math.round(basis.grund),
        aussen: k.strategie === 'vortag' ? null : ergebnis.aussenMittel,
        vortag: k.strategie === 'vortag' ? { prozent: basis.prozent, zuschlag: basis.zuschlag } : null,
        raum: raum.gueltig ? raum.wert : null,
        ziel: Number.isFinite(Number(e.ziel)) ? Number(e.ziel) : null,
        // > 0: der Raum liegt hinter dem Ziel zurueck (Heizen: zu kalt, Kuehlen: zu warm)
        abweichung: rk.abweichung === null ? null : Math.round(rk.abweichung * 10) / 10,
        korrektur: Math.round(rk.korrektur),
        totband: k.totband,
        prozentProK: k.prozentProK,
        grenze: null,
        schwelle: null,
        sollwert: null,
    };
    const ober = k.strategie === 'vortag' ? Math.min(k.obergrenze, k.vortag.max) : k.obergrenze;
    const unter = k.strategie === 'vortag' ? Math.max(k.untergrenze, k.vortag.min) : k.untergrenze;
    if (rk.abweichung !== null && rk.abweichung >= k.vollAbK) {
        soll = 100;
        ergebnis.voll = true;
        weg.art = 'voll';
        weg.schwelle = k.vollAbK;
        teile.push(texte.t('bedarf.volleLeistung', { k: k.vollAbK }));
    } else if (rk.abweichung !== null && k.ueberAbK > 0 && rk.abweichung <= -k.ueberAbK) {
        // Ersatz fuer einen "Guard", der Einstellungen im Modul umschreibt: die Leistung geht ohne
        // jeden Flash-Schreibvorgang auf die Mindeststufe der Anlage, bis der Raum zurueck ist.
        soll = k.mindestStufe;
        weg.art = 'ueber';
        weg.schwelle = k.ueberAbK;
        teile.push(
            r === 'heizen'
                ? texte.t('bedarf.mindestStufeUeber', { k: k.ueberAbK })
                : texte.t('bedarf.mindestStufeUnter', { k: k.ueberAbK }),
        );
    } else {
        const gestuft =
            k.strategie === 'vortag' ? Math.ceil(roh / k.stufe) * k.stufe : Math.round(roh / k.stufe) * k.stufe;
        soll = Math.min(ober, Math.max(unter, gestuft));
        weg.grenze = gestuft > ober ? 'ober' : gestuft < unter ? 'unter' : null;
    }
    weg.sollwert = soll;
    ergebnis.weg = weg;
    ergebnis.sollwert = soll;
    ergebnis.grund = teile.join('; ');
    if (e.faehig === 'no') {
        ergebnis.zustand = 'notCapable';
    }
    zustand.letzterSollwert = soll;
    zustand.letzterVoll = ergebnis.voll;
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
