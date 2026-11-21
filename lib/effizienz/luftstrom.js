'use strict';

/**
 * Luftstrom des Innengeraets aus Luefterstufe bzw. gemeldeter Drehzahl.
 *
 * Datenblaetter nennen den Luftstrom je Stufe (m³/min), meist fuer Leise (SL), Niedrig (L), Mittel (M)
 * und Hoch (H), Heizen und Kuehlen getrennt. Die Anlage kennt dazwischen noch zwei Stufen (ML, MH) und
 * "Auto". Was das Datenblatt nicht nennt, wird hier aus den Nachbarn gebildet und GEKENNZEICHNET.
 *
 * Bei "Auto" (und immer dann, wenn die Anlage den Luefter selbst zuruecknimmt: Anlauf, Abtauen, Pause)
 * sagt die eingestellte Stufe nichts. Dann zaehlt die gemeldete Drehzahl: Der Adapter merkt sich je fest
 * eingestellter Stufe die Drehzahl, die die Anlage dabei faehrt (lernen()), und legt den Luftstrom
 * stueckweise linear ueber diese Punkte - durch den Ursprung, denn der Volumenstrom eines Luefters ist
 * in guter Naeherung proportional zur Drehzahl.
 */

/** Stufen von leise nach hoch. */
const STUFEN = ['SL', 'L', 'ML', 'M', 'MH', 'H'];

/** Wert von control.fan -> Stufe; "auto" hat keine. */
const AUS_FAN = { night: 'SL', low: 'L', lowMedium: 'ML', medium: 'M', mediumHigh: 'MH', high: 'H' };

/** Generische Vorgabe (Wandgeraet der 3,5-kW-Klasse), wenn kein Modell gewaehlt ist - m³/min. */
const GENERISCH = {
    heizen: { SL: 4.5, L: 6.0, M: 8.0, H: 9.8 },
    kuehlen: { SL: 4.2, L: 5.8, M: 7.6, H: 10.5 },
};

/** Wie viele Drehzahlproben je Stufe behalten werden. */
const PROBEN = 30;
/** Ab so vielen Proben gilt die Drehzahl einer Stufe als gelernt. */
const PROBEN_MIN = 5;

const zahl = x => (typeof x === 'number' && isFinite(x) && x > 0 ? x : null);

/**
 * Stufe zu einem Wert von control.fan.
 *
 * @param {unknown} fan  Wert des Datenpunkts
 * @returns {string|null} Stufe oder null (Auto, unbekannt)
 */
function stufeVon(fan) {
    return AUS_FAN[String(fan)] || null;
}

/**
 * Vollstaendige Kennlinie Stufe -> Luftstrom mit Herkunft je Stufe.
 *
 * @param {Record<string, number|null>|null|undefined} datenblatt  Werte des Modells (SL, L, M, H), m³/min
 * @param {Record<string, number|null>|null|undefined} eigen       ueberschriebene Werte je Stufe
 * @param {'heizen'|'kuehlen'} art  Betriebsart (fuer die generische Vorgabe)
 * @returns {{werte: Record<string, number>, herkunft: Record<string, string>, generisch: boolean}} Kennlinie
 */
function kennlinie(datenblatt, eigen, art) {
    const db = datenblatt || {};
    const hatDatenblatt = STUFEN.some(s => zahl(db[s]));
    const basis = hatDatenblatt ? db : GENERISCH[art] || GENERISCH.heizen;
    const werte = {};
    const herkunft = {};
    const quelle = hatDatenblatt ? 'datenblatt' : 'generisch';
    for (const s of ['SL', 'L', 'M', 'H']) {
        if (zahl(basis[s])) {
            werte[s] = basis[s];
            herkunft[s] = quelle;
        }
    }
    // Was fehlt, aus den Nachbarn: M zwischen L und H, L bzw. H vom Nachbarn, SL wie L.
    const luecke = (s, w) => {
        if (!zahl(werte[s]) && zahl(w)) {
            werte[s] = Math.round(w * 100) / 100;
            herkunft[s] = 'interpoliert';
        }
    };
    luecke('M', zahl(werte.L) && zahl(werte.H) ? (werte.L + werte.H) / 2 : null);
    luecke('H', werte.M);
    luecke('L', werte.M);
    luecke('M', werte.H || werte.L);
    luecke('H', werte.M);
    luecke('L', werte.M);
    luecke('SL', werte.L);
    luecke('ML', (werte.L + werte.M) / 2);
    luecke('MH', (werte.M + werte.H) / 2);
    for (const s of STUFEN) {
        if (eigen && zahl(eigen[s])) {
            werte[s] = eigen[s];
            herkunft[s] = 'eigen';
        }
    }
    return { werte, herkunft, generisch: !hatDatenblatt };
}

/**
 * Merkt sich die Drehzahl einer fest eingestellten Stufe (gleitender Median ueber die letzten Proben).
 *
 * @param {Record<string, number[]>|null|undefined} drehzahlen  bisherige Proben je Stufe
 * @param {string} stufe   Stufe
 * @param {number} rpm     gemeldete Drehzahl
 * @returns {Record<string, number[]>} neue Proben (Kopie)
 */
function lernen(drehzahlen, stufe, rpm) {
    const neu = { ...(drehzahlen || {}) };
    if (!STUFEN.includes(stufe) || !zahl(rpm)) {
        return neu;
    }
    neu[stufe] = [...(neu[stufe] || []), Math.round(rpm)].slice(-PROBEN);
    return neu;
}

