'use strict';

/*
 * Ersatz fuer @iobroker/adapter-core im Vergleichsrahmen: Objekte und Zustaende im Speicher,
 * Abos mit stateChange, Zaehler fuer jeden Schreibvorgang. Beide Adapter laufen darauf unter
 * denselben Bedingungen. Nicht nachgebildete Methoden melden sich einmal auf der Konsole.
 */

const { EventEmitter } = require('node:events');

/** Gemeinsamer Datenbestand - ueberlebt einen "Neustart" des Adapters. */
class Bestand {
    constructor() {
        this.objekte = new Map();
        this.werte = new Map();
        this.zaehler = { setState: 0, setStateAck: 0, setStateBefehl: 0, setObject: 0, getState: 0 };
        this.log = { debug: 0, info: 0, warn: 0, error: 0 };
        this.meldungen = new Map(); // warn/error-Texte (auf Muster gekuerzt) -> Anzahl
        this.zeilen = [];
        this.adapter = new Set();
        this.jeId = new Map();
    }
}

const muster = text =>
    String(text)
        .replace(/-?\d+([.,]\d+)?/g, '#')
        .slice(0, 160);

const passt = (pattern, id) => {
    if (pattern === '*') {
        return true;
    }
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(id);
};

let bestandAktuell = null;
let optionenAktuell = {};

/** Nachbildung der Adapter-Basisklasse. */
class Adapter extends EventEmitter {
    constructor(options = {}) {
        super();
        const o = typeof options === 'string' ? { name: options } : options;
        this.name = o.name || optionenAktuell.name;
        this.instance = 0;
        this.namespace = `${this.name}.0`;
        this.config = JSON.parse(JSON.stringify(optionenAktuell.config || {}));
        this.host = 'vergleich';
        this.adapterDir = optionenAktuell.adapterDir || '';
        this.version = optionenAktuell.version || '0.0.0';
        this.FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
        this.bestand = bestandAktuell;
        if (this.name !== 'sim') {
            this.bestand.adapter.add(this);
        }
        this.abos = [];
        this.objektAbos = [];
        this.gestoppt = false;
        const b = this.bestand;
        const schreibe = stufe => text => {
            b.log[stufe]++;
            if (stufe === 'warn' || stufe === 'error') {
                const m = `${stufe}: ${muster(text)}`;
                b.meldungen.set(m, (b.meldungen.get(m) || 0) + 1);
            }
            if (optionenAktuell.logZeilen && (stufe !== 'debug' || optionenAktuell.logDebug)) {
                b.zeilen.push(`${new Date().toISOString()} ${stufe} ${text}`);
            }
        };
        this.log = {
            silly() {},
            debug: schreibe('debug'),
            info: schreibe('info'),
            warn: schreibe('warn'),
            error: schreibe('error'),
            level: 'debug',
        };
        for (const [ereignis, feld] of [
            ['ready', 'ready'],
            ['stateChange', 'stateChange'],
            ['objectChange', 'objectChange'],
            ['message', 'message'],
            ['unload', 'unload'],
        ]) {
            if (typeof o[feld] === 'function') {
                this.on(ereignis, o[feld]);
            }
        }
        for (const methode of [
            'setState',
            'getState',
            'setObjectNotExists',
            'setObject',
            'extendObject',
            'getObject',
            'delObject',
            'getForeignState',
            'setForeignState',
            'getForeignObject',
            'subscribeStates',
            'subscribeForeignStates',
            'subscribeObjects',
            'getStates',
            'getForeignStates',
            'getForeignObjects',
            'getAdapterObjects',
            'delState',
            'setStateChanged',
            'unsubscribeStates',
            'unsubscribeForeignStates',
            'getDevices',
            'getChannelsOf',
            'getStatesOf',
            'delForeignObject',
            'setForeignObject',
            'extendForeignObject',
            'setForeignObjectNotExists',
            'getObjectView',
            'getObjectList',
            'sendTo',
            'getCertificates',
            'setStateChangedAsync',
        ]) {
            const asyncName = `${methode}Async`;
            if (typeof this[asyncName] === 'function' && this[methode] === undefined) {
                this[methode] = (...a) => {
                    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
                    const p = this[asyncName](...a);
                    if (cb) {
                        p.then(
                            r => cb(null, r),
                            e => cb(e),
                        );
                        return undefined;
                    }
                    return p;
                };
            }
        }
        return new Proxy(this, {
            get(ziel, name, empf) {
                if (name in ziel || typeof name === 'symbol' || name === 'then') {
                    return Reflect.get(ziel, name, empf);
                }
                if (
                    typeof name === 'string' &&
                    !Adapter.gemeldet.has(name) &&
                    !name.startsWith('_') &&
                    /^(get|set|del|subscribe|unsubscribe|extend|send|register|supports|check|add|create|delete|rename|write|read|mk|chmod|chown|unlink|file|terminate|restart|disable|update)/.test(
                        name,
                    )
                ) {
                    Adapter.gemeldet.add(name);
                    console.error(`[adapterkern] nicht nachgebildet: ${name}`);
                    return async () => undefined;
                }
                return undefined;
            },
        });
    }

