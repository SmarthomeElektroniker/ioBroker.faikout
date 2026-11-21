'use strict';

const { expect } = require('chai');
const net = require('node:net');
const mqtt = require('mqtt');
const proxyquire = require('proxyquire').noCallThru();
const { FaikoutBroker } = require('../lib/broker');
const { ExternerBroker, testen, praefixVon, fehlerArt } = require('../lib/brokerextern');
const { Attrappe } = require('./sim/simulator');

const log = { debug() {}, info() {}, warn() {}, error() {} };
const timer = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) };
const freierPort = () =>
    new Promise(res => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => res(p));
        });
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

describe('Externer MQTT-Broker', function () {
    this.timeout(15000);
    let fremd; // ein eigener Broker spielt den "externen" (wie Mosquitto)
    let port;
    let modul;

    const starten = async (user, pass) => {
        port = await freierPort();
        fremd = new FaikoutBroker({ port, user, pass, log, timer, onMessage: () => {} });
        await fremd.start();
    };
    afterEach(async () => {
        if (modul) {
            modul.end(true);
            modul = null;
        }
        if (fremd) {
            await fremd.stop();
            fremd = null;
        }
    });

    it('Praefix: ohne fuehrenden, mit einem abschliessenden Schraegstrich; Platzhalter sind verboten', () => {
        expect(praefixVon('')).to.equal('');
        expect(praefixVon(' /haus/klima/ ')).to.equal('haus/klima/');
        expect(praefixVon('haus/#')).to.equal('');
        expect(fehlerArt(new Error('Connection refused: Bad username or password'))).to.equal('anmeldung');
        expect(fehlerArt(new Error('connect ECONNREFUSED 127.0.0.1:1'))).to.equal('nichtErreichbar');
        expect(fehlerArt(new Error('connack timeout'))).to.equal('zeit');
    });

    it('Verbindung testen: erreichbar, Anmeldung falsch, nicht erreichbar, Eingabe fehlt', async () => {
        await starten('klima', 'geheim');
        expect(await testen({ host: '127.0.0.1', port, user: 'klima', pass: 'geheim' })).to.include({
            ok: true,
            art: 'ok',
        });
        expect((await testen({ host: '127.0.0.1', port, user: 'klima', pass: 'falsch' })).art).to.equal('anmeldung');
        expect((await testen({ host: '127.0.0.1', port })).art).to.equal('anmeldung');
        const zu = await freierPort();
        expect((await testen({ host: '127.0.0.1', port: zu }, { zeitlimitMs: 1500 })).art).to.equal('nichtErreichbar');
        expect((await testen({ host: '  ' })).art).to.equal('eingabe');
    });

    it('empfaengt Modulnachrichten ohne Praefix und sendet Befehle mit Praefix; auch gemerkte (retained)', async () => {
        await starten();
        modul = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'Faikout:Sim_ABC' });
        const beimModul = [];
        modul.on('message', (t, p) => beimModul.push([t, p.toString()]));
        await new Promise(r => modul.once('connect', r));
        await new Promise(r => modul.subscribe('haus/command/Sim/#', r));
        // gemerkte Statusmeldung liegt schon am Broker, bevor der Adapter kommt
        await new Promise(r => modul.publish('haus/state/Sim', '{"up":true,"power":true}', { retain: true }, r));
        modul.publish('anderes/state/Fremd', '{"up":true}');
        const empfangen = [];
        const verbindung = [];
        const b = new ExternerBroker({
            host: '127.0.0.1',
            port,
            praefix: 'haus',
            log,
            onMessage: (t, p) => empfangen.push([t, p.toString()]),
            onClient: (id, an) => verbindung.push(an),
        });
        await b.start();
        expect(await bis(() => empfangen.some(e => e[0] === 'state/Sim'))).to.equal(true);
        expect(empfangen.some(e => e[0].includes('Fremd'))).to.equal(false);
        expect(await b.publish('command/Sim/demand', 80)).to.equal(true);
        expect(await bis(() => beimModul.length > 0)).to.equal(true);
        expect(beimModul[0]).to.eql(['haus/command/Sim/demand', '80']);
        expect(await b.publish('setting/Sim', '{"livestatus":true}')).to.equal(true);
        expect(verbindung).to.eql([true]);
        await b.stop();
        expect(await b.publish('command/Sim/demand', 80)).to.equal(false);
    });

    it('Broker nicht erreichbar: start() haelt den Adapter nicht auf, publish meldet false', async () => {
        const zu = await freierPort();
        const zeilen = [];
        const b = new ExternerBroker({
            host: '127.0.0.1',
            port: zu,
            log: { ...log, error: t => zeilen.push(t) },
            onMessage: () => {},
        });
        await b.start();
        expect(await b.publish('command/X/power', 'true')).to.equal(false);
        expect(await bis(() => zeilen.length > 0)).to.equal(true);
        expect(zeilen[0]).to.match(/not reachable/);
        await b.stop();
    });

    it('Anmeldung abgelehnt und der Broker laesst die Verbindung offen: der Adapter verbindet selbst neu, meldet einmal', async () => {
        // mqtt.js tut nach einem CONNACK-Fehler nichts (reconnectOnConnackError ist ab Werk aus) - ohne
        // eigenes Neuverbinden blieb es bei genau EINEM Versuch.
        let versuche = 0;
        const offen = net.createServer(sock => {
            versuche++;
            sock.on('error', () => {});
            sock.on('data', () => sock.write(Buffer.from([0x20, 2, 0, 4]))); // CONNACK: bad user name or password
        });
        const p = await new Promise(res => offen.listen(0, '127.0.0.1', () => res(offen.address().port)));
        const fehler = [];
        const b = new ExternerBroker({
            host: '127.0.0.1',
            port: p,
            user: 'klima',
            pass: 'falsch',
            log: { ...log, error: t => fehler.push(t) },
            onMessage: () => {},
            anmeldungWiederholenMs: 100,
        });
        await b.start();
        expect(await bis(() => versuche >= 4)).to.equal(true);
        expect(fehler).to.have.length(1);
        expect(fehler[0]).to.match(/user name or password not accepted .* trying again every/);
        expect(fehler[0]).to.not.include('falsch');
        // stop() beendet auch die Wiederholung
        await b.stop();
        const stand = versuche;
        await new Promise(r => setTimeout(r, 400));
        expect(versuche).to.equal(stand);
        await new Promise(r => offen.close(r));
    });

    it('Anmeldung abgelehnt, spaeter am Broker berichtigt: verbindet ohne Neustart und meldet "Connected"', async () => {
        await starten('klima', 'geheim');
        const zeilen = [];
        const verbindung = [];
        const b = new ExternerBroker({
            host: '127.0.0.1',
            port,
            user: 'klima',
            pass: 'neu',
            log: { ...log, error: t => zeilen.push(`E ${t}`), info: t => zeilen.push(`I ${t}`) },
            onMessage: () => {},
            onClient: (id, an) => verbindung.push(an),
            anmeldungWiederholenMs: 150,
        });
        await b.start();
        expect(await bis(() => zeilen.some(z => /^E .*not accepted/.test(z)))).to.equal(true);
        await new Promise(r => setTimeout(r, 500)); // mehrere abgelehnte Versuche
        expect(b.verbunden).to.equal(false);
        expect(verbindung).to.eql([]);
        expect(zeilen.filter(z => z.startsWith('E '))).to.have.length(1);
        fremd.pass = 'neu'; // Passwort am Broker berichtigt
        expect(await bis(() => b.verbunden)).to.equal(true);
        expect(zeilen.some(z => /^I Connected to external MQTT broker/.test(z))).to.equal(true);
        expect(verbindung).to.eql([true]);
        expect(await b.publish('command/X/power', 'true')).to.equal(true);
        // dieselbe Ursache wird nach einem Erfolg wieder gemeldet
        expect(b.gemeldet).to.equal('');
        await b.stop();
    });

    it('Standardabstand nach abgelehnter Anmeldung: 60 s', () => {
        expect(require('../lib/brokerextern').ANMELDUNG_WIEDERHOLEN_MS).to.equal(60000);
        expect(new ExternerBroker({ host: 'h', log, onMessage() {} }).wiederholenMs).to.equal(60000);
    });

    it('Adapter im Extern-Betrieb: info.connection und <Geraet>.info.up folgen Brokerverbindung und Meldungen', async () => {
        await starten();
        const a = proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
        Object.assign(a, {
            instance: 0,
            subscribeStates() {},
            subscribeObjectsAsync: async () => {},
            setInterval: () => null,
            clearInterval() {},
            clearTimeout() {},
        });
        a.verbrauchUmziehen = async () => {};
        a.objekteAbgleichen = async () => {};
        a.stundenTaktStarten = () => {};
        a.config = { brokerModus: 'extern', externHost: '127.0.0.1', externPort: port, externClientId: 'test-adapter' };
        // Stand aus dem letzten Lauf: ein Geraet stand noch auf "erreichbar"
        a.objekte.set('Alt', { type: 'device', common: { name: 'Alt' }, native: { wlan: 's3', wlanAn: 's3', wlanAus: false } });
        a.werte.set('Alt.info.up', { val: true, ack: true });
        a.objekte.set('Nie', { type: 'device', common: { name: 'Nie' }, native: {} });
        await a.onReady();
        // Start: up aus dem letzten Lauf gilt nicht mehr; ein Geraet ohne up bekommt keinen Wert
        expect(a.wert('Alt.info.up')).to.equal(false);
        expect(a.objekte.get('Alt').native).to.include({ wlan: 'off', wlanAn: '', wlanAus: true });
        expect(a.werte.has('Nie.info.up')).to.equal(false);
        // Broker verbunden, aber noch kein Modul gemeldet: nicht "verbunden"
        expect(await bis(() => a.broker.verbunden)).to.equal(true);
        expect(a.wert('info.connection')).to.equal(false);
        modul = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'Faikout:Sim_ABC' });
        await new Promise(r => modul.once('connect', r));
        const meldung = JSON.stringify({ up: true, power: true, mode: 'heat', target: 21, temp: 20, rssi: -60 });
        modul.publish('state/Sim', meldung);
        expect(await bis(() => a.wert('info.connection') === true && a.wert('Sim.info.up') === true)).to.equal(true);
        expect(a.objekte.get('Sim').native.wlan).to.equal('s3');
        // Verbindung zum Broker weg: beides false (vorher blieb up true)
        await fremd.stop();
        fremd = null;
        expect(await bis(() => a.wert('info.connection') === false && a.wert('Sim.info.up') === false)).to.equal(true);
        expect(await bis(() => a.objekte.get('Sim').native.wlan === 'off')).to.equal(true);
        // naechste Meldung des Moduls: up wieder true (der Schreib-Zwischenspeicher haelt es nicht zurueck);
        // info.connection bleibt false, solange der Broker fehlt
        a.onMqtt('state/Sim', Buffer.from(meldung));
        expect(await bis(() => a.wert('Sim.info.up') === true && a.geraete.get('Sim').up === true)).to.equal(true);
        expect(a.wert('info.connection')).to.equal(false);
        // Broker wieder da, Modul hat aber seit ueber fuenf Minuten nichts gemeldet: nicht "verbunden"
        a.broker.verbunden = true;
        a.verbindungPruefen();
        expect(a.wert('info.connection')).to.equal(true);
        // das Modul meldet sich ab (letzter Wille ueber den Broker): sofort nicht mehr "verbunden"
        a.onMqtt('state/Sim', Buffer.from('{"up":false}'));
        expect(await bis(() => a.wert('info.connection') === false)).to.equal(true);
        a.onMqtt('state/Sim', Buffer.from(meldung));
        expect(await bis(() => a.wert('info.connection') === true)).to.equal(true);
        a.gesehen.set('Sim', Date.now() - 6 * 60000);
        a.verbindungPruefen(); // im Betrieb der 30-s-Takt
        expect(a.wert('info.connection')).to.equal(false);
        a.gesehen.set('Sim', Date.now());
        a.broker.verbunden = false;
        // Beenden: up false
        await new Promise(res => a.onUnload(res));
        expect(a.wert('Sim.info.up')).to.equal(false);
        expect(a.wert('info.connection')).to.equal(false);
    });

    it('"Verbindung testen": das gespeicherte Passwort nur, wenn die Seite "unveraendert" meldet', async () => {
        const { testPasswort } = require('../lib/brokerextern');
        expect(testPasswort('', true, 'alt')).to.equal('alt');
        expect(testPasswort('getippt', true, 'alt')).to.equal('alt');
        expect(testPasswort('', false, 'alt')).to.equal('');
        expect(testPasswort('getippt', false, 'alt')).to.equal('getippt');
        expect(testPasswort('', 'false', 'alt')).to.equal('');
        // ohne das Feld (aeltere Einstellungsseite): wie bisher
        expect(testPasswort('', undefined, 'alt')).to.equal('alt');
        expect(testPasswort('getippt', undefined, 'alt')).to.equal('getippt');
        expect(testPasswort('', undefined, undefined)).to.equal('');
        // ueber die Nachricht der Einstellungsseite
        const o = require('../lib/oberflaeche');
        const aufrufe = [];
        const a = {
            config: { externPass: 'gespeichert' },
            instance: 0,
            log: { warn() {}, debug() {} },
            sendTo() {},
            getForeignObjectAsync: async () => ({ common: { language: 'en' } }),
            brokerTestFunktion: async x => (aufrufe.push(x.pass), { ok: true, art: 'ok' }),
        };
        const frage = message => o.nachricht(a, { command: 'brokerVerbindungTesten', message, from: 'admin', callback: {} });
        await frage({ host: 'h', user: 'u', pass: '' });
        await frage({ host: 'h', user: 'u', pass: '', passUnveraendert: false });
        await frage({ host: 'h', user: 'u', pass: 'neu', passUnveraendert: false });
        await frage({ host: 'h', user: 'u', pass: '', passUnveraendert: true });
        expect(aufrufe).to.eql(['gespeichert', '', 'neu', 'gespeichert']);
    });

    it('Adapter im Extern-Betrieb: gleiche Wege, Ziel ist der externe Broker; der eigene Broker startet nicht', async () => {
        await starten();
        const gestartet = [];
        class KeinBroker {
            async start() {
                gestartet.push('intern');
            }
        }
        const a = proxyquire('../main', {
            '@iobroker/adapter-core': { Adapter: Attrappe },
            './lib/broker': { FaikoutBroker: KeinBroker },
        })({});
        Object.assign(a, {
            instance: 0,
            subscribeStates() {},
            subscribeObjectsAsync: async () => {},
            setInterval: () => null,
        });
        a.verbrauchUmziehen = async () => {};
        a.objekteAbgleichen = async () => {};
        a.stundenTaktStarten = () => {};
        a.config = {
            brokerModus: 'extern',
            externHost: '127.0.0.1',
            externPort: port,
            port: 1888,
            moduleAddress: '192.0.2.5',
            user: 'intern',
        };
        await a.onReady();
        expect(gestartet).to.eql([]);
        expect(await bis(() => a.broker.verbunden)).to.equal(true);
        expect(a.brokerZiel()).to.include({ extern: true, adresse: '127.0.0.1', port, user: '' });
        expect(a.eigeneAdressen('10.0.0.1')).to.eql(['127.0.0.1']);
        expect(a.anbindenZiel('10.0.0.1')).to.include({ adresse: '127.0.0.1', port });
        // ein Modul meldet sich am externen Broker: Geraet entsteht wie beim eigenen Broker
        modul = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'Faikout:Sim_ABC' });
        await new Promise(r => modul.once('connect', r));
        modul.publish(
            'state/Sim Extern',
            JSON.stringify({ up: true, power: true, mode: 'heat', target: 21, temp: 20, demand: 100 }),
        );
        expect(await bis(() => a.geraete.has('Sim_Extern'))).to.equal(true);
        expect(a.modulClients()).to.eql(['Sim Extern']);
        expect(a.modulGemeldetSeit('Sim Extern', Date.now() - 60000)).to.equal(true);
        expect(a.geraeteFuerSuche()[0]).to.include({ name: 'Sim Extern', verbunden: true });
        await a.broker.stop();
        // zurueck auf den eigenen Broker: Zielangaben wie vorher
        a.config.brokerModus = 'intern';
        expect(a.brokerZiel()).to.include({ extern: false, adresse: '192.0.2.5', port: 1888, user: 'intern' });
    });
});

