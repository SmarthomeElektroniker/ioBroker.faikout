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

    it('nimmt eine Verbindung an und reicht Nachrichten durch', async function () {
        this.timeout(15000);
        port = await freierPort();
        const empfangen = [];
        broker = new FaikoutBroker({
            port,
            log: stilleLog,
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

        client.publish('state/Daikin 1OG', JSON.stringify({ power: true, temp: 19 }));
        await new Promise(r => setTimeout(r, 500));
        await new Promise(r => client.end(false, {}, r));

        expect(empfangen.length).to.be.greaterThan(0);
        expect(empfangen[0][0]).to.equal('state/Daikin 1OG');
        expect(JSON.parse(empfangen[0][1]).temp).to.equal(19);
    });

    it('weist falsche Anmeldedaten ab', async function () {
        this.timeout(15000);
        port = await freierPort();
        broker = new FaikoutBroker({ port, user: 'a', pass: 'b', log: stilleLog, onMessage() {} });
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
        broker = new FaikoutBroker({ port, log: stilleLog, onMessage() {} });
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
        await broker.publish('command/Daikin 1OG/temp', '21');
        const [topic, nutzlast] = await gesehen;
        await new Promise(r => client.end(false, {}, r));

        expect(topic).to.equal('command/Daikin 1OG/temp');
        expect(nutzlast).to.equal('21');
    });
});

describe('Feldkunde', () => {
    it('kennt die schreibbaren Steuerfelder', () => {
        for (const f of ['power', 'mode', 'target', 'fan', 'swing', 'preset', 'demand', 'econo',
            'powerful', 'comfort', 'streamer', 'sensor', 'led', 'quiet', 'humidify']) {
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

    it('kennt alle sechs swing-Werte, nicht nur off/on', () => {
        // Die HA-Discovery meldet nur off|on, das Gerät sendet aber auch H, V, H+V und C
        // (SWING_* in Faikout.c). Live stand am Wohnzimmer-Gerät "V" - mit einer Liste aus
        // nur off/on wäre das im VIS ein unbekannter Zustand.
        const s = felder.FELDER.swing.states;
        for (const w of ['off', 'on', 'V', 'H', 'H+V', 'C']) {
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
