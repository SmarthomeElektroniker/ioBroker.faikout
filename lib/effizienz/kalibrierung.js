'use strict';

/**
 * Kalibrierung der Wirksamkeit ε mit einem Sensor am Luftaustritt.
 *
 * Jeder Messpunkt liefert ε = (T_aus − T_ein) / (T_ref − T_ein). Ausgewertet wird je Betriebsart (Heizen,
 * Kuehlen) und je Luefterstufe; der Wert einer Stufe ist der Median ihrer Punkte (unempfindlich gegen
 * einzelne Ausreisser), der Restfehler die Streuung der Punkte um diesen Wert.
 *
 *  - Stufen ohne Messung zwischen zwei gemessenen werden ueber den Luftstrom interpoliert, Stufen
 *    ausserhalb bekommen den Wert der naechsten gemessenen Stufe, mit dem Verlauf der Datenblatt-Schaetzung
 *    uebertragen - beides gekennzeichnet.
 *  - Liegen die gemessenen Stufen praktisch gleich (hoechstens GLEICH auseinander), wird zu EINEM Wert
 *    zusammengefasst; das Ergebnis nennt den Unterschied als Begruendung.
 *  - Abtauen, Stillstand, Anlauf und Punkte mit zu kleinem Abstand zwischen liquid und Ansaugluft werden
 *    nicht aufgenommen.
 *
 * Reine Funktionen: Punkte rein, Ergebnis raus.
 */

const { STUFEN } = require('./luftstrom');

/** Ab so vielen Punkten gilt eine Stufe als gut abgedeckt. */
const PUNKTE_OK = 20;
/** Ab so vielen Punkten wird eine Stufe ueberhaupt als gemessen gewertet (Streuung bestimmbar). */
const PUNKTE_KNAPP = 6;
/** Mindestabstand |T_ref − T_ein| eines Messpunkts in K. */
const MIN_ABSTAND_K = 3;
/** Stufen gelten als gleich, wenn ihre ε hoechstens so weit vom gemeinsamen Wert abweichen (relativ). */
const GLEICH = 0.05;
/** Unsicherheit von ε, wenn zu wenige Punkte fuer eine Streuung da sind (einzelne Handmessungen). */
const UNSICHER_WENIG = 0.15;
/** Untere Grenze der ausgewiesenen Unsicherheit von ε. */
const UNSICHER_MIN = 0.03;
/** Zuschlag fuer nicht selbst gemessene Stufen. */
const ZUSCHLAG_FREMD = 0.05;
/** Bereiche der Aussentemperatur fuer die Abdeckung: [von, bis) in °C. */
const AUSSEN_BEREICHE = [
    [-50, -5],
    [-5, 0],
    [0, 5],
    [5, 10],
    [10, 50],
];

