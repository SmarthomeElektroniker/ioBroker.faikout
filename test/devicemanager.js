'use strict';

/*
 * Device-Manager (lib/devicemanager.js) - nur mit Attrappen, keine echte Klimaanlage.
 *
 * Vorgabe: Karten zeigen den laufenden Betrieb und bieten Alltagsbedienung (Ein/Aus,
 * Betriebsart, Solltemperatur, Luefterstufe). Keine Konfigurationsaktionen.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { MODUS_TEXTE, LUEFTER_TEXTE, TAETIGKEIT_TEXTE, TEXTE, UMSCHALTEN } = require('../lib/devicemanager');
const felder = require('../lib/fields');

const SPRACHEN = felder.SPRACHEN;

/** Ersatz fuer die Adapterklasse des js-controllers. */
class Attrappe {
    constructor() {
        this.namespace = 'faikout.0';
        this.config = {};
        this.objekte = new Map();
        this.werte = new Map();
        this.gesetzt = [];
        this.zeitgeber = [];
        this.lauscher = {};
        const leer = () => {};
        this.warnungen = [];
        this.log = { debug: leer, info: leer, warn: m => this.warnungen.push(m), error: m => this.warnungen.push(m) };
    }
    on(ereignis, f) {
        this.lauscher[ereignis] = f;
    }
    rel(id) {
        return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
    async getObjectAsync(id) {
        const o = this.objekte.get(this.rel(id));
        return o ? JSON.parse(JSON.stringify(o)) : null;
    }
    async extendObject(id, obj) {
        const alt = this.objekte.get(id) || {};
        const neu = { ...alt, ...obj, _id: `${this.namespace}.${id}` };
        for (const k of ['common', 'native']) {
            if (obj[k]) {
                neu[k] = { ...(alt[k] || {}), ...obj[k] };
            }
        }
        this.objekte.set(id, JSON.parse(JSON.stringify(neu)));
    }
    async setState(id, wert) {
        this.gesetzt.push({ id, wert });
        this.werte.set(id, wert);
    }
    async getStateAsync(id) {
        const w = this.werte.get(this.rel(id));
        if (w === undefined) {
            return null;
        }
        const val = w && typeof w === 'object' && 'val' in w ? w.val : w;
        return { val, ack: !!(w && w.ack), ts: 1, lc: 1, from: 'test', q: 0 };
    }
    sendTo(an, befehl, nachricht, callback) {
        this.gesendet = this.gesendet || [];
        this.gesendet.push({ an, befehl, nachricht, callback });
    }
    async getDevicesAsync() {
        return [...this.objekte.values()].filter(o => o.type === 'device');
    }
    async getObjectViewAsync(_design, typ, { startkey, endkey }) {
        const rows = [...this.objekte.values()]
            .filter(o => o.type === typ && o._id >= startkey && o._id <= endkey)
            .map(o => ({ id: o._id, value: JSON.parse(JSON.stringify(o)) }));
        return { rows };
    }
    // Zeitgeber werden von Hand ausgeloest
    setTimeout(f, ms) {
        const t = { f, ms, aktiv: true };
        this.zeitgeber.push(t);
        return t;
    }
    clearTimeout(t) {
        if (t) {
            t.aktiv = false;
        }
    }
    zeitgeberAusloesen() {
        const faellig = this.zeitgeber.filter(t => t.aktiv);
        this.zeitgeber = [];
        faellig.forEach(t => t.f());
    }
}

const warte = async () => {
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setImmediate(r));
    }
};

const MELDUNG = {
    power: true,
    mode: 'heat',
    target: 21,
    temp: 21.5,
    outside: 5,
    fan: 'auto',
    consumption: 420,
    online: true,
    rssi: -61,
    model: 'FTXM25R',
    energy: 123456,
};

