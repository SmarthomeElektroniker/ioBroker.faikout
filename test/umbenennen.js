'use strict';

/*
 * Umbenanntes und geloeschtes Geraet (Issue #6).
 *
 * Bis 0.2.0 blieb ein Modul nach dem Umstellen seines Hostnamens unter dem alten Namen im Speicher
 * des Adapters. Hatte der Nutzer die alten Objekte geloescht, ging jede volle Stunde ein setState
 * auf jeden Verbrauchsdatenpunkt des alten Namens: "State ... has no existing object".
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

/** Ersatz fuer die Adapterklasse: Objekte, States und jeder setState ohne Objekt. */
class Attrappe {
    constructor() {
        this.namespace = 'faikout.0';
        this.config = {};
        this.objekte = new Map();
        this.werte = new Map();
        /** setState-Aufrufe auf IDs ohne Objekt - genau das loggt der js-controller als Warnung. */
        this.ohneObjekt = [];
        const leer = () => {};
        this.infos = [];
        this.log = { debug: leer, info: t => this.infos.push(t), warn: leer, error: leer };
    }
    on() {}
    kurz(id) {
        return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
    async getObjectAsync(id) {
        const o = this.objekte.get(this.kurz(id));
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
        if (!this.objekte.has(this.kurz(id))) {
            this.ohneObjekt.push(id);
        }
        this.werte.set(this.kurz(id), wert);
    }
    async getStateAsync(id) {
        return this.werte.get(this.kurz(id)) || null;
    }
    async getDevicesAsync() {
        return [...this.objekte.values()].filter(o => o.type === 'device').map(o => JSON.parse(JSON.stringify(o)));
    }
    /** Wie "Objekte loeschen" im Admin: alles unter dem Geraet, jedes Objekt meldet objectChange. */
    loeschen(geraetId, melden = true) {
        for (const id of [...this.objekte.keys()]) {
            if (id === geraetId || id.startsWith(`${geraetId}.`)) {
                this.objekte.delete(id);
                this.werte.delete(id);
                if (melden) {
                    this.onObjectChange(`${this.namespace}.${id}`, null);
                }
            }
        }
    }
}

const neuerAdapter = objekte => {
    const a = proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
    if (objekte) {
        a.objekte = objekte;
    }
    // Instanzobjekte aus io-package.json
    a.objekte.set('info', { type: 'channel' });
    a.objekte.set('info.connection', { type: 'state' });
    return a;
};
const warte = async () => {
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setImmediate(r));
    }
};

/** Steuerbare Uhr: main.js und verbrauch.js lesen die Zeit ueber new Date() und Date.now(). */
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

const MODUL = '983DAEF0AAAA';
const meldung = (energie, extra = {}) =>
    Buffer.from(
        JSON.stringify({
            up: true,
            id: MODUL,
            power: true,
            mode: 'heat',
            target: 21,
            temp: 21.5,
            energy: energie,
            energyheat: energie - 1000000,
            energycool: 1000000,
            ...extra,
        }),
    );

