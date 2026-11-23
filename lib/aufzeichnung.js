'use strict';

/**
 * Zusammenarbeit mit einem History-Adapter: alles mit `common.getHistory`, so wie der Admin es erkennt
 * (history, influxdb 1.x/2.x/3.x, sql mit MySQL/MariaDB, PostgreSQL, SQLite, MS-SQL; Issue #12).
 * Geprueft am Quellcode von ioBroker.history 5.5.0, ioBroker.influxdb 5.5.0 und ioBroker.sql 4.7.0.
 *
 * Drei Stellen:
 *   1. Welche Instanz: die eingestellte, wenn es sie (mit getHistory) gibt; sonst die Standard-History des
 *      Systems (`system.config` common.defaultHistory); sonst keine.
 *   2. Anmelden: Zaehler-Datenpunkte (consumption.*, efficiency.heat/cold.*) bekommen beim ersten Anlegen
 *      `common.custom[<Instanz>] = {enabled, changesOnly}`. Alles andere (Aufbewahrung, Entprellen, maxLength)
 *      bleibt bei der Vorgabe der Instanz - ein ausdrueckliches `retention: 0` hiesse bei history und sql
 *      "fuer immer" und ueberstimmte die Einstellung der Instanz; bei influxdb gibt es keine Aufbewahrung je
 *      Datenpunkt. Danach entscheidet der Nutzer: eine im Admin geaenderte oder abgeschaltete Aufzeichnung wird
 *      bei einem Neustart NICHT wieder ueberschrieben (Marke native.historyRegistered).
 *   3. Lesen (Handmessung im Reiter Effizienz): nur Datenpunkte, die diese Instanz wirklich aufzeichnet (sql
 *      antwortet sonst mit einem Fehler bzw. legt die ID in seiner Tabelle an). Gefragt wird nach dem juengsten
 *      Wert vor dem Zeitpunkt (`aggregate: 'none'`, `returnNewestEntries`, `count` und `limit`); history,
 *      influxdb und sql liefern dann aufsteigend sortiert, Randwerte werden hier selbst verworfen.
 */

/** Anmelden: nur das Noetigste - der Rest kommt aus den Vorgaben der Instanz. */
const EINSTELLUNG = { enabled: true, changesOnly: true };

/** Lesen: so alt darf der juengste Wert vor dem Zeitpunkt hoechstens sein (ms). */
const LESEN_VORHER_MS = 24 * 3600 * 1000;
/** Lesen: so weit nach dem Zeitpunkt darf ein Wert liegen (ms) - die Module melden nur bei Aenderung. */
const LESEN_NACHHER_MS = 60 * 1000;
/** Lesen: hoechstens so viele Eintraege je Datenpunkt (die juengsten). */
const LESEN_ANZAHL = 10;
/** Lesen: so lange wird auf die Antwort gewartet (ms). */
const LESEN_WARTEN_MS = 5000;

const text = v => String(v === undefined || v === null ? '' : v).trim();

/**
 * Instanz und Haken aus der Konfiguration (Schluessel bis 0.0.13: historyInstanz/historyAnmelden).
 *
 * @param {object} [cfg]  adapter.config
 * @returns {{instanz: string, anmelden: boolean}} gewaehlte Instanz (z. B. "influxdb.0"), Haken "aufzeichnen"
 */
function konfig(cfg) {
    const c = cfg || {};
    return {
        instanz: text(c.historyInstance ?? c.historyInstanz),
        anmelden: !!(c.historyRegister ?? c.historyAnmelden),
    };
}

/**
 * Welche Instanz gilt? Rein, ohne ioBroker.
 *
 * @param {string} gewaehlt  eingestellte Instanz ('' = keine)
 * @param {string[]} vorhanden  Instanzen mit common.getHistory (ohne "system.adapter.")
 * @param {string} [standard]  common.defaultHistory aus system.config
 * @returns {{instanz: string, art: 'gewaehlt'|'standard'|'keine'}} geltende Instanz
 */
