'use strict';

/**
 * Kennlinie aus Stuetzpunkten [[x, y], ...] - stueckweise linear, an den Enden waagerecht.
 *
 * Reine Funktionen ohne Zustand. Eine ungueltige Kennlinie liefert einen Konfigurationsfehler
 * (Text) statt still falscher Werte - die Regelung geht dann in den Zustand "gestört".
 */

const texte = require('./texte');

/**
 * Liest Stuetzpunkte aus der Konfiguration. Erlaubt sind [[x,y],...], [{x,y},...] und der
 * Text "x:y, x:y" (so steht es im Eingabefeld der Einstellungsseite).
 *
 * @param {string|Array<number[]|{x: number, y: number}>} roh  Konfigurationswert
 * @returns {{punkte: number[][], fehler: string|null}} Stuetzpunkte oder Fehler
 */
function lesen(roh) {
    let liste = roh;
    if (typeof roh === 'string') {
        const text = roh.trim();
        if (!text) {
            return { punkte: [], fehler: texte.t('kennlinie.leer') };
        }
        liste = text
            .split(/[;,]\s*/)
            .map(paar => paar.split(/[:=]/).map(s => Number(String(s).trim().replace(/\s/g, ''))));
    }
    if (!Array.isArray(liste)) {
        return { punkte: [], fehler: texte.t('kennlinie.keineListe') };
    }
    const punkte = liste.map(p =>
        Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p && p.x), Number(p && p.y)],
    );
    return { punkte, fehler: null };
}

/**
 * Prueft Stuetzpunkte: mindestens zwei, alle Zahlen, x streng steigend, y im Bereich 0..100 und
 * monoton in der verlangten Richtung (Heizen: je kaelter, desto mehr - also fallend ueber x;
 * Kuehlen: je waermer, desto mehr - steigend).
 *
 * @param {number[][]} punkte    Stuetzpunkte
 * @param {'fallend'|'steigend'} richtung  verlangte Monotonie von y ueber x
 * @returns {string|null} Fehlertext oder null
 */
function pruefen(punkte, richtung) {
    if (!Array.isArray(punkte) || punkte.length < 2) {
        return texte.t('kennlinie.zweiPunkte');
    }
    for (let i = 0; i < punkte.length; i++) {
        const [x, y] = punkte[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return texte.t('kennlinie.keineZahl', { nr: i + 1 });
        }
        if (y < 0 || y > 100) {
            return texte.t('kennlinie.ausserhalb', { nr: i + 1, y });
        }
        if (i > 0) {
            const [vx, vy] = punkte[i - 1];
            if (x <= vx) {
                return texte.t('kennlinie.nichtAufsteigend', { vx, x });
            }
            if (richtung === 'fallend' && y > vy) {
                return texte.t('kennlinie.nichtFallend', { vx, vy, x, y });
            }
            if (richtung === 'steigend' && y < vy) {
                return texte.t('kennlinie.nichtSteigend', { vx, vy, x, y });
            }
        }
    }
    return null;
}

/**
 * Wert der Kennlinie an der Stelle x (vorher pruefen!).
 *
 * @param {number[][]} punkte  gepruefte Stuetzpunkte
 * @param {number} x           Eingang (Aussentemperatur)
 * @returns {number} Ausgang in Prozent
 */
function wert(punkte, x) {
    if (x <= punkte[0][0]) {
        return punkte[0][1];
    }
    const letzter = punkte[punkte.length - 1];
    if (x >= letzter[0]) {
        return letzter[1];
    }
    for (let i = 1; i < punkte.length; i++) {
        const [x1, y1] = punkte[i];
        if (x <= x1) {
            const [x0, y0] = punkte[i - 1];
            return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
    }
    return letzter[1];
}

/** Vorgaben laut Planung 20.11.2026. */
const VORGABE_HEIZEN = [
    [-10, 95],
    [0, 75],
    [7, 55],
    [15, 40],
];
const VORGABE_KUEHLEN = [
    [25, 40],
    [30, 65],
    [35, 95],
];

module.exports = { lesen, pruefen, wert, VORGABE_HEIZEN, VORGABE_KUEHLEN };
