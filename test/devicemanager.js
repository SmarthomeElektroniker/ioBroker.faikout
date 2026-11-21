'use strict';

/*
 * Device-Manager (lib/devicemanager.js) - nur mit Attrappen, keine echte Klimaanlage.
 *
 * Vorgabe: Karten zeigen den laufenden Betrieb und bieten Alltagsbedienung (Ein/Aus,
 * Betriebsart, Solltemperatur, Luefterstufe). Keine Konfigurationsaktionen.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const {
    MODUS_TEXTE,
    LUEFTER_TEXTE,
    TAETIGKEIT_TEXTE,
    TEXTE,
    UMSCHALTEN,
    STUFEN_TOOLTIP,
    WLAN_TEXTE,
    STUFEN_SYMBOL,
    BALKEN_STUFEN,
} = require('../lib/devicemanager');
const felder = require('../lib/fields');
const namen = require('../lib/namen');

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
        // wie EventEmitter: alle Lauscher bekommen das Ereignis (Device-Manager und main.js fuer 'message')
        const vorher = this.lauscher[ereignis];
        this.lauscher[ereignis] = vorher
            ? (...args) => {
                  vorher(...args);
                  return f(...args);
              }
            : f;
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

    it('io-package meldet supportedMessages.deviceManager (und custom fuer "Module suchen")', () => {
        const io = require('../io-package.json');
        expect(io.common.supportedMessages).to.eql({ deviceManager: true, custom: true });
    });
});

describe('Device-Manager: Karte', () => {
    it('eine Karte je Klimaanlage: kein Hersteller, kein Bedien-Dialog, nur die Ein/Aus-Aktion', async () => {
        const a = await adapterMitGeraet();
        const { karten, gesamt } = await kartenLaden(a);
        expect(gesamt).to.equal(1);
        expect(karten).to.have.length(1);
        const k = karten[0];
        expect(k.id).to.equal('Wohnzimmer_AC');
        expect(k.name).to.equal('Wohnzimmer AC');
        // identifier zeichnet der Admin mit Beschriftung "ID" und Kopierknopf - beides nicht gewuenscht
        expect(k.identifier).to.equal(undefined);
        expect(k.icon).to.equal('airCondition');
        expect(k.manufacturer).to.equal(undefined);
        // ohne controls kein Knopf unten rechts und kein Bedien-Dialog
        expect(k.controls).to.equal(undefined);
        expect(k.actions.map(x => x.id)).to.eql([UMSCHALTEN]);
        expect(k.model).to.eql({ stateId: 'faikout.0.Wohnzimmer_AC.status.model' });
    });

    it('EIN WLAN-Symbol fuer Verbindung und Signal, keine eingebaute Verbindungs-/Signalanzeige', async () => {
        const a = await adapterMitGeraet();
        const k = (await kartenLaden(a)).karten[0];
        // die eingebauten Anzeigen zeichneten ein zweites Symbol und einen eigenen Balken
        expect(k.status.connection).to.equal(undefined);
        expect(k.status.rssi).to.equal(undefined);
        // ohne connectionType zeichnet der Admin kein zweites, blasses WLAN-Symbol
        expect(k.connectionType).to.equal(undefined);
        // Warnung, wenn die Klimaanlage hinter dem Modul nicht antwortet, bleibt
        expect(k.status.warning.stateId).to.equal('faikout.0.Wohnzimmer_AC.info.online');
        expect(k.status.warning.mapping.false).to.equal(TEXTE.nichtErreichbar);
        const w = k.indicators.find(i => i.id === 'wlan');
        expect(w.value).to.eql({ objectId: 'faikout.0.Wohnzimmer_AC', property: 'native.wlanAn' });
        expect(w.text).to.eql({ stateId: 'faikout.0.Wohnzimmer_AC.info.rssi' });
        expect(w.unit).to.equal('dBm');
        expect(w.levels.map(l => l.value)).to.eql(['s4', 's3', 's2', 's1']);
        for (const l of w.levels) {
            expect(l.tooltip).to.equal(WLAN_TEXTE[l.value]);
            expect(l.icon).to.match(/^data:image\/svg\+xml;base64,/);
        }
        // Boegen je Stufe: s4 drei gefuellte Boegen, s1 keiner; getrennt grau und durchgestrichen
        // getrennt ist eine eigene Anzeige OHNE Einheit ("Getrennt", nicht "Getrennt dBm")
        const off = k.indicators.find(i => i.id === 'wlanAus');
        const text = b64 => Buffer.from(b64.split(',')[1], 'base64').toString();
        const svg = v => text(v === 'off' ? off.icon : w.levels.find(l => l.value === v).icon);
        const blau = v => (svg(v).match(/#2196f3/g) || []).length;
        expect([blau('s4'), blau('s3'), blau('s2'), blau('s1'), blau('off')]).to.eql([4, 3, 2, 1, 0]);
        expect(svg('off')).to.contain('M4 3.5 20 20.5');
        expect(off.value).to.eql({ objectId: 'faikout.0.Wohnzimmer_AC', property: 'native.wlanAus' });
        expect(off.text).to.equal(WLAN_TEXTE.getrennt);
        expect(off.tooltip).to.equal(WLAN_TEXTE.off);
        expect(off.unit).to.equal(undefined);
        expect(off.color).to.equal('error');
        // steht vor dem Ein/Aus-Umschalter
        expect(k.indicators.map(i => i.id)).to.eql(['wlan', 'wlanAus', 'power']);
    });

    it('WLAN-Stufe im Geraeteobjekt: Grenzen, getrennt, nur bei Aenderung geschrieben', async () => {
        expect([-40, -55, -56, -65, -66, -75, -76, -90].map(r => felder.wlanStufe(r, true))).to.eql([
            's4',
            's4',
            's3',
            's3',
            's2',
            's2',
            's1',
            's1',
        ]);
        expect(felder.wlanStufe(-50, false)).to.equal('off');
        expect(felder.wlanStufe(undefined, undefined)).to.equal(null);
        const a = await adapterMitGeraet(); // rssi -61, up true
        expect(a.objekte.get('Wohnzimmer_AC').native.wlan).to.equal('s3');
        // eine weitere Meldung, damit der Geraetezustand sicher steht (die ersten beiden Meldungen
        // der Attrappe laufen parallel an)
        a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ ...MELDUNG, rssi: -60 })));
        await warte();
        const schreiben = [];
        const alt = a.extendObject.bind(a);
        a.extendObject = async (id, obj) => {
            if (obj && obj.native && 'wlan' in obj.native) {
                schreiben.push(id);
            }
            return alt(id, obj);
        };
        a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ ...MELDUNG, rssi: -63 })));
        await warte();
        expect(schreiben).to.eql([]); // gleiche Stufe: native.wlan wird nicht geschrieben
        a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ up: false })));
        await warte();
        expect(a.objekte.get('Wohnzimmer_AC').native.wlan).to.equal('off');
        // getrennt: die Anzeige mit der Einheit hat keinen Wert mehr, die Anzeige "Getrennt" einen
        expect(a.objekte.get('Wohnzimmer_AC').native).to.include({ wlanAn: '', wlanAus: true });
        a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ up: true })));
        await warte();
        expect(a.objekte.get('Wohnzimmer_AC').native).to.include({ wlan: 's3', wlanAn: 's3', wlanAus: false });
        expect(schreiben).to.have.length(2); // off, dann wieder s3
    });

    it('Karte: Betriebsart waehlbar, Sollwert mit Schieber, Luefterstufe als Stufenregler, Rest lesend', async () => {
        const a = await adapterMitGeraet();
        const { customInfo } = (await kartenLaden(a)).karten[0];
        const items = customInfo.schema.items;
        expect(Object.keys(items)).to.eql([
            'ident',
            'modeLabel',
            'mode',
            'temp',
            'target',
            'targetSlider',
            'fanSteps',
            'outside',
            'consumption',
            'energyToday',
            'energyMonth',
        ]);
        // die ID nur als Wert
        expect(items.ident).to.include({ type: 'staticText', text: 'Wohnzimmer AC', noTranslation: true });
        // keine Ein/Aus-Zeile mehr - das ist der Umschalter in der Statuszeile
        expect(items.power).to.equal(undefined);
        // Beschriftung der Betriebsart links daneben, die Auswahl selbst ohne eigene Beschriftung
        // (sonst laeuft der Rahmen durch den Text)
        expect(items.modeLabel.type).to.equal('staticText');
        expect(items.modeLabel.text).to.eql(namen.vollerName(felder.FELDER.mode.name));
        expect(items.mode.label).to.equal('');
        expect(items.modeLabel.xs + items.mode.xs).to.equal(12);
        const bedienbar = ['mode', 'targetSlider'];
        for (const [k, i] of Object.entries(items).filter(
            ([key]) => !['ident', 'modeLabel', 'fanSteps'].includes(key),
        )) {
            expect(i.type).to.equal('state');
            expect(i.foreign).to.equal(true);
            expect(a.objekte.has(a.rel(i.oid)), i.oid).to.equal(true);
            // bedienbar heisst: NICHT readOnly (sonst graut der Admin das Feld aus)
            expect(!!i.readOnly, k).to.equal(!bedienbar.includes(k));
        }
        // die Auswahl haengt an control.selectedMode und kennt kein "Aus"
        expect(items.mode.oid).to.equal('faikout.0.Wohnzimmer_AC.control.selectedMode');
        expect(items.mode.control).to.equal('select');
        expect(items.mode.options.map(o => o.value)).to.eql(['heat_cool', 'cool', 'heat', 'dry', 'fan_only']);
        // Luefterstufe nur als Stufenregler, keine zusaetzliche Zeile
        expect(items.fan).to.equal(undefined);
        const s = items.targetSlider;
        expect([s.control, s.min, s.max, s.step, s.controlDelay]).to.eql(['slider', 16, 29, 0.5, 1000]);
        expect(s.oid).to.equal('faikout.0.Wohnzimmer_AC.control.target');
        expect(items.energyToday.oid).to.equal('faikout.0.Wohnzimmer_AC.consumption.total.today');
        expect(items.consumption.unit).to.equal('W');
        // kurze Beschriftung auf der Karte, der Datenpunkt heisst weiter "Momentanleistung"
        expect(items.consumption.label.de).to.equal('Leistung');
        expect(items.consumption.label.en).to.equal('Power');
        expect(a.objekte.get('Wohnzimmer_AC.status.consumption').common.name.de).to.equal('Momentanleistung');
    });

    describe('Luefterstufe als Stufenregler', () => {
        const regler = async (meldung = MELDUNG) => {
            const a = await adapterMitGeraet(meldung);
            return (await kartenLaden(a)).karten[0].customInfo.schema.items.fanSteps;
        };
        /** Welche Knoepfe bei Stufe `wert` zu sehen sind (so rechnet der Admin `hidden` aus). */
        const sichtbar = (panel, wert) =>
            Object.entries(panel.items)
                .filter(([k]) => k !== 'label')
                .filter(([, i]) => !new Function('_states', `return ${i.hidden};`)({ v: { val: wert } }))
                .map(([k]) => k);

        it('ein Knopf je Stufe: Auto, Leise und fuenf Balken - jeder schreibt seine Stufe', async () => {
            const p = await regler();
            expect(p.type).to.equal('panel');
            // Beschriftung links, nimmt den freien Platz - die Knoepfe stehen rechtsbuendig
            const { label, ...knoepfe } = p.items;
            expect(label.type).to.equal('staticText');
            expect(label.text).to.eql(namen.vollerName(felder.FELDER.fan.name));
            expect(label.xs).to.equal('grow');
            expect(p.innerStyle.justifyContent).to.equal('flex-end');
            const werte = [...new Set(Object.values(knoepfe).map(i => i.buttonValue))];
            expect(werte).to.eql(['auto', 'night', ...BALKEN_STUFEN]);
            expect([...werte].sort()).to.eql([...felder.FAN_MODES].sort());
            for (const i of Object.values(knoepfe)) {
                expect(i.xs).to.equal('auto');
                expect(i.type).to.equal('state');
                expect(i.control).to.equal('button');
                expect(i.oid).to.equal('faikout.0.Wohnzimmer_AC.control.fan');
                expect(i.dependsOnStates).to.eql({ v: 'faikout.0.Wohnzimmer_AC.control.fan' });
                expect(i.readOnly).to.equal(undefined);
                expect(i.tooltip).to.equal(STUFEN_TOOLTIP[i.buttonValue] || LUEFTER_TEXTE[i.buttonValue]);
                expect(i.falseText, i.buttonValue).to.not.equal('');
            }
            // Auto und Leise als Symbole (Hintergrundbild), Tooltips "Automatisch" / "Leise"
            for (const k of ['autoOn', 'autoOff', 'nightOn', 'nightOff']) {
                expect(p.items[k].falseText).to.equal('\u200b');
                expect(p.items[k].falseTextStyle.backgroundImage).to.match(/^url\("data:image\/svg\+xml;base64,/);
                expect(p.items[k].falseTextStyle.height).to.equal(30);
            }
            const svg = k => Buffer.from(p.items[k].falseTextStyle.backgroundImage.slice(31, -2), 'base64').toString();
            expect(svg('autoOn')).to.contain(STUFEN_SYMBOL.auto).and.contain('stroke="#ffffff"');
            expect(svg('nightOff')).to.contain(STUFEN_SYMBOL.night).and.not.contain('#ffffff');
            expect(p.items.autoOn.tooltip.de).to.equal('Automatisch');
            expect(p.items.nightOn.tooltip.de).to.equal('Leise');
            expect(p.items.autoOn.falseTextStyle.backgroundColor).to.not.equal(
                p.items.autoOff.falseTextStyle.backgroundColor,
            );
        });

        it('Balken bis zur gewaehlten Stufe gefuellt, aktive Sonderstufe hervorgehoben', async () => {
            const p = await regler();
            // klarer Abstand zwischen den Symbolknoepfen und den Balken
            expect(p.items.nightOn.style.marginRight).to.be.at.least(10);
            expect(p.items.nightOff.style.marginRight).to.be.at.least(10);
            expect(p.items.autoOn.style.marginRight).to.equal(0);
            // Knoepfe und Balken unten buendig
            for (const i of Object.values(p.items).filter(i => i.type === 'state')) {
                expect(i.style).to.include({ alignItems: 'flex-end', height: 36 });
            }
            expect(sichtbar(p, 'medium')).to.eql([
                'autoOff',
                'nightOff',
                'step1On',
                'step2On',
                'step3On',
                'step4Off',
                'step5Off',
            ]);
            expect(sichtbar(p, 'high')).to.eql([
                'autoOff',
                'nightOff',
                'step1On',
                'step2On',
                'step3On',
                'step4On',
                'step5On',
            ]);
            expect(sichtbar(p, 'auto')).to.eql([
                'autoOn',
                'nightOff',
                'step1Off',
                'step2Off',
                'step3Off',
                'step4Off',
                'step5Off',
            ]);
            expect(sichtbar(p, 'night')).to.eql([
                'autoOff',
                'nightOn',
                'step1Off',
                'step2Off',
                'step3Off',
                'step4Off',
                'step5Off',
            ]);
            // gefuellt und leer unterscheiden sich in der Farbe, die Hoehe steigt
            expect(p.items.step1On.falseTextStyle.backgroundColor).to.not.equal(
                p.items.step1Off.falseTextStyle.backgroundColor,
            );
            expect(p.items.step5On.falseTextStyle.height).to.be.above(p.items.step1On.falseTextStyle.height);
        });

        it('ein Klick auf einen Balken schickt die Stufe (auch bei ausgeschalteter Anlage)', async () => {
            const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
            const p = (await kartenLaden(a)).karten[0].customInfo.schema.items.fanSteps;
            // so schreibt der Admin beim Klick: buttonValue ohne ack in den Datenpunkt
            await a.onStateChange(p.items.step2Off.oid, { val: p.items.step2Off.buttonValue, ack: false });
            expect(a.veroeffentlicht).to.eql([{ topic: 'command/Wohnzimmer AC/fan', nutzlast: 'lowMedium' }]);
        });
    });

    it('Bedienung auch bei ausgeschalteter Anlage: nichts haengt am Ein/Aus-Zustand', async () => {
        const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
        a.onMqtt('state/Wohnzimmer AC/status', Buffer.from(JSON.stringify({ power: false, mode: 'C' })));
        await warte();
        const k = (await kartenLaden(a)).karten[0];
        const items = k.customInfo.schema.items;
        for (const key of ['mode', 'targetSlider']) {
            expect(items[key].readOnly, key).to.equal(undefined);
            expect(items[key].disabled, key).to.equal(undefined);
            expect(items[key].hidden, key).to.equal(undefined);
        }
        expect(items.fanSteps.hidden).to.equal(undefined);
        expect(items.mode.options.map(o => o.value)).not.to.include('off');
    });

    it('Betriebsart waehlen, waehrend die Anlage aus ist: ein Befehl mode, kein eigener power-Befehl', async () => {
        // Das Modul schaltet bei command/<Name>/mode selbst ein (Faikout.c: power = Wert != "off").
        const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
        a.onMqtt('state/Wohnzimmer AC/status', Buffer.from(JSON.stringify({ power: false, mode: 'H' })));
        await warte();
        // so schreibt der Admin aus der Kartenzeile (ConfigState): ohne ack in den Datenpunkt
        await a.onStateChange('faikout.0.Wohnzimmer_AC.control.selectedMode', { val: 'cool', ack: false });
        expect(a.veroeffentlicht).to.eql([{ topic: 'command/Wohnzimmer AC/mode', nutzlast: 'cool' }]);
    });

    describe('gewaehlte Betriebsart (control.selectedMode)', () => {
        const wert = a => a.werte.get('Wohnzimmer_AC.control.selectedMode');
        it('laeuft: wie control.mode', async () => {
            const a = await adapterMitGeraet();
            expect(wert(a)).to.eql({ val: 'heat', ack: true });
            const o = a.objekte.get('Wohnzimmer_AC.control.selectedMode');
            expect(o.common.write).to.equal(true);
            expect(Object.keys(o.common.states)).to.eql(['heat_cool', 'cool', 'heat', 'dry', 'fan_only']);
            expect(o.common.name.de).to.equal('Gewählte Betriebsart');
        });
        it('aus: aus der nativen Meldung state/<Name>/status (mode "H"), state/ meldet nur "off"', async () => {
            const a = await adapterMitGeraet({ ...MELDUNG, power: false, mode: 'off' });
            expect(wert(a)).to.equal(undefined);
            expect(a.werte.get('Wohnzimmer_AC.control.mode').val).to.equal('off');
            a.onMqtt('state/Wohnzimmer AC/status', Buffer.from(JSON.stringify({ power: false, mode: 'H', fan: '4' })));
            await warte();
            expect(wert(a).val).to.equal('heat');
            // die native Meldung legt sonst nichts an (Fan "4" bleibt beim Klartext)
            expect(a.werte.get('Wohnzimmer_AC.control.fan').val).to.equal('auto');
        });
        it('laeuft: native Meldung zaehlt nicht (Faikout-Automatik meldet dort die echte Betriebsart)', async () => {
            const a = await adapterMitGeraet({ ...MELDUNG, mode: 'heat_cool' });
            a.onMqtt('state/Wohnzimmer AC/status', Buffer.from(JSON.stringify({ power: true, mode: 'H' })));
            await warte();
            expect(wert(a).val).to.equal('heat_cool');
        });
        it('aus ohne native Meldung: der letzte Wert bleibt', async () => {
            const a = await adapterMitGeraet({ ...MELDUNG, mode: 'cool' });
            a.onMqtt('state/Wohnzimmer AC', Buffer.from(JSON.stringify({ ...MELDUNG, power: false, mode: 'off' })));
            await warte();
            expect(wert(a).val).to.equal('cool');
        });
        it('Kuerzel der nativen Meldung', () => {
            const n = m => felder.gewaehlteBetriebsart({ power: false, mode: m }, true);
            expect(['F', 'H', 'C', 'A', 'D', '4', 'X'].map(n)).to.eql([
                'fan_only',
                'heat',
                'cool',
                'heat_cool',
                'dry',
                null,
                null,
            ]);
            expect(felder.gewaehlteBetriebsart({ mode: 'off' }, false)).to.equal(null);
            expect(felder.gewaehlteBetriebsart({ mode: 'dry' }, false)).to.equal('dry');
        });
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

    it('Ein/Aus-Umschalter in der Statuszeile: Symbol, Text und Tooltip folgen control.power', async () => {
        const a = await adapterMitGeraet();
        const k = (await kartenLaden(a)).karten[0];
        const ind = k.indicators.find(i => i.id === 'power');
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
        expect(k.indicators.map(i => i.id)).to.eql(['wlan', 'wlanAus']);
        expect(k.actions).to.equal(undefined);
    });

    it('Sollwertbereich folgt der HA-Discovery des Geraets', async () => {
        const a = await adapterMitGeraet();
        await a.klimaConfig(
            JSON.stringify({ avty_t: 'state/Wohnzimmer AC', min_temp: 18, max_temp: 30, temp_step: 1 }),
        );
        const s = (await kartenLaden(a)).karten[0].customInfo.schema.items.targetSlider;
        expect([s.min, s.max, s.step, s.falseText, s.trueText]).to.eql([18, 30, 1, '18', '30']);
    });

    it('ohne gemeldete Felder keine Bedienelemente', async () => {
        const a = await adapterMitGeraet({ online: true, rssi: -70 });
        const k = (await kartenLaden(a)).karten[0];
        expect(k.actions).to.equal(undefined);
        expect(Object.keys(k.customInfo.schema.items)).to.eql(['ident']);
    });
});

