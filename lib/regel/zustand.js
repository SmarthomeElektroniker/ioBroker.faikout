'use strict';

/**
 * Neustartfester Zustand der Regelung je Geraet. Er liegt als JSON im Datenpunkt
 * `<Geraet>.regel.bedarf.zustandJson` - kein Wissen geht beim Adapter-Neustart verloren
 * (Aussenmittel, Haltezeiten, Befehlszaehler, Faehigkeit, Handeingriff-Sperre, laufender
 * Feuchteeingriff, letzte control-Nachricht, Verlauf der Leistungsgrenze).
 *
 * Version 1 (0.5.0-alpha) kannte nur bedarf/schreiber/faehig und wird uebernommen.
 */

const bedarf = require('./bedarf');
const schreiber = require('./schreiber');
const feuchte = require('./feuchte');
const handeingriff = require('./handeingriff');
const sender = require('./sender');
const koordinator = require('./koordinator');

const VERSION = 2;
const VERLAUF_MAX = 150;

/** @returns {object} leerer Zustand */
function leer() {
    return {
        v: VERSION,
        bedarf: bedarf.neuerZustand(),
        schreiber: schreiber.neuerZustand(),
        faehig: null,
        hand: handeingriff.neuerZustand(),
        feuchte: feuchte.neuerZustand(),
        koordinator: koordinator.neuerZustand(),
        sender: sender.neuerZustand(),
        control: null,
        verlauf: [],
    };
}

const objekt = v => v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} text  gespeicherter Wert (JSON-Text)
 * @returns {object} Zustand; bei Unsinn oder unbekannter Version der leere
 */
function lesen(text) {
    if (typeof text !== 'string' || !text) {
        return leer();
    }
    try {
        const z = JSON.parse(text);
        if (!objekt(z) || ![1, VERSION].includes(z.v) || !objekt(z.bedarf) || !objekt(z.schreiber)) {
            return leer();
        }
        const l = leer();
        return {
            v: VERSION,
            bedarf: { ...l.bedarf, ...z.bedarf },
            schreiber: { ...l.schreiber, ...z.schreiber },
            faehig: objekt(z.faehig) && typeof z.faehig.wert === 'string' ? z.faehig : null,
            hand: objekt(z.hand) ? { ...l.hand, ...z.hand } : l.hand,
            feuchte: objekt(z.feuchte) ? { ...l.feuchte, ...z.feuchte } : l.feuchte,
            koordinator: objekt(z.koordinator) ? { ...l.koordinator, ...z.koordinator } : l.koordinator,
            sender: objekt(z.sender) ? { ...l.sender, ...z.sender } : l.sender,
            control: objekt(z.control) && typeof z.control.text === 'string' ? z.control : null,
            verlauf: Array.isArray(z.verlauf) ? z.verlauf.filter(Array.isArray).slice(-VERLAUF_MAX) : [],
        };
    } catch {
        return leer();
    }
}

/**
 * @param {object} z  Zustand
 * @returns {string} JSON
 */
function schreiben(z) {
    return JSON.stringify({ ...z, v: VERSION, verlauf: (z.verlauf || []).slice(-VERLAUF_MAX) });
}

/**
 * Haengt einen Punkt an den Verlauf der Leistungsgrenze (nur bei Aenderung; 24 h, hoechstens 150).
 *
 * @param {Array<Array<number>>} verlauf  [[zeit, prozent], ...]
 * @param {number|null} wert  Prozent
 * @param {number} jetzt  Uhr
 * @returns {Array<Array<number>>} neuer Verlauf
 */
function verlaufAnhaengen(verlauf, wert, jetzt) {
    const v = (verlauf || []).filter(p => jetzt - p[0] <= 24 * 3600000 && p[0] <= jetzt);
    const letzter = v[v.length - 1];
    if (!Number.isFinite(wert) || (letzter && letzter[1] === wert)) {
        return v;
    }
    return [...v, [jetzt, wert]].slice(-VERLAUF_MAX);
}

module.exports = { lesen, schreiben, leer, verlaufAnhaengen, VERSION };
