'use strict';

/*
 * Simulator fuer die Bedarfsregelung: eine Daikin-Anlage am faikout-Modul und ein Ersatz fuer den
 * js-controller. Die Anlage erzeugt Statusmeldungen wie state/<Name> (outside, temp, target, mode,
 * power, comp, consumption, demand, action=defrosting beim Abtauen), beantwortet demand-Befehle
 * mit Annahme oder failed-set und kann die Verbindung verlieren. Die Uhr ist simuliert.
 */

const proxyquire = require('proxyquire').noCallThru();
const { Bedarfsregelung } = require('../../lib/regel');

/** Ersatz fuer die Adapterklasse: Objekte, Werte, Logzeilen, Broker mit Mitschnitt. */
class Attrappe {
    constructor() {
        this.namespace = 'faikout.0';
        this.config = {};
        this.zeilen = [];
        this.objekte = new Map();
        this.werte = new Map();
        this.fremd = new Map();
        this.gesendet = [];
        const merke = stufe => text => this.zeilen.push({ stufe, text });
        this.log = { debug: merke('debug'), info: merke('info'), warn: merke('warn'), error: merke('error') };
        this.brokerAttrappe = {
            publish: async (topic, nutzlast) => {
                this.gesendet.push({ topic, nutzlast });
                if (this.beimSenden) {
                    this.beimSenden(topic, nutzlast);
                }
                return true;
            },
        };
    }
    on() {}
    async getObjectAsync(id) {
        return this.objekte.get(id) || null;
    }
    async extendObject(id, obj) {
        this.objekte.set(id, { ...(this.objekte.get(id) || {}), ...obj });
    }
    async setObjectNotExistsAsync(id, obj) {
        if (!this.objekte.has(id)) {
            this.objekte.set(id, obj);
        }
    }
    async setState(id, wert) {
        this.werte.set(id, wert);
    }
    async setStateAsync(id, wert) {
        this.werte.set(id, wert);
    }
    async getStateAsync(id) {
        return this.werte.get(id) || null;
    }
    async getForeignStateAsync(id) {
        return this.fremd.get(id) || null;
    }
    wert(id) {
        const s = this.werte.get(id);
        return s ? s.val : undefined;
    }
}

/** Simulierte Anlage. */
class Anlage {
    /**
     * @param {object} opt  {name, outside, temp, target, mode, power, nimmtDemand: 'immer'|'nie'|'nurEin'}
     */
    constructor(opt = {}) {
        this.name = opt.name || 'Daikin Test';
        this.outside = opt.outside ?? 5;
        this.temp = opt.temp ?? 21;
        this.target = opt.target ?? 21;
        this.mode = opt.mode ?? 'heat';
        this.power = opt.power ?? true;
        this.demand = 100;
        this.econo = false;
        this.abtauen = false;
        this.verbunden = true;
        this.nimmtDemand = opt.nimmtDemand || 'immer';
        this.fehler = []; // failed-set-Meldungen
        this.fan = opt.fan ?? 'auto';
        this.hum = opt.hum;
        this.ble = opt.ble || null; // {temp, hum}
        this.autoe = opt.autoe;
        this.lehntAb = opt.lehntAb || []; // Felder, die die Anlage nie uebernimmt
        this.befehle = []; // Mitschnitt aller Befehle
        this.control = null;
    }
    /** Antwort auf command/<Name>/demand - wie Firmware + Anlage. */
    befehl(topic, nutzlast) {
        if (!this.verbunden || !topic.startsWith(`command/${this.name}/`)) {
            return;
        }
        this.befehle.push({ topic, nutzlast });
        const feld = topic.slice(`command/${this.name}/`.length);
        if (feld !== 'demand') {
            // Firmware: mode schaltet zugleich ein (off = aus); temp setzt den Sollwert
            if (this.lehntAb.includes(feld)) {
                this.fehler.push({ [feld]: nutzlast });
            } else if (feld === 'power') {
                this.power = nutzlast === 'true';
            } else if (feld === 'mode') {
                this.power = nutzlast !== 'off';
                if (this.power) {
                    this.mode = nutzlast;
                }
            } else if (feld === 'temp') {
                this.target = Number(nutzlast);
            } else if (feld === 'fan') {
                this.fan = nutzlast;
            } else if (feld === 'control') {
                this.control = JSON.parse(nutzlast);
            }
            return;
        }
        const w = Number(nutzlast);
        const nimmt = this.nimmtDemand === 'immer' || (this.nimmtDemand === 'nurEin' && this.power);
        if (nimmt || w === this.demand) {
            this.demand = w;
        } else {
            this.fehler.push({ demand: w });
        }
    }
    /** Statusmeldung im Klartextformat (state/<Name>). */
    status() {
        const comp = this.power && this.mode !== 'fan_only' ? Math.round(20 + (this.demand / 100) * 40) : 0;
        const zusatz = {};
        if (this.hum !== undefined) {
            zusatz.hum = this.hum;
        }
        if (this.ble) {
            zusatz.bletemp = this.ble.temp;
            zusatz.blehum = this.ble.hum;
        }
        if (this.autoe !== undefined) {
            zusatz.autoe = this.autoe;
        }
        return {
            ...zusatz,
            fan: this.fan,
            power: this.power,
            mode: this.power ? this.mode : 'off',
            target: this.target,
            temp: this.temp,
            outside: this.outside,
            demand: this.demand,
            econo: this.econo,
            comp,
            consumption: comp * 12,
            action: !this.power ? 'off' : this.abtauen ? 'defrosting' : this.mode === 'cool' ? 'cooling' : 'heating',
        };
    }
}

/**
 * Baut Adapter (echtes main.js mit Attrappe) + Regelung mit simulierter Uhr.
 *
 * @param {object} [config]  Instanzeinstellungen
 * @param {number} [start]   Startzeit
 * @returns {{a: object, uhr: {t: number}, regel: Bedarfsregelung}} Testaufbau
 */
function aufbau(config = {}, start = Date.parse('2026-11-20T22:00:00')) {
    const a = proxyquire('../../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
    a.config = config;
    a.broker = a.brokerAttrappe; // main.js setzt broker im Konstruktor auf null
    const uhr = { t: start };
    a.regelung = new Bedarfsregelung(a, { jetzt: () => uhr.t });
    return { a, uhr, regel: a.regelung };
}

const warte = () => new Promise(r => setTimeout(r, 5));

/**
 * Laesst die Anlage `minuten` lang je Minute melden; Befehle des Adapters gehen an die Anlage,
 * failed-set kommt zurueck.
 *
 * @param {object} a        Adapter
 * @param {{t: number}} uhr Uhr
 * @param {Anlage} anlage   Anlage
 * @param {number} minuten  Dauer
 * @param {Function} [jedeMinute]  Eingriff je Minute (i, anlage)
 */
async function laufen(a, uhr, anlage, minuten, jedeMinute) {
    a.beimSenden = (topic, n) => anlage.befehl(topic, n);
    for (let i = 0; i < minuten; i++) {
        if (jedeMinute) {
            jedeMinute(i, anlage);
        }
        if (anlage.verbunden) {
            a.onMqtt(`state/${anlage.name}`, Buffer.from(JSON.stringify(anlage.status())));
            await warte();
            while (anlage.fehler.length) {
                a.onMqtt(`error/${anlage.name}/failed-set`, Buffer.from(JSON.stringify(anlage.fehler.shift())));
                await warte();
            }
        }
        uhr.t += 60000;
    }
}

module.exports = { Attrappe, Anlage, aufbau, laufen, warte };