/** Adapter mit einer Klimaanlage "Wohnzimmer AC", die sich gemeldet hat. */
async function adapterMitGeraet(meldung = MELDUNG) {
    const a = proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
    a.veroeffentlicht = [];
    a.broker = {
        publish: async (topic, nutzlast) => {
            a.veroeffentlicht.push({ topic, nutzlast });
            return true;
        },
    };
    a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify(meldung)));
    a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ up: true })));
    await warte();
    a.gesetzt = [];
    return a;
}

/** Ladekontext wie in dm-utils. */
async function kartenLaden(a) {
    const karten = [];
    let gesamt = null;
    await a.deviceManagement.loadDevices({
        addDevice: k => karten.push(k),
        setTotalDevices: n => (gesamt = n),
    });
    return { karten, gesamt };
}

describe('Device-Manager: Instanz', () => {
    it('meldet API v3 und bietet KEINE Instanzaktionen an', async () => {
        const a = await adapterMitGeraet();
        const info = await a.deviceManagement.getInstanceInfo();
        expect(info.apiVersion).to.equal('v3');
        expect(info.actions || []).to.have.length(0);
        // kein zusaetzlicher Kommunikations-Datenpunkt
        expect(info.communicationStateId).to.equal(undefined);
        expect(a.objekte.has('info.deviceManager')).to.equal(false);
    });

    it('lauscht auf sendTo-Nachrichten (dm:*)', async () => {
        const a = await adapterMitGeraet();
        expect(a.lauscher.message).to.be.a('function');
    });

    it('io-package meldet supportedMessages.deviceManager', () => {
        const io = require('../io-package.json');
        expect(io.common.supportedMessages).to.eql({ deviceManager: true });
    });
});