function waehlen(gewaehlt, vorhanden, standard) {
    const liste = vorhanden || [];
    if (gewaehlt && liste.includes(gewaehlt)) {
        return { instanz: gewaehlt, art: 'gewaehlt' };
    }
    const s = text(standard);
    if (s && liste.includes(s)) {
        return { instanz: s, art: 'standard' };
    }
    return { instanz: '', art: 'keine' };
}

/**
 * Ermittelt die geltende Instanz am laufenden Adapter und merkt sie sich in `adapter.historyInstanz`.
 *
 * @param {object} adapter  Adapter
 * @returns {Promise<string>} Instanz ('' = keine)
 */
async function ermitteln(adapter) {
    const { instanz } = konfig(adapter.config);
    let vorhanden;
    let standard = '';
    try {
        const sicht = await adapter.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.香',
        });
        vorhanden = (sicht.rows || [])
            .filter(z => z.value && z.value.common && z.value.common.getHistory)
            .map(z => z.id.slice('system.adapter.'.length));
        const sys = await adapter.getForeignObjectAsync('system.config');
        standard = text(sys && sys.common && sys.common.defaultHistory);
    } catch (e) {
        adapter.log.debug(`History instances not readable (${e.message}) - using "${instanz}".`);
        adapter.historyInstanz = instanz;
        return instanz;
    }
    const w = waehlen(instanz, vorhanden, standard);
    if (instanz && w.art === 'standard') {
        adapter.log.info(`History instance "${instanz}" not found - using the default history "${w.instanz}" instead.`);
    } else if (instanz && w.art === 'keine') {
        adapter.log.info(
            `History instance "${instanz}" not found and no default history set - nothing is recorded or read.`,
        );
    }
    adapter.historyInstanz = w.instanz;
    return w.instanz;
}

/**
 * Geltende Instanz eines Adapters: die ermittelte, sonst die eingestellte.
 *
 * @param {object} adapter  Adapter
 * @returns {string} Instanz ('' = keine)
 */
function instanzVon(adapter) {
    return typeof adapter.historyInstanz === 'string' ? adapter.historyInstanz : konfig(adapter.config).instanz;
}

/**
 * Was beim Anlegen eines Zaehler-Datenpunkts fuer die Aufzeichnung dazukommt.
 *
 * @param {object|null|undefined} vorhanden  bestehendes Objekt (oder nichts)
 * @param {{instanz: string, anmelden: boolean}} wahl  geltende Instanz und Haken
 * @returns {{custom?: object, native?: object}} Ergaenzung fuer common.custom bzw. native (leer = nichts tun)
 */
function anmeldung(vorhanden, wahl) {
    const instanz = text(wahl && wahl.instanz);
    if (!(wahl && wahl.anmelden) || !instanz) {
        return {};
    }
    const native = (vorhanden && vorhanden.native) || {};
    if (native.historyRegistered === instanz) {
        return {}; // schon einmal angemeldet: was der Nutzer seitdem eingestellt hat, gilt
    }
    const custom = vorhanden && vorhanden.common && vorhanden.common.custom;
    if (custom && custom[instanz]) {
        // bis 1.2.0 angemeldet (ohne Marke): Einstellung unangetastet lassen, nur die Marke setzen
        return { native: { historyRegistered: instanz } };
    }
    return { custom: { [instanz]: { ...EINSTELLUNG } }, native: { historyRegistered: instanz } };
}

/**
 * Optionen fuer `getHistory`: die juengsten Rohwerte vor dem Zeitpunkt.
 *
 * - `aggregate: 'none'`: Rohwerte. Ohne Angabe waere es bei allen dreien 'average' mit erfundenen Zwischenwerten.
 * - `returnNewestEntries`: sonst liefern history, influxdb und sql bei `count` die AELTESTEN Eintraege.
 * - `count` und `limit`: aeltere Fassungen kennen nur count, neuere limit; ohne beides gilt 500 bzw. 2000.
 * - `removeBorderValues`: influxdb haengt sonst den Wert vor dem Beginn und nach dem Ende an (sql tut es
 *   trotzdem) - verworfen wird ohnehin in wertBei().
 *
 * @param {number} zeit  Zeitpunkt in ms
 * @returns {object} Optionen
 */
