'use strict';

/*
 * Prueft den Broker gegen einen echten MQTT-Client: Verbindung, Anmeldung, Empfang und
 * das Senden von Kommandos - samt Geraetename mit Leerzeichen, der Kern der Topic-Falle.
 */

const { expect } = require('chai');
const net = require('node:net');
const { FaikoutBroker } = require('../lib/broker');
const felder = require('../lib/fields');

const stilleLog = { info() {}, warn() {}, error() {}, debug() {} };
const zeitgeber = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) };

/** Sucht einen freien Port, damit der Test nicht mit laufenden Diensten kollidiert. */
function freierPort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}

describe('FaikoutBroker', () => {
    let broker;
    let port;

    afterEach(async () => {
        if (broker) await broker.stop();
        broker = null;
    });

    it('beendet sich schnell, auch wenn ein Modul verbunden bleibt', async function () {
        // Vorher wartete server.close() auf das Trennen der Module, die aber dauerhaft
        // verbunden bleiben: Das Beenden hing, bis der js-controller den Prozess abschoss.
        this.timeout(15000);
        port = await freierPort();
        broker = new FaikoutBroker({ port, log: stilleLog, timer: zeitgeber, onMessage: () => {} });
        await broker.start();
        const mqtt = require('mqtt');
        const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'bleibt-verbunden', reconnectPeriod: 0 });
        await new Promise((res, rej) => {
            client.on('connect', res);
            client.on('error', rej);
            setTimeout(() => rej(new Error('Zeitablauf beim Verbinden')), 8000);
        });
        const start = Date.now();
        await broker.stop();
        broker = null;
        const dauer = Date.now() - start;
        client.end(true);
        expect(dauer).to.be.below(1500);
        // Port ist wieder frei
        await new Promise((res, rej) => {
            const s = net.createServer();
            s.on('error', rej);
            s.listen(port, () => s.close(res));
        });
    });

    it('nimmt eine Verbindung an und reicht Nachrichten durch', async function () {
        this.timeout(15000);
        port = await freierPort();
        const empfangen = [];
        broker = new FaikoutBroker({
            port,
            log: stilleLog,
            timer: zeitgeber,
            onMessage: (topic, payload) => empfangen.push([topic, payload.toString()]),
        });
        await broker.start();

        const mqtt = require('mqtt');
        const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'test-faikout' });
        await new Promise((res, rej) => {
            client.on('connect', res);
            client.on('error', rej);
            setTimeout(() => rej(new Error('Zeitablauf beim Verbinden')), 8000);
        });

        client.publish('state/Wohnzimmer AC', JSON.stringify({ power: true, temp: 19 }));
        await new Promise(r => setTimeout(r, 500));
        await new Promise(r => client.end(false, {}, r));

        expect(empfangen.length).to.be.greaterThan(0);
        expect(empfangen[0][0]).to.equal('state/Wohnzimmer AC');
        expect(JSON.parse(empfangen[0][1]).temp).to.equal(19);
    });

    it('weist falsche Anmeldedaten ab', async function () {
        this.timeout(15000);
        port = await freierPort();
        broker = new FaikoutBroker({ port, user: 'a', pass: 'b', log: stilleLog, timer: zeitgeber, onMessage() {} });
        await broker.start();

        const mqtt = require('mqtt');
        const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
            clientId: 'test-falsch',
            username: 'a',
            password: 'FALSCH',
            reconnectPeriod: 0,
        });
        const ergebnis = await new Promise(res => {
            client.on('connect', () => res('verbunden'));
            client.on('error', () => res('abgelehnt'));
            setTimeout(() => res('zeitablauf'), 8000);
        });
        await new Promise(r => client.end(true, {}, r));
        expect(ergebnis).to.equal('abgelehnt');
    });

    it('sendet Kommandos auf ein Topic mit Leerzeichen im Gerätenamen', async function () {
        this.timeout(15000);
        port = await freierPort();
        broker = new FaikoutBroker({ port, log: stilleLog, timer: zeitgeber, onMessage() {} });
        await broker.start();

        const mqtt = require('mqtt');
        const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'test-lauscher' });
        await new Promise((res, rej) => {
            client.on('connect', res);
            client.on('error', rej);
            setTimeout(() => rej(new Error('Zeitablauf')), 8000);
        });
        await new Promise((res, rej) => client.subscribe('command/#', e => (e ? rej(e) : res())));

        const gesehen = new Promise(res => client.on('message', (t, p) => res([t, p.toString()])));
        await broker.publish('command/Wohnzimmer AC/temp', '21');
        const [topic, nutzlast] = await gesehen;
        await new Promise(r => client.end(false, {}, r));

        expect(topic).to.equal('command/Wohnzimmer AC/temp');
        expect(nutzlast).to.equal('21');
    });
});

