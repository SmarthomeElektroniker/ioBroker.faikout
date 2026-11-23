'use strict';

/*
 * Zusammenarbeit mit History-Adaptern (Issue #12): Anmelden der Zaehler bei history/influxdb/sql und Lesen per
 * getHistory fuer die Handmessung. Ohne ioBroker.
 */

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const au = require('../lib/aufzeichnung');

describe('Aufzeichnung: History-Adapter erkennen (Issue #12)', () => {
    it('die Instanzauswahl zeigt alle Adapter mit common.getHistory (history, influxdb, sql) wie der Admin', () => {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
        const suchen = o => {
            if (!o || typeof o !== 'object') {
                return null;
            }
            if (o.historyInstance) {
                return o.historyInstance;
            }
            for (const v of Object.values(o)) {
                const r = suchen(v);
                if (r) {
                    return r;
                }
            }
            return null;
        };
        const feld = suchen(cfg);
        expect(feld.type).to.equal('instance');
        expect(feld.adapter).to.equal('_dataSources');
    });
});

describe('Aufzeichnung: welche Instanz (Standard-History, mehrere Instanzen)', () => {
    const da = ['history.0', 'influxdb.0', 'influxdb.1', 'sql.0'];

    it('die gewählte gilt, wenn es sie gibt - egal welcher Adapter und welche Nummer', () => {
        expect(au.waehlen('influxdb.1', da, 'history.0')).to.deep.equal({ instanz: 'influxdb.1', art: 'gewaehlt' });
        expect(au.waehlen('sql.0', da, '')).to.deep.equal({ instanz: 'sql.0', art: 'gewaehlt' });
    });

    it('Vorgabe "history.0" ohne history-Adapter: die Standard-History des Systems', () => {
        expect(au.waehlen('history.0', ['influxdb.0'], 'influxdb.0')).to.deep.equal({ instanz: 'influxdb.0', art: 'standard' });
        expect(au.waehlen('', ['influxdb.0'], 'influxdb.0')).to.deep.equal({ instanz: 'influxdb.0', art: 'standard' });
    });

    it('nichts passt: keine Instanz (kein Anmelden bei einer Instanz, die es nicht gibt)', () => {
        expect(au.waehlen('history.0', ['influxdb.0'], '')).to.deep.equal({ instanz: '', art: 'keine' });
        expect(au.waehlen('history.0', ['influxdb.0'], 'sql.3')).to.deep.equal({ instanz: '', art: 'keine' });
    });

    it('am Adapter: liest Instanzen mit common.getHistory und system.config, merkt sich das Ergebnis', async () => {
        const log = [];
        const a = {
            config: { historyRegister: true, historyInstance: 'history.0' },
            log: { info: m => log.push(m), debug: () => {} },
            getObjectViewAsync: async () => ({
                rows: [
                    { id: 'system.adapter.influxdb.0', value: { common: { getHistory: true } } },
                    { id: 'system.adapter.mqtt.0', value: { common: {} } },
                ],
            }),
            getForeignObjectAsync: async () => ({ common: { defaultHistory: 'influxdb.0' } }),
        };
        expect(await au.ermitteln(a)).to.equal('influxdb.0');
        expect(au.instanzVon(a)).to.equal('influxdb.0');
        expect(log[0]).to.contain('History instance "history.0" not found - using the default history "influxdb.0"');
        // nicht lesbar: die eingestellte gilt
        a.getObjectViewAsync = async () => {
            throw new Error('weg');
        };
        expect(await au.ermitteln(a)).to.equal('history.0');
        // ohne Ermittlung (Tests, Werkzeuge): die eingestellte
        expect(au.instanzVon({ config: { historyInstance: 'sql.0' } })).to.equal('sql.0');
    });
});