describe('Device-Manager: Karte', () => {
    it('eine Karte je Klimaanlage, ID ja, Hersteller nein, nur die Ein/Aus-Aktion', async () => {
        const a = await adapterMitGeraet();
        const { karten, gesamt } = await kartenLaden(a);
        expect(gesamt).to.equal(1);
        expect(karten).to.have.length(1);
        const k = karten[0];
        expect(k.id).to.equal('Wohnzimmer_AC');
        expect(k.name).to.equal('Wohnzimmer AC');
        expect(k.identifier).to.equal('Wohnzimmer AC');
        expect(k.icon).to.equal('airCondition');
        expect(k.manufacturer).to.equal(undefined);
        expect(k.actions.map(x => x.id)).to.eql([UMSCHALTEN]);
        expect(k.model).to.eql({ stateId: 'faikout.0.Wohnzimmer_AC.status.model' });
    });

    it('Verbindung vom Modul, Warnung wenn die Klimaanlage nicht antwortet, WLAN-Signal', async () => {
        const a = await adapterMitGeraet();
        const { status } = (await kartenLaden(a)).karten[0];
        expect(status.connection).to.eql({
            stateId: 'faikout.0.Wohnzimmer_AC.info.up',
            mapping: { true: 'connected', false: 'disconnected' },
        });
        expect(status.warning.stateId).to.equal('faikout.0.Wohnzimmer_AC.info.online');
        expect(status.warning.mapping.true).to.equal(false);
        expect(status.warning.mapping.false).to.equal(TEXTE.nichtErreichbar);
        expect(status.rssi).to.eql({ stateId: 'faikout.0.Wohnzimmer_AC.info.rssi' });
    });

    it('ohne `up` zeigt `online` die Verbindung', async () => {
        const a = await adapterMitGeraet();
        a.objekte.delete('Wohnzimmer_AC.info.up');
        const { status } = (await kartenLaden(a)).karten[0];
        expect(status.connection.stateId).to.equal('faikout.0.Wohnzimmer_AC.info.online');
        expect(status.warning).to.equal(undefined);
    });

    it('Karte: Betriebsart und Luefterstufe bedienbar, Sollwert mit Schieber, Rest nur lesend', async () => {
        const a = await adapterMitGeraet();
        const { customInfo } = (await kartenLaden(a)).karten[0];
        const items = customInfo.schema.items;
        expect(Object.keys(items)).to.eql([
            'mode',
            'temp',
            'target',
            'targetSlider',
            'fan',
            'outside',
            'consumption',
            'energyToday',
        ]);
        // keine Ein/Aus-Zeile mehr - das ist der Umschalter in der Statuszeile
        expect(items.power).to.equal(undefined);
        const bedienbar = ['mode', 'targetSlider', 'fan'];
        for (const [k, i] of Object.entries(items)) {
            expect(i.type).to.equal('state');
            expect(i.foreign).to.equal(true);
            expect(a.objekte.has(a.rel(i.oid)), i.oid).to.equal(true);
            // bedienbar heisst: NICHT readOnly (sonst graut der Admin das Feld aus)
            expect(!!i.readOnly, k).to.equal(!bedienbar.includes(k));
        }
        expect(items.mode.control).to.equal('select');
        expect(items.mode.options.map(o => o.value)).to.eql(felder.MODES);
        expect(items.fan.control).to.equal('select');
        expect(items.fan.options.map(o => o.value)).to.eql(felder.FAN_MODES);
        const s = items.targetSlider;
        expect([s.control, s.min, s.max, s.step, s.controlDelay]).to.eql(['slider', 16, 29, 0.5, 1000]);
        expect(s.oid).to.equal('faikout.0.Wohnzimmer_AC.control.target');
        expect(items.energyToday.oid).to.equal('faikout.0.Wohnzimmer_AC.consumption.total.today');
        expect(items.consumption.unit).to.equal('W');
    });

    it('Bedienung auch bei ausgeschalteter Anlage: nichts haengt am Ein/Aus-Zustand', async () => {
        const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
        const k = (await kartenLaden(a)).karten[0];
        const items = k.customInfo.schema.items;
        for (const key of ['mode', 'targetSlider', 'fan']) {
            expect(items[key].readOnly, key).to.equal(undefined);
            expect(items[key].disabled, key).to.equal(undefined);
            expect(items[key].hidden, key).to.equal(undefined);
        }
        // "Aus" bleibt als Auswahl, damit der aktuelle Wert angezeigt wird
        expect(items.mode.options.map(o => o.value)).to.include('off');
        expect(k.controls.map(c => c.id)).to.eql(['mode', 'target', 'fan']);
    });

    it('Betriebsart waehlen, waehrend die Anlage aus ist: ein Befehl mode, kein eigener power-Befehl', async () => {
        // Das Modul schaltet bei command/<Name>/mode selbst ein (Faikout.c: power = Wert != "off").
        const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
        // so schreibt der Admin aus der Kartenzeile (ConfigState): ohne ack in den Datenpunkt
        await a.onStateChange('faikout.0.Wohnzimmer_AC.control.mode', { val: 'cool', ack: false });
        expect(a.veroeffentlicht).to.eql([{ topic: 'command/Wohnzimmer AC/mode', nutzlast: 'cool' }]);
    });

    it('Luftfeuchte als Zahl mit %, nicht als Fortschrittsbalken', async () => {
        const a = await adapterMitGeraet({ ...MELDUNG, hum: 47 });
        const hum = (await kartenLaden(a)).karten[0].customInfo.schema.items.hum;
        // Ein state-Element mit Einheit % zeichnet der Admin als Balken - deshalb staticText.
        expect(hum.type).to.equal('staticText');
        expect(hum.format).to.equal('html');
        expect(hum.dependsOnStates).to.eql({ v: 'faikout.0.Wohnzimmer_AC.status.hum' });
        expect(Object.keys(hum.text)).to.eql(['func']);
        const html = hum.text.func;
        for (const l of SPRACHEN) {
            expect(html[l], l).to.contain('${Math.round(Number(_states.v?.val))}');
            expect(html[l], l).to.contain('%</span>');
            expect(html[l], l).not.to.match(/progress/i);
        }
        expect(html.de).to.contain('Luftfeuchte innen');
        // Musterauswertung des Admins: im Ausdruck keine schliessende geschweifte Klammer
        const ausdruecke = html.de.match(/\$\{[^}]*\}/g);
        expect(ausdruecke).to.eql(['${Math.round(Number(_states.v?.val))}']);
        // so rechnet der Admin das Muster aus (Template-String mit _states)
        const f = new Function('_states', `return \`${html.de}\`;`);
        expect(f({ v: { val: 46.6 } })).to.contain('<span>47</span>');
        // ohne Wert ausgeblendet
        const versteckt = new Function('_states', `return ${hum.hidden};`);
        expect(versteckt({ v: { val: 47 } })).to.equal(false);
        expect(versteckt({ v: { val: null } })).to.equal(true);
        expect(versteckt({})).to.equal(true);
    });

    it('abgelehnte Einstellung und Trennungsgrund nicht auf der Karte (zu lang für eine Zeile)', async () => {
        const a = await adapterMitGeraet();
        await a.einstellungAbgelehnt('Wohnzimmer AC', { settings: { demand: 90 }, text: 'demand=90' });
        a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ up: false, reason: 'LWT' })));
        await warte();
        const items = (await kartenLaden(a)).karten[0].customInfo.schema.items;
        expect(items.failedSet).to.equal(undefined);
        expect(items.reason).to.equal(undefined);
        expect(a.objekte.has('Wohnzimmer_AC.info.failedSet')).to.equal(true);
    });

    it('Bedien-Dialog: Betriebsart, Solltemperatur, Luefterstufe - jedes mit getStateHandler', async () => {
        const a = await adapterMitGeraet();
        const { controls } = (await kartenLaden(a)).karten[0];
        expect(controls.map(c => [c.id, c.type])).to.eql([
            ['mode', 'select'],
            ['target', 'slider'],
            ['fan', 'select'],
        ]);
        for (const c of controls) {
            expect(c.stateId).to.equal(`faikout.0.Wohnzimmer_AC.control.${c.id}`);
            expect(c.handler).to.be.a('function');
            expect(c.getStateHandler).to.be.a('function');
        }
        const target = controls.find(c => c.id === 'target');
        expect([target.min, target.max, target.step, target.unit]).to.eql([16, 29, 0.5, '°C']);
        expect(controls.find(c => c.id === 'fan').options.map(o => o.value)).to.eql(felder.FAN_MODES);
    });

    it('Ein/Aus-Umschalter in der Statuszeile: Symbol, Text und Tooltip folgen control.power', async () => {
        const a = await adapterMitGeraet();
        const k = (await kartenLaden(a)).karten[0];
        expect(k.indicators).to.have.length(1);
        const ind = k.indicators[0];
        expect(ind.value).to.eql({ stateId: 'faikout.0.Wohnzimmer_AC.control.power' });
        expect(ind.actionId).to.equal(UMSCHALTEN);
        expect(ind.hideIfEmpty).to.equal(false);
        const [ein, aus, sonst] = ind.levels;
        expect([ein.value, ein.text, ein.tooltip]).to.eql([true, TEXTE.an, TEXTE.tipAusschalten]);
        expect([aus.value, aus.text, aus.tooltip]).to.eql([false, TEXTE.aus, TEXTE.tipEinschalten]);
        expect(sonst.value).to.equal(undefined);
        expect(ein.icon).to.match(/^data:image\/svg\+xml;base64,/);
        expect(ein.icon).not.to.equal(aus.icon);
        // die Aktion steht nicht zusaetzlich als Knopf in der Fusszeile
        expect(k.actions.find(x => x.id === UMSCHALTEN).placement).to.equal(undefined);
    });

    it('ohne beschreibbares control.power kein Umschalter', async () => {
        const a = await adapterMitGeraet();
        a.objekte.get('Wohnzimmer_AC.control.power').common.write = false;
        const k = (await kartenLaden(a)).karten[0];
        expect(k.indicators).to.equal(undefined);
        expect(k.actions).to.equal(undefined);
    });

    it('Sollwertbereich folgt der HA-Discovery des Geraets', async () => {
        const a = await adapterMitGeraet();
        await a.klimaConfig(
            JSON.stringify({ avty_t: 'state/Wohnzimmer AC', min_temp: 18, max_temp: 30, temp_step: 1 }),
        );
        const target = (await kartenLaden(a)).karten[0].controls.find(c => c.id === 'target');
        expect([target.min, target.max, target.step]).to.eql([18, 30, 1]);
    });

    it('ohne gemeldete Felder keine Bedienelemente', async () => {
        const a = await adapterMitGeraet({ online: true, rssi: -70 });
        const k = (await kartenLaden(a)).karten[0];
        expect(k.controls).to.eql([]);
        expect(Object.keys(k.customInfo.schema.items)).to.eql([]);
    });
});

