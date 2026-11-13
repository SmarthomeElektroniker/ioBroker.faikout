'use strict';

/*
 * Zahl und Text zugleich (Forum 85668, FernetMenta 13.11.2026).
 *
 * Neben mode/fan/swing/preset (Text, wie das Modul sie spricht) gibt es modeNum/fanNum/
 * swingNum/presetNum (Zahl mit common.states) - fuer Lovelace, das beim Schreiben die
 * states-Schluessel mit parseInt() umrechnet. Geprueft wird:
 * - die Zuordnung ist fest (0 = off, 1 = heat_cool, ... wie im Forenbeitrag),
 * - eine Meldung des Moduls setzt beide mit ack=true,
 * - ein Befehl auf Zahl ODER Text erzeugt genau EINEN MQTT-Befehl, als Text,
 * - ack kommt erst mit der Bestaetigung des Moduls, und die eigenen Rueckmeldungen loesen
 *   keinen weiteren Befehl aus (keine Schleife).
 * Alles gegen Attrappen bzw. den eigenen Broker auf einem freien Port - nie gegen echte Module.
 */

const { expect } = require('chai');
const net = require('node:net');
const proxyquire = require('proxyquire').noCallThru();
const felder = require('../lib/fields');
const namen = require('../lib/namen');
const { FaikoutBroker } = require('../lib/broker');

describe('Zahl und Text: Feldkunde', () => {
    it('modeNum entspricht dem Beispiel aus dem Forum', () => {
        const d = felder.FELDER.modeNum;
        expect(d.type).to.equal('number');
        expect(d.w).to.equal(true);
        expect(d.cmd).to.equal('mode');
        expect(d.states).to.eql({ 0: 'off', 1: 'heat_cool', 2: 'cool', 3: 'heat', 4: 'dry', 5: 'fan_only' });
        expect(d.role).to.equal('level.mode.airconditioner');
        expect([d.min, d.max, d.step]).to.eql([0, 5, 1]);
    });

    it('fanNum, swingNum und presetNum haben Zahlen mit Beschriftung', () => {
        expect(felder.FELDER.fanNum.states).to.eql({
            0: 'auto',
            1: 'night',
            2: 'low',
            3: 'lowMedium',
            4: 'medium',
            5: 'mediumHigh',
            6: 'high',
        });
        // swing: die Beschriftung des Text-Datenpunkts, nicht das Kuerzel des Moduls
        expect(felder.FELDER.swingNum.states).to.eql({
            0: 'off',
            1: 'on',
            2: 'vertical',
            3: 'horizontal',
            4: 'both',
            5: 'comfort',
        });
        expect(felder.FELDER.presetNum.states).to.eql({ 0: 'home', 1: 'eco', 2: 'boost' });
        expect(felder.FELDER.fanNum.role).to.equal('level.mode.fan');
        expect(felder.FELDER.swingNum.role).to.equal('level.mode.swing');
    });

    it('die Text-Datenpunkte bleiben unveraendert Text', () => {
        for (const f of ['mode', 'fan', 'swing', 'preset', 'selectedMode']) {
            expect(felder.FELDER[f].type, f).to.equal('string');
            expect(felder.FELDER[f].role, f).to.equal('state');
        }
    });

    it('alle Zwillinge haben Namen in elf Sprachen', () => {
        for (const f of ['modeNum', 'fanNum', 'swingNum', 'presetNum']) {
            expect(Object.keys(namen.vollerName(felder.FELDER[f].name)), f).to.have.length(11);
        }
    });

    it('ergaenzt eine Meldung um die Zahlen, unbekannte Texte nicht', () => {
        const d = { mode: 'cool', fan: 'night', swing: 'H+V', preset: 'eco', target: 21 };
        expect(felder.zahlZwillingeErgaenzen(d)).to.eql({
            ...d,
            modeNum: 2,
            fanNum: 1,
            swingNum: 4,
            presetNum: 1,
        });
        expect(d).to.not.have.property('modeNum'); // Eingabe bleibt unveraendert
        expect(felder.zahlZwillingeErgaenzen({ mode: 'turbo' })).to.eql({ mode: 'turbo' });
        expect(felder.zahlZwillingeErgaenzen({ up: false })).to.eql({ up: false });
    });

    it('uebersetzt geschriebene Zahlen, Zahltexte und Beschriftungen in den Modultext', () => {
        expect(felder.zahlZuText('modeNum', 3)).to.equal('heat');
        expect(felder.zahlZuText('modeNum', '3')).to.equal('heat');
        expect(felder.zahlZuText('modeNum', 'heat')).to.equal('heat');
        expect(felder.zahlZuText('swingNum', 2)).to.equal('V');
        expect(felder.zahlZuText('swingNum', 'vertical')).to.equal('V');
        expect(felder.zahlZuText('swingNum', 'H+V')).to.equal('H+V');
        expect(felder.zahlZuText('fanNum', 0)).to.equal('auto');
        for (const falsch of [6, -1, 2.5, NaN, 'turbo', true, null]) {
            expect(felder.zahlZuText('modeNum', falsch), String(falsch)).to.equal(null);
        }
        expect(felder.zahlZuText('mode', 1)).to.equal(null); // kein Zwilling
    });
});