describe('Aufzeichnung: Anmelden der Zähler', () => {
    const wahl = instanz => ({ anmelden: true, instanz });

    it('neues Objekt: bei der Instanz anmelden, egal ob history, influxdb oder sql - nur enabled und changesOnly', () => {
        for (const inst of ['history.0', 'influxdb.0', 'sql.1']) {
            const z = au.anmeldung(null, wahl(inst));
            expect(z.custom).to.deep.equal({ [inst]: { enabled: true, changesOnly: true } });
            expect(z.native).to.deep.equal({ historyRegistered: inst });
        }
        // kein retention: 0 - bei history und sql hiesse das "fuer immer" und ueberstimmte die Instanz
        expect(au.EINSTELLUNG).not.to.have.any.keys('retention', 'debounce', 'maxLength');
    });

    it('Haken aus oder keine Instanz: nichts', () => {
        expect(au.anmeldung(null, { anmelden: false, instanz: 'influxdb.0' })).to.deep.equal({});
        expect(au.anmeldung(null, wahl('  '))).to.deep.equal({});
        expect(au.anmeldung(null, undefined)).to.deep.equal({});
    });

    it('alte Schlüssel bis 0.0.13 gelten weiter', () => {
        expect(au.konfig({ historyAnmelden: true, historyInstanz: 'sql.0' })).to.deep.equal({ instanz: 'sql.0', anmelden: true });
    });

    it('schon angemeldet: Einstellungen des Nutzers (z. B. nur "yesterday" täglich) werden beim Neustart nicht überschrieben', () => {
        const abgeschaltet = { common: { custom: {} }, native: { historyRegistered: 'influxdb.0' } };
        expect(au.anmeldung(abgeschaltet, wahl('influxdb.0'))).to.deep.equal({});
        const geaendert = { common: { custom: { 'influxdb.0': { enabled: true, changesOnly: true, debounceTime: 5000 } } }, native: {} };
        // bis 1.2.0 ohne Marke angemeldet: nur die Marke nachtragen
        expect(au.anmeldung(geaendert, wahl('influxdb.0'))).to.deep.equal({ native: { historyRegistered: 'influxdb.0' } });
    });

    it('andere Instanz gewählt: dort einmal anmelden', () => {
        const alt = { common: { custom: { 'history.0': { enabled: true } } }, native: { historyRegistered: 'history.0' } };
        expect(au.anmeldung(alt, wahl('influxdb.0')).custom).to.have.key('influxdb.0');
    });
});

/*
 * Nachbildung der getHistory-Antworten fuer die Optionen aus au.anfrage() - nach dem Quellcode von
 * ioBroker.history 5.5.0 (src/main.ts getHistory), ioBroker.influxdb 5.5.0 (getHistoryV1/V2 + sendResponse aus
 * @iobroker/aggregate) und ioBroker.sql 4.7.0 (getHistorySql, lib/postgresql.ts usw.).
 */
const NACHBILD = {
    // history: Rohwerte aufsteigend; mit returnNewestEntries die juengsten `count`; keine Randwerte bei 'none'
    history: (daten, o) => {
        const drin = daten.filter(e => e.ts >= o.start && e.ts <= o.end).sort((x, y) => x.ts - y.ts);
        return { result: o.returnNewestEntries ? drin.slice(-o.count) : drin.slice(0, o.count), step: null, error: null };
    },
    // influxdb 1.x: InfluxQL "time > start AND time < end ORDER BY time DESC LIMIT count" (returnNewestEntries),
    // Randwerte vor dem Beginn/nach dem Ende ohne removeBorderValues; Zeit als ISO-Text -> ms, dann sortiert
    influxdb1: (daten, o) => {
        const drin = daten.filter(e => e.ts > o.start && e.ts < o.end).sort((x, y) => y.ts - x.ts);
        let rows = o.returnNewestEntries ? drin.slice(0, o.count) : drin.reverse().slice(0, o.count);
        if (!o.removeBorderValues) {
            const vor = daten.filter(e => e.ts <= o.start).sort((x, y) => y.ts - x.ts)[0];
            rows = vor ? [vor, ...rows] : rows;
        }
        if (!rows.length) {
            return { result: [], step: null }; // sendResponse: "No Data"
        }
        return { result: rows.map(e => ({ ts: new Date(new Date(e.ts).toISOString()).getTime(), val: e.val })).sort((x, y) => x.ts - y.ts), step: 0 };
    },
    // influxdb 2.x (Flux): range(start, stop) |> sort(desc: true) |> limit(n: count), Ergebnis aufsteigend
    influxdb2: (daten, o) => {
        const drin = daten.filter(e => e.ts >= o.start && e.ts < o.end).sort((x, y) => y.ts - x.ts).slice(0, o.count);
        return drin.length ? { result: drin.sort((x, y) => x.ts - y.ts), step: 0 } : { result: [], step: null };
    },
    // sql: "ts >= start AND ts < end UNION ALL (letzter vor start) UNION ALL (erster nach end) ORDER BY ts DESC
    // LIMIT count+2" - die Randzeilen kommen immer mit; ts als Zahl (parseInt), Werte bei MySQL ggf. als Zahl 0/1
    sql: (daten, o) => {
        const drin = daten.filter(e => e.ts >= o.start && e.ts < o.end);
        const vor = daten.filter(e => e.ts < o.start).sort((x, y) => y.ts - x.ts)[0];
        const nach = daten.filter(e => e.ts >= o.end).sort((x, y) => x.ts - y.ts)[0];
        const rows = [...drin, ...(vor ? [vor] : []), ...(nach ? [nach] : [])].sort((x, y) => y.ts - x.ts).slice(0, o.count + 2);
        return { result: rows.map(e => ({ ts: parseInt(String(e.ts), 10), val: e.val })).sort((x, y) => x.ts - y.ts), step: null, error: null };
    },
};

