'use strict';

/*
 * Schreiblast je MQTT-Nachricht (Issue #5).
 *
 * Bis 0.0.18 schrieb der Adapter bei jeder Statusmeldung alle Datenpunkte, drei neu gebaute
 * JSON-Reihen je Zaehler und den kompletten Zaehlerstand per extendObject ins Geraeteobjekt -
 * bei vier Geraeten rund 27 % CPU. Jetzt wird nur geschrieben, was sich geaendert hat, und der
 * Zaehlerstand nur bei Stundenwechsel, Hinweisen, hoechstens alle 10 min und beim Beenden.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const v = require('../lib/verbrauch');

/** Ersatz fuer die Adapterklasse des js-controllers: zaehlt Schreibzugriffe. */
class Attrappe {
    constructor() {
        this.namespace = 'faikout.0';
        this.config = {};
        this.objekte = new Map();
        this.werte = new Map();
        this.zahl = { setState: 0, extendObject: 0 };
        const leer = () => {};
        this.log = { debug: leer, info: leer, warn: leer, error: leer };
    }
    on() {}
    async getObjectAsync(id) {
        // wie der js-controller: mit und ohne Namensraum
        const o = this.objekte.get(id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id);
        return o ? JSON.parse(JSON.stringify(o)) : null;
    }
    async extendObject(id, obj) {
        this.zahl.extendObject++;
        const alt = this.objekte.get(id) || {};
        const neu = { ...alt, ...obj };
        for (const k of ['common', 'native']) {
            if (obj[k]) {
                neu[k] = { ...(alt[k] || {}), ...obj[k] };
            }
        }
        // wie die Datenbank: als Kopie ablegen, nicht als Verweis auf den Speicher des Adapters
        this.objekte.set(id, JSON.parse(JSON.stringify(neu)));
    }
    async setState(id, wert) {
        this.zahl.setState++;
        this.werte.set(id, wert);
    }
}

const neuerAdapter = objekte => {
    const a = proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
    if (objekte) {
        a.objekte = objekte;
    }
    return a;
};
const warte = async () => {
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setImmediate(r));
    }
};

/** Steuerbare Uhr: main.js liest die Zeit ueber new Date() und Date.now(). */
const EchtesDate = Date;
let uhr = 0;
class Uhr extends EchtesDate {
    constructor(...a) {
        if (a.length) {
            super(...a);
        } else {
            super(uhr);
        }
    }
    static now() {
        return uhr;
    }
}
const stelle = (tag, stunde, minute) => (uhr = new EchtesDate(2026, 10, tag, stunde, minute, 0).getTime());

const meldung = (energie, extra = {}) =>
    Buffer.from(
        JSON.stringify({
            power: true,
            mode: 'heat',
            target: 21,
            temp: 21.5,
            outside: 5,
            fan: 'auto',
            comp: 2640,
            consumption: 450,
            energy: energie,
            energyheat: energie - 1000000,
            energycool: 1000000,
            uptime: 1000,
            ...extra,
        }),
    );