/**
 * Ersatz fuer die Adapterklasse des js-controllers. Wie der echte Controller meldet er jeden
 * setState eines abonnierten eigenen Datenpunkts zurueck an onStateChange - auch die mit
 * ack=true. Nur so zeigt der Test, dass es keine Schleife gibt.
 */
class Attrappe {
    constructor() {
        this.namespace = 'faikout.0';
        this.objekte = new Map();
        this.werte = new Map();
        this.verlauf = [];
        this.zeilen = [];
        const merke = stufe => text => this.zeilen.push({ stufe, text });
        this.log = { debug: merke('debug'), info: merke('info'), warn: merke('warn'), error: merke('error') };
    }
    on() {}
    kurz(id) {
        return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
    async getObjectAsync(id) {
        return this.objekte.get(this.kurz(id)) || null;
    }
    async extendObject(id, obj) {
        const alt = this.objekte.get(id) || {};
        this.objekte.set(id, {
            ...alt,
            ...obj,
            common: { ...(alt.common || {}), ...(obj.common || {}) },
            native: { ...(alt.native || {}), ...(obj.native || {}) },
        });
    }
    async setState(id, wert) {
        const kurz = this.kurz(id);
        const state = typeof wert === 'object' && wert !== null ? wert : { val: wert, ack: false };
        this.werte.set(kurz, state);
        this.verlauf.push({ id: kurz, ...state });
        // Rueckmeldung wie im js-controller (subscribeStates('*.control.*'))
        if (/\.control\./.test(kurz)) {
            setImmediate(() => this.onStateChange(`${this.namespace}.${kurz}`, { ...state }));
        }
    }
}

const neuerAdapter = () => proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
const warte = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** Statusmeldung im Klartext, wie sie state/<Name> liefert. */
const meldung = (ueber = {}) =>
    Buffer.from(
        JSON.stringify({
            up: true,
            power: true,
            mode: 'cool',
            fan: 'auto',
            swing: 'off',
            preset: 'home',
            target: 22,
            temp: 24,
            ...ueber,
        }),
    );

describe('Zahl und Text: Adapter mit Attrappe', () => {
    let a;
    let gesendet;

    beforeEach(async () => {
        a = neuerAdapter();
        gesendet = [];
        a.broker = {
            publish: async (topic, nutzlast) => {
                gesendet.push({ topic, nutzlast });
                return true;
            },
        };
        a.onMqtt('state/Daikin 1OG', meldung());
        await warte();
        a.verlauf.length = 0;
    });

    it('eine Meldung setzt Text und Zahl mit ack=true', () => {
        expect(a.werte.get('Daikin_1OG.control.mode')).to.eql({ val: 'cool', ack: true });
        expect(a.werte.get('Daikin_1OG.control.modeNum')).to.eql({ val: 2, ack: true });
        expect(a.werte.get('Daikin_1OG.control.fanNum')).to.eql({ val: 0, ack: true });
        expect(a.werte.get('Daikin_1OG.control.swingNum')).to.eql({ val: 0, ack: true });
        expect(a.werte.get('Daikin_1OG.control.presetNum')).to.eql({ val: 0, ack: true });
        const o = a.objekte.get('Daikin_1OG.control.modeNum');
        expect(o.common.type).to.equal('number');
        expect(o.common.write).to.equal(true);
        expect(o.common.states[5]).to.equal('fan_only');
        expect(o.native.feld).to.equal('modeNum');
        expect(gesendet).to.have.length(0); // die eigenen ack-Rueckmeldungen senden nichts
    });

    it('Schreiben auf die Zahl: genau EIN Befehl, als Text; ack erst mit der Bestaetigung', async () => {
        await a.setState('Daikin_1OG.control.modeNum', { val: 3, ack: false });
        await warte();
        expect(gesendet).to.eql([{ topic: 'command/Daikin 1OG/mode', nutzlast: 'heat' }]);
        // Der Text-Datenpunkt wurde nicht angefasst, die Zahl wartet unbestaetigt.
        expect(a.verlauf.filter(v => v.id === 'Daikin_1OG.control.mode')).to.have.length(0);
        expect(a.werte.get('Daikin_1OG.control.modeNum')).to.eql({ val: 3, ack: false });
        expect(a.werte.get('Daikin_1OG.control.mode')).to.eql({ val: 'cool', ack: true });

        // Das Modul bestaetigt: beide ziehen nach, ohne weiteren Befehl.
        a.onMqtt('state/Daikin 1OG', meldung({ mode: 'heat' }));
        await warte();
        expect(a.werte.get('Daikin_1OG.control.modeNum')).to.eql({ val: 3, ack: true });
        expect(a.werte.get('Daikin_1OG.control.mode')).to.eql({ val: 'heat', ack: true });
        expect(gesendet).to.have.length(1);
    });

    it('Schreiben auf den Text: genau EIN Befehl, die Zahl zieht mit der Bestaetigung nach', async () => {
        await a.setState('Daikin_1OG.control.fan', { val: 'medium', ack: false });
        await warte();
        expect(gesendet).to.eql([{ topic: 'command/Daikin 1OG/fan', nutzlast: 'medium' }]);
        expect(a.verlauf.filter(v => v.id === 'Daikin_1OG.control.fanNum')).to.have.length(0);

        a.onMqtt('state/Daikin 1OG', meldung({ fan: 'medium' }));
        await warte();
        expect(a.werte.get('Daikin_1OG.control.fanNum')).to.eql({ val: 4, ack: true });
        expect(a.werte.get('Daikin_1OG.control.fan')).to.eql({ val: 'medium', ack: true });
        expect(gesendet).to.have.length(1);
    });

    it('lehnt die Anlage ab, bestaetigt die Zahl den alten Wert wieder mit ack', async () => {
        await a.setState('Daikin_1OG.control.swingNum', { val: 2, ack: false });
        await warte();
        expect(gesendet).to.eql([{ topic: 'command/Daikin 1OG/swing', nutzlast: 'V' }]);
        a.onMqtt('state/Daikin 1OG', meldung()); // swing weiter "off"
        await warte();
        expect(a.werte.get('Daikin_1OG.control.swingNum')).to.eql({ val: 0, ack: true });
        expect(gesendet).to.have.length(1);
    });

    it('Lovelace-Weg: Beschriftung oder Zahl als Text werden verstanden', async () => {
        await a.setState('Daikin_1OG.control.swingNum', { val: 'vertical', ack: false });
        await a.setState('Daikin_1OG.control.modeNum', { val: '4', ack: false });
        await warte();
        expect(gesendet).to.eql([
            { topic: 'command/Daikin 1OG/swing', nutzlast: 'V' },
            { topic: 'command/Daikin 1OG/mode', nutzlast: 'dry' },
        ]);
    });

    it('ungueltige Zahl: kein Befehl, Warnung im Log', async () => {
        await a.setState('Daikin_1OG.control.modeNum', { val: 9, ack: false });
        await a.setState('Daikin_1OG.control.modeNum', { val: NaN, ack: false });
        await warte();
        expect(gesendet).to.have.length(0);
        expect(a.zeilen.filter(z => z.stufe === 'warn')).to.have.length(2);
    });
});

/** Sucht einen freien Port, damit der Test nicht mit laufenden Diensten kollidiert. */
function freierPort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}