describe('Aufzeichnung: Lesen per getHistory (Handmessung) - history, influxdb 1.x/2.x, sql', () => {
    const zeit = Date.UTC(2026, 10, 23, 6, 0);
    const min = 60000;

    it('Anfrage: Rohwerte, count und limit, die juengsten Einträge, ohne Randwerte, 24 h zurück', () => {
        const o = au.anfrage(zeit);
        expect(o).to.deep.include({ aggregate: 'none', count: 10, limit: 10, returnNewestEntries: true, removeBorderValues: true, ignoreNull: true });
        expect(o.start).to.equal(zeit - 24 * 3600000);
        expect(o.end).to.equal(zeit + min);
    });

    for (const [name, quelle] of Object.entries(NACHBILD)) {
        it(`${name}: der jüngste Wert vor dem Zeitpunkt, auch wenn er Stunden alt ist (Wert ändert sich selten)`, () => {
            const daten = [
                { ts: zeit - 30 * 3600000, val: 'uralt' }, // vor dem Fenster (Randwert bei influxdb 1.x/sql)
                { ts: zeit - 5 * 3600000, val: 'cool' },
                { ts: zeit - 3 * 3600000, val: 'heat' },
                { ts: zeit + 10 * min, val: 'spaeter' }, // nach dem Fenster (Randwert bei sql)
            ];
            for (let i = 0; i < 40; i++) {
                daten.push({ ts: zeit - 23 * 3600000 + i * 1000, val: 'frueh' }); // mehr als count alte Eintraege
            }
            expect(au.wertBei(quelle(daten, au.anfrage(zeit)), zeit)).to.equal('heat');
        });

        it(`${name}: leerer Zeitraum ergibt null, ein Wert kurz nach dem Zeitpunkt zählt noch`, () => {
            expect(au.wertBei(quelle([{ ts: zeit - 30 * 3600000, val: 1 }], au.anfrage(zeit)), zeit)).to.equal(null);
            expect(au.wertBei(quelle([], au.anfrage(zeit)), zeit)).to.equal(null);
            expect(au.wertBei(quelle([{ ts: zeit - min, val: 1 }, { ts: zeit + 30000, val: 2 }], au.anfrage(zeit)), zeit)).to.equal(2);
        });
    }

    it('Fehlerantworten (sql ohne ersten Eintrag, Datenbank getrennt) und Unsinn ergeben null', () => {
        expect(au.wertBei({ result: [], step: 0, error: 'Please wait till next data record is logged and reload.' }, zeit)).to.equal(null);
        expect(au.wertBei({ result: [], step: 0, error: 'Database no longer connected' }, zeit)).to.equal(null);
        expect(au.wertBei(null, zeit)).to.equal(null);
        expect(au.wertBei({ result: [null, { ts: 'kaputt', val: 1 }, { ts: zeit - min, val: null }] }, zeit)).to.equal(null);
        expect(au.wertBei({ result: [{ ts: new Date(zeit - min).toISOString(), val: 7 }] }, zeit)).to.equal(7);
        expect(au.wertBei({ result: [{ ts: new Date(zeit - min), val: 8 }] }, zeit)).to.equal(8);
    });

    it('wertLesen: fragt nur, was die Instanz aufzeichnet; wartet höchstens 5 s', async () => {
        const gefragt = [];
        const a = {
            namespace: 'faikout.0',
            getForeignObjectAsync: async id =>
                id.endsWith('status.comp')
                    ? { common: { custom: { 'sql.0': { enabled: true } } } }
                    : id.endsWith('status.liquid')
                      ? { common: { custom: { 'sql.0': { enabled: false }, 'history.0': { enabled: true } } } }
                      : { common: {} },
            sendToAsync: async (inst, befehl, msg) => {
                gefragt.push([inst, befehl, msg.id]);
                return NACHBILD.sql([{ ts: zeit - 2 * min, val: 42 }], msg.options);
            },
        };
        expect(await au.wertLesen(a, 'sql.0', 'Truhe.status.comp', zeit)).to.equal(42);
        expect(await au.wertLesen(a, 'sql.0', 'Truhe.status.liquid', zeit)).to.equal(null);
        expect(await au.wertLesen(a, 'sql.0', 'Truhe.status.outside', zeit)).to.equal(null);
        expect(gefragt).to.deep.equal([['sql.0', 'getHistory', 'faikout.0.Truhe.status.comp']]);
        a.sendToAsync = async () => {
            throw new Error('timeout');
        };
        expect(await au.wertLesen(a, 'sql.0', 'Truhe.status.comp', zeit)).to.equal(null);
    });
});
