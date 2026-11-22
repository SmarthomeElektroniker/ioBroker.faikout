'use strict';

/**
 * Waerme-, Kaelte- und Strommenge aufsummieren - als eigene, monoton steigende Zaehler in Wh.
 *
 * Die Zaehler laufen danach durch dieselbe Rechnung wie die Stromzaehler der Anlage (lib/verbrauch.js):
 * heute, gestern, Monat, Stunden-/Tages-/Monatsreihen, Luecken und Neustart sind dort geloest.
 *
 * Die Arbeitszahl eines Tages ist ∫Q / ∫P. Damit Zaehler und Nenner zusammenpassen, laeuft der Strom hier
 * ueber DIESELBEN Zeitabschnitte mit: aus der gemeldeten Leistung (status.consumption, bei Daikin in
 * 10-W-Schritten). Der Energiezaehler der Anlage (status.energy) zaehlt nur in 100-Wh-Schritten - fuer eine
 * Stunde oder den Anfang eines Tages ist das zu grob (der COP spraenge um 20 % und mehr); er dient deshalb nur
 * als Rueckfall, wenn die Anlage keine Leistung meldet. Die Zaehlerwerte selbst stehen unveraendert unter
 * consumption.*. Ein Abschnitt, der laenger als MAX_ABSTAND dauert (Adapter oder Modul war weg), zaehlt auf
 * BEIDEN Seiten nicht - sonst stuende dem Strom keine Waerme gegenueber und die Arbeitszahl waere zu klein.
 * Ein zurueckgesprungener Energiezaehler (Neustart des Moduls) wird wie im Verbrauchsteil nicht als Verbrauch
 * gebucht.
 *
 * Abtauen und Stillstand im Heizbetrieb liefern keine Waerme, ihr Strom zaehlt aber zum Heizen - die
 * Tages-Arbeitszahl enthaelt sie also, so wie die Stromrechnung auch.
 */

/** Laengster Abstand zweier Proben, der noch als durchgehend gilt (s). */
const MAX_ABSTAND = 300;

/** Leerer Stand. */
function neu() {
    return {
        zeit: null, // Zeitpunkt der letzten Probe (ms)
        leistung: null, // thermische Leistung der letzten Probe (W)
        pEl: null, // elektrische Leistung der letzten Probe (W)
        energie: null, // Energiezaehler der Anlage bei der letzten Probe (Wh)
        quelle: null, // Herkunft von pEl/energie: null = Anlage (Aussengeraet), 'innen' = Zaehler des Innengeraets
        richtung: null, // 'heizen'|'kuehlen'|null bei der letzten Probe
        waerme: 0, // Wh abgegebene Waerme
        kaelte: 0, // Wh entzogene Waerme
        stromHeizen: 0, // Wh Strom im Heizbetrieb
        stromKuehlen: 0, // Wh Strom im Kuehlbetrieb
        luecken: 0, // Zahl der uebersprungenen Abschnitte
    };
}

const istZahl = x => typeof x === 'number' && isFinite(x);

/**
 * Nimmt eine Probe auf und zaehlt den Abschnitt seit der letzten.
 *
 * @param {object|null} stand  bisheriger Stand
 * @param {object} p  Probe
 * @param {number} p.zeit  Zeitpunkt in ms
 * @param {'heizen'|'kuehlen'|null} p.richtung  Betriebsrichtung (auch bei Stillstand/Abtauen), null = aus
 * @param {number|null} p.leistung  thermische Leistung in W (0 bei Stillstand/Abtauen, null = unbekannt)
 * @param {number|null} [p.pEl]  elektrische Leistung in W
 * @param {number|null} [p.energie]  Energiezaehler der Anlage in Wh
 * @param {'innen'|null} [p.quelle]  'innen': energie ist der Heiz- + Kuehlzaehler des Innengeraets (Multisplit)
 * @returns {{stand: object, luecke: boolean}} neuer Stand und ob der Abschnitt uebersprungen wurde
 */
function probe(stand, p) {
    const s = { ...neu(), ...(stand || {}) };
    const merken = () => {
        s.zeit = p.zeit;
        s.leistung = istZahl(p.leistung) ? p.leistung : null;
        s.pEl = istZahl(p.pEl) ? p.pEl : null;
        s.energie = istZahl(p.energie) ? p.energie : null;
        s.richtung = p.richtung || null;
        s.quelle = p.quelle || null;
    };
    if (!istZahl(s.zeit) || p.zeit <= s.zeit) {
        merken();
        return { stand: s, luecke: false };
    }
    const dt = (p.zeit - s.zeit) / 1000;
    if (dt > MAX_ABSTAND) {
        s.luecken++;
        merken();
        return { stand: s, luecke: true };
    }
    // Der Abschnitt gehoert der Richtung an seinem ANFANG (so lief die Anlage in dieser Zeit).
    const r = s.richtung;
    if (r) {
        // Waerme: Mittel aus Anfang und Ende; eine unbekannte Seite zaehlt als die bekannte
        const a = istZahl(s.leistung) ? s.leistung : p.leistung;
        const b = istZahl(p.leistung) ? p.leistung : s.leistung;
        if (istZahl(a) && istZahl(b)) {
            const wh = (((a + b) / 2) * dt) / 3600;
            if (r === 'heizen') {
                s.waerme += wh;
            } else {
                s.kaelte += wh;
            }
        }
        // Strom: Leistung mal Zeit; ohne gemeldete Leistung die Differenz des Energiezaehlers. Wechselt die
        // Quelle (Multisplit erkannt: Innen- statt Aussenzaehler), zaehlt dieser eine Abschnitt keinen Strom -
        // die Differenz zweier verschiedener Zaehler waere kein Verbrauch.
        let strom = null;
        if ((s.quelle || null) !== (p.quelle || null)) {
            strom = null;
        } else if (istZahl(s.pEl) || istZahl(p.pEl)) {
            const pa = istZahl(s.pEl) ? s.pEl : p.pEl;
            const pb = istZahl(p.pEl) ? p.pEl : s.pEl;
            strom = (((pa + pb) / 2) * dt) / 3600;
        } else if (istZahl(s.energie) && istZahl(p.energie)) {
            strom = p.energie >= s.energie ? p.energie - s.energie : 0; // Ruecksprung: nichts buchen
        }
        if (strom !== null) {
            if (r === 'heizen') {
                s.stromHeizen += strom;
            } else {
                s.stromKuehlen += strom;
            }
        }
    }
    merken();
    return { stand: s, luecke: false };
}

/**
 * Arbeitszahl aus zwei Mengen.
 *
 * @param {number|null|undefined} waermeKwh  Waerme- bzw. Kaeltemenge
 * @param {number|null|undefined} stromKwh   Strommenge
 * @param {number} [mindest]  kleinste Strommenge, ab der ein Wert gebildet wird (kWh)
 * @returns {number|null} Arbeitszahl auf zwei Stellen oder null
 */
function arbeitszahl(waermeKwh, stromKwh, mindest = 0.05) {
    if (!istZahl(waermeKwh) || !istZahl(stromKwh) || stromKwh < mindest) {
        return null;
    }
    return Math.round((waermeKwh / stromKwh) * 100) / 100;
}

module.exports = { MAX_ABSTAND, neu, probe, arbeitszahl };
