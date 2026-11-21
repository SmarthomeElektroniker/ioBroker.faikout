'use strict';

/**
 * Schluessel der JSON-Nutzlasten unter `<Geraet>.regulation.*`.
 *
 * Nutzerentscheid 21.11.2026 (vor 1.0.0): Was als JSON in einem Datenpunkt steht, traegt englische
 * Schluessel - wie die IDs der Datenpunkte selbst. Der Adapter rechnet intern weiter mit den deutschen
 * Namen (heizen, untergrenze, von ...); uebersetzt wird nur an der Grenze zum Datenpunkt:
 *   - geschrieben wird ausschliesslich englisch (`schreiben`),
 *   - gelesen wird englisch UND das deutsche Format des Vorabstands (`lesen`) - auch dann, wenn ein
 *     Skript noch das alte Format schreibt,
 *   - gespeicherte Altwerte werden beim Start einmal umgeschrieben (`umschreiben`).
 *
 * Nicht betroffen: `demand.stateJson` (reiner Merker des Adapters, keine Schnittstelle),
 * `schedule.weekJson` ({t, s} - sprachneutral), `historyJson` (Zahlenpaare) und die Szenen-IDs.
 */

/** Schluessel je Art: intern (deutsch) -> Datenpunkt (englisch) */
const SCHLUESSEL = {
    kennlinie: { heizen: 'heating', kuehlen: 'cooling', untergrenze: 'lowerLimit', obergrenze: 'upperLimit' },
    befehl: { felder: 'fields', wert: 'value', zeit: 'time', aktion: 'action', ist: 'current' },
    abwesenheit: { von: 'from', bis: 'to', szene: 'scene' },
};

/** Werte je Art und (internem) Schluessel: intern -> Datenpunkt */
const WERTE = {
    befehl: { aktion: { wuerde: 'would', senden: 'send' } },
};

/** Datenpunkt (Pfad unter regulation) -> Art */
const DATENPUNKTE = {
    'demand.curveJson': 'kennlinie',
    'demand.wouldSend': 'befehl',
    lastCommand: 'befehl',
    'schedule.absenceJson': 'abwesenheit',
};

const umgekehrt = o => Object.fromEntries(Object.entries(o).map(([a, b]) => [b, a]));

/**
 * Interne Struktur -> Nutzlast des Datenpunkts (englische Schluessel und Werte).
 *
 * @param {'kennlinie'|'befehl'|'abwesenheit'} art  Art der Nutzlast
 * @param {object} intern  Struktur mit deutschen Schluesseln
 * @returns {object} Struktur mit englischen Schluesseln
 */
function schreiben(art, intern) {
    const s = SCHLUESSEL[art];
    const w = WERTE[art] || {};
    const aus = {};
    for (const [k, v] of Object.entries(intern || {})) {
        aus[s[k] || k] = w[k] && typeof v === 'string' && w[k][v] ? w[k][v] : v;
    }
    return aus;
}

/**
 * Nutzlast eines Datenpunkts -> interne Struktur. Nimmt das englische Format und das deutsche des
 * Vorabstands; steht beides in einem Objekt, gewinnt das englische.
 *
 * @param {'kennlinie'|'befehl'|'abwesenheit'} art  Art der Nutzlast
 * @param {unknown} roh  Objekt oder JSON-Text
 * @returns {object|null} Struktur mit deutschen Schluesseln oder null (leer, kein Objekt, kein JSON)
 */
function lesen(art, roh) {
    let o = roh;
    if (typeof roh === 'string') {
        try {
            o = roh.trim() ? JSON.parse(roh) : null;
        } catch {
            return null;
        }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
        return null;
    }
    const zurueck = umgekehrt(SCHLUESSEL[art]);
    const w = WERTE[art] || {};
    const aus = {};
    for (const [k, v] of Object.entries(o)) {
        if (!zurueck[k]) {
            aus[k] = v;
        }
    }
    for (const [k, v] of Object.entries(o)) {
        if (zurueck[k]) {
            aus[zurueck[k]] = v;
        }
    }
    for (const [k, tabelle] of Object.entries(w)) {
        const r = umgekehrt(tabelle);
        if (typeof aus[k] === 'string' && r[aus[k]]) {
            aus[k] = r[aus[k]];
        }
    }
    return aus;
}

/**
 * Gespeicherten Wert eines Datenpunkts auf das englische Format bringen.
 *
 * @param {string} pfad  Pfad unter regulation ('demand.curveJson', 'lastCommand' ...)
 * @param {unknown} text  gespeicherter JSON-Text
 * @returns {string|null} neuer Text - oder null, wenn nichts zu tun ist (leer, schon englisch, kein JSON)
 */
function umschreiben(pfad, text) {
    const art = DATENPUNKTE[pfad];
    if (!art || typeof text !== 'string' || !text.trim()) {
        return null;
    }
    const intern = lesen(art, text);
    if (!intern) {
        return null;
    }
    const neu = JSON.stringify(schreiben(art, intern));
    return neu === text ? null : neu;
}

module.exports = { SCHLUESSEL, WERTE, DATENPUNKTE, schreiben, lesen, umschreiben };
