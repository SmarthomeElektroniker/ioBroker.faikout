'use strict';

/**
 * Modellliste: Luftstrom je Luefterstufe, Nennleistung, SEER/SCOP und Quelle je Innengeraet.
 *
 * Die Daten stehen in modelle.json. Jeder Eintrag nennt seine Quelle und wie er geprueft wurde
 * (`geprueft`: "original" = jeder Wert im Rohtext der Herstellerseite gesehen, "zusammenfassung" = aus
 * einer maschinellen Zusammenfassung der Seite, nicht einzeln gegengeprueft). Werte, die die Quelle nicht
 * eindeutig hergibt, sind null und stehen unter `luecken` - es wird nichts geraten und nichts interpoliert.
 * Eigene Modelle legt der Nutzer in der Instanzkonfiguration an (gleiche Felder, Quelle frei).
 */

const LISTE = require('./modelle.json');
const { STUFEN } = require('./luftstrom');

const DATENBLATT_STUFEN = ['SL', 'L', 'M', 'H'];
const BAUFORMEN = ['wand', 'truhe', 'kanal', 'kassette', 'decke'];
const GEPRUEFT = ['original', 'zusammenfassung', 'eigen'];

/** Plausibilitaetsgrenzen (Single-Split-Innengeraete bis etwa 10 kW). */
const GRENZEN = {
    luftstrom: [1, 40], // m³/min
    nennKW: [0.5, 20],
    seer: [2, 12],
    scop: [2, 7],
    bypassfaktor: [0.01, 0.5],
};

const istZahl = x => typeof x === 'number' && isFinite(x);
const text = x => (typeof x === 'string' ? x.trim() : '');

/**
 * Baugroesse aus der Modellbezeichnung (FTXM35R -> 35).
 *
 * @param {string} modell  Modellbezeichnung
 * @returns {number|null} Baugroesse oder null
 */
function baugroesse(modell) {
    const m = /[A-Z](\d{2,3})[A-Z]/.exec(String(modell || '').toUpperCase());
    return m ? Number(m[1]) : null;
}

/**
 * Prueft einen Eintrag der Modellliste.
 *
 * @param {object} m  Eintrag
 * @param {object} [opt]  Optionen
 * @param {boolean} [opt.eigen]  eigenes Modell des Nutzers: Quelle und Pruefstand sind frei
 * @returns {string[]} Fehler (leer = in Ordnung), englisch fuer Log und Test
 */
function pruefen(m, opt = {}) {
    const f = [];
    if (!m || typeof m !== 'object') {
        return ['not an object'];
    }
    if (!text(m.modell)) {
        f.push('modell missing');
    }
    if (!text(m.hersteller)) {
        f.push('hersteller missing');
    }
    if (!opt.eigen) {
        if (!BAUFORMEN.includes(m.bauform)) {
            f.push(`bauform "${m.bauform}" unknown`);
        }
        if (!/^https?:\/\/\S+/.test(text(m.quelle))) {
            f.push('quelle (URL) missing');
        }
        if (!GEPRUEFT.includes(m.geprueft) || m.geprueft === 'eigen') {
            f.push(`geprueft "${m.geprueft}" invalid`);
        }
        if (!Array.isArray(m.luecken)) {
            f.push('luecken missing');
        }
    }
    if (m.einheit !== 'm3/min') {
        f.push(`einheit "${m.einheit}" (must be m3/min)`);
    }
    const bereich = (name, wert, [lo, hi]) => {
        if (wert === null || wert === undefined) {
            return;
        }
        if (!istZahl(wert) || wert < lo || wert > hi) {
            f.push(`${name} ${wert} outside ${lo}..${hi}`);
        }
    };
    for (const seite of ['luftstromHeizen', 'luftstromKuehlen']) {
        const l = m[seite];
        if (!l || typeof l !== 'object') {
            f.push(`${seite} missing`);
            continue;
        }
        let vor = 0;
        for (const s of DATENBLATT_STUFEN) {
            bereich(`${seite}.${s}`, l[s], GRENZEN.luftstrom);
            if (istZahl(l[s])) {
                if (l[s] < vor) {
                    f.push(`${seite}.${s} ${l[s]} below the lower stage (${vor})`);
                }
                vor = l[s];
            }
        }
        for (const k of Object.keys(l)) {
            if (!DATENBLATT_STUFEN.includes(k)) {
                f.push(`${seite}.${k} unknown stage`);
            }
        }
    }
    bereich('nennKuehlenKW', m.nennKuehlenKW, GRENZEN.nennKW);
    bereich('nennHeizenKW', m.nennHeizenKW, GRENZEN.nennKW);
    bereich('seer', m.seer, GRENZEN.seer);
    bereich('scop', m.scop, GRENZEN.scop);
    bereich('bypassfaktor', m.bypassfaktor, GRENZEN.bypassfaktor);
    return f;
}