describe('Device-Manager: Bedienen (Attrappe, keine echte Anlage)', () => {
    const bediene = async (a, control, wert) => {
        const { controls } = (await kartenLaden(a)).karten[0];
        const c = controls.find(x => x.id === control);
        return c.handler('Wohnzimmer_AC', control, wert);
    };

    /** js-controller: ein ack:false-Schreiben kommt als stateChange beim Adapter an. */
    const zustellen = async a => {
        for (const { id, wert } of a.gesetzt.filter(g => !g.wert.ack)) {
            await a.onStateChange(`faikout.0.${id}`, wert);
        }
    };

    /** Aktion wie aus dem Admin, Rueckfrage wird mit `antwort` beantwortet. */
    const umschalten = async (a, antwort) => {
        const k = (await kartenLaden(a)).karten[0];
        const fragen = [];
        const context = {
            showConfirmation: async text => {
                fragen.push(text);
                return antwort;
            },
        };
        const ergebnis = await k.actions.find(x => x.id === UMSCHALTEN).handler('Wohnzimmer_AC', context);
        return { ergebnis, fragen };
    };

    it('Umschalter bei laufender Anlage: fragt "ausschalten?" und schreibt false ohne ack', async () => {
        const a = await adapterMitGeraet();
        const { ergebnis, fragen } = await umschalten(a, true);
        expect(fragen).to.have.length(1);
        expect(fragen[0].de).to.equal('Klimaanlage „Wohnzimmer AC“ ausschalten?');
        expect(fragen[0].en).to.equal('Switch off the air conditioner "Wohnzimmer AC"?');
        expect(ergebnis).to.eql({ refresh: false });
        expect(a.gesetzt).to.eql([{ id: 'Wohnzimmer_AC.control.power', wert: { val: false, ack: false } }]);
        await zustellen(a);
        expect(a.veroeffentlicht).to.eql([{ topic: 'command/Wohnzimmer AC/power', nutzlast: 'false' }]);
    });

    it('Umschalter bei ausgeschalteter Anlage: fragt "einschalten?" und schreibt true', async () => {
        const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
        const { fragen } = await umschalten(a, true);
        expect(fragen[0].de).to.equal('Klimaanlage „Wohnzimmer AC“ einschalten?');
        expect(a.gesetzt).to.eql([{ id: 'Wohnzimmer_AC.control.power', wert: { val: true, ack: false } }]);
    });

    it('Umschalter: "Nein" in der Rueckfrage schaltet nichts', async () => {
        const a = await adapterMitGeraet();
        const { fragen } = await umschalten(a, false);
        expect(fragen).to.have.length(1);
        expect(a.gesetzt).to.eql([]);
        await zustellen(a);
        expect(a.veroeffentlicht).to.eql([]);
    });

    it('Betriebsart und Luefterstufe nur mit gueltigem Wert', async () => {
        const a = await adapterMitGeraet();
        expect((await bediene(a, 'mode', 'cool')).val).to.equal('cool');
        expect((await bediene(a, 'fan', 'night')).val).to.equal('night');
        expect((await bediene(a, 'mode', 'turbo')).error.code).to.equal(400);
        expect((await bediene(a, 'fan', 'irgendwas')).error).to.be.an('object');
        expect(a.gesetzt.map(g => [g.id, g.wert.val])).to.eql([
            ['Wohnzimmer_AC.control.mode', 'cool'],
            ['Wohnzimmer_AC.control.fan', 'night'],
        ]);
        await zustellen(a);
        expect(a.veroeffentlicht.map(v => `${v.topic}=${v.nutzlast}`)).to.eql([
            'command/Wohnzimmer AC/mode=cool',
            'command/Wohnzimmer AC/fan=night',
        ]);
    });

    it('Solltemperatur: Schieber wird beruhigt, nur der letzte Wert geht raus (als temp)', async () => {
        const a = await adapterMitGeraet();
        await bediene(a, 'target', 21.5);
        await bediene(a, 'target', 22);
        const letzte = await bediene(a, 'target', 22.3);
        expect(letzte.val).to.equal(22.5); // auf die Schrittweite gerundet
        expect(a.gesetzt).to.eql([]); // noch nichts geschrieben
        a.zeitgeberAusloesen();
        await warte();
        expect(a.gesetzt).to.eql([{ id: 'Wohnzimmer_AC.control.target', wert: { val: 22.5, ack: false } }]);
        await zustellen(a);
        // Asymmetrie des Moduls: gelesen als target, geschrieben auf temp
        expect(a.veroeffentlicht).to.eql([{ topic: 'command/Wohnzimmer AC/temp', nutzlast: '22.5' }]);
    });

    it('Solltemperatur wird auf den Bereich begrenzt, Unsinn abgelehnt', async () => {
        const a = await adapterMitGeraet();
        expect((await bediene(a, 'target', 40)).val).to.equal(29);
        expect((await bediene(a, 'target', '10')).val).to.equal(16);
        expect((await bediene(a, 'target', 'warm')).error).to.be.an('object');
    });

    it('unbekanntes Geraet oder Bedienelement wird abgelehnt', async () => {
        const a = await adapterMitGeraet();
        const dm = a.deviceManagement;
        expect((await dm.bedienen('Gibtsnicht', 'mode', 'cool')).error).to.be.an('object');
        expect((await dm.bedienen('Wohnzimmer_AC', 'power', true)).error).to.be.an('object');
        expect((await dm.bedienen('Wohnzimmer_AC', 'demand', 50)).error).to.be.an('object');
        expect(a.gesetzt).to.eql([]);
    });

    it('beim Beenden wird ein wartender Sollwert verworfen', async () => {
        const a = await adapterMitGeraet();
        await bediene(a, 'target', 23);
        a.deviceManagement.beenden();
        a.zeitgeberAusloesen();
        await warte();
        expect(a.gesetzt).to.eql([]);
    });
});

