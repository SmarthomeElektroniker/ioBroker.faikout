'use strict';

/*
 * Vergleichsrahmen: laesst EINEN Adapter gegen eine simulierte Welt (sim/) laufen - mit simulierter
 * Uhr, im Speicher, ohne Netz. Derselbe Rahmen fuer beide Adapter, dasselbe Szenario, derselbe Seed:
 * identische Physik, identische Ereignisse.
 *
 *   node vergleich/lauf.js --art eigen --main <pfad/main.js> --iopack <pfad/io-package.json> \
 *        --variante adapter|faikout --szenario heizenKalterTag --aus ergebnis.json [--log datei]
 *   node vergleich/lauf.js --art fremd --main <pfad/build/src/main.js> --iopack <...> --szenario ...
 *
 * Fremder Adaptercode wird nur geladen, wenn --art fremd gewaehlt ist; das geschieht ausschliesslich
 * im Testcontainer.
 */

process.env.TZ = 'Europe/Berlin';

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Uhr, echt } = require('./uhr');
const kern = require('./adapterkern');
const { Welt } = require('../simwelt/welt');
const { ModulHttp } = require('../simwelt/http');
const { auswerten } = require('../simwelt/messung');
const { szenario: szenarioHolen } = require('../simwelt/szenarien');
const wochenplan = require('../../lib/regel/wochenplan');

const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};

const topicPasst = (muster, topic) => {
    const m = muster.split('/');
    const t = topic.split('/');
    for (let i = 0; i < m.length; i++) {
        if (m[i] === '#') {
            return true;
        }
        if (m[i] !== '+' && m[i] !== t[i]) {
            return false;
        }
    }
    return m.length === t.length;
};

/** Verbindet Module und Adapter im Speicher; merkt retained-Nachrichten. */
class Bus {
    constructor() {
        this.retained = new Map();
        this.hoerer = new Set();
        this.welt = null;
        this.befehle = [];
    }
    vonModul(topic, payload, retain) {
        const text = typeof payload === 'string' ? payload : String(payload ?? '');
        if (retain) {
            if (text === '') {
                this.retained.delete(topic);
            } else {
                this.retained.set(topic, text);
            }
        }
        for (const h of this.hoerer) {
            h(topic, text);
        }
    }
    vonAdapter(topic, payload) {
        const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
        this.befehle.push({ zeit: Date.now(), topic, payload: text });
        this.welt.empfangen(topic, text);
    }
}

/**
 * Ersatz fuer lib/broker.js unseres Adapters.
 *
 * @param {Bus} bus Bus
 * @returns {Function} Klasse
 */
function brokerErsatz(bus) {
    return class FaikoutBroker {
        constructor(opts) {
            this.opts = opts;
            this.h = null;
        }
        async start() {
            this.h = (topic, text) => this.opts.onMessage(topic, Buffer.from(text));
            bus.hoerer.add(this.h);
            for (const m of bus.welt.module) {
                this.opts.onClient(m.clientId ? m.clientId() : m.name, true);
            }
            for (const [topic, text] of bus.retained) {
                this.h(topic, text);
            }
        }
        publish(topic, payload) {
            bus.vonAdapter(topic, payload);
            return Promise.resolve(true);
        }
        async stop() {
            bus.hoerer.delete(this.h);
        }
    };
}

/**
 * Ersatz fuer das Paket mqtt (Client des Fremdadapters).
 *
 * @param {Bus} bus Bus
 * @returns {object} Modul mit connect()
 */
function mqttErsatz(bus) {
    return {
        connect() {
            const c = new EventEmitter();
            const abos = [];
            c.connected = false;
            const h = (topic, text) => {
                if (abos.some(a => topicPasst(a, topic))) {
                    c.emit('message', topic, Buffer.from(text), { retain: false });
                }
            };
            c.subscribe = (topic, opt, cb) => {
                for (const t of Array.isArray(topic) ? topic : [topic]) {
                    abos.push(t);
                    for (const [rt, text] of bus.retained) {
                        if (topicPasst(t, rt)) {
                            queueMicrotask(() => c.emit('message', rt, Buffer.from(text), { retain: true }));
                        }
                    }
                }
                const fn = typeof opt === 'function' ? opt : cb;
                if (fn) {
                    fn(null, []);
                }
                return c;
            };
            c.unsubscribe = () => c;
            c.publish = (topic, payload, opt, cb) => {
                bus.vonAdapter(topic, payload);
                const fn = typeof opt === 'function' ? opt : cb;
                if (fn) {
                    fn(null);
                }
                return c;
            };
            c.end = (force, opt, cb) => {
                bus.hoerer.delete(h);
                c.connected = false;
                const fn = [force, opt, cb].find(x => typeof x === 'function');
                if (fn) {
                    fn();
                }
                return c;
            };
            c.removeOutgoingMessage = () => {};
            c.reconnect = () => c;
            bus.hoerer.add(h);
            queueMicrotask(() => {
                c.connected = true;
                c.emit('connect', {});
            });
            return c;
        },
    };
}