const istZahl = x => typeof x === 'number' && isFinite(x);
const median = liste => {
    const s = [...liste].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const runden = (x, stellen = 3) => Math.round(x * 10 ** stellen) / 10 ** stellen;

/**
 * Taugt ein Messpunkt fuer die Kalibrierung?
 *
 * @param {object} p  Messpunkt {art, stufe, tEin, tRef, tAus, comp?, rpm?}
 * @returns {{ok: boolean, grund: string}} Urteil; grund: '' | 'unvollstaendig' | 'steht' | 'abtauen' | 'kleinerAbstand' | 'vorzeichen'
 */
function pruefen(p) {
    if (!p || !['heizen', 'kuehlen'].includes(p.art) || !istZahl(p.tEin) || !istZahl(p.tRef) || !istZahl(p.tAus)) {
        return { ok: false, grund: 'unvollstaendig' };
    }
    if ((istZahl(p.comp) && p.comp <= 0) || (istZahl(p.rpm) && p.rpm <= 0)) {
        return { ok: false, grund: 'steht' };
    }
    const d = p.tRef - p.tEin;
    if (p.art === 'heizen' && d < -1) {
        return { ok: false, grund: 'abtauen' };
    }
    if (Math.abs(d) < MIN_ABSTAND_K) {
        return { ok: false, grund: 'kleinerAbstand' };
    }
    // Die Luft muss sich in dieselbe Richtung bewegen wie das Register
    if ((p.art === 'heizen' && (d < 0 || p.tAus <= p.tEin)) || (p.art === 'kuehlen' && (d > 0 || p.tAus >= p.tEin))) {
        return { ok: false, grund: 'vorzeichen' };
    }
    return { ok: true, grund: '' };
}

/**
 * ε eines Messpunkts.
 *
 * @param {object} p  Messpunkt
 * @returns {number} Wirksamkeit
 */
function epsVon(p) {
    return (p.tAus - p.tEin) / (p.tRef - p.tEin);
}

/**
 * Abdeckung der Messung: Punkte je Stufe und je Aussentemperaturbereich, dazu die Stufe, die man als
 * naechste kurz fahren sollte.
 *
 * @param {object[]} punkte  Messpunkte
 * @param {'heizen'|'kuehlen'} art  Betriebsart
 * @returns {{gesamt: number, stufen: Record<string, {n: number, stand: 'ok'|'knapp'|'wenig'}>, aussen: {von: number, bis: number, n: number}[],
 *   ohneStufe: number, naechste: string|null, fertig: boolean}} Abdeckung
 */
function abdeckung(punkte, art) {
    const gut = (punkte || []).filter(p => p.art === art && pruefen(p).ok);
    const stufen = {};
    for (const s of STUFEN) {
        const n = gut.filter(p => p.stufe === s).length;
        stufen[s] = { n, stand: n >= PUNKTE_OK ? 'ok' : n >= PUNKTE_KNAPP ? 'knapp' : 'wenig' };
    }
    const aussen = AUSSEN_BEREICHE.map(([von, bis]) => ({
        von,
        bis,
        n: gut.filter(p => istZahl(p.aussen) && p.aussen >= von && p.aussen < bis).length,
    }));
    // Empfehlung: zuerst die Eckstufen und die Mitte (L, H, M), dann der Rest - jeweils die mit den wenigsten Punkten
    const reihenfolge = ['M', 'H', 'L', 'MH', 'ML', 'SL'];
    const offen = reihenfolge.filter(s => stufen[s].stand !== 'ok');
    const naechste = offen.length ? offen.sort((a, b) => stufen[b].n - stufen[a].n || 0)[0] : null;
    const gemessen = STUFEN.filter(s => stufen[s].stand === 'ok').length;
    return {
        gesamt: gut.length,
        stufen,
        aussen,
        ohneStufe: gut.filter(p => !STUFEN.includes(p.stufe)).length,
        naechste: gut.length ? naechste : 'M',
        fertig: gemessen >= 2,
    };
}

/**
 * Wertet die Punkte einer Betriebsart aus.
 *
 * @param {object[]} punkte  Messpunkte (alle Arten, ungefiltert)
 * @param {'heizen'|'kuehlen'} art  Betriebsart
 * @param {{stufen: Record<string, {eps: number}>}} vorgabe  Datenblatt-Schaetzung je Stufe (fuer den Verlauf)
 * @param {Record<string, number>} werte  Luftstromkennlinie Stufe -> m³/min
 * @returns {object|null} {stufen: {S: {eps, herkunft, n}}, zusammengefasst, unterschied, restfehler, n, unsicherheit, guete} oder null
 */
function auswertenArt(punkte, art, vorgabe, werte) {
    const gut = (punkte || []).filter(p => p.art === art && pruefen(p).ok);
    if (!gut.length) {
        return null;
    }
    const vor = (vorgabe && vorgabe.stufen) || {};
    const jeStufe = {};
    for (const s of STUFEN) {
        const liste = gut.filter(p => p.stufe === s).map(epsVon);
        if (liste.length) {
            jeStufe[s] = { eps: median(liste), n: liste.length, liste };
        }
    }
    // Punkte ohne zugeordnete Stufe (Handmessung ohne Angabe) zaehlen nur fuer den gemeinsamen Wert
    const alle = gut.map(epsVon);
    const gemeinsam = median(alle);
    const gemessen = STUFEN.filter(s => jeStufe[s] && jeStufe[s].n >= PUNKTE_KNAPP);
    const stufen = {};
    let zusammengefasst = false;
    let unterschied = null;
    if (gemessen.length >= 2) {
        unterschied = Math.max(...gemessen.map(s => Math.abs(jeStufe[s].eps - gemeinsam) / gemeinsam));
        zusammengefasst = unterschied <= GLEICH;
    }
    const basis = gemessen.length ? gemessen : STUFEN.filter(s => jeStufe[s]);
    if (zusammengefasst || !basis.length) {
        // ein Wert fuer alle Stufen: praktisch konstant - oder es gibt nur Punkte ohne Stufe
        for (const s of STUFEN) {
            stufen[s] = {
                eps: runden(gemeinsam),
                herkunft: jeStufe[s] ? 'gemessen' : 'zusammengefasst',
                n: jeStufe[s] ? jeStufe[s].n : 0,
            };
        }
        zusammengefasst = true;
    } else {
        for (const s of basis) {
            stufen[s] = { eps: runden(jeStufe[s].eps), herkunft: 'gemessen', n: jeStufe[s].n };
        }
        const x = s => (istZahl(werte && werte[s]) ? werte[s] : STUFEN.indexOf(s));
        for (const s of STUFEN.filter(st => !stufen[st])) {
            const unten = basis.filter(b => x(b) < x(s)).pop();
            const oben = basis.find(b => x(b) > x(s));
            if (unten && oben) {
                const a = (x(s) - x(unten)) / (x(oben) - x(unten));
                stufen[s] = {
                    eps: runden(jeStufe[unten].eps + a * (jeStufe[oben].eps - jeStufe[unten].eps)),
                    herkunft: 'interpoliert',
                    n: jeStufe[s] ? jeStufe[s].n : 0,
                };
            } else {
                // ausserhalb: Wert des Nachbarn, mit dem Verlauf der Datenblatt-Schaetzung uebertragen
                const nachbar = unten || oben;
                const faktor = vor[s] && vor[nachbar] ? vor[s].eps / vor[nachbar].eps : 1;
                stufen[s] = {
                    eps: runden(jeStufe[nachbar].eps * faktor),
                    herkunft: 'uebertragen',
                    n: jeStufe[s] ? jeStufe[s].n : 0,
                };
            }
        }
    }
    // Restfehler: relative Abweichung jedes Punkts von dem ε, mit dem spaeter gerechnet wird
    const fehler = gut.map(p => {
        const e = stufen[p.stufe] ? stufen[p.stufe].eps : gemeinsam;
        return (epsVon(p) - e) / e;
    });
    const restfehler = gut.length >= 3 ? Math.sqrt(fehler.reduce((s, f) => s + f * f, 0) / fehler.length) : null;
    const genug = gut.length >= PUNKTE_KNAPP;
    const fremd = STUFEN.some(s => stufen[s] && ['interpoliert', 'uebertragen'].includes(stufen[s].herkunft));
    const unsicherheit =
        (genug && restfehler !== null ? Math.max(UNSICHER_MIN, restfehler) : UNSICHER_WENIG) +
        (fremd ? ZUSCHLAG_FREMD : 0);
    return {
        stufen,
        zusammengefasst,
        unterschied: unterschied === null ? null : runden(unterschied),
        restfehler: restfehler === null ? null : runden(restfehler),
        n: gut.length,
        unsicherheit: runden(unsicherheit),
        guete: 'calibrated',
        interpolieren: !zusammengefasst,
    };
}

/**
 * Wertet eine Messung aus (beide Betriebsarten).
 *
 * @param {object[]} punkte  Messpunkte
 * @param {{heizen: object, kuehlen: object}} vorgaben  Datenblatt-Schaetzung je Betriebsart
 * @param {{heizen: Record<string, number>, kuehlen: Record<string, number>}} werte  Luftstromkennlinien
 * @returns {{heizen: object|null, kuehlen: object|null, verworfen: Record<string, number>}} Ergebnis je Betriebsart
 */
function auswerten(punkte, vorgaben, werte) {
    const verworfen = {};
    for (const p of punkte || []) {
        const u = pruefen(p);
        if (!u.ok) {
            verworfen[u.grund] = (verworfen[u.grund] || 0) + 1;
        }
    }
    return {
        heizen: auswertenArt(punkte, 'heizen', vorgaben && vorgaben.heizen, werte && werte.heizen),
        kuehlen: auswertenArt(punkte, 'kuehlen', vorgaben && vorgaben.kuehlen, werte && werte.kuehlen),
        verworfen,
    };
}

module.exports = {
    PUNKTE_OK,
    PUNKTE_KNAPP,
    MIN_ABSTAND_K,
    GLEICH,
    UNSICHER_WENIG,
    UNSICHER_MIN,
    ZUSCHLAG_FREMD,
    AUSSEN_BEREICHE,
    pruefen,
    epsVon,
    abdeckung,
    auswerten,
    auswertenArt,
};
