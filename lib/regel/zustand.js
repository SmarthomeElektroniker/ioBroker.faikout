'use strict';

/**
 * Neustartfester Zustand der Regelung je Geraet. Er liegt als JSON im Datenpunkt
 * `<Geraet>.regel.bedarf.zustandJson` - kein Wissen geht beim Adapter-Neustart verloren
 * (Aussenmittel, Haltezeiten, Befehlszaehler, Faehigkeit).
 */

const bedarf = require('./bedarf');
const schreiber = require('./schreiber');

const VERSION = 1;

/** @returns {{v: number, bedarf: object, schreiber: object, faehig: object|null}} leerer Zustand */
function leer() {
    return { v: VERSION, bedarf: bedarf.neuerZustand(), schreiber: schreiber.neuerZustand(), faehig: null };
}

/**
 * @param {unknown} text  gespeicherter Wert (JSON-Text)
 * @returns {object} Zustand; bei Unsinn oder anderer Version der leere
 */
function lesen(text) {
    if (typeof text !== 'string' || !text) {
        return leer();
    }
    try {
        const z = JSON.parse(text);
        if (!z || z.v !== VERSION || typeof z.bedarf !== 'object' || typeof z.schreiber !== 'object') {
            return leer();
        }
        return {
            v: VERSION,
            bedarf: { ...bedarf.neuerZustand(), ...z.bedarf },
            schreiber: { ...schreiber.neuerZustand(), ...z.schreiber },
            faehig: z.faehig && typeof z.faehig.wert === 'string' ? z.faehig : null,
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
    return JSON.stringify({ v: VERSION, bedarf: z.bedarf, schreiber: z.schreiber, faehig: z.faehig });
}

module.exports = { lesen, schreiben, leer, VERSION };