describe('FaikoutBroker: Anmeldung (Maengel aus dem Test der MQTT-Anmeldung)', function () {
    this.timeout(15000);
    const mqtt = require('mqtt');
    let broker;
    afterEach(async () => {
        if (broker) {
            await broker.stop();
        }
        broker = null;
    });
    /** Ein Verbindungsversuch: 'verbunden' oder 'abgelehnt'. */
    const versuch = (port, clientId, username, password) =>
        new Promise(res => {
            const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId, username, password, reconnectPeriod: 0 });
            const ende = r => c.end(true, {}, () => res(r));
            c.on('connect', () => ende('verbunden'));
            c.on('error', () => ende('abgelehnt'));
        });
    const mitLog = () => {
        const zeilen = [];
        const merke = stufe => text => zeilen.push({ stufe, text });
        return { zeilen, log: { debug: merke('debug'), info: merke('info'), warn: merke('warn'), error: merke('error') } };
    };

    it('Startzeile nennt, ob der Broker MIT oder OHNE Anmeldung laeuft; Passwort ohne Benutzer wird gewarnt', async () => {
        let l = mitLog();
        broker = new FaikoutBroker({ port: await freierPort(), user: 'klima', pass: 'geheim', log: l.log, timer: zeitgeber, onMessage() {} });
        await broker.start();
        expect(l.zeilen.filter(z => z.stufe === 'info').map(z => z.text).join('\n')).to.match(/WITH login \(user "klima"\)/);
        expect(l.zeilen.map(z => z.text).join('\n')).to.not.include('geheim');
        await broker.stop();

        l = mitLog();
        broker = new FaikoutBroker({ port: await freierPort(), log: l.log, timer: zeitgeber, onMessage() {} });
        await broker.start();
        expect(l.zeilen.filter(z => z.stufe === 'info').map(z => z.text).join('\n')).to.match(/WITHOUT login/);
        expect(l.zeilen.filter(z => z.stufe === 'warn')).to.eql([]);
        await broker.stop();

        l = mitLog();
        broker = new FaikoutBroker({ port: await freierPort(), pass: 'geheim', log: l.log, timer: zeitgeber, onMessage() {} });
        await broker.start();
        expect(l.zeilen.filter(z => z.stufe === 'warn').map(z => z.text).join('\n')).to.match(/no user name .* WITHOUT login/);
        expect(l.zeilen.map(z => z.text).join('\n')).to.not.include('geheim');
    });

    it('"MQTT login rejected": je Client beim ersten Mal, dann hoechstens stuendlich, mit Handlungshinweis', async () => {
        const { ABLEHNUNG_MELDEN_MS } = require('../lib/broker');
        const l = mitLog();
        let uhr = 1000000;
        const port = await freierPort();
        broker = new FaikoutBroker({ port, user: 'klima', pass: 'geheim', log: l.log, timer: zeitgeber, onMessage() {}, jetzt: () => uhr });
        await broker.start();
        const warnungen = () => l.zeilen.filter(z => z.stufe === 'warn').map(z => z.text);
        for (let i = 0; i < 3; i++) {
            expect(await versuch(port, 'Faikout:Wohnzimmer', 'klima', 'FALSCH')).to.equal('abgelehnt');
        }
        expect(warnungen()).to.have.length(1);
        expect(warnungen()[0]).to.match(/^MQTT login rejected for "Faikout:Wohnzimmer" \(user "klima"\)\./);
        expect(warnungen()[0]).to.include('"mqttuser" and "mqttpass"').and.to.include('"Connect" in the tab "Find modules"');
        expect(l.zeilen.filter(z => z.stufe === 'debug' && /login rejected/.test(z.text))).to.have.length(2);
        // ein anderer Client wird fuer sich gemeldet
        expect(await versuch(port, 'Faikout:Buero', '', '')).to.equal('abgelehnt');
        expect(warnungen()).to.have.length(2);
        // kurz vor Ablauf der Stunde: weiter still; danach wieder eine Warnung mit der Zahl der Versuche
        uhr += ABLEHNUNG_MELDEN_MS - 1000;
        await versuch(port, 'Faikout:Wohnzimmer', 'klima', 'FALSCH');
        expect(warnungen()).to.have.length(2);
        uhr += 2000;
        await versuch(port, 'Faikout:Wohnzimmer', 'klima', 'FALSCH');
        expect(warnungen()).to.have.length(3);
        expect(warnungen()[2]).to.include('3 more attempt(s)');
        // nach gelungener Anmeldung ist die naechste Ablehnung wieder neu
        expect(await versuch(port, 'Faikout:Wohnzimmer', 'klima', 'geheim')).to.equal('verbunden');
        await versuch(port, 'Faikout:Wohnzimmer', 'klima', 'FALSCH');
        expect(warnungen()).to.have.length(4);
        // Passwoerter stehen nie im Log
        expect(l.zeilen.map(z => z.text).join('\n')).to.not.match(/FALSCH|geheim/);
    });

    it('der Merker der Drosselung waechst nicht unbegrenzt (wechselnde Client-IDs)', () => {
        const l = mitLog();
        const b = new FaikoutBroker({ port: 1, user: 'u', pass: 'p', log: l.log, timer: zeitgeber, onMessage() {} });
        for (let i = 0; i < 500; i++) {
            b.ablehnungMelden(`scanner-${i}`, 'x');
        }
        expect(b.abgelehnt.size).to.equal(200);
    });
});

