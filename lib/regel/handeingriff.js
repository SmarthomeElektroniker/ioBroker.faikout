'use strict';

/**
 * Handeingriff: erkennt, dass jemand die Anlage an der Fernbedienung, in einer App oder ueber die
 * Datenpunkte selbst verstellt hat, und sperrt dann die Automatik. Rein, die Uhr kommt herein.
 *
 * Erkennung: Ein gemeldeter Wert (power, mode, target, fan) hat sich gegenueber der letzten Meldung
 * geaendert UND entspricht nicht dem, was der Adapter zuletzt selbst befohlen hat. Eigene Befehle
 * gelten `eigenMs` lang als Erklaerung fuer eine Aenderung auf genau diesen Wert. Folgeaenderungen
 * der Firmware (Betriebsart setzt power) sind ueber `abhaengig` abgedeckt.
 *
 * Sperre (Nutzerentscheid 20.11.2026): bis zum naechsten Schaltpunkt des Wochenplans, laengstens
 * `stunden` (Vorgabe und Obergrenze 4 h). Alternativen: feste Dauer oder gar keine Sperre.
 */

const FELDER = ['power', 'mode', 'target', 'fan'];
const VORGABEN = { modus: 'schaltpunkt', stunden: 4, eigenMs: 120000 };
const STUNDEN_MAX = 24;
/**
 * Uebergabezeit nach dem Umstellen von "Faikout-Modul regelt selbst" auf "ioBroker-Adapter regelt": Das
 * Modul fuehrt die Anlage nach der letzten control-Nachricht noch bis zu tcontrol (600 s) selbst weiter.
 * Was es in dieser Zeit verstellt, ist kein Handeingriff. 10 min Nachlauf + 1 min fuer die Meldung.
 */
const MODUL_NACHLAUF_MS = 11 * 60000;

/**
 * @param {object} [roh]  {modus, stunden}
 * @returns {object} gepruefte Einstellung
 */
function konfigPruefen(roh = {}) {
    const modus = ['schaltpunkt', 'dauer', 'nie'].includes(roh.modus) ? roh.modus : VORGABEN.modus;
    const s = Number(roh.stunden);
    const stunden = Number.isFinite(s) && s > 0 ? Math.min(STUNDEN_MAX, s) : VORGABEN.stunden;
    return { modus, stunden, eigenMs: VORGABEN.eigenMs };
}

/** Leerer Zustand. */
function neuerZustand() {
    return { bekannt: {}, befohlen: {}, bis: 0, seit: 0, felder: [] };
}

const gleich = (a, b) =>
    typeof a === 'number' || typeof b === 'number' ? Math.abs(Number(a) - Number(b)) < 0.05 : a === b;

/**
 * Vermerkt einen eigenen Befehl.
 *
 * @param {object} z      Zustand
 * @param {object} felder gesendete Felder {power?, mode?, target?, fan?}
 * @param {number} jetzt  Uhr
 * @returns {object} neuer Zustand
 */
function befehlMerken(z, felder, jetzt) {
    const befohlen = { ...(z.befohlen || {}) };
    for (const [f, wert] of Object.entries(felder)) {
        befohlen[f] = { wert, zeit: jetzt };
    }
    // Firmware: command/<Name>/mode setzt power im selben Befehl (aus = off, sonst an).
    if (felder.mode !== undefined && felder.power === undefined) {
        befohlen.power = { wert: felder.mode !== 'off', zeit: jetzt };
    }
    return { ...z, befohlen };
}

/**
 * Wertet eine Statusmeldung aus.
 *
 * @param {object} gemeldet  {power, mode, target, fan} - nur vorhandene Felder
 * @param {object|null} z    bisheriger Zustand
 * @param {object} k         Einstellung (konfigPruefen)
 * @param {number} jetzt     Uhr (ms)
 * @param {object} [opt]     {naechsterSchaltpunkt: number|null, ignoriere: string[], ersteMeldung: boolean, erwartet: object|null}
 * @returns {{zustand: object, neu: string[], gesperrt: boolean}} Zustand, neu von Hand geaenderte Felder
 */
function auswerten(gemeldet, z, k, jetzt, opt = {}) {
    const zustand = { ...neuerZustand(), ...(z || {}) };
    zustand.bekannt = { ...zustand.bekannt };
    const ignoriere = opt.ignoriere || [];
    const neu = [];
    for (const f of FELDER) {
        const wert = gemeldet[f];
        if (wert === undefined || wert === null) {
            continue;
        }
        const alt = zustand.bekannt[f];
        zustand.bekannt[f] = wert;
        if (ignoriere.includes(f)) {
            continue;
        }
        let geaendert = alt !== undefined && !gleich(alt, wert);
        // Erste Meldung nach dem Start: Abweichung vom Erwarteten (Szene) zaehlt wie eine Aenderung,
        // damit ein Neustart nichts ueberschreibt, was inzwischen von Hand eingestellt wurde.
        if (alt === undefined && opt.ersteMeldung && opt.erwartet && opt.erwartet[f] !== undefined) {
            geaendert = !gleich(opt.erwartet[f], wert);
        }
        if (!geaendert) {
            continue;
        }
        const b = zustand.befohlen[f];
        const eigen = b && gleich(b.wert, wert) && jetzt - b.zeit <= k.eigenMs;
        if (!eigen) {
            neu.push(f);
        }
    }
    if (neu.length && k.modus !== 'nie') {
        const grenze = jetzt + k.stunden * 3600000;
        const punkt = opt.naechsterSchaltpunkt;
        zustand.bis =
            k.modus === 'schaltpunkt' && Number.isFinite(punkt) && punkt > jetzt ? Math.min(punkt, grenze) : grenze;
        zustand.seit = jetzt;
        zustand.felder = [...new Set([...(jetzt < (z && z.bis) ? zustand.felder : []), ...neu])];
    }
    return { zustand, neu, gesperrt: jetzt < zustand.bis };
}

/**
 * Hebt die Sperre auf (Knopf "Plan fortsetzen").
 *
 * @param {object} z  Zustand
 * @returns {object} Zustand ohne Sperre
 */
function aufheben(z) {
    return { ...neuerZustand(), ...(z || {}), bis: 0, seit: 0, felder: [] };
}

module.exports = {
    FELDER,
    VORGABEN,
    STUNDEN_MAX,
    MODUL_NACHLAUF_MS,
    konfigPruefen,
    neuerZustand,
    befehlMerken,
    auswerten,
    aufheben,
};
