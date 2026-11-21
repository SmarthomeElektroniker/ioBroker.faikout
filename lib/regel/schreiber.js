'use strict';

/**
 * Schreiber: entscheidet, ob ein neuer Sollwert an das Modul geht. Rein, Uhr kommt herein.
 *
 * Schutz der Anlage und des Moduls vor Befehlsfluten:
 *  - nur Geraetestufen (30..100 in 5er-Schritten), nur wenn der Istwert abweicht
 *  - Haltezeit: ein Wunsch muss nach oben 60 s, nach unten 600 s stabil anstehen
 *  - Mindestabstand 180 s zwischen zwei Befehlen, hoechstens 12 Befehle je Stunde
 *
 * Im Probelauf wird NIE gesendet: die Aktion heisst dann `wuerde` und der Wert gilt als virtueller
 * Istwert, damit das Verhalten (Haltezeiten, Takt) dem echten Betrieb entspricht.
 */

const texte = require('./texte');

const GRENZEN = { haltHochMs: 60000, haltRunterMs: 600000, abstandMs: 180000, proStunde: 12 };

/**
 * @param {number} wert  gewuenschter Wert
 * @returns {number} naechste Geraetestufe 30..100
 */
function geraeteStufe(wert) {
    return Math.min(100, Math.max(30, Math.round(Number(wert) / 5) * 5));
}

/**
 * Uhrzeit HH:MM:SS (Ortszeit) - als fester Text statt eines Countdowns, damit der Datenpunkt mit
 * der Begruendung waehrend einer Wartezeit nicht bei jedem Schritt neu geschrieben wird.
 *
 * @param {number} ms  Zeitpunkt
 * @returns {string} Uhrzeit
 */
function uhrzeit(ms) {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

/** Leerer Schreiberzustand. */
function neuerZustand() {
    return { wunsch: null, wunschSeit: 0, befehle: [], virtuell: null, letzter: null };
}

/**
 * @param {object} p  Eingang
 * @param {number|null} p.sollwert   Ergebnis des Rechenkerns (null = neutral, nichts tun)
 * @param {number|null} p.istwert    vom Modul gemeldetes demand
 * @param {boolean} p.probelauf      true = nur protokollieren
 * @param {string} p.faehig          'yes' | 'no' | 'unknown'
 * @param {number} p.jetzt           Uhr (ms)
 * @param {object|null} p.zustand    bisheriger Zustand
 * @param {object} [p.grenzen]       abweichende Grenzen
 * @returns {{aktion: 'nichts'|'senden'|'wuerde', wert: number|null, grund: string, befehleStunde: number, zustand: object}} Entscheidung
 */
function entscheiden({ sollwert, istwert, probelauf, faehig, jetzt, zustand, grenzen }) {
    const g = { ...GRENZEN, ...(grenzen || {}) };
    const z = { ...neuerZustand(), ...(zustand || {}) };
    z.befehle = (z.befehle || []).filter(t => jetzt - t < 3600000 && t <= jetzt);
    const aus = (aktion, wert, grund) => ({ aktion, wert, grund, befehleStunde: z.befehle.length, zustand: z });

    if (!probelauf) {
        z.virtuell = null; // im echten Betrieb zaehlt nur der gemeldete Istwert
    }
    if (sollwert === null || sollwert === undefined) {
        z.wunsch = null;
        return aus('nichts', null, texte.t('schreiber.keineVorgabe'));
    }
    if (faehig === 'no') {
        z.wunsch = null;
        return aus('nichts', null, texte.t('schreiber.nichtFaehig'));
    }
    const ziel = geraeteStufe(sollwert);
    const ist = probelauf && Number.isFinite(z.virtuell) ? z.virtuell : Number(istwert);
    if (ziel === ist) {
        z.wunsch = null;
        return aus('nichts', null, texte.t('schreiber.istStimmt'));
    }
    if (z.wunsch !== ziel) {
        z.wunsch = ziel;
        z.wunschSeit = jetzt;
    }
    const halt = Number.isFinite(ist) && ziel < ist ? g.haltRunterMs : g.haltHochMs;
    if (jetzt - z.wunschSeit < halt) {
        return aus('nichts', null, texte.t('schreiber.haltezeit', { zeit: uhrzeit(z.wunschSeit + halt) }));
    }
    const letzter = z.befehle[z.befehle.length - 1];
    if (letzter !== undefined && jetzt - letzter < g.abstandMs) {
        return aus('nichts', null, texte.t('schreiber.mindestabstand', { zeit: uhrzeit(letzter + g.abstandMs) }));
    }
    if (z.befehle.length >= g.proStunde) {
        return aus('nichts', null, texte.t('schreiber.obergrenze', { n: g.proStunde }));
    }
    z.befehle.push(jetzt);
    z.letzter = { wert: ziel, zeit: jetzt };
    z.wunsch = null;
    if (probelauf) {
        z.virtuell = ziel;
        return aus('wuerde', ziel, texte.t('schreiber.wuerde', { wert: ziel }));
    }
    return aus('senden', ziel, texte.t('schreiber.sende', { wert: ziel }));
}

module.exports = { entscheiden, geraeteStufe, neuerZustand, GRENZEN };
