'use strict';

/**
 * Wirksamkeit ε des Innenregisters: Wie weit naehert sich die Luft der Bezugstemperatur?
 *
 *     T_aus = T_ein + ε · (T_ref − T_ein)
 *
 * T_ref ist der Wert `liquid` der Anlage. WICHTIG: Das ist der Sensor an der Fluessigkeitsleitung des
 * Innenregisters - NICHT die Kondensations- bzw. Verdampfungstemperatur und nicht die mittlere
 * Oberflaechentemperatur. Beim Heizen liegt der groesste Teil des Registers waermer als dieser Sensor
 * (Kondensation, davor Heissgas). ε ist deshalb hier ein EMPIRISCHER Faktor und darf groesser als 1 sein;
 * die Rechnung begrenzt ihn nicht kuenstlich.
 *
 * Vorabschaetzung ohne Messung: Die Leistungstabellen von Daikin nennen fuer das Kuehlen den
 * Bypassfaktor BF des Registers beim Nennluftstrom. 1 − BF ist die Wirksamkeit gegenueber der
 * Registeroberflaeche. Fuer andere Luftstroeme gilt NTU = −ln(BF) und NTU ~ V^(−0,4) (der luftseitige
 * Waermeuebergang waechst etwa mit V^0,6, der Kapazitaetsstrom mit V). Damit liegt ε zwischen leiser
 * und hoher Stufe nur wenige Prozent auseinander. Was die Tabelle NICHT hergibt, ist der Abstand
 * zwischen `liquid` und der wirksamen Oberflaechentemperatur - er steckt in der ausgewiesenen
 * Unsicherheit und wird erst durch die Kalibrierung mit einem Austrittssensor bestimmt.
 */

const { STUFEN } = require('./luftstrom');

/** Bypassfaktor, wenn das Modell keinen nennt (typischer Bereich bei Split-Innengeraeten 0,1 … 0,2). */
const BF_GENERISCH = 0.15;
/** Exponent der Abhaengigkeit NTU ~ V^(−n). */
const NTU_EXPONENT = 0.4;
/** Relative Unsicherheit von ε ohne Kalibrierung: mit Bypassfaktor des Modells bzw. ganz generisch. */
const UNSICHER_MODELL = 0.25;
const UNSICHER_GENERISCH = 0.3;

/**
 * Wirksamkeit aus Bypassfaktor bei anderem Luftstrom.
 *
 * @param {number} bf      Bypassfaktor beim Bezugsluftstrom
 * @param {number} vBezug  Bezugsluftstrom (beliebige Einheit)
 * @param {number} v       Luftstrom (gleiche Einheit)
 * @returns {number} Wirksamkeit gegenueber der Registeroberflaeche
 */
function ausBypass(bf, vBezug, v) {
    const ntu = -Math.log(bf) * Math.pow(vBezug / v, NTU_EXPONENT);
    return 1 - Math.exp(-ntu);
}

/**
 * Vorabschaetzung von ε je Stufe aus dem Datenblatt.
 *
 * @param {object|null|undefined} modell  Modell (nutzt bypassfaktor und bypassLuftstrom, falls vorhanden)
 * @param {Record<string, number>} werte  Kennlinie Stufe -> m³/min der Betriebsart
 * @returns {{stufen: Record<string, {eps: number, herkunft: string}>, unsicherheit: number, bf: number, generisch: boolean}}
 *   ε je Stufe, relative Unsicherheit (0..1), benutzter Bypassfaktor
 */
function vorgabe(modell, werte) {
    const m = modell || {};
    const hat = typeof m.bypassfaktor === 'number' && m.bypassfaktor > 0 && m.bypassfaktor < 1;
    const bf = hat ? m.bypassfaktor : BF_GENERISCH;
    const vBezug = (hat && m.bypassLuftstrom) || werte.H || werte.M || 1;
    const stufen = {};
    for (const s of STUFEN) {
        if (typeof werte[s] === 'number' && werte[s] > 0) {
            stufen[s] = {
                eps: Math.round(ausBypass(bf, vBezug, werte[s]) * 1000) / 1000,
                herkunft: hat ? 'datenblatt' : 'generisch',
            };
        }
    }
    return { stufen, unsicherheit: hat ? UNSICHER_MODELL : UNSICHER_GENERISCH, bf, generisch: !hat };
}

/**
 * ε fuer den Augenblick: zur Stufe, sonst ueber den Luftstrom zwischen den Stufen interpoliert.
 *
 * @param {Record<string, {eps: number}>} stufen  ε je Stufe
 * @param {Record<string, number>} werte  Kennlinie Stufe -> m³/min
 * @param {string|null} stufe  zugeordnete Stufe (null = unbekannt)
 * @param {number|null} m3min  Luftstrom
 * @param {boolean} [interpolieren]  ueber den Luftstrom interpolieren statt die Stufe zu nehmen
 * @returns {number|null} ε
 */
function fuer(stufen, werte, stufe, m3min, interpolieren = false) {
    if (!interpolieren && stufe && stufen[stufe]) {
        return stufen[stufe].eps;
    }
    const punkte = STUFEN.filter(s => stufen[s] && typeof werte[s] === 'number')
        .map(s => [werte[s], stufen[s].eps])
        .sort((a, b) => a[0] - b[0]);
    if (!punkte.length) {
        return null;
    }
    if (typeof m3min !== 'number' || m3min <= punkte[0][0]) {
        return punkte[0][1];
    }
    for (let i = 1; i < punkte.length; i++) {
        if (m3min <= punkte[i][0]) {
            const [x0, y0] = punkte[i - 1];
            const [x1, y1] = punkte[i];
            return x1 === x0 ? y1 : y0 + ((y1 - y0) * (m3min - x0)) / (x1 - x0);
        }
    }
    return punkte[punkte.length - 1][1];
}

module.exports = { BF_GENERISCH, NTU_EXPONENT, UNSICHER_MODELL, UNSICHER_GENERISCH, ausBypass, vorgabe, fuer };
