'use strict';

/**
 * Fuehlerbewertung: Frische, Plausibilitaet, Sprungfilter. Rein, die Uhr kommt herein.
 *
 * Ein Fuehlerwert ist nur brauchbar, wenn er juenger als das Hoechstalter ist (aussen 60 min,
 * Raum 15 min) und im plausiblen Bereich liegt. Ein einzelner Sprung um mehr als `sprungMax`
 * wird erst uebernommen, wenn die naechste Messung ihn bestaetigt - bis dahin gilt der alte Wert.
 */

const texte = require('./texte');

const AUSSEN = { hoechstalterMs: 60 * 60000, min: -40, max: 50, sprungMax: 8 };
const RAUM = { hoechstalterMs: 15 * 60000, min: 0, max: 40, sprungMax: 4 };

/**
 * @param {{wert: (number|string|null), zeit: number}|null} messung  letzter gemeldeter Wert mit Zeitstempel (ms)
 * @param {number} jetzt                             Uhrzeit (ms)
 * @param {{hoechstalterMs: number, min: number, max: number, sprungMax: number}} opt  Grenzen
 * @param {{wert?: number, verdacht?: number|null}} [merker]  Stand des Sprungfilters
 * @returns {{gueltig: boolean, wert: number|null, grund: string, merker: object}} Ergebnis
 */
function bewerten(messung, jetzt, opt, merker = {}) {
    const m = { wert: merker.wert, verdacht: merker.verdacht === undefined ? null : merker.verdacht };
    if (!messung || messung.wert === null || messung.wert === undefined || messung.wert === '') {
        return { gueltig: false, wert: null, grund: texte.t('fuehler.keinWert'), merker: m };
    }
    const wert = Number(messung.wert);
    if (!Number.isFinite(wert)) {
        return { gueltig: false, wert: null, grund: texte.t('fuehler.keineZahl'), merker: m };
    }
    if (!Number.isFinite(messung.zeit) || jetzt - messung.zeit > opt.hoechstalterMs) {
        const min = Number.isFinite(messung.zeit) ? Math.round((jetzt - messung.zeit) / 60000) : '?';
        return { gueltig: false, wert: null, grund: texte.t('fuehler.veraltet', { min }), merker: m };
    }
    if (wert < opt.min || wert > opt.max) {
        return { gueltig: false, wert: null, grund: texte.t('fuehler.unplausibel', { wert }), merker: m };
    }
    if (Number.isFinite(m.wert) && Math.abs(wert - m.wert) > opt.sprungMax) {
        // Zweite Messung in derselben Gegend bestaetigt den Sprung.
        if (Number.isFinite(m.verdacht) && Math.abs(wert - m.verdacht) <= opt.sprungMax / 2) {
            return {
                gueltig: true,
                wert,
                grund: texte.t('fuehler.sprungBestaetigt'),
                merker: { wert, verdacht: null },
            };
        }
        return {
            gueltig: true,
            wert: m.wert,
            grund: texte.t('fuehler.sprungVerworfen', { wert }),
            merker: { wert: m.wert, verdacht: wert },
        };
    }
    return { gueltig: true, wert, grund: 'ok', merker: { wert, verdacht: null } };
}

module.exports = { bewerten, AUSSEN, RAUM };