function anfrage(zeit) {
    return {
        start: zeit - LESEN_VORHER_MS,
        end: zeit + LESEN_NACHHER_MS,
        aggregate: 'none',
        count: LESEN_ANZAHL,
        limit: LESEN_ANZAHL,
        returnNewestEntries: true,
        removeBorderValues: true,
        ignoreNull: true,
    };
}

/**
 * Zeitstempel eines Eintrags in ms (alle drei liefern Zahlen; zur Sicherheit auch Text oder Date).
 *
 * @param {unknown} ts  Zeitstempel
 * @returns {number} ms oder NaN
 */
function zeitVon(ts) {
    if (typeof ts === 'number') {
        return ts;
    }
    if (ts instanceof Date) {
        return ts.getTime();
    }
    if (typeof ts === 'string' && ts.trim()) {
        const n = Number(ts);
        return Number.isFinite(n) ? n : Date.parse(ts);
    }
    return NaN;
}

/**
 * Der zum Zeitpunkt geltende Wert aus einer `getHistory`-Antwort: der juengste Eintrag im Fenster
 * [Zeitpunkt - 24 h, Zeitpunkt + 60 s), unabhaengig von Reihenfolge und Randwerten der Antwort. Eine Antwort mit
 * `error` (sql: "Please wait till next data record is logged", Datenbank getrennt) oder leerem `result` ergibt null.
 *
 * @param {{result?: Array<{val: unknown, ts: unknown}>}|null|undefined} antwort  Antwort des History-Adapters
 * @param {number} zeit  Zeitpunkt in ms
 * @returns {unknown} Wert oder null
 */
function wertBei(antwort, zeit) {
    const liste = ((antwort && Array.isArray(antwort.result) && antwort.result) || [])
        .map(e => (e ? { val: e.val, ts: zeitVon(e.ts) } : null))
        .filter(
            e =>
                e &&
                e.val !== null &&
                e.val !== undefined &&
                Number.isFinite(e.ts) &&
                e.ts >= zeit - LESEN_VORHER_MS &&
                e.ts < zeit + LESEN_NACHHER_MS,
        )
        .sort((a, b) => a.ts - b.ts);
    return liste.length ? liste[liste.length - 1].val : null;
}

/**
 * Zeichnet die Instanz diesen Datenpunkt auf?
 *
 * @param {object|null|undefined} obj  Objekt des Datenpunkts
 * @param {string} instanz  Instanz
 * @returns {boolean} true, wenn custom[instanz].enabled
 */
function zeichnetAuf(obj, instanz) {
    const c = obj && obj.common && obj.common.custom && obj.common.custom[instanz];
    return !!(c && c.enabled !== false && c.enabled !== 'false');
}

/**
 * Wert eines eigenen Datenpunkts zum Zeitpunkt aus dem History-Adapter.
 *
 * @param {object} adapter  Adapter (namespace, getForeignObjectAsync, sendToAsync)
 * @param {string} instanz  History-Instanz
 * @param {string} rel  ID ohne Namensraum
 * @param {number} zeit  Zeitpunkt in ms
 * @returns {Promise<unknown>} Wert oder null
 */
async function wertLesen(adapter, instanz, rel, zeit) {
    const id = `${adapter.namespace}.${rel}`;
    try {
        if (!zeichnetAuf(await adapter.getForeignObjectAsync(id), instanz)) {
            return null;
        }
        let uhr;
        const antwort = await Promise.race([
            adapter.sendToAsync(instanz, 'getHistory', { id, options: anfrage(zeit) }),
            new Promise(res => (uhr = setTimeout(() => res(null), LESEN_WARTEN_MS))),
        ]);
        clearTimeout(uhr);
        return wertBei(antwort, zeit);
    } catch {
        return null;
    }
}

module.exports = {
    EINSTELLUNG,
    LESEN_VORHER_MS,
    konfig,
    waehlen,
    ermitteln,
    instanzVon,
    anmeldung,
    anfrage,
    wertBei,
    zeitVon,
    zeichnetAuf,
    wertLesen,
};