describe('Client-ID am externen Broker: einstellbar, Standard einmal erzeugt', () => {
    const b = require('../lib/brokerextern');
    const o = require('../lib/oberflaeche');
    it('neueClientId: Instanz plus fester Zufallsteil, jedes Mal anders', () => {
        expect(b.neueClientId(0)).to.match(/^iobroker-faikout-0-[0-9a-f]{6}$/);
        expect(b.neueClientId(1)).to.not.equal(b.neueClientId(1));
    });
    it('Knopf "Standard wiederherstellen" liefert den gespeicherten Standardwert der Instanz', async () => {
        const gesendet = [];
        const a = { config: { externClientIdStandard: 'iobroker-faikout-0-abc123' }, instance: 0, log: { warn() {} }, sendTo: (an, befehl, antwort) => gesendet.push(antwort) };
        await o.nachricht(a, { command: 'clientIdStandard', message: {}, from: 'admin', callback: {} });
        await o.nachricht(a, { command: 'clientIdStandard', message: { standard: 'aus-dem-formular' }, from: 'admin', callback: {} });
        expect(gesendet).to.eql([{ native: { externClientId: 'iobroker-faikout-0-abc123' } }, { native: { externClientId: 'aus-dem-formular' } }]);
    });
    it('Einstellungsseite: Feld und Knopf nur beim externen Broker, Vorgabe in io-package', () => {
        const B = require('../admin/jsonConfig.json').items.tabBroker.items;
        // Client-ID und Knopf stehen im eingeklappten Abschnitt "Fuer Fortgeschrittene", den es nur
        // beim externen Broker gibt
        const P = B._pFortgeschritten;
        expect(P).to.include({ type: 'panel', collapsable: true, hidden: "data.brokerModus !== 'extern'" });
        expect(P.items.externClientId.type).to.equal('text');
        expect(P.items._clientIdStandard).to.include({ type: 'sendTo', command: 'clientIdStandard' });
        expect(require('../io-package.json').native).to.have.property('externClientIdStandard', '');
    });
});