describe('Device-Manager: Bedienen (Attrappe, keine echte Anlage)', () => {
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
});

describe('Device-Manager: Weg ueber sendTo wie aus dem Admin', () => {
    const nachricht = (a, command, message, nr) =>
        a.lauscher.message({ _id: nr, command, message, from: 'system.adapter.admin.0', callback: { id: nr } });

    it('Admin-Ablauf (instanceInfo, loadDevices) ohne Warnung und ohne controls', async () => {
        const a = await adapterMitGeraet();
        a.warnungen = [];
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
        // keine controls: der Admin fragt also nie dm:deviceControlState ab - die Ursache der
        // Warnung "Device get state ... is disabled because it has no handler" ist weg
        expect(geladen).not.to.contain('"controls"');
        expect(a.warnungen).to.eql([]);
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

    it('unbekannte Nachrichten (ohne dm:) bleiben unbeantwortet', async () => {
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
        ...Object.fromEntries(Object.entries(STUFEN_TOOLTIP).map(([k, v]) => [`Tooltip.${k}`, v])),
        ...Object.fromEntries(Object.entries(WLAN_TEXTE).map(([k, v]) => [`WLAN.${k}`, v])),
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

describe('Device-Manager: alle elf Sprachen, nichts unuebersetzt', () => {
    /**
     * Sucht in einer beliebigen Struktur jedes Uebersetzungsobjekt (Objekt mit Schluessel "en")
     * und meldet fehlende Sprachen sowie Eintraege, die woertlich dem Englischen gleichen.
     */
    const pruefe = (wurzel, wo) => {
        const fehler = [];
        // Woerter, die in einer Sprache wirklich wie im Englischen heissen ("sprache:wort");
        // derzeit keine
        const gleichErlaubt = new Set([]);
        const lauf = (x, pfad) => {
            if (!x || typeof x !== 'object') {
                return;
            }
            if (typeof x.en === 'string' && Object.keys(x).every(k => typeof x[k] === 'string')) {
                for (const l of SPRACHEN) {
                    if (typeof x[l] !== 'string' || !x[l].trim()) {
                        fehler.push(`${wo}${pfad}: ${l} fehlt`);
                    } else if (l !== 'en' && x[l] === x.en && !gleichErlaubt.has(`${l}:${x[l]}`)) {
                        fehler.push(`${wo}${pfad}: ${l} = englisch "${x.en}"`);
                    }
                }
                return;
            }
            for (const [k, v] of Object.entries(x)) {
                lauf(v, `${pfad}.${k}`);
            }
        };
        lauf(wurzel, '');
        return fehler;
    };

    it('jede Beschriftung, jeder Tooltip und jede Rueckfrage der Karte (aus der echten Karte gelesen)', async () => {
        const a = await adapterMitGeraet({ ...MELDUNG, hum: 50, action: 'heating' });
        const k = (await kartenLaden(a)).karten[0];
        // Funktionen (handler) und HTML-Muster der Luftfeuchte zaehlen nicht als Text
        const karte = JSON.parse(JSON.stringify(k));
        const fehler = pruefe(karte, 'Karte');
        // die Rueckfragen entstehen erst beim Klick
        fehler.push(...pruefe({ ein: TEXTE.frageEinschalten, aus: TEXTE.frageAusschalten }, 'Rueckfrage'));
        expect(fehler).to.eql([]);
        // es wurden wirklich Texte gefunden (Kontrolle des Pruefers selbst)
        expect(JSON.stringify(karte)).to.contain('"zh-cn"');
    });

    it('Namen der Datenpunkte auf der Karte, auch control.selectedMode', () => {
        const felderDerKarte = [
            'power',
            'mode',
            'selectedMode',
            'target',
            'fan',
            'temp',
            'outside',
            'hum',
            'consumption',
            'action',
        ];
        const namenListe = Object.fromEntries(felderDerKarte.map(f => [f, namen.vollerName(felder.FELDER[f].name)]));
        expect(pruefe(namenListe, 'Datenpunkt')).to.eql([]);
    });

    it('News im io-package', () => {
        const io = require('../io-package.json');
        expect(pruefe(io.common.news, 'news')).to.eql([]);
    });

    it('der Pruefer selbst findet fehlende und englische Eintraege', () => {
        const f = pruefe({ a: { en: 'Fan', de: 'Fan', ru: 'Вентилятор' } }, 'x');
        expect(f).to.include('x.a: de = englisch "Fan"');
        expect(f).to.include('x.a: pt fehlt');
    });
});

describe('Device-Manager: Regelung auf der Karte', () => {
    const dm = require('../lib/devicemanager');
    const oberflaeche = require('../lib/oberflaeche');
    const ID = 'Wohnzimmer_AC';

    /** Adapter mit den Datenpunkten regulation.* eines Geraets (wie sie lib/regel anlegt). */
    async function mitRegelung(werte = {}) {
        const a = await adapterMitGeraet({ ...MELDUNG, hum: 50, action: 'heating' });
        const id = [...a.objekte.values()].find(x => x.type === 'device')._id.slice(a.namespace.length + 1);
        const standard = {
            'regulation.state': 'ok',
            'regulation.reason': 'Szene Komfort · Bedarf: Kennlinie Heizen bei 5 °C → 61 %',
            'regulation.mode': 'adapter',
            'regulation.historyJson': JSON.stringify([[Date.now() - 3600000, 60]]),
            'regulation.demand.active': true,
            'regulation.demand.dryRun': true,
            'regulation.demand.setpoint': 60,
            'regulation.demand.rawValue': 61.3,
            'regulation.demand.outsideMean': 5,
            'regulation.demand.reason': 'Kennlinie Heizen bei 5 °C → 61 %; Raum 21.5 °C / Ziel 21 °C | würde senden',
            'regulation.demand.strategy': 'curve',
            'regulation.schedule.active': true,
            'regulation.schedule.weekJson': '',
            'regulation.schedule.absenceJson': '',
            'regulation.schedule.scene': 'Komfort',
            'regulation.schedule.next': Date.now() + 3600000,
            'regulation.schedule.nextScene': 'Absenken',
            'regulation.humidity.active': false,
            'regulation.manual.locked': false,
            'regulation.manual.until': null,
            'regulation.manual.resume': false,
            'regulation.sensors.outside': 5,
            'regulation.sensors.outsideSource': 'Fühler der Anlage',
            'regulation.sensors.room': 21.5,
            'regulation.sensors.roomSource': 'Fühler der Anlage',
            'regulation.sensors.humidity': 50,
            'regulation.sensors.humiditySource': 'Fühler der Anlage',
            'info.demandCapable': 'yes',
            ...werte,
        };
        for (const [rel, val] of Object.entries(standard)) {
            const schreibbar = /aktiv|probelauf|Json|aufheben/.test(rel) && !rel.includes('verlauf');
            a.objekte.set(`${id}.${rel}`, {
                _id: `${a.namespace}.${id}.${rel}`,
                type: 'state',
                common: { name: rel, type: typeof val, role: 'state', read: true, write: schreibbar },
                native: {},
            });
            a.werte.set(`${id}.${rel}`, { val, ack: true });
        }
        a.sprache = async () => 'de';
        a.gesetzt = [];
        return { a, id };
    }
    /** Wertet ein Muster des Admins aus wie json-config (Template mit _states). */
    const muster = (text, werte) =>
        new Function('_states', `return \`${text.replace(/`/g, '\\`')}\``)(
            Object.fromEntries(Object.entries(werte).map(([k, v]) => [k, { val: v }])),
        );

    it('ohne Datenpunkte regulation.* bleibt die Karte wie bisher (kein Abschnitt, keine Aktionen)', async () => {
        const a = await adapterMitGeraet();
        const k = (await kartenLaden(a)).karten[0];
        expect(Object.keys(k.customInfo.schema.items).some(x => x.startsWith('regel'))).to.equal(false);
        expect(k.actions.map(x => x.id)).to.eql([UMSCHALTEN]);
    });

    it('Abschnitt Regelung: Zustand, Leistungsgrenze, Szene, Handeingriff, Schalter, Fuehler - und zwei Aktionen', async () => {
        const { a, id } = await mitRegelung();
        expect(id).to.equal(ID);
        const k = (await kartenLaden(a)).karten[0];
        const items = k.customInfo.schema.items;
        expect(Object.keys(items).filter(x => x.startsWith('regel'))).to.eql([
            'regelKopf',
            'regelGrenze',
            'regelPlan',
            'regelHand',
            'regelFortsetzen',
            'regelKnoepfe',
            'regelFuehler',
        ]);
        expect(k.actions.map(x => x.id)).to.eql([UMSCHALTEN, dm.WOCHENPLAN, dm.DETAILS]);
        expect(k.controls).to.equal(undefined);
        // alles haengt an den Datenpunkten der Regelung (live, ohne Neuladen)
        expect(items.regelKopf.dependsOnStates).to.eql({
            z: `faikout.0.${ID}.regulation.state`,
            g: `faikout.0.${ID}.regulation.reason`,
            p: `faikout.0.${ID}.regulation.demand.dryRun`,
        });
        // Handeingriff: Hinweis und Knopf nur bei Sperre; der Knopf heisst "Handeingriff beenden" und schreibt den Knopf-Datenpunkt
        expect(items.regelHand.hidden).to.equal('_states.h?.val !== true');
        expect(items.regelFortsetzen).to.include({ oid: `faikout.0.${ID}.regulation.manual.resume`, control: 'button', buttonValue: true });
        expect(items.regelFortsetzen.falseText.de).to.equal('Handeingriff beenden');
        expect(items.regelFortsetzen.falseText.en).to.equal('End manual override');
        // "Wochenplan bearbeiten" traegt den Kalender, der Schalter des Wochenplans die Uhr: zwei
        // verschiedene Symbole - und der Einrichtungstext nennt den "Knopf mit dem Kalender"
        const svgVon = url => Buffer.from(url.split(',')[1], 'base64').toString();
        const aktion = svgVon(k.actions.find(x => x.id === dm.WOCHENPLAN).icon);
        expect(aktion).to.contain(dm.REGEL_SYMBOL.kalender).and.to.not.contain(dm.REGEL_SYMBOL.plan);
        expect(dm.REGEL_SYMBOL.kalender).to.contain('<rect').and.to.not.equal(dm.REGEL_SYMBOL.plan);
        expect(dm.REGEL_SYMBOL.plan).to.contain('<circle'); // Uhr
        expect(svgVon(items.regelKnoepfe.items.plan ? items.regelKnoepfe.items.plan.labelIcon || '' : ',')).to.not.contain('<rect');
        for (const l of SPRACHEN) {
            const schritt = JSON.parse(require('node:fs').readFileSync(`${__dirname}/../admin/i18n/${l}.json`, 'utf8')).textSchritt3;
            expect(schritt, l).to.match(/Kalender|calendar|календар|calendário|kalender|calendrier|calendario|kalendarz|日历/i);
            expect(schritt, l).to.not.match(/\bUhr\b|clock|часами|relógio|klok|horloge|orologio|reloj|zegar|时钟/i);
        }
        // Szene nur bei eingeschaltetem Wochenplan
        expect(items.regelPlan.hidden).to.equal('_states.a?.val !== true');
    });

    it('Automatik: je Regelung eine beschriftete Schalterzeile (Zustand am Schalter, nicht nur als Farbe), Hinweis "wirkt sofort"', async () => {
        const { a } = await mitRegelung();
        const knoepfe = (await kartenLaden(a)).karten[0].customInfo.schema.items.regelKnoepfe.items;
        expect(knoepfe.label.text).to.equal(oberflaeche.TEXTE.automatik);
        expect(knoepfe.hinweis.text.de).to.equal('Wirkt sofort – ohne Speichern');
        expect(dm.REGEL_SCHALTER.map(s => oberflaeche.TEXTE[s.text].de)).to.eql(['Leistungsgrenze', 'Feuchte', 'Wochenplan']);
        for (const s of dm.REGEL_SCHALTER) {
            const z = knoepfe[s.name];
            expect(z).to.include({ type: 'state', control: 'switch', foreign: true, oid: `faikout.0.${ID}.${s.rel}` });
            expect(z.label).to.equal(oberflaeche.TEXTE[s.text]);
            expect(z.labelIcon).to.match(/^data:image\/svg\+xml;base64,/);
        }
        // keine reinen Symbolknoepfe mehr
        expect(Object.keys(knoepfe)).to.eql(['label', 'hinweis', 'bedarf', 'feuchte', 'plan']);
    });

    it('Knoepfe − und + neben dem Schieber schreiben die vorhandenen Datenpunkte regulation.target.down/up', async () => {
        const { a } = await mitRegelung({ 'regulation.target.down': false, 'regulation.target.up': false });
        const items = (await kartenLaden(a)).karten[0].customInfo.schema.items;
        expect(items.targetMinus).to.include({ control: 'button', buttonValue: true, oid: `faikout.0.${ID}.regulation.target.down` });
        expect(items.targetPlus).to.include({ control: 'button', buttonValue: true, oid: `faikout.0.${ID}.regulation.target.up` });
        expect(items.targetMinus.falseText.de).to.equal('−');
        expect(items.targetPlus.falseText.de).to.equal('+');
        // jeder Knopf zeigt auf einen Datenpunkt, den es gibt (sonst blendet der Admin ihn aus)
        for (const k of [items.targetMinus, items.targetPlus]) {
            expect(a.objekte.has(k.oid.slice(a.namespace.length + 1))).to.equal(true);
        }
        expect(items.targetSlider.xs).to.equal(8);
        // ohne die Datenpunkte: nur der Schieber ueber die volle Breite
        const ohne = (await kartenLaden((await mitRegelung()).a)).karten[0].customInfo.schema.items;
        expect(ohne.targetMinus).to.equal(undefined);
        expect(ohne.targetSlider.xs).to.equal(12);
    });

    it('Muster der Karte: Zustand, Probelauf, Balken, "ruht (Faikout-Auto)", nicht unterstuetzt, Fuehler-Rueckfall', () => {
        const kopf = muster(dm.regelKopfHtml(true).de, { z: 'ok', g: 'Szene <b>Komfort</b>', p: true });
        expect(kopf).to.contain('>aktiv<').and.to.contain('Probelauf').and.to.contain('Szene &lt;b>Komfort');
        expect(muster(dm.regelKopfHtml(false).de, { z: 'manual', g: '', p: false })).to.contain('Handeingriff').and.not.to.contain('Probelauf');
        expect(muster(dm.regelKopfHtml(true).de, { z: 'off', g: '', p: true })).to.contain('ausgeschaltet').and.not.to.contain('Probelauf');

        const grenze = w => muster(dm.regelGrenzeHtml(true).de, { s: 45, a: true, p: true, f: 'yes', b: 'adapter', st: 'curve', ...w });
        expect(grenze({})).to.contain('>45<').and.to.contain('Probelauf: nicht gesendet');
        expect(grenze({}).match(/opacity:1"/g)).to.have.length(4); // 30, 35, 40, 45 %
        expect(grenze({ f: 'no' })).to.contain('nicht unterstützt').and.to.contain('>–<');
        // Tooltip am Etikett: warum eine Daikin die Leistungsgrenze nicht uebernimmt
        expect(grenze({ f: 'no' })).to.contain('title="Bei Daikin wirkt die Leistungsgrenze nur').and.to.contain('SP 1');
        expect(grenze({ b: 'faikout' })).to.contain('ruht (Faikout-Auto)').and.to.contain('>–<');
        expect(grenze({ b: 'faikout', st: 'previousDay' })).to.contain('>45<').and.not.to.contain('ruht');
        expect(grenze({ a: false })).to.contain('nicht begrenzt');
        expect(muster(dm.regelGrenzeHtml(false).de, { s: 45, a: true, p: false, f: 'yes', b: 'adapter', st: 'curve' })).not.to.contain('Probelauf');

        const plan = muster(dm.regelPlanHtml().de, { s: 'Komfort', n: new Date(new Date().setHours(22, 0, 0, 0)).getTime(), ns: 'Absenken' });
        expect(plan).to.contain('Komfort').and.to.contain('22:00 Absenken');
        expect(muster(dm.regelPlanHtml().de, { s: '', n: null, ns: '' })).to.contain('kein Wochenplan');

        const f = muster(dm.regelFuehlerHtml().de, { av: 4.5, aq: 'Fühler der Anlage', rv: 20.6, rq: 'Fühler der Anlage (Rückfall: Datenpunkt zu alt)', fv: null, fq: '', fa: false });
        expect(f).to.contain('Außen 4,5 °C').and.to.contain('Raum 20,6 °C · Rückfall').and.not.to.contain('Feuchte');
        expect(f).to.contain('title="Fühler der Anlage (Rückfall: Datenpunkt zu alt)"');
        expect(muster(dm.regelFuehlerHtml().de, { av: null, fa: true })).to.contain('Außen fehlt').and.to.contain('Feuchte fehlt');
        // mit dem Datenpunkt regulation.sensors.<art>Stand zaehlt der, nicht mehr das Wort im Quellentext
        const stand = muster(dm.regelFuehlerHtml().de, { av: 4.5, aq: 'Sensor of the unit (fallback)', as: 'fallback', rv: 20, rq: 'x (Rückfall: y)', rs: 'ok' });
        expect(stand).to.contain('Außen 4,5 °C · Rückfall').and.to.contain('Raum 20 °C<');
        expect(muster(dm.regelHandHtml().de, { h: true, b: new Date(new Date().setHours(22, 0, 0, 0)).getTime() })).to.contain('<b>22:00</b>');
    });

    it('jedes Muster laesst sich in jeder Sprache auswerten, auch ganz ohne Werte', () => {
        for (const l of SPRACHEN) {
            for (const m of [dm.regelKopfHtml(true), dm.regelGrenzeHtml(true), dm.regelPlanHtml(), dm.regelHandHtml(), dm.regelFuehlerHtml()]) {
                expect(muster(m[l], {})).to.be.a('string');
                // die Musterauswertung des Admins bricht an geschweiften Klammern im Ausdruck ab
                expect(m[l].replace(/\$\{[^{}]*\}/g, '')).not.to.match(/[{}]/);
            }
        }
    });

    describe('Wochenplan-Dialog', () => {
        /** Dialogkontext: `beimFormular` spielt die Wochenplan-Seite (bekommt die Kennung aus der URL). */
        const kontext = beimFormular => {
            const k = { formulare: [], meldungen: [] };
            k.showForm = async (schema, opt) => {
                k.formulare.push({ schema, opt });
                return beimFormular(schema, opt, k.formulare.length);
            };
            k.showMessage = async text => k.meldungen.push(text);
            return k;
        };
        const kennung = schema => /token=(\w+)/.exec(schema.items.raster.url)[1];

        it('oeffnet die Wochenplan-Seite als iframe; Info liefert Plan, Szenen, Farben und Texte', async () => {
            const { a } = await mitRegelung();
            let info;
            const k = kontext(async schema => {
                expect(schema.items.raster).to.include({ type: 'iframe' });
                expect(schema.items.raster.url).to.contain('adapter/faikout/wochenplan.html?instance=faikout.0&device=Wohnzimmer_AC&token=');
                info = await a.deviceManagement.wochenplanNachricht('wochenplanInfo', { device: ID, token: kennung(schema) });
                return undefined; // Abbrechen
            });
            expect(await a.deviceManagement.wochenplanDialog(ID, k)).to.eql({ refresh: false });
            expect(k.formulare[0].opt.title.de).to.equal('Wochenplan von Wohnzimmer AC');
            expect(info.program).to.eql([]);
            expect(info.types.map(t => t.type)).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
            expect(info.types[0].info).to.equal('21 °C · max. 95 %');
            expect(info.types[3].info).to.equal('Anlage aus');
            expect(info.farben.hell.komfort).to.be.a('string');
            expect(info.texts.pVorgabe).to.equal('Vorgabeplan laden');
            expect(info.abwesenheit.aktiv).to.equal(false);
            // abgebrochen: nichts geschrieben, Entwurf weg
            expect(a.gesetzt).to.eql([]);
            expect(a.deviceManagement.planEntwuerfe.size).to.equal(0);
        });

        it('Vorgabeplan laden und OK: schreibt plan.wocheJson und abwesenheitJson ohne ack', async () => {
            const { a } = await mitRegelung();
            const k = kontext(async schema => {
                const token = kennung(schema);
                const v = await a.deviceManagement.wochenplanNachricht('wochenplanVorgabe', { device: ID, token });
                const r = await a.deviceManagement.wochenplanNachricht('wochenplanEntwurf', {
                    device: ID,
                    token,
                    program: v.program,
                    abwesenheit: { aktiv: true, von: '2026-12-27T00:00', bis: '2027-01-03T00:00', szene: 'abwesend' },
                });
                expect(r).to.eql({ ok: true, count: v.program.length });
                return {};
            });
            await a.deviceManagement.wochenplanDialog(ID, k);
            const plan = a.gesetzt.find(g => g.id === `${ID}.regulation.schedule.weekJson`);
            expect(plan.wert.ack).to.equal(false);
            expect(JSON.parse(plan.wert.val)).to.have.length(7);
            expect(JSON.parse(plan.wert.val)[0][1]).to.eql({ t: 360, s: 'komfort' });
            const abw = JSON.parse(a.gesetzt.find(g => g.id === `${ID}.regulation.schedule.absenceJson`).wert.val);
            expect(abw).to.eql({ from: new Date(2026, 11, 27).getTime(), to: new Date(2027, 0, 3).getTime(), scene: 'abwesend' });
            // Wochenplan war schon an: keine zweite Rueckfrage
            expect(k.formulare).to.have.length(1);
        });

        it('Wochenplan aus: fragt nach dem Speichern, ob er eingeschaltet werden soll', async () => {
            for (const antwort of [{}, undefined]) {
                const { a } = await mitRegelung({ 'regulation.schedule.active': false });
                const k = kontext(async (schema, opt, nr) => {
                    if (nr === 1) {
                        await a.deviceManagement.wochenplanNachricht('wochenplanEntwurf', {
                            device: ID,
                            token: kennung(schema),
                            program: [{ day: 'Mon', time: '06:00', type: 'komfort' }],
                        });
                        return {};
                    }
                    expect(schema.items.frage.text.de).to.contain('Jetzt einschalten?');
                    expect(opt.buttons.map(b => b.label.de)).to.eql(['Einschalten', 'Nur speichern']);
                    return antwort;
                });
                await a.deviceManagement.wochenplanDialog(ID, k);
                const an = a.gesetzt.find(g => g.id === `${ID}.regulation.schedule.active`);
                expect(!!an).to.equal(!!antwort);
                expect(a.gesetzt.some(g => g.id === `${ID}.regulation.schedule.weekJson`)).to.equal(true);
            }
        });

        it('Fehler im Klartext: unbekannte Szene und falsche Abwesenheit schon beim Entwurf, leerer Plan beim OK', async () => {
            const { a } = await mitRegelung();
            const k = kontext(async schema => {
                const token = kennung(schema);
                const n = (program, abwesenheit) =>
                    a.deviceManagement.wochenplanNachricht('wochenplanEntwurf', { device: ID, token, program, abwesenheit });
                expect((await n([{ day: 'Mon', time: '06:00', type: 'party' }])).error).to.contain('Szene "party" gibt es nicht');
                const falsch = { aktiv: true, von: '2026-12-27T00:00', bis: '2026-12-26T00:00', szene: 'abwesend' };
                expect((await n([{ day: 'Mon', time: '06:00', type: 'komfort' }], falsch)).error).to.equal(oberflaeche.TEXTE.pAbwFehler.de);
                expect(await n([])).to.eql({ ok: true, count: 0 });
                return {};
            });
            await a.deviceManagement.wochenplanDialog(ID, k);
            expect(k.meldungen[0].de).to.equal('Der Wochenplan wurde nicht gespeichert: der Plan hat keinen Schaltpunkt');
            expect(a.gesetzt).to.eql([]);
        });

        it('"Plan uebernehmen" mit zuletzt fehlerhafter Eingabe speichert nichts und sagt warum', async () => {
            const { a } = await mitRegelung();
            const k = kontext(async schema => {
                const token = kennung(schema);
                const n = (program, abwesenheit) =>
                    a.deviceManagement.wochenplanNachricht('wochenplanEntwurf', { device: ID, token, program, abwesenheit });
                const plan = [{ day: 'Mon', time: '06:00', type: 'komfort' }];
                // erst ein gueltiger Entwurf, danach die Abwesenheit mit Ende vor Beginn
                expect((await n(plan)).ok).to.equal(true);
                const falsch = { aktiv: true, von: '2026-12-27T00:00', bis: '2026-12-26T00:00', szene: 'abwesend' };
                expect((await n(plan, falsch)).error).to.equal(oberflaeche.TEXTE.pAbwFehler.de);
                return {};
            });
            await a.deviceManagement.wochenplanDialog(ID, k);
            expect(k.meldungen).to.have.length(1);
            expect(k.meldungen[0].de).to.equal(`Der Wochenplan wurde nicht gespeichert: ${oberflaeche.TEXTE.pAbwFehler.de}`);
            expect(k.meldungen[0].en).to.equal(`The weekly schedule was not saved: ${oberflaeche.TEXTE.pAbwFehler.en}`);
            expect(a.gesetzt).to.eql([]);
        });

        it('ein spaeter korrigierter Fehler sperrt das Speichern nicht mehr', async () => {
            const { a } = await mitRegelung();
            const k = kontext(async schema => {
                const token = kennung(schema);
                const n = (program, abwesenheit) =>
                    a.deviceManagement.wochenplanNachricht('wochenplanEntwurf', { device: ID, token, program, abwesenheit });
                const plan = [{ day: 'Mon', time: '06:00', type: 'komfort' }];
                await n(plan, { aktiv: true, von: '2026-12-27T00:00', bis: '2026-12-26T00:00', szene: 'abwesend' });
                expect((await n(plan, { aktiv: true, von: '2026-12-27T00:00', bis: '2026-12-28T00:00', szene: 'abwesend' })).ok).to.equal(true);
                return {};
            });
            await a.deviceManagement.wochenplanDialog(ID, k);
            expect(k.meldungen).to.eql([]);
            expect(a.gesetzt.some(g => g.id === `${ID}.regulation.schedule.absenceJson` && g.wert)).to.equal(true);
        });

        it('fremde oder abgelaufene Kennung wird abgewiesen', async () => {
            const { a } = await mitRegelung();
            const r = await a.deviceManagement.wochenplanNachricht('wochenplanInfo', { device: ID, token: 'falsch' });
            expect(r.error).to.equal('unknown or expired dialog');
        });

        it('die Wochenplan-Seite liegt im Paket und spricht die richtigen Befehle', () => {
            const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin', 'wochenplan.html'), 'utf8');
            for (const b of ['wochenplanInfo', 'wochenplanEntwurf', 'wochenplanVorgabe']) {
                expect(html).to.contain(`'${b}'`);
                expect(oberflaeche.BEFEHLE.has(b)).to.equal(true);
            }
        });

        it('Wochenplan-Seite: Klickzeit auf dem Raster, die Linie bietet keine Blockmitte an', () => {
            const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin', 'wochenplan.html'), 'utf8');
            const teil = /\/\* calc:begin[^*]*\*\/([\s\S]*?)\/\* calc:end \*\//.exec(html);
            expect(teil, 'Abschnitt calc:begin..calc:end').to.not.equal(null);
            const f = new Function('STEP', 'DAY', `${teil[1]}; return { snap, minuteFromX, splitOffer, edgeOf };`)(15, 1440);
            // Spur 1000 px breit ab x = 100: 8:30 liegt bei 100 + 1000 * 8.5 / 24
            expect(f.minuteFromX(100, 1000, 100 + (1000 * 8.5) / 24, 0)).to.equal(510);
            expect(f.minuteFromX(100, 1000, 100 + (1000 * 8.4) / 24, 2)).to.equal(2 * 1440 + 510);
            // Handybreite (Spur 400 px ab 0): derselbe Zeitpunkt, Raender begrenzt
            expect(f.minuteFromX(0, 400, (400 * 8.5) / 24, 0)).to.equal(510);
            expect(f.minuteFromX(0, 400, -20, 0)).to.equal(0);
            expect(f.minuteFromX(0, 400, 999, 0)).to.equal(1440);
            const block = { a: 510, b: 990 }; // 08:30-16:30
            // Klick auf die Linie 08:30: kein "Neuer Schaltpunkt um 12:30" (frueher die Blockmitte)
            expect(f.splitOffer(block, undefined, [510, 990], true)).to.equal(-1);
            // Menue eines Blocks: an der Zeigerstelle, sonst in der Mitte; nie auf einem vorhandenen Schaltpunkt
            expect(f.splitOffer(block, 615, [510, 990], false)).to.equal(615);
            expect(f.splitOffer(block, undefined, [510, 990], false)).to.equal(750);
            expect(f.splitOffer(block, undefined, [510, 750, 990], false)).to.equal(-1);
            expect(f.splitOffer({ a: 510, b: 525 }, undefined, [510], false)).to.equal(-1);
            expect([f.edgeOf(0), f.edgeOf(0.5), f.edgeOf(0.97)]).to.eql(['edge-l', '', 'edge-r']);
        });
    });

    describe('Details-Dialog', () => {
        it('Kennlinie mit Arbeitspunkt, Rechenweg als Liste, Verlauf, Fuehler - nur Anzeige', async () => {
            const { a } = await mitRegelung();
            let gezeigt;
            const k = { showForm: async (schema, opt) => ((gezeigt = { schema, opt }), undefined) };
            expect(await a.deviceManagement.detailsDialog(ID, k)).to.eql({ refresh: false });
            // "Schließen" mit eigener Beschriftung ('close' zeichnete der Admin als "Abbrechen")
            expect(gezeigt.opt.buttons).to.have.length(1);
            expect(gezeigt.opt.buttons[0]).to.include({ type: 'cancel' });
            expect(gezeigt.opt.buttons[0].label.de).to.equal('Schließen');
            expect(gezeigt.opt.title.de).to.equal('Regelung von Wohnzimmer AC');
            const html = gezeigt.schema.items.inhalt.text;
            expect(gezeigt.schema.items.inhalt).to.include({ type: 'staticText', format: 'html', noTranslation: true });
            expect(html.match(/<svg/g)).to.have.length(2);
            expect(html).to.contain('Probelauf.').and.to.contain('würde senden 60 %');
            expect(html).to.contain('<li style="margin:2px 0">Szene Komfort</li>');
            expect(html).to.contain('Kennlinie Heizen bei 5 °C → 61 %</li>');
            expect(html).to.contain('Leistungsgrenze, letzte 24 Stunden').and.to.contain('Adapter regelt');
            expect(html).to.contain('21,5 °C').and.to.contain('Fühler der Anlage');
            // nichts, was der Admin als Muster auswerten wuerde
            expect(html).not.to.match(/[`\\]|\$\{/);
            expect(a.gesetzt).to.eql([]);
        });

        it('Texte aus Datenpunkten werden maskiert (kein HTML, kein Muster)', async () => {
            const { a } = await mitRegelung({ 'regulation.reason': '<img src=x> ${1+1} `x`' });
            const f = await a.deviceManagement.detailsFormular(ID, 'de');
            expect(f.items.inhalt.text).to.contain('&lt;img src=x&gt; &#36;{1+1} &#96;x&#96;');
        });
    });

    it('Uebersetzungen: Karte mit Regelung, Aktionen und Dialogtexte in allen elf Sprachen', async () => {
        const { a } = await mitRegelung();
        const k = (await kartenLaden(a)).karten[0];
        const fehlt = [];
        const lauf = (x, pfad) => {
            if (!x || typeof x !== 'object') {
                return;
            }
            if (typeof x.en === 'string') {
                for (const l of SPRACHEN) {
                    if (typeof x[l] !== 'string' || !x[l].trim()) {
                        fehlt.push(`${pfad}: ${l}`);
                    }
                }
                return;
            }
            for (const [s, v] of Object.entries(x)) {
                lauf(v, `${pfad}.${s}`);
            }
        };
        lauf(JSON.parse(JSON.stringify(k)), 'Karte');
        expect(fehlt).to.eql([]);
        expect(dm.WOCHENTAGE).to.have.all.keys(SPRACHEN);
    });
});

describe('Device-Manager: Fuehlerkorrektur neben der Solltemperatur', () => {
    it('Etikett nur mit Datenpunkt regulation.sensors.correction und nur bei wirksamer Korrektur', async () => {
        const a = await adapterMitGeraet();
        const id = [...a.objekte.values()].find(x => x.type === 'device')._id.slice(a.namespace.length + 1);
        expect((await kartenLaden(a)).karten[0].customInfo.schema.items.regelKorrektur).to.equal(undefined);
        for (const rel of ['regulation.sensors.correction', 'regulation.sensors.target']) {
            a.objekte.set(`${id}.${rel}`, { _id: `${a.namespace}.${id}.${rel}`, type: 'state', common: { type: 'number' }, native: {} });
        }
        const items = (await kartenLaden(a)).karten[0].customInfo.schema.items;
        const e = items.regelKorrektur;
        // steht direkt hinter Sollwert und Schieber
        const namenListe = Object.keys(items);
        expect(namenListe.indexOf('regelKorrektur')).to.equal(namenListe.indexOf('targetSlider') + 1);
        expect(e.hidden).to.contain('Math.abs(_states.k.val) >= 0.05');
        const textIn = (l, werte) =>
            new Function('_states', `return \`${e.text.func[l]}\``)(
                Object.fromEntries(Object.entries(werte).map(([k, v]) => [k, { val: v }])),
            );
        const text = werte => textIn('de', werte);
        expect(text({ k: 1, z: 21 })).to.contain('Fühlerkorrektur +1,0 K · Ziel 21,0 °C');
        // Dezimalzeichen der Sprache: Englisch und Chinesisch Punkt, alle anderen Komma
        for (const l of SPRACHEN) {
            const punkt = l === 'en' || l === 'zh-cn';
            expect(textIn(l, { k: 1.5, z: 21.5 }), l).to.contain(punkt ? '+1.5 K' : '+1,5 K').and.to.contain(punkt ? '21.5 °C' : '21,5 °C');
        }
        expect(text({ k: -0.5 })).to.contain('Fühlerkorrektur −0,5 K').and.not.to.contain('Ziel');
        for (const l of SPRACHEN) {
            expect(e.text.func[l]).to.be.a('string');
        }
    });
});
