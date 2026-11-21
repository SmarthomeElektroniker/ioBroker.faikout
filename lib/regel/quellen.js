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
const texte = require('./texte');

const FEUCHTE = { hoechstalterMs: 30 * 60000, min: 5, max: 100, sprungMax: 100 };
const GRENZEN = { aussen: fuehler.AUSSEN, raum: fuehler.RAUM, feuchte: FEUCHTE };
/** Deutsche Namen der Quellen (Bestand; angezeigt wird name() in der geltenden Sprache). */
const NAMEN = { ble: 'BLE-Fühler am Modul', dp: 'Datenpunkt', intern: 'Fühler der Anlage' };

/**
 * Name einer Quelle in der geltenden Sprache.
 *
 * @param {string} q  'ble' | 'dp' | 'intern'
 * @returns {string} Name
 */
function name(q) {
    if (q === 'ble') {
        return texte.t('quellen.ble');
    }
    return q === 'dp' ? texte.t('quellen.dp') : texte.t('quellen.intern');
}
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
 * @returns {{messung: {wert: number, zeit: number}|null, quelle: string|null, stand: 'ok'|'fallback'|'missing', text: string}} Auswahl
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
                stand: rueckfall ? 'fallback' : 'ok',
                text:
                    rueckfall && probleme.length
                        ? texte.t('quellen.rueckfall', { name: name(q), probleme: probleme.join('; ') })
                        : name(q),
            };
        }
        probleme.push(`${name(q)} ${b.grund}`);
    }
    return {
        messung: null,
        quelle: null,
        stand: 'missing',
        text: probleme.length ? probleme.join('; ') : texte.t('quellen.keiner'),
    };
}

/**
 * Traeger Fremdfuehler (anderer Raum, viel Luft dazwischen): Der Fremdfuehler bestimmt den Wert auf
 * Dauer, die schnellen Aenderungen kommen vom Fuehler der Anlage (Komplementaerfilter):
 *     wert = fremd + (intern - Tiefpass(intern))
 * Im Beharrungszustand ist intern = Tiefpass(intern), der Wert also genau der des Fremdfuehlers.
 * Heizt die Anlage los, steigt der Wert sofort mit - die Regelung sieht ihre Wirkung, bevor sie am
 * traegen Fuehler ankommt, und schwingt nicht ueber.
 *
 * @param {number} fremd   Wert des Fremdfuehlers
 * @param {number|null} intern  Wert des Anlagenfuehlers (null = keiner: dann unveraendert fremd)
 * @param {{tp?: number, zeit?: number}|null} zustand  Tiefpass des Anlagenfuehlers
 * @param {number} jetzt   Uhr (ms)
 * @param {number} tauMs   Zeitkonstante; 0 = aus
 * @returns {{wert: number, anteil: number, zustand: object}} gemischter Wert, schneller Anteil in K
 */
function mischen(fremd, intern, zustand, jetzt, tauMs) {
    if (!Number.isFinite(intern) || !(tauMs > 0)) {
        return { wert: fremd, anteil: 0, zustand: {} };
    }
    const z = zustand && Number.isFinite(zustand.tp) && Number.isFinite(zustand.zeit) ? zustand : null;
    // Nach einer Luecke (Neustart, Fuehlerausfall) neu aufsetzen statt einen alten Tiefpass fortzuschreiben.
    if (!z || jetzt - z.zeit > 3 * tauMs || jetzt < z.zeit) {
        return { wert: fremd, anteil: 0, zustand: { tp: intern, zeit: jetzt } };
    }
    const a = 1 - Math.exp(-(jetzt - z.zeit) / tauMs);
    const tp = z.tp + a * (intern - z.tp);
    // Begrenzen: der schnelle Anteil darf den Fremdwert um hoechstens 2 K verschieben.
    const anteil = Math.max(-2, Math.min(2, intern - tp));
    return { wert: Math.round((fremd + anteil) * 10) / 10, anteil, zustand: { tp, zeit: jetzt } };
}

module.exports = { waehlen, mischen, name, FEUCHTE, NAMEN };
