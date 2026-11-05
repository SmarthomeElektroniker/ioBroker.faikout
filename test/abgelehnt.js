'use strict';

/*
 * Abgelehnte Einstellungen (error/<Name>/failed-set).
 *
 * Hintergrund (Faikout.c, Hauptschleife): Das Modul sendet eine Einstellung per S21 und liest sie
 * zurueck. Uebernimmt die Klimaanlage sie in `s21.tries` Runden nicht, verwirft das Modul die
 * Aenderung und meldet die Felder mit dem verlangten Wert auf error/<Name>/failed-set.
 * Am 05.11.2026 gemessen: `demand` 90 wird quittiert, aber nie uebernommen. Bis 0.0.18 stand
 * dafuer nur `Daikin 1OG: {"demand":90}` im Log - als Fehler des Adapters gemeldet.
 */

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const felder = require('../lib/fields');

describe('Abgelehnte Einstellung: Auswertung', () => {
    it('liest Feld und verlangten Wert aus failed-set', () => {
        expect(felder.abgelehntAuswerten('failed-set', '{"demand":90}')).to.eql({
            settings: { demand: 90 },
            text: 'demand=90',
        });
    });

    it('nennt mehrere Felder und laesst native Werte unveraendert', () => {
        const a = felder.abgelehntAuswerten('failed-set', '{"econo":true,"mode":"H","temp":21.5}');
        expect(a.settings).to.eql({ econo: true, mode: 'H', temp: 21.5 });
        expect(a.text).to.equal('econo=true, mode="H", temp=21.5');
    });

    it('zaehlt verschachtelte Angaben nicht als Einstellung, reicht sie aber durch', () => {
        const a = felder.abgelehntAuswerten('failed-set', '{"demand":90,"temp":null,"s21":{"D7":"ack","G7":"00IN"}}');
        expect(a.settings).to.eql({ demand: 90, temp: null });
        expect(a.text).to.equal('demand=90, temp=null');
        expect(a.details).to.eql({ s21: { D7: 'ack', G7: '00IN' } });
        expect(felder.abgelehntAuswerten('failed-set', '{"s21":{"D7":"nak"}}')).to.equal(null);
    });

    it('uebergeht andere Fehlertopics und unbrauchbare Nutzlasten', () => {
        expect(felder.abgelehntAuswerten('comms', '{"timeout":true}')).to.equal(null);
        expect(felder.abgelehntAuswerten('', '{"demand":90}')).to.equal(null);
        expect(felder.abgelehntAuswerten('failed-set', '{kaputt')).to.equal(null);
        expect(felder.abgelehntAuswerten('failed-set', '{}')).to.equal(null);
        expect(felder.abgelehntAuswerten('failed-set', '[90]')).to.equal(null);
        expect(felder.abgelehntAuswerten('failed-set', '90')).to.equal(null);
    });

    it('der Datenpunkt liegt als JSON unter info.failedSet', () => {
        const def = felder.FELDER['failed-set'];
        expect(def.kanal).to.equal('info');
        expect(def.role).to.equal('json');
        expect(def.w).to.equal(undefined);
        expect(felder.objektId('failed-set')).to.equal('failedSet');
    });
});

describe('Abgelehnte Einstellung: Adapter', () => {
    /** Ersatz fuer die Adapterklasse des js-controllers: merkt sich Logzeilen, Objekte und Werte. */
    class Attrappe {
        constructor() {
            this.namespace = 'faikout.0';
            this.zeilen = [];
            this.objekte = new Map();
            this.werte = new Map();
            const merke = stufe => text => this.zeilen.push({ stufe, text });
            this.log = { debug: merke('debug'), info: merke('info'), warn: merke('warn'), error: merke('error') };
        }
        on() {}
        async getObjectAsync(id) {
            return this.objekte.get(id) || null;
        }
        async extendObject(id, obj) {
            this.objekte.set(id, { ...(this.objekte.get(id) || {}), ...obj });
        }
        async setState(id, wert) {
            this.werte.set(id, wert);
        }
    }

    const neuerAdapter = () => proxyquire('../main', { '@iobroker/adapter-core': { Adapter: Attrappe } })({});
    const warte = () => new Promise(r => setTimeout(r, 20));
    const warnungen = a => a.zeilen.filter(z => z.stufe === 'warn').map(z => z.text);

    it('warnt im Klartext und fuellt info.failedSet', async () => {
        const a = neuerAdapter();
        const vorher = Date.now();
        a.onMqtt('error/Daikin 1OG/failed-set', Buffer.from('{"demand":90}'));
        await warte();

        expect(warnungen(a)).to.have.length(1);
        expect(warnungen(a)[0]).to.match(/^Daikin 1OG: the air conditioner did not accept demand=90\./);
        expect(warnungen(a)[0]).to.include('faikout.0.Daikin_1OG.info.failedSet');

        const obj = a.objekte.get('Daikin_1OG.info.failedSet');
        expect(obj.common.role).to.equal('json');
        expect(obj.common.write).to.equal(false);
        expect(obj.common.name.de).to.equal('Zuletzt von der Klimaanlage abgelehnte Einstellung');
        expect(Object.keys(obj.common.name)).to.have.length(11);

        const wert = a.werte.get('Daikin_1OG.info.failedSet');
        expect(wert.ack).to.equal(true);
        const inhalt = JSON.parse(wert.val);
        expect(inhalt.settings).to.eql({ demand: 90 });
        expect(Date.parse(inhalt.time)).to.be.within(vorher, Date.now());
        // Der Stellwert selbst bleibt unberuehrt - den echten Wert meldet das Modul selbst.
        expect(a.werte.has('Daikin_1OG.control.demand')).to.equal(false);
    });

    it('wiederholt dieselbe Ablehnung nicht als Warnung, eine andere schon', async () => {
        const a = neuerAdapter();
        a.onMqtt('error/Daikin 1OG/failed-set', Buffer.from('{"demand":90}'));
        await warte();
        a.onMqtt('error/Daikin 1OG/failed-set', Buffer.from('{"demand":90}'));
        await warte();
        expect(warnungen(a)).to.have.length(1);
        expect(a.zeilen.filter(z => z.stufe === 'debug' && /did not accept demand=90/.test(z.text))).to.have.length(1);

        a.onMqtt('error/Daikin 1OG/failed-set', Buffer.from('{"demand":50}'));
        a.onMqtt('error/Daikin Wohnzimmer/failed-set', Buffer.from('{"demand":90}'));
        await warte();
        expect(warnungen(a)).to.have.length(3);
        expect(JSON.parse(a.werte.get('Daikin_1OG.info.failedSet').val).settings).to.eql({ demand: 50 });
    });

    it('nennt bei anderen Fehlern das Topic und legt keinen Datenpunkt an', async () => {
        const a = neuerAdapter();
        a.onMqtt('error/Daikin 1OG/comms', Buffer.from('{"protocol":"S21","timeout":true}'));
        await warte();
        expect(warnungen(a)).to.eql(['Daikin 1OG: comms: {"protocol":"S21","timeout":true}']);
        expect(a.werte.size).to.equal(0);
    });
});