describe('Schreiblast je Nachricht (Issue #5)', () => {
    before(() => {
        global.Date = /** @type {any} */ (Uhr);
    });
    after(() => {
        global.Date = EchtesDate;
    });

    it('1000 gleiche Nachrichten schreiben nach der ersten nahezu nichts', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        const erste = { ...a.zahl };
        expect(erste.setState).to.be.above(30); // erster Durchlauf: alles

        for (let i = 0; i < 1000; i++) {
            uhr += 100; // 1000 Nachrichten in 100 s, innerhalb derselben Stunde
            a.onMqtt('state/Daikin 1OG', meldung(3774300));
            await warte();
        }
        expect(a.zahl.setState - erste.setState).to.equal(0);
        expect(a.zahl.extendObject - erste.extendObject).to.equal(0);
    });

    it('schreibt nur, was sich aendert', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        const vorher = a.zahl.setState;

        uhr += 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774300, { uptime: 1001 }));
        await warte();
        expect(a.zahl.setState - vorher).to.equal(1);
        expect(a.werte.get('Daikin_1OG.info.uptime').val).to.equal(1001);

        // 5 Wh mehr: Gesamt- und Heizzaehler, je laufende Stunde/heute/Monat (2 × 4: Gesamtzaehler
        // in status, currentHour, today, thisMonth) plus Tages- und Monatsreihe je Zweig (2 × 2).
        // Die Stundenreihe bleibt - die Stunde ist dieselbe.
        const vorZaehler = a.zahl.setState;
        uhr += 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774305, { uptime: 1001 }));
        await warte();
        expect(a.zahl.setState - vorZaehler).to.equal(12);
        expect(a.werte.get('Daikin_1OG.consumption.total.currentHour').val).to.equal(0.005);
        expect(a.werte.get('Daikin_1OG.consumption.cooling.currentHour').val).to.equal(0);
    });

    it('frischt unveraenderte Werte nach 5 min wieder auf', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        const vorher = a.zahl.setState;
        uhr += 4 * 60 * 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        expect(a.zahl.setState).to.equal(vorher);
        uhr += 2 * 60 * 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        expect(a.zahl.setState).to.be.above(vorher);
        expect(a.werte.get('Daikin_1OG.status.outside').val).to.equal(5);
    });

    it('bestaetigt einen Befehl auch dann mit ack, wenn das Modul den alten Wert meldet', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.broker = { publish: async () => true };
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();

        // Nutzer setzt 24 °C, die Anlage lehnt ab und meldet weiter 21.
        a.werte.set('Daikin_1OG.control.target', { val: 24, ack: false });
        await a.onStateChange('faikout.0.Daikin_1OG.control.target', { val: 24, ack: false });
        uhr += 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        expect(a.werte.get('Daikin_1OG.control.target')).to.eql({ val: 21, ack: true });
    });

    it('sichert den Zaehlerstand bei Stundenwechsel, sonst hoechstens alle 10 min', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin 1OG', meldung(3774300));
        await warte();
        const sicherungen = () => a.zahl.extendObject;
        const nachStart = sicherungen();

        // 9 min lang jede Minute 1 Wh mehr: keine Sicherung
        for (let m = 1; m <= 9; m++) {
            uhr += 60 * 1000;
            a.onMqtt('state/Daikin 1OG', meldung(3774300 + m));
            await warte();
        }
        expect(sicherungen()).to.equal(nachStart);
        // nach 10 min: eine
        uhr += 60 * 1000;
        a.onMqtt('state/Daikin 1OG', meldung(3774310));
        await warte();
        expect(sicherungen()).to.equal(nachStart + 1);
        expect(a.objekte.get('Daikin_1OG').native.zaehler.energy.letzterWert).to.equal(3774310);

        // Stundenwechsel: sofort
        stelle(9, 11, 0);
        a.onMqtt('state/Daikin 1OG', meldung(3774311));
        await warte();
        expect(sicherungen()).to.equal(nachStart + 2);
        expect(a.objekte.get('Daikin_1OG').native.zaehler.energy.stunde).to.equal('2026-11-09T11');

        // Zaehler springt zurueck (Modul-Neustart): sofort
        uhr += 60 * 1000;
        a.onMqtt('state/Daikin 1OG', meldung(12));
        await warte();
        expect(sicherungen()).to.equal(nachStart + 3);

        // Beenden: immer
        await new Promise(r => a.onUnload(r));
        expect(sicherungen()).to.equal(nachStart + 4);
    });

    it('bucht nach einem Absturz zwischen zwei Sicherungen keinen falschen Verbrauch', async () => {
        stelle(9, 10, 0);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin 1OG', meldung(1000000));
        await warte();
        // 10:00-10:30 je Minute 10 Wh -> Sicherungen um 10:10, 10:20, 10:30
        for (let m = 1; m <= 30; m++) {
            uhr += 60 * 1000;
            a.onMqtt('state/Daikin 1OG', meldung(1000000 + m * 10));
            await warte();
        }
        // 10:31-10:38 weiter, aber ohne Sicherung - dann Absturz (kein onUnload)
        for (let m = 31; m <= 38; m++) {
            uhr += 60 * 1000;
            a.onMqtt('state/Daikin 1OG', meldung(1000000 + m * 10));
            await warte();
        }
        const gesichert = a.objekte.get('Daikin_1OG').native.zaehler.energy;
        expect(gesichert.letzterWert).to.equal(1000300); // Stand 10:30
        expect(a.werte.get('Daikin_1OG.consumption.total.currentHour').val).to.equal(0.38);

        // Fall 1: Neustart in derselben Stunde. Laufende Stunde und Tag = Rohwert minus Basis,
        // nichts doppelt, nichts verloren.
        stelle(9, 10, 45);
        const b = neuerAdapter(new Map(a.objekte));
        b.onMqtt('state/Daikin 1OG', meldung(1000450));
        await warte();
        expect(b.werte.get('Daikin_1OG.consumption.total.currentHour').val).to.equal(0.45);
        expect(b.werte.get('Daikin_1OG.consumption.total.today').val).to.equal(0.45);

        // Fall 2: Neustart erst nach dem Stundenwechsel (11:20). Was nach der letzten Sicherung
        // kam, faellt in die neue Stunde - die Summe stimmt, es entsteht kein Fantasiewert.
        stelle(9, 11, 20);
        const c = neuerAdapter(new Map(a.objekte));
        c.onMqtt('state/Daikin 1OG', meldung(1000600));
        await warte();
        const w = k => c.werte.get(`Daikin_1OG.consumption.total.${k}`).val;
        expect(w('lastHour')).to.equal(0.3);
        expect(w('currentHour')).to.equal(0.3);
        expect(w('today')).to.equal(0.6);
        expect(w('thisMonth')).to.equal(0.6);

        // Fall 3: Das Modul startete waehrend des Ausfalls neu, der Zaehler steht tiefer.
        stelle(9, 10, 50);
        const d = neuerAdapter(new Map(a.objekte));
        d.onMqtt('state/Daikin 1OG', meldung(500));
        await warte();
        expect(d.werte.get('Daikin_1OG.consumption.total.currentHour').val).to.equal(0);
        expect(d.werte.get('Daikin_1OG.consumption.total.today').val).to.equal(0);
    });
});

describe('Verbrauch: unveraendert()', () => {
    const zeit = (tag, stunde) => new EchtesDate(2026, 7, tag, stunde, 30, 0);

    it('erkennt gleichen Wert in derselben Stunde', () => {
        const s = v.verarbeiten(null, 1000, zeit(17, 10)).stand;
        expect(v.unveraendert(s, 1000, zeit(17, 10))).to.equal(true);
        expect(v.unveraendert(s, 1001, zeit(17, 10))).to.equal(false);
        expect(v.unveraendert(s, 1000, zeit(17, 11))).to.equal(false);
        expect(v.unveraendert(s, 1000, zeit(18, 10))).to.equal(false);
        expect(v.unveraendert(null, 1000, zeit(17, 10))).to.equal(false);
    });
});