    voll(id) {
        const s = String(id);
        return s.startsWith(`${this.namespace}.`) || s === this.namespace ? s : `${this.namespace}.${s}`;
    }

    async starten() {
        this.emit('ready');
    }

    async stoppen() {
        this.gestoppt = true;
        await new Promise(fertig => {
            let erledigt = false;
            const ende = () => {
                if (!erledigt) {
                    erledigt = true;
                    fertig();
                }
            };
            if (this.listenerCount('unload')) {
                this.emit('unload', ende);
            } else {
                ende();
            }
        });
        this.bestand.adapter.delete(this);
        this.removeAllListeners();
    }

    // ---- Zustaende
    async setForeignStateAsync(id, wert, ack) {
        const b = this.bestand;
        let s =
            wert !== null && typeof wert === 'object' && 'val' in wert ? { ...wert } : { val: wert, ack: ack === true };
        if (typeof ack === 'boolean' && !(wert !== null && typeof wert === 'object' && 'ack' in wert)) {
            s.ack = ack;
        }
        const alt = b.werte.get(id);
        const jetzt = Date.now();
        s = {
            val: s.val,
            ack: s.ack === true,
            ts: s.ts || jetzt,
            lc: alt && alt.val === s.val ? alt.lc : jetzt,
            from: `system.adapter.${this.namespace}`,
            q: s.q || 0,
        };
        b.werte.set(id, s);
        b.zaehler.setState++;
        b.jeId.set(id, (b.jeId.get(id) || 0) + 1);
        b.zaehler[s.ack ? 'setStateAck' : 'setStateBefehl']++;
        for (const a of b.adapter) {
            if (!a.gestoppt && a.abos.some(p => passt(p, id))) {
                queueMicrotask(() => {
                    if (!a.gestoppt) {
                        try {
                            a.emit('stateChange', id, { ...s });
                        } catch (e) {
                            console.error(`stateChange: ${e.stack || e}`);
                        }
                    }
                });
            }
        }
        return id;
    }
    setStateAsync(id, wert, ack) {
        return this.setForeignStateAsync(this.voll(id), wert, ack);
    }
    async setStateChangedAsync(id, wert, ack) {
        const alt = this.bestand.werte.get(this.voll(id));
        const neu =
            wert !== null && typeof wert === 'object' && 'val' in wert ? wert : { val: wert, ack: ack === true };
        if (alt && alt.val === neu.val && alt.ack === (neu.ack === true)) {
            return { id, notChanged: true };
        }
        await this.setStateAsync(id, wert, ack);
        return { id, notChanged: false };
    }
    async getForeignStateAsync(id) {
        this.bestand.zaehler.getState++;
        const s = this.bestand.werte.get(id);
        return s ? { ...s } : null;
    }
    getStateAsync(id) {
        return this.getForeignStateAsync(this.voll(id));
    }
    async getForeignStatesAsync(pattern) {
        const r = {};
        for (const [id, s] of this.bestand.werte) {
            if (passt(pattern, id)) {
                r[id] = { ...s };
            }
        }
        return r;
    }
    getStatesAsync(pattern) {
        return this.getForeignStatesAsync(this.voll(pattern));
    }
    async delStateAsync(id) {
        this.bestand.werte.delete(this.voll(id));
    }
    async subscribeForeignStatesAsync(pattern) {
        this.abos.push(pattern);
    }
    async subscribeStatesAsync(pattern) {
        this.abos.push(this.voll(pattern));
    }
    async unsubscribeStatesAsync() {}
    async unsubscribeForeignStatesAsync() {}