describe('Adapter am eigenen Broker: Altfall `User`, info.connection', function () {
    this.timeout(15000);
    const mqtt = require('mqtt');
    const proxyquire = require('proxyquire').noCallThru();
    const { Attrappe } = require('./sim/simulator');
    let a;
    let clients = [];
    afterEach(async () => {
        clients.forEach(c => c.end(true));
        clients = [];
        if (a && a.broker) {
            await a.broker.stop();
        }
        a = null;
    });
    const bis = async (fn, ms = 4000) => {
        const ende = Date.now() + ms;
        while (Date.now() < ende) {
            if (fn()) {
                return true;
            }
            await new Promise(r => setTimeout(r, 20));
        }
        return false;
    };
    const adapter = (config, broker) => {
        const stub = { '@iobroker/adapter-core': { Adapter: Attrappe } };
        if (broker) {
            stub['./lib/broker'] = { FaikoutBroker: broker };
        }
        const x = proxyquire('../main', stub)({});
        Object.assign(x, { instance: 0, subscribeStates() {}, subscribeObjectsAsync: async () => {}, setInterval: () => null });
        x.verbrauchUmziehen = async () => {};
        x.objekteAbgleichen = async () => {};
        x.stundenTaktStarten = () => {};
        // alles ausser `User` ist schon auf dem Stand von 1.0.0 - der Umzug betrifft nur den Benutzernamen
        x.config = { externClientIdStandard: 'id', externClientId: 'id', regelUmzugStand: 1, ...config };
        return x;
    };
    const verbinden = (port, opt) =>
        new Promise(res => {
            const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, ...opt });
            clients.push(c);
            c.on('connect', () => res(c));
            c.on('error', () => res(null));
        });

    it('`User` + `pass`: der Umzug schreibt `user` und beendet onReady VOR dem Brokerstart - nie ein offener Broker', async () => {
        const gebaut = [];
        class Merker {
            constructor(opts) {
                gebaut.push(opts);
            }
            async start() {
                gebaut.push('gestartet');
            }
            async stop() {}
        }
        a = adapter({ port: 1888, User: 'klima', pass: 'geheim' }, Merker);
        const objekt = { native: { port: 1888, User: 'klima', pass: 'VERSCHLUESSELT' } };
        const geschrieben = [];
        a.getForeignObjectAsync = async () => JSON.parse(JSON.stringify(objekt));
        a.setForeignObjectAsync = async (id, o) => geschrieben.push([id, o]);
        a.extendForeignObjectAsync = async () => {};
        await a.onReady();
        expect(gebaut, 'in diesem Lauf entsteht kein Broker').to.eql([]);
        expect(a.broker).to.equal(null);
        expect(geschrieben).to.have.length(1);
        expect(geschrieben[0][0]).to.equal('system.adapter.faikout.0');
        // das (verschluesselte) Passwort bleibt, wie es gespeichert ist
        expect(geschrieben[0][1].native).to.include({ user: 'klima', User: '', pass: 'VERSCHLUESSELT' });

        // Laesst sich die Instanz nicht schreiben, laeuft der Broker DIESES Laufs trotzdem mit Anmeldung
        const b = adapter({ port: 1888, User: 'klima', pass: 'geheim' }, Merker);
        await b.onReady();
        expect(gebaut[0]).to.include({ user: 'klima', pass: 'geheim' });
        expect(gebaut[1]).to.equal('gestartet');
    });

    it('nach dem Umzug: ohne Anmeldung abgelehnt, mit den Zugangsdaten angenommen', async () => {
        const port = await freierPort();
        a = adapter({ port, User: 'klima', pass: 'geheim' });
        await a.onReady(); // die Attrappe kann die Instanz nicht schreiben: derselbe Lauf, Broker echt
        expect(a.zeilen.map(z => z.text).join('\n')).to.match(/WITH login \(user "klima"\)/);
        expect(await verbinden(port, { clientId: 'Faikout:Ohne' })).to.equal(null);
        expect(await verbinden(port, { clientId: 'Faikout:Falsch', username: 'klima', password: 'x' })).to.equal(null);
        expect(await verbinden(port, { clientId: 'Faikout:Recht', username: 'klima', password: 'geheim' })).to.not.equal(null);
    });

    it('info.connection: true nur, solange wirklich ein Modul am Broker haengt', async () => {
        const port = await freierPort();
        a = adapter({ port, user: 'klima', pass: 'geheim' });
        await a.onReady();
        expect(a.wert('info.connection')).to.equal(false);
        // abgelehnte Anmeldung: kein Client, bleibt false
        expect(await verbinden(port, { clientId: 'Faikout:Sim', username: 'klima', password: 'x' })).to.equal(null);
        await new Promise(r => setTimeout(r, 100));
        expect(a.mqttClients.size).to.equal(0);
        expect(a.wert('info.connection')).to.equal(false);
        // Modul meldet sich an und sendet
        const c = await verbinden(port, { clientId: 'Faikout:Sim', username: 'klima', password: 'geheim' });
        c.publish('state/Sim', JSON.stringify({ up: true, power: true, target: 21, temp: 20 }));
        expect(await bis(() => a.geraete.has('Sim') && a.wert('info.connection') === true)).to.equal(true);
        // Modul weg: das Geraet bleibt bekannt, die Anzeige faellt trotzdem ab (vorher blieb sie true)
        await new Promise(r => c.end(true, {}, r));
        expect(await bis(() => a.wert('info.connection') === false)).to.equal(true);
        expect(a.geraete.size).to.equal(1);
        // ... und es wird nur bei Aenderung geschrieben
        let n = 0;
        const echt = a.setState.bind(a);
        a.setState = async (id, w) => (id === 'info.connection' && n++, echt(id, w));
        a.verbindungPruefen();
        a.verbindungPruefen();
        expect(n).to.equal(0);
    });
});

