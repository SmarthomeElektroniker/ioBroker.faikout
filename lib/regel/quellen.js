'use strict';

/**
 * Fuehlerquellen: waehlt je Messgroesse (aussen, raum, feuchte) den besten verfuegbaren Fuehler.
 * Rein, die Uhr kommt herein.
 *
 * Reihenfolge bei "auto":
 *  - raum / feuchte: BLE-Fuehler am Modul > eigener Datenpunkt > interner Fuehler der Anlage
 *  - aussen:         eigener Datenpunkt > Aussengeraet der Anlage
 * Ein BLE-Fuehler hat im Modul immer Vorrang (Firmware: bei verbundenem BLE wird ein per MQTT
 * gelieferter Wert ignoriert) - deshalb steht er auch hier vorn. Ist die gewaehlte Quelle veraltet
 * oder unbrauchbar, faellt die Wahl auf die naechste; das Ergebnis nennt Quelle und Rueckfall.
 */

const fuehler = require('./fuehler');

const FEUCHTE = { hoechstalterMs: 30 * 60000, min: 5, max: 100, sprungMax: 100 };
const GRENZEN = { aussen: fuehler.AUSSEN, raum: fuehler.RAUM, feuchte: FEUCHTE };
const NAMEN = { ble: 'BLE-Fühler am Modul', dp: 'Datenpunkt', intern: 'Fühler der Anlage' };
const REIHENFOLGE = {
    aussen: ['dp', 'intern'],
    raum: ['ble', 'dp', 'intern'],
    feuchte: ['ble', 'dp', 'intern'],
};

/**
 * @param {'aussen'|'raum'|'feuchte'} art  Messgroesse
 * @param {string} wahl  'auto' | 'intern' | 'ble' | 'dp'
 * @param {{intern?: object|null, ble?: object|null, dp?: object|null}} verfuegbar  Messungen {wert, zeit} je Quelle
 * @param {number} jetzt  Uhr (ms)
 * @returns {{messung: {wert: number, zeit: number}|null, quelle: string|null, stand: 'ok'|'rueckfall'|'fehlt', text: string}} Auswahl
 */
function waehlen(art, wahl, verfuegbar, jetzt) {
    const grenzen = GRENZEN[art];
    const alle = REIHENFOLGE[art];
    const folge = wahl && wahl !== 'auto' && alle.includes(wahl) ? [wahl, ...alle.filter(q => q !== wahl)] : alle;
    const probleme = [];
    for (const [i, q] of folge.entries()) {
        const m = verfuegbar[q];
        if (m === undefined) {
            continue; // Quelle gibt es an diesem Geraet nicht (kein BLE gekoppelt, kein Datenpunkt gewaehlt)
        }
        const b = fuehler.bewerten(m, jetzt, grenzen, {});
        if (b.gueltig) {
            const rueckfall = probleme.length > 0 || (wahl && wahl !== 'auto' && i > 0);
            return {
                messung: { wert: b.wert, zeit: m.zeit },
                quelle: q,
                stand: rueckfall ? 'rueckfall' : 'ok',
                text: rueckfall && probleme.length ? `${NAMEN[q]} (Rückfall: ${probleme.join('; ')})` : NAMEN[q],
            };
        }
        probleme.push(`${NAMEN[q]} ${b.grund}`);
    }
    return {
        messung: null,
        quelle: null,
        stand: 'fehlt',
        text: probleme.length ? probleme.join('; ') : 'kein Fühler vorhanden',
    };
}

module.exports = { waehlen, FEUCHTE, NAMEN };
