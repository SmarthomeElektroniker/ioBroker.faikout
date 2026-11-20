'use strict';

/**
 * Sender fuer die Szenenfelder (power, mode, target, fan): vergleicht Wunsch und gemeldeten Stand
 * und liefert die noetigen Befehle. Rein, die Uhr kommt herein. Zusammen mit dem Schreiber
 * (Leistungsgrenze) und der control-Nachricht ist das die einzige Stelle, an der die Regelung
 * Befehle erzeugt.
 *
 * Schutz vor Befehlsfluten:
 *  - nur Felder, die das Geraet meldet (Faehigkeit) und die vom Wunsch abweichen
 *  - nach einem Befehl `wartenMs` auf die Bestaetigung warten, hoechstens `versuche` Anlaeufe je Wert;
 *    danach gilt der Wert als abgelehnt, bis sich der Wunsch aendert oder `ruheMs` vergangen sind
 *  - hoechstens `proStunde` Befehle je Stunde
 * Die Firmware schaltet mit `mode` zugleich ein - deshalb geht beim Einschalten nur `mode`.
 */

const texte = require('./texte');

const GRENZEN = { wartenMs: 45000, versuche: 3, ruheMs: 3600000, proStunde: 20 };
const REIHENFOLGE = ['power', 'mode', 'target', 'fan'];

/** Leerer Zustand. */
function neuerZustand() {
    return { felder: {}, befehle: [] };
}

const gleich = (a, b) =>
    typeof a === 'number' || typeof b === 'number' ? Math.abs(Number(a) - Number(b)) < 0.05 : a === b;

/**
 * Welche Felder weichen ab? Beruecksichtigt, dass ein ausgeschaltetes Geraet nur ueber power
 * verglichen wird und `mode` das Einschalten mit erledigt.
 *
 * @param {object} wunsch  {power, mode, target, fan} (undefined = nicht anfassen)
 * @param {object} status  gemeldeter Stand
 * @returns {object} abweichende Felder {feld: wert}
 */
function abweichung(wunsch, status) {
    const ab = {};
    if (wunsch.power === false) {
        if (status.power !== false && status.power !== undefined) {
            ab.power = false;
        }
        return ab;
    }
    if (wunsch.power === true) {
        const modusPasst = wunsch.mode === undefined || status.mode === undefined || status.mode === wunsch.mode;
        if (status.power === false || !modusPasst) {
            if (wunsch.mode !== undefined && status.mode !== undefined) {
                ab.mode = wunsch.mode; // schaltet zugleich ein
            } else if (status.power === false) {
                ab.power = true;
            }
        }
    } else if (wunsch.mode !== undefined && status.mode !== undefined && status.power && status.mode !== wunsch.mode) {
        ab.mode = wunsch.mode;
    }
    if (status.power === false && wunsch.power !== true) {
        return ab; // Geraet bleibt aus: Ziel und Luefter nicht anfassen
    }
    for (const f of ['target', 'fan']) {
        if (wunsch[f] !== undefined && status[f] !== undefined && status[f] !== null && !gleich(wunsch[f], status[f])) {
            ab[f] = wunsch[f];
        }
    }
    return ab;
}

/**
 * @param {object} p  Eingang
 * @param {object} p.wunsch   gewuenschter Stand
 * @param {object} p.status   gemeldeter Stand
 * @param {object|null} p.zustand  bisheriger Zustand
 * @param {number} p.jetzt    Uhr (ms)
 * @param {object} [p.grenzen]  abweichende Grenzen
 * @returns {{befehle: object, wartet: string[], abgelehnt: string[], grund: string, zustand: object}} Befehle {feld: wert}
 */
function planen({ wunsch, status, zustand, jetzt, grenzen }) {
    const g = { ...GRENZEN, ...(grenzen || {}) };
    const z = { ...neuerZustand(), ...(zustand || {}) };
    z.felder = { ...z.felder };
    z.befehle = (z.befehle || []).filter(t => jetzt - t < 3600000 && t <= jetzt);
    const ab = abweichung(wunsch, status);
    const befehle = {};
    const wartet = [];
    const abgelehnt = [];

    // erledigte oder ueberholte Merker entfernen
    for (const f of Object.keys(z.felder)) {
        if (ab[f] === undefined || !gleich(z.felder[f].wert, ab[f])) {
            delete z.felder[f];
        }
    }
    for (const f of REIHENFOLGE) {
        if (ab[f] === undefined) {
            continue;
        }
        const m = z.felder[f];
        if (m && m.abgelehnt) {
            if (jetzt - m.zeit < g.ruheMs) {
                abgelehnt.push(f);
                continue;
            }
            delete z.felder[f];
        } else if (m && jetzt - m.zeit < g.wartenMs) {
            wartet.push(f);
            continue;
        } else if (m && m.versuche >= g.versuche) {
            z.felder[f] = { ...m, abgelehnt: true, zeit: jetzt };
            abgelehnt.push(f);
            continue;
        }
        if (z.befehle.length >= g.proStunde) {
            wartet.push(f);
            continue;
        }
        const alt = z.felder[f];
        z.felder[f] = { wert: ab[f], zeit: jetzt, versuche: alt ? alt.versuche + 1 : 1 };
        z.befehle.push(jetzt);
        befehle[f] = ab[f];
    }
    const teile = [];
    if (Object.keys(befehle).length) {
        teile.push(
            texte.t('sender.sende', {
                liste: Object.entries(befehle)
                    .map(([f, w]) => `${f}=${w}`)
                    .join(', '),
            }),
        );
    }
    if (wartet.length) {
        teile.push(texte.t('sender.warte', { liste: wartet.join(', ') }));
    }
    if (abgelehnt.length) {
        teile.push(texte.t('sender.abgelehnt', { liste: abgelehnt.join(', ') }));
    }
    return { befehle, wartet, abgelehnt, grund: teile.join('; '), zustand: z };
}

/**
 * Das Modul hat einen Wert zurueckgewiesen (failed-set): nicht weiter wiederholen.
 *
 * @param {object|null} zustand  Zustand
 * @param {string[]} felder      abgelehnte Felder
 * @param {number} jetzt         Uhr
 * @returns {object} neuer Zustand
 */
function ablehnen(zustand, felder, jetzt) {
    const z = { ...neuerZustand(), ...(zustand || {}) };
    z.felder = { ...z.felder };
    for (const f of felder) {
        if (z.felder[f]) {
            z.felder[f] = { ...z.felder[f], abgelehnt: true, zeit: jetzt };
        }
    }
    return z;
}

module.exports = { GRENZEN, neuerZustand, abweichung, planen, ablehnen };