/**
 * Gelernte Drehzahl je Stufe (Median), nur Stufen mit genug Proben.
 *
 * @param {Record<string, number[]>|null|undefined} drehzahlen  Proben je Stufe
 * @returns {Record<string, number>} Drehzahl je Stufe
 */
function gelernt(drehzahlen) {
    const r = {};
    for (const s of STUFEN) {
        const p = ((drehzahlen || {})[s] || []).filter(zahl);
        if (p.length >= PROBEN_MIN) {
            const sortiert = [...p].sort((a, b) => a - b);
            r[s] = sortiert[Math.floor(sortiert.length / 2)];
        }
    }
    return r;
}

/**
 * Luftstrom zu einer Drehzahl: stueckweise linear ueber die gelernten Punkte, durch den Ursprung,
 * oberhalb des hoechsten Punkts proportional weiter.
 *
 * @param {Record<string, number>} werte  Kennlinie Stufe -> m³/min
 * @param {Record<string, number>} rpmJeStufe  gelernte Drehzahl je Stufe
 * @param {number} rpm  gemeldete Drehzahl
 * @returns {number|null} Luftstrom in m³/min oder null, wenn nichts gelernt ist
 */
function ausDrehzahl(werte, rpmJeStufe, rpm) {
    const punkte = STUFEN.filter(s => zahl(rpmJeStufe[s]) && zahl(werte[s]))
        .map(s => [rpmJeStufe[s], werte[s]])
        .sort((a, b) => a[0] - b[0]);
    if (!punkte.length || typeof rpm !== 'number' || !isFinite(rpm)) {
        return null;
    }
    if (rpm <= 0) {
        return 0;
    }
    let [x0, y0] = [0, 0];
    for (const [x1, y1] of punkte) {
        if (rpm <= x1) {
            return y0 + ((y1 - y0) * (rpm - x0)) / (x1 - x0);
        }
        [x0, y0] = [x1, y1];
    }
    return (y0 * rpm) / x0;
}

/**
 * Welcher Stufe liegt ein Luftstrom am naechsten?
 *
 * @param {Record<string, number>} werte  Kennlinie Stufe -> m³/min
 * @param {number} m3min  Luftstrom
 * @returns {string} Stufe
 */
function naechsteStufe(werte, m3min) {
    let beste = 'M';
    let abstand = Infinity;
    for (const s of STUFEN) {
        if (zahl(werte[s]) && Math.abs(werte[s] - m3min) < abstand) {
            abstand = Math.abs(werte[s] - m3min);
            beste = s;
        }
    }
    return beste;
}

/**
 * Luftstrom im Augenblick.
 *
 * Vorrang hat die Drehzahl (sie stimmt auch bei Auto, Anlauf und Abtauen), sobald fuer mindestens eine
 * Stufe eine Drehzahl gelernt ist. Sonst gilt die eingestellte Stufe; bei Auto ohne gelernte Drehzahl
 * bleibt nur die Mitte der Kennlinie - mit entsprechend grosser Unsicherheit.
 *
 * @param {object} o  Eingang
 * @param {unknown} o.fan  Wert von control.fan
 * @param {number|null} [o.rpm]  gemeldete Drehzahl (null = die Anlage meldet keine)
 * @param {Record<string, number>} o.werte  Kennlinie Stufe -> m³/min
 * @param {Record<string, number[]>|null} [o.drehzahlen]  gelernte Proben je Stufe
 * @returns {{m3min: number|null, stufe: string|null, quelle: 'drehzahl'|'stufe'|'mitte'|'steht'|'fehlt', unsicherheit: number}}
 *   Luftstrom, zugeordnete Stufe, Herkunft und relative Unsicherheit (0..1)
 */
function bestimmen(o) {
    const werte = o.werte || {};
    const stufe = stufeVon(o.fan);
    const hatRpm = typeof o.rpm === 'number' && isFinite(o.rpm);
    if (hatRpm && o.rpm <= 0) {
        return { m3min: 0, stufe, quelle: 'steht', unsicherheit: 0 };
    }
    const rpmJeStufe = gelernt(o.drehzahlen);
    if (hatRpm) {
        const v = ausDrehzahl(werte, rpmJeStufe, o.rpm);
        if (v !== null) {
            return { m3min: v, stufe: stufe || naechsteStufe(werte, v), quelle: 'drehzahl', unsicherheit: 0.1 };
        }
    }
    if (stufe && zahl(werte[stufe])) {
        return { m3min: werte[stufe], stufe, quelle: 'stufe', unsicherheit: 0.1 };
    }
    if (String(o.fan) === 'auto' && zahl(werte.M)) {
        // Auto ohne gelernte Drehzahl: irgendwo zwischen leise und hoch
        const spanne = zahl(werte.SL) && zahl(werte.H) ? (werte.H - werte.SL) / 2 / werte.M : 0.4;
        return { m3min: werte.M, stufe: null, quelle: 'mitte', unsicherheit: Math.max(0.2, spanne * 0.6) };
    }
    return { m3min: null, stufe, quelle: 'fehlt', unsicherheit: 1 };
}

module.exports = {
    STUFEN,
    AUS_FAN,
    GENERISCH,
    PROBEN,
    PROBEN_MIN,
    stufeVon,
    kennlinie,
    lernen,
    gelernt,
    ausDrehzahl,
    naechsteStufe,
    bestimmen,
};