describe('Device-Manager: Weg ueber sendTo wie aus dem Admin', () => {
    const nachricht = (a, command, message, nr) =>
        a.lauscher.message({ _id: nr, command, message, from: 'system.adapter.admin.0', callback: { id: nr } });

    it('dm:instanceInfo, dm:loadDevices und dm:deviceControl', async () => {
        const a = await adapterMitGeraet();
        nachricht(a, 'dm:instanceInfo', {}, 1);
        await warte();
        const info = a.gesendet.find(g => g.befehl === 'dm:instanceInfo').nachricht;
        expect(info.apiVersion).to.equal('v3');
        expect(info.actions).to.equal(undefined);

        nachricht(a, 'dm:loadDevices', {}, 2);
        await warte();
        const geladen = JSON.stringify(a.gesendet.filter(g => g.befehl === 'dm:loadDevices'));
        expect(geladen).to.contain('Wohnzimmer_AC');
        expect(geladen).not.to.contain('handler');

        nachricht(a, 'dm:deviceControl', { deviceId: 'Wohnzimmer_AC', controlId: 'mode', state: 'dry' }, 3);
        await warte();
        expect(a.gesetzt).to.eql([{ id: 'Wohnzimmer_AC.control.mode', wert: { val: 'dry', ack: false } }]);
        const antwort = a.gesendet.find(g => g.befehl === 'dm:deviceControl').nachricht;
        expect(JSON.stringify(antwort)).to.contain('"val":"dry"');
    });

    it('dm:deviceControlState (Admin fragt den Wert jedes Bedienelements ab): Wert, keine Warnung', async () => {
        const a = await adapterMitGeraet();
        a.warnungen = [];
        nachricht(a, 'dm:loadDevices', {}, 10);
        await warte();
        let nr = 11;
        for (const controlId of ['mode', 'target', 'fan']) {
            nachricht(a, 'dm:deviceControlState', { deviceId: 'Wohnzimmer_AC', controlId }, nr++);
        }
        await warte();
        expect(a.warnungen).to.eql([]);
        const antworten = a.gesendet.filter(g => g.befehl === 'dm:deviceControlState').map(g => g.nachricht);
        expect(antworten).to.have.length(3);
        expect(JSON.stringify(antworten)).not.to.contain('no handler');
        expect(antworten.map(x => x.result.state.val)).to.eql(['heat', 21, 'auto']);
    });

    it('dm:deviceAction powerToggle: Rueckfrage, nach "Ja" wird geschaltet', async () => {
        const a = await adapterMitGeraet();
        a.warnungen = [];
        nachricht(a, 'dm:loadDevices', {}, 20);
        await warte();
        nachricht(a, 'dm:deviceAction', { deviceId: 'Wohnzimmer_AC', actionId: UMSCHALTEN }, 21);
        await warte();
        const frage = a.gesendet.filter(g => g.befehl === 'dm:deviceAction').pop().nachricht;
        expect(frage.type).to.equal('confirm');
        expect(frage.confirm.de).to.contain('ausschalten?');
        expect(a.gesetzt).to.eql([]);
        nachricht(a, 'dm:actionProgress', { origin: 21, confirm: true }, 22);
        await warte();
        expect(a.gesetzt).to.eql([{ id: 'Wohnzimmer_AC.control.power', wert: { val: false, ack: false } }]);
        expect(a.warnungen).to.eql([]);
    });

    it('fremde Nachrichten (ohne dm:) bleiben unbeantwortet', async () => {
        const a = await adapterMitGeraet();
        nachricht(a, 'getIrgendwas', {}, 4);
        await warte();
        expect(a.gesendet).to.equal(undefined);
    });
});

