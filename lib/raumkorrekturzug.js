'use strict';

/**
 * Regeln der ziehbaren Raumkorrektur auf der Einstellungsseite ("Fuer Fortgeschrittene"): Korrekturstaerke
 * (Prozentpunkte je Kelvin, `regelProzentProK`) und Totband (K, `regelTotband`). Rein und ohne
 * Abhaengigkeiten - die Komponente src-admin/src/Raumkorrektur.tsx bindet diese Datei ein, die Tests
 * pruefen sie gegen den Rechenkern (lib/regel/bedarf.js raumKorrektur).
 *
 * Dieselbe Bedienlogik wie die Grenzlinien der Kennlinie (lib/kennlinienzug.js): ziehen rastet, die
 * Pfeiltasten gehen einen Rasterschritt, eine eingetippte Zahl muss im Bereich und auf dem Raster liegen.
 */

/** Bereich und Raster je Groesse (wie die Zahlenfelder, die sie ersetzen) */
const BEREICH = {
    staerke: { min: 0, max: 50, raster: 1, stellen: 0, vorgabe: 10 },
    totband: { min: 0, max: 2, raster: 0.1, stellen: 1, vorgabe: 0.3 },
};

/** Schwellen des Rechenkerns (bedarf.VORGABEN vollAbK / ueberAbK) - nur zur Anzeige der Zonen */
const SCHWELLEN = { vollAbK: 2, ueberAbK: 1.5 };

/**
 * Auf das Raster der Groesse runden und in den Bereich holen.
 *
 * @param {'staerke'|'totband'} welche  Groesse
 * @param {number} wert  Rohwert
 * @returns {number} gueltiger Wert
 */
function rasten(welche, wert) {
    const b = BEREICH[welche];
    const n = Number.isFinite(Number(wert)) ? Number(wert) : b.vorgabe;
    const gerastet = Math.round(n / b.raster) * b.raster;
    const faktor = Math.pow(10, b.stellen);
    return Math.min(b.max, Math.max(b.min, Math.round(gerastet * faktor) / faktor));
}

/**
 * Wert aus dem Formular lesen: leer oder Unsinn = Werksvorgabe.
 *
 * @param {'staerke'|'totband'} welche  Groesse
 * @param {unknown} roh  Formularwert
 * @returns {number} Wert, mit dem gerechnet wird
 */
function lesen(welche, roh) {
    const b = BEREICH[welche];
    return roh === undefined || roh === null || roh === '' || !Number.isFinite(Number(roh)) ? b.vorgabe : Number(roh);
}

/**
 * Raumkorrektur in Prozentpunkten fuer eine Abweichung "Raum minus Ziel" beim HEIZEN: zu kalt (negativ)
 * gibt Punkte dazu, zu warm nimmt welche weg; innerhalb des Totbands 0. (Kuehlen: spiegelbildlich.)
 *
 * @param {number} raumMinusZiel  Abweichung in K (negativ = Raum zu kalt)
 * @param {number} staerke  Punkte je Kelvin
 * @param {number} totband  Totband in K
 * @returns {number} Korrektur in Prozentpunkten
 */
function korrektur(raumMinusZiel, staerke, totband) {
    const zurueck = -raumMinusZiel; // > 0: der Raum liegt hinter dem Ziel zurueck
    if (Math.abs(zurueck) <= totband) {
        return 0;
    }
    return (zurueck > 0 ? zurueck - totband : zurueck + totband) * staerke;
}

/**
 * Ein Tastenschritt (n Rasterschritte).
 *
 * @param {'staerke'|'totband'} welche  Groesse
 * @param {number} wert  aktueller Wert
 * @param {number} n  Schritte (negativ = kleiner)
 * @returns {number} neuer Wert
 */
function schritt(welche, wert, n) {
    return rasten(welche, rasten(welche, wert) + n * BEREICH[welche].raster);
}

/**
 * Eingetippte Zahl pruefen: zulaessig ist, was auch das Ziehen erreicht.
 *
 * @param {'staerke'|'totband'} welche  Groesse
 * @param {string} text  Eingabe (Komma oder Punkt, Einheit am Ende erlaubt)
 * @returns {{wert: number, grund: ''}|{wert: null, grund: 'zahl'|'bereich'}} Wert oder Grund der Ablehnung
 */
function eingabe(welche, text) {
    const b = BEREICH[welche];
    const kurz = String(text ?? '')
        .trim()
        .replace(/^[±+]\s*/, '')
        .replace(/\s*(%|K)(\s.*)?$/i, '')
        .replace(',', '.');
    const n = kurz === '' ? NaN : Number(kurz);
    if (!Number.isFinite(n)) {
        return { wert: null, grund: 'zahl' };
    }
    if (n < b.min || n > b.max) {
        return { wert: null, grund: 'bereich' };
    }
    return { wert: rasten(welche, n), grund: '' };
}

module.exports = { BEREICH, SCHWELLEN, rasten, lesen, korrektur, schritt, eingabe };