describe('Zahl und Text: eigener Broker mit nachgebautem Modul', () => {
    const stilleLog = { info() {}, warn() {}, error() {}, debug() {} };
    const zeitgeber = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) };
    let broker;
    let modul;

    afterEach(async () => {
        if (modul) modul.end(true);
        if (broker) await broker.stop();
        broker = null;
        modul = null;
    });

    it('je Schreibbefehl kommt am Modul genau eine Nachricht an', async function () {
        this.timeout(15000);
        const port = await freierPort();
        const a = neuerAdapter();
        broker = new FaikoutBroker({
            port,
            log: stilleLog,
            timer: zeitgeber,
            onMessage: (topic, payload) => a.onMqtt(topic, payload),
        });
        await broker.start();
        a.broker = broker;

        // Nachgebautes Modul: Name mit Leerzeichen wie die echten, eigener Prueflingsname.
        const mqtt = require('mqtt');
        modul = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'pruefling', reconnectPeriod: 0 });
        await new Promise((res, rej) => {
            modul.on('connect', res);
            modul.on('error', rej);
            setTimeout(() => rej(new Error('Zeitablauf beim Verbinden')), 8000);
        });
        const empfangen = [];
        modul.on('message', (topic, payload) => empfangen.push(`${topic}=${payload.toString()}`));
        await modul.subscribeAsync('command/#');

        modul.publish('state/Pruef Modul', meldung().toString());
        await warte(200);
        expect(a.werte.get('Pruef_Modul.control.modeNum')).to.eql({ val: 2, ack: true });

        await a.setState('Pruef_Modul.control.modeNum', { val: 5, ack: false });
        await warte(200);
        await a.setState('Pruef_Modul.control.mode', { val: 'dry', ack: false });
        await warte(200);
        expect(empfangen).to.eql(['command/Pruef Modul/mode=fan_only', 'command/Pruef Modul/mode=dry']);

        // Bestaetigung des Moduls: kein weiterer Befehl
        modul.publish('state/Pruef Modul', meldung({ mode: 'dry' }).toString());
        await warte(200);
        expect(a.werte.get('Pruef_Modul.control.modeNum')).to.eql({ val: 4, ack: true });
        expect(a.werte.get('Pruef_Modul.control.mode')).to.eql({ val: 'dry', ack: true });
        expect(empfangen).to.have.length(2);
    });
});