describe('Umbenanntes Modul (Issue #6)', () => {
    before(() => {
        global.Date = /** @type {any} */ (Uhr);
    });
    after(() => {
        global.Date = EchtesDate;
    });

    it('Umbenennen im laufenden Betrieb: Zaehler wandern mit, der alte Name bekommt nichts mehr', async () => {
        stelle(16, 1, 10);
        const a = neuerAdapter();
        a.onMqtt('state/Faik Rainer', meldung(2000000));
        await warte();
        stelle(16, 2, 30);
        a.onMqtt('state/Faik Rainer', meldung(2001500)); // 1,5 kWh heute
        await warte();
        expect(a.werte.get('Faik_Rainer.consumption.total.today').val).to.equal(1.5);

        // Hostname im Modul umgestellt: dasselbe Modul meldet sich unter neuem Namen.
        stelle(16, 3, 10);
        a.onMqtt('state/Faik Neu', meldung(2002000));
        await warte();
        expect([...a.geraete.keys()]).to.eql(['Faik_Neu']);
        // Heute = 1,5 kWh unter altem Namen + 0,5 kWh seitdem, nicht bei null begonnen.
        expect(a.werte.get('Faik_Neu.consumption.total.today').val).to.equal(2);
        expect(a.objekte.get('Faik_Neu').native.modulId).to.equal(MODUL);
        expect(a.objekte.get('Faik_Rainer').native.renamedTo).to.equal('Faik_Neu');
        expect(a.infos.some(t => t.includes('was known as "Faik Rainer"') && t.includes('taken over'))).to.equal(
            true,
        );

        // Nutzer loescht die alten Objekte; die naechste volle Stunde schreibt nur noch den neuen Namen.
        a.loeschen('Faik_Rainer');
        stelle(16, 4, 0);
        await a.stundenwechsel();
        expect(a.ohneObjekt).to.eql([]);
        expect(a.werte.has('Faik_Neu.consumption.total.lastHour')).to.equal(true);
    });

    it('der Fall aus dem Issue: alte Objekte geloescht, alter Name nicht mehr im Speicher und kein Schreiben', async () => {
        stelle(16, 1, 10);
        const a = neuerAdapter();
        a.onMqtt('state/Faik Rainer', meldung(2000000, { id: undefined }));
        await warte();
        // Ohne objectChange (Abo verpasst o. ae.): die Stundenpruefung faengt es selbst ab.
        a.loeschen('Faik_Rainer', false);
        stelle(16, 2, 0);
        await a.stundenwechsel();
        expect(a.ohneObjekt).to.eql([]);
        expect(a.geraete.size).to.equal(0);
        // Insbesondere kein Rumpfobjekt per extendObject(native.zaehler) wiederbelebt.
        expect(a.objekte.has('Faik_Rainer')).to.equal(false);
    });

    it('geloeschte Objekte eines weiter sendenden Moduls werden vollstaendig neu angelegt', async () => {
        stelle(16, 1, 10);
        const a = neuerAdapter();
        a.onMqtt('state/Faik Rainer', meldung(2000000));
        await warte();
        a.loeschen('Faik_Rainer');
        expect(a.geraete.size).to.equal(0);
        a.onMqtt('state/Faik Rainer', meldung(2000100));
        await warte();
        expect(a.ohneObjekt).to.eql([]);
        expect(a.objekte.get('Faik_Rainer').type).to.equal('device');
        expect(a.objekte.has('Faik_Rainer.consumption.total.today')).to.equal(true);
    });

    it('ein einzelner geloeschter Datenpunkt entsteht vor dem naechsten Schreiben neu', async () => {
        stelle(16, 1, 10);
        const a = neuerAdapter();
        a.onMqtt('state/Faik Rainer', meldung(2000000));
        await warte();
        for (const id of ['Faik_Rainer.consumption.total.today', 'Faik_Rainer.status.temp']) {
            a.objekte.delete(id);
            a.onObjectChange(`faikout.0.${id}`, null);
        }
        stelle(16, 1, 20);
        a.onMqtt('state/Faik Rainer', meldung(2000100, { temp: 22 }));
        await warte();
        expect(a.ohneObjekt).to.eql([]);
        expect(a.objekte.has('Faik_Rainer.consumption.total.today')).to.equal(true);
        expect(a.objekte.has('Faik_Rainer.status.temp')).to.equal(true);
    });

    it('nach einem Neustart: alter Name aus dem Objektbaum erkannt (ID nur im Datenpunkt info.id)', async () => {
        stelle(16, 1, 10);
        const vorher = neuerAdapter();
        vorher.onMqtt('state/Faik Rainer', meldung(2000000));
        await warte();
        stelle(16, 2, 30);
        vorher.onMqtt('state/Faik Rainer', meldung(2001500));
        await warte();
        await vorher.zaehlerstandSichern('Faik_Rainer', vorher.geraete.get('Faik_Rainer'));
        // Stand bis 0.2.0: kein native.modulId am Geraet.
        const objekte = vorher.objekte;
        delete objekte.get('Faik_Rainer').native.modulId;

        stelle(16, 3, 10);
        const a = neuerAdapter(objekte);
        a.werte = vorher.werte;
        a.onMqtt('state/Faik Neu', meldung(2002000));
        await warte();
        expect(a.werte.get('Faik_Neu.consumption.total.today').val).to.equal(2);
        expect(objekte.get('Faik_Rainer').native.renamedTo).to.equal('Faik_Neu');

        // Weiterer Neustart: das alte Geraet ist markiert - keine erneute Meldung, Zaehler bleiben.
        const b = neuerAdapter(objekte);
        b.werte = a.werte;
        await a.zaehlerstandSichern('Faik_Neu', a.geraete.get('Faik_Neu'));
        stelle(16, 3, 20);
        b.onMqtt('state/Faik Neu', meldung(2002100));
        await warte();
        expect(b.infos.some(t => t.includes('was known as'))).to.equal(false);
        expect(b.werte.get('Faik_Neu.consumption.total.today').val).to.equal(2.1);
    });

    it('verschiedene Module behalten ihre eigenen Zaehler', async () => {
        stelle(16, 1, 10);
        const a = neuerAdapter();
        a.onMqtt('state/Daikin A', meldung(2000000, { id: 'AAAAAAAAAAAA' }));
        a.onMqtt('state/Daikin B', meldung(5000000, { id: 'BBBBBBBBBBBB' }));
        await warte();
        stelle(16, 2, 30);
        a.onMqtt('state/Daikin A', meldung(2001000, { id: 'AAAAAAAAAAAA' }));
        a.onMqtt('state/Daikin B', meldung(5000300, { id: 'BBBBBBBBBBBB' }));
        await warte();
        expect([...a.geraete.keys()].sort()).to.eql(['Daikin_A', 'Daikin_B']);
        expect(a.werte.get('Daikin_A.consumption.total.today').val).to.equal(1);
        expect(a.werte.get('Daikin_B.consumption.total.today').val).to.equal(0.3);
        expect(a.infos.some(t => t.includes('was known as'))).to.equal(false);
    });

    it('hat das Geraet unter dem neuen Namen schon eigene Zaehler, werden sie nicht ueberschrieben', async () => {
        stelle(16, 1, 10);
        const objekte = new Map();
        // Altes Geraet aus 0.2.0: ID nur in info.id, eigener Zaehlerstand.
        const alt = neuerAdapter(objekte);
        alt.onMqtt('state/Faik Rainer', meldung(2000000, { id: undefined }));
        await warte();
        alt.werte.set('Faik_Rainer.info.id', { val: MODUL, ack: true });
        // Neuer Name, ebenfalls schon aus einem frueheren Lauf mit eigener Zaehlung (ohne ID gemeldet).
        alt.onMqtt('state/Faik Neu', meldung(2000000, { id: undefined }));
        await warte();
        stelle(16, 2, 30);
        alt.onMqtt('state/Faik Neu', meldung(2000700, { id: undefined }));
        await warte();
        await alt.zaehlerstandSichern('Faik_Neu', alt.geraete.get('Faik_Neu'));

        const a = neuerAdapter(objekte);
        a.werte = alt.werte;
        stelle(16, 2, 40);
        a.onMqtt('state/Faik Neu', meldung(2000800));
        await warte();
        expect(a.werte.get('Faik_Neu.consumption.total.today').val).to.equal(0.8);
        expect(objekte.get('Faik_Rainer').native.renamedTo).to.equal('Faik_Neu');
        expect(a.infos.some(t => t.includes('was known as') && !t.includes('taken over'))).to.equal(true);
    });
});
