'use strict';

/*
 * Verbrauchsrechnung aus den Lebensdauer-Zaehlern der Anlage.
 *
 * Die Module liefern nur monoton steigende Gesamtzaehler in Wh (energy, energyheat,
 * energycool). Verbrauch je Stunde und Tag entsteht erst durch Differenzbildung - und dabei
 * gibt es vier Faelle, die man nicht naiv behandeln darf:
 *
 *   1. Der Zaehler springt zurueck (Modul-Neustart, Firmware-Reset). Eine negative Differenz
 *      darf NICHT als riesiger Verbrauch gebucht werden; stattdessen neu basieren.
 *   2. Der Adapter war Stunden offline. Die aufgelaufene Differenz gehoert nicht komplett in
 *      die letzte Stunde - die uebersprungenen Stunden werden als Luecke (null) vermerkt.
 *   3. Der Stundenwechsel passiert auch ohne eintreffende Nachricht. Deshalb muss der Aufrufer
 *      zusaetzlich zyklisch anstossen (siehe pruefen()).
 *   4. Nach einem Adapter-Neustart muessen die Basiswerte noch da sein, sonst faengt jede
 *      Zaehlung wieder bei null an. Der Zustand gehoert deshalb persistiert.
 *
 * Dieses Modul ist bewusst frei von ioBroker-Abhaengigkeiten: rein Zustand rein, Zustand raus.
 */

/** Wie viele abgeschlossene Stunden der Ringpuffer behaelt. */
const RING_STUNDEN = 48;
/* Zwei Monate Tageswerte reichen fuer jede Monatsansicht, auch am Monatsersten. */
const RING_TAGE = 62;
/* Zwei Jahre Monatswerte - so laesst sich das laufende Jahr mit dem Vorjahr vergleichen. */
const RING_MONATE = 24;

/**
 * Wh -> kWh, auf 3 Stellen.
 *
 * @param {number} wh   Energie in Wattstunden
 * @returns {number} Energie in Kilowattstunden
 */
function kwh(wh) {
    return Math.round(wh) / 1000;
}

/**
 * Stundenschluessel wie 2026-08-17T14 (lokale Zeit, denn Tageswechsel ist lokal gemeint).
 *
 * @param {Date} d   Zeitpunkt
 * @returns {string} Stundenschluessel
 */