    // ---- Objekte
    objektMelden(id, obj) {
        for (const a of this.bestand.adapter) {
            if (!a.gestoppt && a.objektAbos.some(p => passt(p, id))) {
                queueMicrotask(() => !a.gestoppt && a.emit('objectChange', id, obj));
            }
        }
    }
    async setForeignObjectAsync(id, obj) {
        this.bestand.zaehler.setObject++;
        const neu = { ...obj, _id: id };
        this.bestand.objekte.set(id, neu);
        if (obj && obj.type === 'state' && obj.common && obj.common.def !== undefined && !this.bestand.werte.has(id)) {
            this.bestand.werte.set(id, {
                val: obj.common.def,
                ack: true,
                ts: Date.now(),
                lc: Date.now(),
                from: 'def',
                q: 0,
            });
        }
        this.objektMelden(id, neu);
        return { id };
    }
    setObjectAsync(id, obj) {
        return this.setForeignObjectAsync(this.voll(id), obj);
    }
    async setForeignObjectNotExistsAsync(id, obj) {
        if (!this.bestand.objekte.has(id)) {
            return this.setForeignObjectAsync(id, obj);
        }
        return { id };
    }
    setObjectNotExistsAsync(id, obj) {
        return this.setForeignObjectNotExistsAsync(this.voll(id), obj);
    }
    async extendForeignObjectAsync(id, obj) {
        const alt = this.bestand.objekte.get(id) || {};
        const neu = {
            ...alt,
            ...obj,
            common: { ...(alt.common || {}), ...(obj.common || {}) },
            native: { ...(alt.native || {}), ...(obj.native || {}) },
        };
        return this.setForeignObjectAsync(id, neu);
    }
    extendObjectAsync(id, obj) {
        return this.extendForeignObjectAsync(this.voll(id), obj);
    }
    async getForeignObjectAsync(id) {
        if (id === 'system.config') {
            return { _id: id, type: 'config', common: { language: 'de', tempUnit: '°C' }, native: {} };
        }
        const o = this.bestand.objekte.get(id);
        return o ? JSON.parse(JSON.stringify(o)) : null;
    }
    getObjectAsync(id) {
        return this.getForeignObjectAsync(this.voll(id));
    }
    async delForeignObjectAsync(id, opt) {
        for (const k of [...this.bestand.objekte.keys()]) {
            if (k === id || (opt && opt.recursive && k.startsWith(`${id}.`))) {
                this.bestand.objekte.delete(k);
                this.bestand.werte.delete(k);
                this.objektMelden(k, null);
            }
        }
    }
    delObjectAsync(id, opt) {
        return this.delForeignObjectAsync(this.voll(id), opt);
    }
    async getForeignObjectsAsync(pattern, typ) {
        const r = {};
        for (const [id, o] of this.bestand.objekte) {
            if (passt(pattern, id) && (!typ || typeof typ !== 'string' || o.type === typ)) {
                r[id] = JSON.parse(JSON.stringify(o));
            }
        }
        return r;
    }
    getAdapterObjectsAsync() {
        return this.getForeignObjectsAsync(`${this.namespace}.*`);
    }
    async getObjectViewAsync(design, suche, param) {
        const rows = [];
        for (const [id, o] of this.bestand.objekte) {
            if (
                o.type === suche &&
                (!param || ((!param.startkey || id >= param.startkey) && (!param.endkey || id <= param.endkey)))
            ) {
                rows.push({ id, value: JSON.parse(JSON.stringify(o)) });
            }
        }
        return { rows };
    }
    async getObjectListAsync(param) {
        const rows = [];
        for (const [id, o] of this.bestand.objekte) {
            if (!param || ((!param.startkey || id >= param.startkey) && (!param.endkey || id <= param.endkey))) {
                rows.push({ id, value: JSON.parse(JSON.stringify(o)), doc: JSON.parse(JSON.stringify(o)) });
            }
        }
        return { rows };
    }
    async getDevicesAsync() {
        return Object.values(await this.getForeignObjectsAsync(`${this.namespace}.*`, 'device'));
    }
    async getChannelsOfAsync(geraet) {
        return Object.values(
            await this.getForeignObjectsAsync(`${this.namespace}.${geraet ? `${geraet}.` : ''}*`, 'channel'),
        );
    }
    async getStatesOfAsync(geraet, kanal) {
        const p = [this.namespace, geraet, kanal].filter(Boolean).join('.');
        return Object.values(await this.getForeignObjectsAsync(`${p}.*`, 'state'));
    }
    async subscribeObjectsAsync(pattern) {
        this.objektAbos.push(this.voll(pattern));
    }
    async subscribeForeignObjectsAsync(pattern) {
        this.objektAbos.push(pattern);
    }

    // ---- Sonstiges
    setTimeout(fn, ms, ...a) {
        return this.gestoppt ? undefined : setTimeout(fn, ms, ...a);
    }
    clearTimeout(h) {
        clearTimeout(h);
    }
    setInterval(fn, ms, ...a) {
        return this.gestoppt ? undefined : setInterval(fn, ms, ...a);
    }
    clearInterval(h) {
        clearInterval(h);
    }
    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    async sendToAsync(ziel, befehl, nachricht) {
        this.bestand.zeilen.push(`sendTo ${ziel} ${befehl} ${JSON.stringify(nachricht).slice(0, 200)}`);
        return {};
    }
    sendTo(ziel, befehl, nachricht, cb) {
        if (cb && typeof cb === 'object' && this.antworten) {
            this.antworten(cb, nachricht);
        } else if (typeof cb === 'function') {
            cb({});
        }
    }
    terminate() {}
    restart() {}
    supportsFeature() {
        return true;
    }
    async getCertificatesAsync() {
        return [];
    }
    formatDate(d) {
        return new Date(d).toISOString();
    }
}
Adapter.gemeldet = new Set();

/**
 * Legt fest, womit der naechste Adapter entsteht.
 *
 * @param {Bestand} bestand   Datenbestand
 * @param {object} optionen   {name, config, logZeilen, logDebug}
 */
function vorbereiten(bestand, optionen) {
    bestandAktuell = bestand;
    optionenAktuell = optionen;
}

module.exports = {
    Adapter,
    Bestand,
    vorbereiten,
    getAbsoluteDefaultDataDir: () => '/tmp',
    getAbsoluteInstanceDataDir: () => '/tmp',
    EXIT_CODES: { NO_ERROR: 0, ADAPTER_REQUESTED_TERMINATION: 11 },
    I18n: { init: async () => {}, translate: t => t, getTranslatedObject: t => ({ en: t }) },
    commonTools: {},
};