describe('Device-Manager: Uebersetzungen', () => {
    const alle = {
        ...Object.fromEntries(Object.entries(TEXTE).map(([k, v]) => [`TEXTE.${k}`, v])),
        ...Object.fromEntries(Object.entries(MODUS_TEXTE).map(([k, v]) => [`Modus.${k}`, v])),
        ...Object.fromEntries(Object.entries(LUEFTER_TEXTE).map(([k, v]) => [`Luefter.${k}`, v])),
        ...Object.fromEntries(Object.entries(TAETIGKEIT_TEXTE).map(([k, v]) => [`Taetigkeit.${k}`, v])),
    };
    it('Rueckfragen enthalten in jeder Sprache den Platzhalter {name}', () => {
        for (const l of SPRACHEN) {
            expect(TEXTE.frageEinschalten[l], l).to.contain('{name}');
            expect(TEXTE.frageAusschalten[l], l).to.contain('{name}');
        }
    });
    it('jeder Text in allen elf Sprachen', () => {
        for (const [name, t] of Object.entries(alle)) {
            for (const l of SPRACHEN) {
                expect(t[l], `${name} ${l}`).to.be.a('string').and.not.equal('');
            }
        }
    });
    it('jede Betriebsart, Luefterstufe und Taetigkeit hat einen Text', () => {
        expect(Object.keys(MODUS_TEXTE)).to.eql(felder.MODES);
        expect(Object.keys(LUEFTER_TEXTE)).to.eql(felder.FAN_MODES);
        expect(Object.keys(TAETIGKEIT_TEXTE)).to.eql(felder.HVAC_ACTIONS);
    });
});