function stundeVon(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/**
 * Der Monat eines Zeitpunkts als Schluessel "JJJJ-MM".
 *
 * @param {Date} d Zeitpunkt
 * @returns {string} Monatsschluessel
 */
function monatVon(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Der Tag eines Zeitpunkts als Schluessel "JJJJ-MM-TT".
 *
 * @param {Date} d Zeitpunkt
 * @returns {string} Tagesschluessel
 */
function tagVon(d) {
    return stundeVon(d).slice(0, 10);
}

/**
 * Wie viele volle Stunden liegen zwischen zwei Stundenschluesseln?
 *
 * @param {string} a   fruehere Stunde
 * @param {string} b   spaetere Stunde
 * @returns {number} Anzahl voller Stunden
 */
function stundenDazwischen(a, b) {
    const zeit = s =>
        new Date(
            Number(s.slice(0, 4)),
            Number(s.slice(5, 7)) - 1,
            Number(s.slice(8, 10)),
            Number(s.slice(11, 13)),
        ).getTime();
    return Math.round((zeit(b) - zeit(a)) / 3600000);
}

/** Leerer Anfangszustand eines Zaehlers. */
function neuerStand() {
    return {
        letzterWert: null, // zuletzt gesehener Gesamtzaehler in Wh
        basisStunde: null, // Zaehlerstand zu Beginn der laufenden Stunde
        basisTag: null, // Zaehlerstand zu Beginn des laufenden Tages
        stunde: null, // Schluessel der laufenden Stunde
        tag: null, // Schluessel des laufenden Tages
        letzteStunde: null, // kWh der zuletzt abgeschlossenen Stunde
        gestern: null, // kWh des Vortages
        monat: null, // Schluessel des laufenden Monats
        basisMonat: null, // Zaehlerstand zu Monatsbeginn
        letzterMonat: null, // kWh des Vormonats
        ring: [], // [{ stunde, kwh }] - kwh null = Luecke
        ringTage: [], // [{ tag, kwh }] - Grundlage der Monatsansicht
        ringMonate: [], // [{ monat, kwh }] - Grundlage der Jahresansicht
    };
}

/**
 * Verarbeitet einen neuen Zaehlerstand.
 *
 * @param {object|null} stand  bisheriger Zustand (aus der Persistenz) oder null
 * @param {number} wert        aktueller Gesamtzaehler in Wh
 * @param {Date} [jetzt]       Zeitpunkt (fuer Tests setzbar)
 * @returns {{stand: object, werte: object, hinweise: string[]}} neuer Zustand, zu schreibende Werte und Meldungen
 */
function verarbeiten(stand, wert, jetzt = new Date()) {
    const hinweise = [];
    // Ueber neuerStand() zusammenfuehren, nicht nur uebernehmen: ein Zustand aus einer aelteren
    // Fassung kennt spaeter ergaenzte Felder nicht, und ein fehlender Ring liess das Update von
    // 0.0.1 auf 0.0.2 bei jedem Zaehlerwert mit "reading 'push'" auflaufen.
    const s = stand
        ? {
              ...neuerStand(),
              ...stand,
              ring: (stand.ring || []).slice(),
              ringTage: (stand.ringTage || []).slice(),
              ringMonate: (stand.ringMonate || []).slice(),
          }
        : neuerStand();
    const stunde = stundeVon(jetzt);
    const tag = tagVon(jetzt);
    const monat = monatVon(jetzt);

    if (typeof wert !== 'number' || !isFinite(wert)) {
        return { stand: s, werte: ausgabe(s, s.letzterWert), hinweise };
    }

    // --- Erster Wert ueberhaupt -------------------------------------------------
    if (s.letzterWert === null || s.basisStunde === null || s.basisTag === null) {
        s.letzterWert = wert;
        s.basisStunde = wert;
        s.basisTag = wert;
        s.basisMonat = wert;
        s.stunde = stunde;
        s.tag = tag;
        s.monat = monat;
        return { stand: s, werte: ausgabe(s, wert), hinweise };
    }

    // --- Zaehler zurueckgesprungen ----------------------------------------------
    // Kommt beim Neustart des Moduls vor. Der Verbrauch zwischen letztem Wert und Ruecksprung ist
    // nicht mehr ermittelbar. Was in der laufenden Stunde, am laufenden Tag und im laufenden Monat
    // bis dahin schon gezaehlt war, bleibt aber erhalten: die Basis wandert mit dem Zaehler mit.
    // (Frueher wurde alles neu basiert - "heute" und "dieser Monat" fielen auf 0 zurueck und
    // widersprachen danach den Stunden- und Tagesbalken, Volltest 21.11.2026.) Stunden-, Tages- und
    // Monatswechsel laufen danach ganz normal weiter unten.
    if (wert < s.letzterWert) {
        hinweise.push(`Meter reading went backwards (${s.letzterWert} -> ${wert} Wh) - counted values kept`);
        const versatz = s.letzterWert - wert;
        s.basisStunde -= versatz;
        s.basisTag -= versatz;
        if (s.basisMonat !== null) {
            s.basisMonat -= versatz;
        }
        s.letzterWert = wert;
    }

    // --- Stundenwechsel ---------------------------------------------------------
    if (s.stunde !== stunde) {
        const luecke = stundenDazwischen(s.stunde, stunde) - 1; // uebersprungene volle Stunden
        s.letzteStunde = kwh(s.letzterWert - s.basisStunde);
        s.ring.push({ stunde: s.stunde, kwh: s.letzteStunde });
        if (luecke > 0) {
            // Der Adapter war offline. Was in dieser Zeit verbraucht wurde, laesst sich nicht
            // auf die einzelnen Stunden aufteilen - als Luecke kennzeichnen statt zu erfinden.
            hinweise.push(`${luecke} hour(s) without data - recorded as a gap`);
            for (let i = 1; i <= luecke; i++) {
                s.ring.push({ stunde: null, kwh: null });
            }
        }
        if (s.ring.length > RING_STUNDEN) {
            s.ring = s.ring.slice(-RING_STUNDEN);
        }
        s.basisStunde = s.letzterWert;
        s.stunde = stunde;
    }

    // --- Tageswechsel -----------------------------------------------------------
    if (s.tag !== tag) {
        s.gestern = kwh(s.letzterWert - s.basisTag);
        s.ringTage.push({ tag: s.tag, kwh: s.gestern });
        if (s.ringTage.length > RING_TAGE) {
            s.ringTage = s.ringTage.slice(-RING_TAGE);
        }
        s.basisTag = s.letzterWert;
        s.tag = tag;
    }

    // --- Monatswechsel ----------------------------------------------------------
    // Bewusst nach dem Tageswechsel: der letzte Tag des alten Monats gehoert noch dorthin.
    if (s.monat !== monat) {
        if (s.monat === null || s.basisMonat === null) {
            // Erster Monat, den dieser Zaehler sieht - er hat keinen Vorgaenger. Ohne diese
            // Ausnahme wurde bei einem Zustand aus 0.0.1 (kannte noch keinen Monat) der volle
            // Zaehlerstand als Vormonatsverbrauch gebucht: 3783 kWh statt der echten Differenz.
            s.basisMonat = s.letzterWert;
            s.monat = monat;
        } else {
            s.letzterMonat = kwh(s.letzterWert - s.basisMonat);
            s.ringMonate.push({ monat: s.monat, kwh: s.letzterMonat });
            if (s.ringMonate.length > RING_MONATE) {
                s.ringMonate = s.ringMonate.slice(-RING_MONATE);
            }
            s.basisMonat = s.letzterWert;
            s.monat = monat;
        }
    }

    s.letzterWert = wert;
    return { stand: s, werte: ausgabe(s, wert), hinweise };
}

/**
 * Aendert dieser Zaehlerstand nichts? Das ist der Fall, wenn der Rohwert gleich dem zuletzt
 * gesehenen ist und Stunde, Tag und Monat noch dieselben sind - dann kaeme bei verarbeiten()
 * genau der bisherige Zustand heraus. Der Adapter spart sich damit Rechnung und Schreiben bei
 * jeder Statusmeldung einer stehenden Anlage (Issue #5: 27 % CPU bei vier Geraeten).
 *
 * @param {object|null} stand  bisheriger Zustand
 * @param {number} wert        aktueller Gesamtzaehler in Wh
 * @param {Date} [jetzt]       Zeitpunkt (fuer Tests setzbar)
 * @returns {boolean} true, wenn nichts zu tun ist
 */
function unveraendert(stand, wert, jetzt = new Date()) {
    return (
        !!stand &&
        stand.letzterWert === wert &&
        stand.basisStunde !== null &&
        stand.basisTag !== null &&
        stand.stunde === stundeVon(jetzt) &&
        stand.tag === tagVon(jetzt) &&
        stand.monat === monatVon(jetzt)
    );
}

/**
 * Stossen ohne neuen Zaehlerstand - fuer den Timer auf die volle Stunde. Meldet einen
 * Stunden- bzw. Tageswechsel auch dann, wenn gerade keine Nachricht hereinkam.
 *
 * @param {object|null} stand   bisheriger Zustand
 * @param {Date} [jetzt]        Zeitpunkt (fuer Tests setzbar)
 * @returns {{stand: object, werte: object, hinweise: string[]}} wie bei verarbeiten
 */
function pruefen(stand, jetzt = new Date()) {
    if (!stand || stand.letzterWert === null) {
        return { stand, werte: null, hinweise: [] };
    }
    if (stand.stunde === stundeVon(jetzt) && stand.tag === tagVon(jetzt) && stand.monat === monatVon(jetzt)) {
        return { stand, werte: null, hinweise: [] };
    }
    return verarbeiten(stand, stand.letzterWert, jetzt);
}

/**
 * Die Werte, die der Adapter schreibt - mit den englischen Schluesseln der Objekt-IDs
 * (Review 11.10.2026). Der gespeicherte Zustand `s` behaelt seine Feldnamen; er liegt nur in
 * native.zaehler und muss so beim Update nicht umgeschrieben werden.
 *
 * @param {object} s       aktueller Zustand
 * @param {number|null} wert  letzter Zaehlerstand in Wh
 * @returns {object} Werte fuer die Datenpunkte unter consumption.*
 */
function ausgabe(s, wert) {
    const reihe = (liste, von, nach) => liste.map(e => ({ [nach]: e[von], kwh: e.kwh }));
    return {
        total: wert === null ? null : kwh(wert),
        currentHour: s.basisStunde === null || wert === null ? null : kwh(wert - s.basisStunde),
        lastHour: s.letzteStunde,
        today: s.basisTag === null || wert === null ? null : kwh(wert - s.basisTag),
        yesterday: s.gestern,
        thisMonth: s.basisMonat === null || wert === null ? null : kwh(wert - s.basisMonat),
        lastMonth: s.letzterMonat,
        hours: reihe(s.ring, 'stunde', 'hour'),
        // Der laufende Tag bzw. Monat steht noch nicht im Ring - fuer die Anzeige gehoert er
        // aber ans Ende, sonst fehlt in der Monatsansicht immer der heutige Balken.
        days: reihe(
            s.ringTage.concat(s.tag && wert !== null ? [{ tag: s.tag, kwh: kwh(wert - s.basisTag) }] : []),
            'tag',
            'day',
        ),
        months: reihe(
            s.ringMonate.concat(s.monat && wert !== null ? [{ monat: s.monat, kwh: kwh(wert - s.basisMonat) }] : []),
            'monat',
            'month',
        ),
    };
}

/** Kleinster Lebensdauer-Zaehler (Wh), ab dem gleiche Werte als gemeinsames Aussengeraet gelten. */
const GEMEINSAM_AB_WH = 10000;
/** Groesster Abstand (Wh) zweier Zaehler desselben Aussengeraets: eine Stufe der Firmware (100 Wh). */
const GEMEINSAM_TOLERANZ_WH = 100;

/**
 * Welche Geraete denselben Aussengeraete-Zaehler melden (Multisplit).
 *
 * Das Modulfeld `energy` ist laut Faikout-Firmware der Zaehler des AUSSENGERAETS (S21 "M"). Haengen mehrere
 * Innengeraete an einem Aussengeraet, meldet jedes Modul denselben Wert. Zwei getrennte Anlagen mit
 * Lebensdauer-Zaehlern ueber 10 kWh, die auf 100 Wh gleich sind, sind praktisch ausgeschlossen. Die Module
 * melden zeitversetzt - eine Firmware-Stufe (100 Wh) Abstand gilt deshalb noch als gleich.
 *
 * @param {Map<string, unknown>} werte  Geraete-ID -> letzter Rohwert von `energy` in Wh
 * @returns {Map<string, string>} Geraete-ID -> Kennung der Gruppe (kleinste ID der Gruppe); nur Geraete,
 *   die ihren Zaehler mit mindestens einem anderen teilen
 */
function gemeinsameZaehler(werte) {
    const liste = [...(werte || new Map())]
        .filter(([, w]) => typeof w === 'number' && Number.isFinite(w) && w >= GEMEINSAM_AB_WH)
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const gruppen = [];
    for (const [id, w] of liste) {
        const letzte = gruppen[gruppen.length - 1];
        if (letzte && w - letzte.bis <= GEMEINSAM_TOLERANZ_WH) {
            letzte.ids.push(id);
            letzte.bis = w;
        } else {
            gruppen.push({ ids: [id], bis: w });
        }
    }
    const aus = new Map();
    for (const g of gruppen.filter(x => x.ids.length > 1)) {
        const kennung = [...g.ids].sort()[0];
        g.ids.forEach(id => aus.set(id, kennung));
    }
    return aus;
}

/**
 * Letzte Rohwerte von `energy` aller Geraete eines Adapters (aus dem gemerkten Zaehlerstand).
 *
 * @param {Map<string, {zaehler?: {energy?: {letzterWert?: number|null}}}>} [geraete]  adapter.geraete
 * @returns {Map<string, number|null>} Geraete-ID -> Wh
 */
function aussenZaehler(geraete) {
    const m = new Map();
    for (const [id, g] of geraete || new Map()) {
        const s = g && g.zaehler && g.zaehler.energy;
        m.set(id, s && typeof s.letzterWert === 'number' ? s.letzterWert : null);
    }
    return m;
}

module.exports = {
    gemeinsameZaehler,
    aussenZaehler,
    GEMEINSAM_AB_WH,
    GEMEINSAM_TOLERANZ_WH,
    verarbeiten,
    pruefen,
    unveraendert,
    neuerStand,
    stundeVon,
    tagVon,
    monatVon,
    kwh,
    RING_STUNDEN,
    RING_TAGE,
    RING_MONATE,
};