/**
 * Welche Angaben eines Eintrags fehlen (fuer die Anzeige "Luecken")?
 *
 * @param {object} m  Eintrag
 * @returns {string[]} Feldnamen
 */
function luecken(m) {
    const l = [];
    for (const k of ['nennKuehlenKW', 'nennHeizenKW', 'seer', 'scop']) {
        if (!istZahl(m[k])) {
            l.push(k);
        }
    }
    for (const seite of ['luftstromHeizen', 'luftstromKuehlen']) {
        for (const s of DATENBLATT_STUFEN) {
            if (!istZahl((m[seite] || {})[s])) {
                l.push(`${seite}.${s}`);
            }
        }
    }
    return l;
}

/**
 * Alle Modelle: mitgelieferte Liste plus eigene des Nutzers (eigene mit gleichem Namen gehen vor).
 *
 * @param {object[]} [eigene]  eigene Modelle aus der Instanzkonfiguration
 * @returns {object[]} Liste
 */
function alle(eigene) {
    const meine = (Array.isArray(eigene) ? eigene : [])
        .filter(m => m && text(m.modell))
        .map(m => ({
            einheit: 'm3/min',
            hersteller: '',
            luftstromHeizen: {},
            luftstromKuehlen: {},
            ...m,
            geprueft: 'eigen',
            eigen: true,
        }));
    const namen = new Set(meine.map(m => m.modell.toUpperCase()));
    return [...meine, ...LISTE.filter(m => !namen.has(m.modell.toUpperCase()))];
}

/**
 * Sucht ein Modell nach seiner Bezeichnung (Gross-/Kleinschreibung egal).
 *
 * @param {string} name  Modellbezeichnung
 * @param {object[]} [eigene]  eigene Modelle
 * @returns {object|null} Eintrag oder null
 */
function finde(name, eigene) {
    const n = text(name).toUpperCase();
    return n ? alle(eigene).find(m => m.modell.toUpperCase() === n) || null : null;
}

/**
 * Filtert die Liste fuer das Suchfeld.
 *
 * @param {object[]} liste  Modelle
 * @param {object} f  Filter
 * @param {string} [f.text]  Suchtext (alle Woerter muessen in Hersteller, Reihe oder Modell vorkommen)
 * @param {string} [f.hersteller]  Hersteller
 * @param {string} [f.reihe]  Reihe
 * @param {string} [f.bauform]  Bauform
 * @param {number} [f.groesse]  Baugroesse
 * @returns {object[]} Treffer
 */
function filtern(liste, f = {}) {
    const worte = text(f.text).toLowerCase().split(/\s+/).filter(Boolean);
    return liste.filter(m => {
        const heu = `${m.hersteller} ${m.reihe || ''} ${m.modell}`.toLowerCase();
        return (
            worte.every(w => heu.includes(w)) &&
            (!f.hersteller || m.hersteller === f.hersteller) &&
            (!f.reihe || m.reihe === f.reihe) &&
            (!f.bauform || m.bauform === f.bauform) &&
            (!f.groesse || baugroesse(m.modell) === Number(f.groesse))
        );
    });
}

module.exports = {
    LISTE,
    STUFEN,
    DATENBLATT_STUFEN,
    BAUFORMEN,
    GEPRUEFT,
    GRENZEN,
    baugroesse,
    pruefen,
    luecken,
    alle,
    finde,
    filtern,
};