/**
 * Ersatz fuer node:http in der Geraeteerkennung des Fremdadapters: Seiten kommen aus sim/http.js.
 *
 * @param {ModulHttp} seiten Seiten der Module
 * @returns {object} Modul mit get()
 */
function httpErsatz(seiten) {
    return {
        get(url, cb) {
            const u = new URL(url);
            const req = new EventEmitter();
            req.setTimeout = () => req;
            req.destroy = () => {};
            echt.setImmediate(() => {
                const r = seiten.antwort({
                    method: 'GET',
                    url: u.pathname + u.search,
                    host: u.host,
                    port: Number(u.port) || 80,
                });
                const res = new EventEmitter();
                res.statusCode = r.status;
                res.headers = {};
                res.setEncoding = () => {};
                cb(res);
                echt.setImmediate(() => {
                    res.emit('data', Buffer.from(r.text));
                    res.emit('end');
                });
            });
            return req;
        },
    };
}

/**
 * Ein Lauf.
 *
 * @param {object} o {art, main, iopack, variante, szenario, seed, minuten, logDatei, plan}
 * @returns {Promise<object>} Ergebnis
 */
async function lauf(o) {
    const sz = szenarioHolen(o.szenario);
    const startMs = Date.parse(sz.start);
    const uhr = new Uhr(startMs);
    uhr.einbauen();
    const bus = new Bus();
    const zeilen = [];
    const fuehlerStand = new Map(); // wahre Raumwerte als "externer Fuehler" (Datenpunkte sim.0.<modul>.*)
    const extern = o.fuehler === 'extern' || o.fuehler === 'traege';
    const traege = o.fuehler === 'traege'; // Fuehler in einem anderen Raum: Tiefpass 30 min + Totzeit 5 min
    const traegeStand = new Map();
    const mitPlan = !!o.plan;
    const mitFeuchte = !!o.feuchte;
    const marken = [];
    const faikoutAuto = o.art === 'fremd' || o.variante === 'faikout';
    const startZiel = (sz.anlage && sz.anlage.temp) || 21;
    const einstellungen = faikoutAuto ? { autoe: true, autor: 0.5, autot: startZiel } : {};
    const welt = new Welt({
        name: o.art === 'fremd' ? 'fremd' : `eigen-${o.variante}`,
        szenario: o.szenario,
        seed: o.seed || 1,
        module: [
            { typ: 's21', einstellungen },
            { typ: 'nodemand', einstellungen },
            { typ: 'tcl', einstellungen: {} },
        ],
        senden: (modul, topic, payload, opt) => bus.vonModul(topic, payload, !!(opt && opt.retain)),
        uhr: () => Date.now(),
        messung: z => {
            zeilen.push(z);
let raumWert = z.raum;
            if (traege) {
                const s = traegeStand.get(z.modul) || { tp: z.raum, verlauf: [] };
                s.tp += (1 - Math.exp(-1 / 30)) * (z.raum - s.tp); // je simulierter Minute
                s.verlauf.push(s.tp);
                raumWert = s.verlauf.length > 5 ? s.verlauf[s.verlauf.length - 6] : s.verlauf[0];
                s.verlauf = s.verlauf.slice(-10);
                traegeStand.set(z.modul, s);
            }
            fuehlerStand.set(z.modul, {
                raum: Math.round(raumWert * 10) / 10,
                feuchte: Math.round(z.feuchte),
                aussen: Math.round(z.aussen * 10) / 10,
            });
        },
        beiMarke: m => marken.push({ ...m, zeit: Date.now() }),
    });
    bus.welt = welt;
    const namen = welt.module.map(m => m.name);
    const seiten = new ModulHttp();
    for (const m of welt.module) {
        seiten.anmelden(m, {});
    }

    const iopack = JSON.parse(fs.readFileSync(o.iopack, 'utf8'));
    const bestand = new kern.Bestand();
    const eigen = o.art === 'eigen';
    const config = { ...iopack.native };
    const { szenen } = wochenplan.szenenLesen(null);
    const plan = wochenplan.vorgabePlan(szenen);
    if (eigen) {
        Object.assign(config, {
            regelProbelauf: false,
            regelAktiv: true,
            regelGeraete: namen.map(n => ({
                geraet: n,
                betrieb: o.variante === 'faikout' && !n.includes('tcl') ? 'faikout' : 'adapter',
                ...(extern
                    ? {
                          raumQuelle: 'dp',
                          raumDp: `sim.0.${n}.raum`,
                          feuchteQuelle: 'dp',
                          feuchteDp: `sim.0.${n}.feuchte`,
                          raumTraegeMin: Number(o.mischen) || 0,
                      }
                    : {}),
            })),
            historyRegister: false,
        });
    } else {
        Object.assign(config, {
            devices: namen.map(n => ({ name: n, ip: n, enabled: true, useDemand: true, useHumidity: mitFeuchte })),
            demandEnabled: true,
        });
        for (const n of namen) {
            const ordner = n.replace(/[^a-zA-Z0-9_-]/g, '_');
            // Raumfuehler der Bedarfsregelung: mit externem Fuehler der gelieferte env-Wert (Vorgabe des
            // Adapters), sonst der Fuehler der Anlage.
            config[n] = extern ? {} : { demandRoomTempId: `faikout-ac.0.${ordner}.home` };
        }
        if (extern) {
            config.envSensors = namen.map(n => ({ deviceName: n, sensorStateId: `sim.0.${n}.raum`, intervalSec: 30 }));
        }
        if (mitFeuchte) {
            config.humCfg = Object.fromEntries(
                namen.map(n => [
                    n,
                    extern ? { humTempStateId: `sim.0.${n}.raum`, humHumStateId: `sim.0.${n}.feuchte` } : {},
                ]),
            );
        }
        if (mitPlan) {
            // derselbe Wochenplan als Schaltzeiten: je Wechsel Ziel und Luefter der Szene
            const eintraege = [];
            plan.forEach((tag, d) => {
                for (const punkt of tag) {
                    const s = szenen.get(punkt.s);
                    for (const n of namen) {
                        eintraege.push({
                            enabled: true,
                            deviceName: n,
                            days: [d],
                            time: `${String(Math.floor(punkt.t / 60)).padStart(2, '0')}:${String(punkt.t % 60).padStart(2, '0')}`,
                            actions: [
                                { field: 'autot', value: s.soll },
                                { field: 'fan', value: s.fan === 'night' ? 'Q' : 'A' },
                            ],
                        });
                    }
                }
            });
            config.schedule = eintraege;
        }
    }
    const optionen = {
        name: iopack.common.name,
        config,
        logZeilen: !!o.logDatei,
        logDebug: false,
        version: iopack.common.version,
    };

    const urspr = Module._load;
    const brokerKlasse = brokerErsatz(bus);
    const mqtt = mqttErsatz(bus);
    const http = httpErsatz(seiten);
    Module._load = function (request, parent, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return kern;
        }
        const von = (parent && parent.filename) || '';
        if (eigen && /(^|\/)lib\/broker(\.js)?$/.test(request) && von.endsWith('main.js')) {
            return { FaikoutBroker: brokerKlasse };
        }
        if (!eigen && request === 'mqtt') {
            return mqtt;
        }
        if (!eigen && (request === 'node:http' || request === 'http') && von.includes('deviceDiscovery')) {
            return http;
        }
        return urspr.call(this, request, parent, ...rest);
    };
    const fabrik = require(path.resolve(o.main));
    let adapter = null;
    const starten = async () => {
        kern.vorbereiten(bestand, optionen);
        adapter = fabrik({ name: optionen.name });
        adapter.antworten = () => {};
        await adapter.starten();
        await uhr.ruhe(20);
    };
    const neustart = async () => {
        await adapter.stoppen();
        await uhr.ruhe(10);
        await starten();
    };
    const setze = async (id, val) => {
        await adapter.setForeignStateAsync(id, { val, ack: false });
        await uhr.ruhe(6);
    };
    let fremdQuelle = null; // schreibt die "externen Fuehler" (zaehlt nicht mit)
    const schritt = async sek => {
        for (let i = 0; i < sek; i++) {
            welt.vor(1000);
            await uhr.vor(1000);
            if (extern && Math.round(uhr.t / 1000) % 60 === 0) {
                const vorher = { ...bestand.zaehler };
                if (!fremdQuelle) {
                    kern.vorbereiten(bestand, optionen);
                    fremdQuelle = new kern.Adapter({ name: 'sim' });
                }
                for (const [n, w] of fuehlerStand) {
                    for (const [f, v] of Object.entries(w)) {
                        await fremdQuelle.setForeignStateAsync(`sim.0.${n}.${f}`, { val: v, ack: true });
                    }
                }
                Object.assign(bestand.zaehler, vorher);
            }
        }
    };

    // ---- Einrichtung (zaehlt als Schritte bis zum Laufen)
    const einrichtung = [];
    await starten();
    welt.verbinden();
    await schritt(90);
    if (eigen) {
        einrichtung.push('Module melden sich am Broker des Adapters: Geräte und Datenpunkte entstehen von selbst');
        einrichtung.push('Regelung in den Instanzeinstellungen einschalten, Probelauf abschalten');
        for (const id of [...bestand.objekte.keys()].filter(k => k.endsWith('.regulation.demand.dryRun'))) {
            await setze(id, false);
        }
    } else {
        einrichtung.push('externen MQTT-Broker bereitstellen und in jedem Modul eintragen');
        einrichtung.push('Geräte mit Name und IP in die Tabelle eintragen, speichern');
        for (const n of namen) {
            await new Promise(fertig => {
                adapter.antworten = (cb, nachricht) => {
                    einrichtung.push(`Erkennung ${n}: ${JSON.stringify(nachricht).slice(0, 120)}`);
                    fertig();
                };
                adapter.emit('message', {
                    command: 'discovery',
                    message: { name: n },
                    from: 'system.adapter.admin.0',
                    callback: { id: 1 },
                });
                echt.setTimeout(fertig, 3000);
            });
            await uhr.ruhe(20);
        }
        einrichtung.push('Bedarfsregelung je Gerät ankreuzen, Fühler wählen, speichern (Neustart)');
        await neustart();
    }
    await schritt(30);
    const vorlauf = {
        befehle: bus.befehle.length,
        setState: bestand.zaehler.setState,
        flash: welt.module.map(m => m.zaehler.flash),
    };

    // ---- Wochenplan (nur in den Plan-Szenarien)
    if (eigen && mitPlan) {
        for (const id of [...bestand.objekte.keys()].filter(k => k.endsWith('.regulation.schedule.weekJson'))) {
            await setze(id, JSON.stringify(plan));
            await setze(id.replace('wocheJson', 'aktiv'), true);
        }
    }
    if (eigen && mitFeuchte) {
        for (const id of [...bestand.objekte.keys()].filter(k => k.endsWith('.regulation.humidity.active'))) {
            await setze(id, true);
        }
    }

    // ---- Lauf
    const dauerMin = Number(o.minuten) || sz.dauerMin;
    const cpu0 = process.cpuUsage();
    const echt0 = echt.Date.now();
    let soll = welt.soll;
    let markenGesehen = 0;
    let fehlerAbbruch = null;
    try {
        for (let min = 0; min < dauerMin; min++) {
            await schritt(60);
            if (welt.soll !== soll && welt.soll !== null) {
                soll = welt.soll;
                // Der Bewohner stellt die Wunschtemperatur am Adapter um - ausser er hat es im selben
                // Augenblick an der Fernbedienung getan (Szenario "handeingriff").
                const perHand = (sz.ereignisse || []).some(e => e.art === 'handeingriff' && e.nachMin === min + 1);
                for (const n of perHand ? [] : namen) {
                    const id = n.replace(/[^a-zA-Z0-9_-]/g, '_');
                    if (eigen) {
                        const ziel = `${optionen.name}.0.${adapter.geraetId ? adapter.geraetId(n) : id}.control.target`;
                        if (bestand.objekte.has(ziel)) {
                            await setze(ziel, soll);
                        }
                    } else if (bestand.objekte.has(`${optionen.name}.0.${id}.autot`)) {
                        await setze(`${optionen.name}.0.${id}.autot`, soll);
                    }
                }
            }
            while (markenGesehen < marken.length) {
                const m = marken[markenGesehen++];
                if (/neustart/i.test(m.name)) {
                    await neustart();
                }
            }
        }
    } catch (e) {
        fehlerAbbruch = String(e && e.stack ? e.stack : e);
    }
    const cpu = process.cpuUsage(cpu0);
    const kennzahlen = auswerten(zeilen);
    const nachTopic = {};
    for (const b of bus.befehle.slice(vorlauf.befehle)) {
        const teile = b.topic.split('/');
        const k = `${teile[0]}/${teile.slice(2).join('/') || '(json)'}`;
        nachTopic[k] = (nachTopic[k] || 0) + 1;
    }
    const stunden = dauerMin / 60;
    const ergebnis = {
        art: o.art,
        variante: eigen ? o.variante : 'faikout-auto + demand',
        fuehler: o.fuehler || 'intern',
        plan: mitPlan,
        feuchte: mitFeuchte,
        adapter: `${iopack.common.name} ${iopack.common.version}`,
        szenario: o.szenario,
        dauerMin,
        einrichtung,
        module: kennzahlen.module,
        mqtt: {
            befehleGesamt: bus.befehle.length - vorlauf.befehle,
            befehleJeStunde: Math.round(((bus.befehle.length - vorlauf.befehle) / stunden) * 10) / 10,
            nachTopic,
            einrichtungBefehle: vorlauf.befehle,
        },
        flash: Object.fromEntries(
            welt.module.map((m, i) => [
                m.name,
                { einrichtung: vorlauf.flash[i], betrieb: m.zaehler.flash - vorlauf.flash[i] },
            ]),
        ),
        failedSet: Object.fromEntries(welt.module.map(m => [m.name, m.zaehler.failedSet])),
        neustarts: Object.fromEntries(welt.module.map(m => [m.name, m.zaehler.neustarts])),
        datenbank: {
            setStateBetrieb: bestand.zaehler.setState - vorlauf.setState,
            setStateJeStunde: Math.round((bestand.zaehler.setState - vorlauf.setState) / stunden),
            setObject: bestand.zaehler.setObject,
            objekte: bestand.objekte.size,
            haeufigste: [...bestand.jeId.entries()].sort((x, y) => y[1] - x[1]).slice(0, 25),
        },
        log: { ...bestand.log, meldungen: [...bestand.meldungen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) },
        rechenzeit: {
            cpuMs: Math.round((cpu.user + cpu.system) / 1000),
            echtMs: echt.Date.now() - echt0,
            heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        },
        marken,
        fehlerAbbruch,
    };
    if (o.zustaende) {
        ergebnis.zustaende = Object.fromEntries(
            [...bestand.werte.entries()]
                .filter(([id]) => o.zustaende.some(t => id.includes(t)))
                .map(([id, s]) => [id, s.val]),
        );
    }
    try {
        await adapter.stoppen();
    } catch (e) {
        ergebnis.fehlerBeimBeenden = String(e);
    }
    uhr.ausbauen();
    Module._load = urspr;
    if (o.logDatei) {
        fs.writeFileSync(o.logDatei, bestand.zeilen.join('\n'));
    }
    if (o.messDatei) {
        fs.writeFileSync(o.messDatei, zeilen.map(z => JSON.stringify(z)).join('\n'));
    }
    return ergebnis;
}

if (require.main === module) {
    const o = {
        art: arg('art') || 'eigen',
        main: arg('main') || path.join(__dirname, '..', '..', 'main.js'),
        iopack: arg('iopack') || path.join(__dirname, '..', '..', 'io-package.json'),
        variante: arg('variante') || 'adapter',
        szenario: arg('szenario') || 'heizenKalterTag',
        seed: Number(arg('seed')) || 1,
        minuten: arg('minuten'),
        logDatei: arg('log'),
        messDatei: arg('mess'),
        zustaende: arg('zustaende') ? arg('zustaende').split(',') : null,
        plan: arg('plan') === 'ja',
        feuchte: arg('feuchte') === 'ja',
        fuehler: arg('fuehler') || 'intern',
        mischen: arg('mischen'),
    };
    lauf(o)
        .then(e => {
            const text = JSON.stringify(e, null, 1);
            if (arg('aus')) {
                fs.writeFileSync(arg('aus'), text);
                console.log(
                    `${e.adapter} / ${e.variante} / ${e.szenario}: ${arg('aus')}${e.fehlerAbbruch ? ' ABBRUCH' : ''}`,
                );
            } else {
                console.log(text);
            }
            process.exit(0);
        })
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}

module.exports = { lauf };