describe('Feldkunde', () => {
    it('kennt die schreibbaren Steuerfelder', () => {
        for (const f of [
            'power',
            'mode',
            'target',
            'fan',
            'swing',
            'preset',
            'demand',
            'econo',
            'powerful',
            'comfort',
            'streamer',
            'sensor',
            'led',
            'quiet',
            'humidify',
        ]) {
            expect(felder.FELDER[f], f).to.be.an('object');
            expect(felder.FELDER[f].w, `${f} muss schreibbar sein`).to.equal(true);
        }
    });

    it('macht Messwerte nicht schreibbar', () => {
        for (const f of ['hum', 'outside', 'consumption', 'energy', 'comp', 'actarget', 'temp']) {
            expect(!!felder.FELDER[f].w, `${f} darf nicht schreibbar sein`).to.equal(false);
        }
    });

    it('rechnet Energie von Wh in kWh um', () => {
        const def = felder.FELDER.energy;
        expect(felder.umrechnen(def, 3774300)).to.equal(3774.3);
        expect(felder.umrechnen(felder.FELDER.consumption, 400)).to.equal(400);
    });

    it('leitet unbekannte Felder aus dem Wert ab', () => {
        expect(felder.beschreibe('neuesFeld', true).type).to.equal('boolean');
        expect(felder.beschreibe('neuesFeld', 42).type).to.equal('number');
        expect(felder.beschreibe('neuesFeld', 'x').type).to.equal('string');
        expect(felder.beschreibe('neuesFeld', 42).unbekannt).to.equal(true);
        expect(felder.beschreibe('target', 20).unbekannt).to.equal(undefined);
    });

    it('trennt Sollwert und Raumtemperatur richtig', () => {
        // Belegt durch die HA-Discovery des Geraets: temp_stat_tpl = {{value_json.target}},
        // curr_temp_tpl = {{value_json.temp}}. Geschrieben wird aber auf command/<Name>/temp.
        expect(felder.FELDER.target.w, 'target ist der schreibbare Sollwert').to.equal(true);
        expect(felder.FELDER.target.cmd, 'target schreibt auf das temp-Topic').to.equal('temp');
        expect(felder.FELDER.target.kanal).to.equal('control');
        expect(!!felder.FELDER.temp.w, 'temp ist die Raumtemperatur, nur lesbar').to.equal(false);
        expect(felder.FELDER.temp.kanal).to.equal('status');
    });

    it('verwirft die Platzhalter-Luftfeuchte, bis ein echter Wert kam', () => {
        // Anlage ohne Sensor: meldet dauerhaft 50, das ist kein Messwert.
        let bekannt = false;
        let u = felder.feuchteBewerten(50, bekannt);
        expect(u.nehmen, '50 ohne Vorgeschichte ist ein Platzhalter').to.equal(false);
        expect(u.echtAbJetzt).to.equal(false);

        // Sobald ein anderer Wert kommt, gibt es einen Sensor.
        u = felder.feuchteBewerten(53, bekannt);
        expect(u.nehmen).to.equal(true);
        expect(u.echtAbJetzt).to.equal(true);
        bekannt = true;

        // Ab dann sind auch 50 % ein gültiger Messwert.
        u = felder.feuchteBewerten(50, bekannt);
        expect(u.nehmen, '50 nach erkanntem Sensor ist echt').to.equal(true);
        expect(u.echtAbJetzt).to.equal(true);
    });

    it('kennt alle sieben swing-Werte, nicht nur off/on', () => {
        // Die HA-Discovery meldet nur off|on, das Gerät sendet aber auch H, V, H+V, C und H+C
        // (SWING_* in Faikout.c). Live stand am Wohnzimmer-Gerät "V" - mit einer Liste aus
        // nur off/on wäre das im VIS ein unbekannter Zustand.
        const s = felder.FELDER.swing.states;
        for (const w of ['off', 'on', 'V', 'H', 'H+V', 'C', 'H+C']) {
            expect(s, `swing muss "${w}" kennen`).to.have.property(w);
        }
    });

    it('kennt die Felder der Faikout-Automatik', () => {
        for (const f of ['autoe', 'autop', 'autor', 'autot', 'auto0', 'auto1']) {
            expect(felder.beschreibe(f, 0).unbekannt, `${f} sollte bekannt sein`).to.equal(undefined);
        }
    });

    it('macht Bindestriche in Objekt-IDs unschädlich', () => {
        expect(felder.objektId('mqtt-up')).to.equal('mqttUp');
        expect(felder.objektId('build-suffix')).to.equal('buildSuffix');
        expect(felder.objektId('hum')).to.equal('hum');
    });
});
