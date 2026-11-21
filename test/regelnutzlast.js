'use strict';

/*
 * JSON-Nutzlasten der Regelung (lib/regel/nutzlast.js): geschrieben wird mit englischen Schluesseln,
 * gelesen wird auch das deutsche Format des Vorabstands, gespeicherte Altwerte werden beim Start
 * einmal umgeschrieben.
 */

process.env.TZ = 'Europe/Berlin';

const { expect } = require('chai');
const nutzlast = require('../lib/regel/nutzlast');
const wochenplan = require('../lib/regel/wochenplan');
const { Anlage, aufbau, laufen } = require('./sim/simulator');

const { szenen } = wochenplan.szenenLesen(null);
const START = new Date(2026, 10, 20, 21, 30).getTime();

describe('Regelung: JSON-Nutzlasten englisch', () => {
    const ALT = {
        'demand.curveJson':
            '{"heizen":[[-10,95],[0,80],[8,60],[15,40]],"kuehlen":[[25,40],[30,65],[35,95]],"untergrenze":45,"obergrenze":95}',
        'demand.wouldSend': '{"wert":85,"zeit":"2026-11-21T12:14:38.489Z","aktion":"senden","ist":100}',
        lastCommand: '{"felder":{"target":22,"fan":"auto"},"zeit":"2026-11-21T11:38:19.361Z","aktion":"wuerde"}',
        'schedule.absenceJson': '{"von":1798326000000,"bis":1798930800000,"szene":"abwesend"}',
    };
    const NEU = {
        'demand.curveJson':
            '{"heating":[[-10,95],[0,80],[8,60],[15,40]],"cooling":[[25,40],[30,65],[35,95]],"lowerLimit":45,"upperLimit":95}',
        'demand.wouldSend': '{"value":85,"time":"2026-11-21T12:14:38.489Z","action":"send","current":100}',
        lastCommand: '{"fields":{"target":22,"fan":"auto"},"time":"2026-11-21T11:38:19.361Z","action":"would"}',
        'schedule.absenceJson': '{"from":1798326000000,"to":1798930800000,"level":"abwesend"}',
    };

    it('jeder JSON-Datenpunkt mit Schluesseln hat eine Art; alt -> neu je Datenpunkt', () => {
        expect(Object.keys(nutzlast.DATENPUNKTE).sort()).to.eql(Object.keys(ALT).sort());
        for (const pfad of Object.keys(ALT)) {
            expect(nutzlast.umschreiben(pfad, ALT[pfad]), pfad).to.equal(NEU[pfad]);
        }
    });

    it('neues Format bleibt stehen, Leeres und Unsinn auch (kein zweites Umschreiben)', () => {
        for (const pfad of Object.keys(NEU)) {
            expect(nutzlast.umschreiben(pfad, NEU[pfad]), pfad).to.equal(null);
        }
        expect(nutzlast.umschreiben('lastCommand', '')).to.equal(null);
        expect(nutzlast.umschreiben('lastCommand', '{kaputt')).to.equal(null);
        expect(nutzlast.umschreiben('lastCommand', '[1,2]')).to.equal(null);
        expect(nutzlast.umschreiben('lastCommand', null)).to.equal(null);
        expect(nutzlast.umschreiben('schedule.weekJson', '[[{"t":1,"s":"aus"}]]')).to.equal(null);
    });

    it('altes Format wird gelesen, neues geschrieben - beide ergeben dieselbe interne Struktur', () => {
        for (const pfad of Object.keys(ALT)) {
            const art = nutzlast.DATENPUNKTE[pfad];
            const ausAlt = nutzlast.lesen(art, ALT[pfad]);
            expect(nutzlast.lesen(art, NEU[pfad]), pfad).to.eql(ausAlt);
            expect(JSON.stringify(nutzlast.schreiben(art, ausAlt)), pfad).to.equal(NEU[pfad]);
        }
        expect(nutzlast.lesen('befehl', NEU.lastCommand).aktion).to.equal('wuerde');
        // stehen beide Schreibweisen in einem Objekt, gewinnt die englische
        expect(nutzlast.lesen('abwesenheit', { von: 1, from: 2, to: 3, level: 'aus' })).to.eql({
            von: 2,
            bis: 3,
            szene: 'aus',
        });
        // Zwischenstand `scene` (vor der Umbenennung in Temperaturstufen): wird gelesen, `level` gewinnt
        const zwischen = '{"from":1798326000000,"to":1798930800000,"scene":"abwesend"}';
        expect(nutzlast.lesen('abwesenheit', zwischen)).to.eql(nutzlast.lesen('abwesenheit', NEU['schedule.absenceJson']));
        expect(nutzlast.umschreiben('schedule.absenceJson', zwischen)).to.equal(NEU['schedule.absenceJson']);
        expect(nutzlast.lesen('abwesenheit', { szene: 'a', scene: 'b', level: 'c' }).szene).to.equal('c');
        expect(nutzlast.lesen('abwesenheit', { szene: 'a', scene: 'b' }).szene).to.equal('b');
        expect(Object.keys(nutzlast.schreiben('abwesenheit', { von: 1, bis: 2, szene: 'aus' }))).to.eql(['from', 'to', 'level']);
    });

    it('in den geschriebenen Nutzlasten steht kein deutscher Schluessel und kein deutscher Wert mehr', () => {
        const deutsch = /heizen|kuehlen|grenze|felder|zeit|aktion|wert|"ist"|"von"|"bis"|szene"|scene"|wuerde|senden/;
        for (const [pfad, text] of Object.entries(NEU)) {
            expect(text, pfad).to.not.match(deutsch);
        }
    });

    it('Abwesenheit: beide Formate werden gelesen', () => {
        const erwartet = { von: 1798326000000, bis: 1798930800000, szene: 'abwesend' };
        expect(wochenplan.abwesenheitLesen(ALT['schedule.absenceJson'], szenen)).to.eql(erwartet);
        expect(wochenplan.abwesenheitLesen(NEU['schedule.absenceJson'], szenen)).to.eql(erwartet);
        expect(wochenplan.abwesenheitLesen('{"from":5,"to":3,"level":"aus"}', szenen)).to.equal(null);
    });

    describe('im Adapter (main.js + Anlage)', function () {
        this.timeout(20000);

        it('Altwerte des Vorabstands werden beim Start einmal umgeschrieben', async () => {
            const { a, uhr } = aufbau({ regelProbelauf: true }, START);
            const anlage = new Anlage({ name: 'Alt N', target: 21, mode: 'heat' });
            for (const [pfad, text] of Object.entries(ALT)) {
                a.werte.set(`Alt_N.regulation.${pfad}`, { val: text, ack: true });
            }
            // Abwesenheit in der Zukunft, damit sie gueltig bleibt
            const abw = { von: START + 86400000, bis: START + 3 * 86400000, szene: 'abwesend' };
            a.werte.set('Alt_N.regulation.schedule.absenceJson', { val: JSON.stringify(abw), ack: true });
            await laufen(a, uhr, anlage, 2);
            expect(a.wert('Alt_N.regulation.lastCommand')).to.equal(NEU.lastCommand);
            expect(a.wert('Alt_N.regulation.demand.wouldSend')).to.equal(NEU['demand.wouldSend']);
            expect(JSON.parse(a.wert('Alt_N.regulation.schedule.absenceJson'))).to.eql({
                from: abw.von,
                to: abw.bis,
                level: 'abwesend',
            });
            expect(Object.keys(JSON.parse(a.wert('Alt_N.regulation.demand.curveJson')))).to.eql([
                'heating',
                'cooling',
                'lowerLimit',
                'upperLimit',
            ]);
            const zeilen = a.zeilen.filter(z => /rewritten to the current format/.test(z.text));
            expect(zeilen.length).to.be.within(3, 4);
            // die gelesene Abwesenheit gilt in der Regelung
            expect(a.regelung.geraete.get('Alt_N').abwesenheit).to.eql(abw);
        });

        it('ein Skript schreibt noch das alte Format: es wird uebernommen und englisch bestaetigt', async () => {
            const { a, uhr } = aufbau({ regelProbelauf: true }, START);
            const anlage = new Anlage({ name: 'Alt S', target: 21, mode: 'heat' });
            await laufen(a, uhr, anlage, 2);
            const abw = { von: START + 86400000, bis: START + 2 * 86400000, szene: 'aus' };
            expect(await a.regelung.schalter('Alt_S', 'schedule.absenceJson', JSON.stringify(abw))).to.equal(true);
            expect(JSON.parse(a.wert('Alt_S.regulation.schedule.absenceJson'))).to.eql({
                from: abw.von,
                to: abw.bis,
                level: 'aus',
            });
            expect(a.regelung.geraete.get('Alt_S').abwesenheit).to.eql(abw);
        });

        it('Befehle der Regelung: fields/time/action bzw. value/time/action/current', async () => {
            const { a, uhr } = aufbau({ regelProbelauf: true, regelAktiv: true }, START);
            const anlage = new Anlage({ name: 'Neu B', target: 23, mode: 'heat', outside: 5 });
            await laufen(a, uhr, anlage, 2);
            await a.regelung.schalter('Neu_B', 'schedule.weekJson', JSON.stringify(wochenplan.vorgabePlan(szenen)));
            await a.regelung.schalter('Neu_B', 'schedule.active', true);
            await laufen(a, uhr, anlage, 60);
            const befehl = JSON.parse(a.wert('Neu_B.regulation.lastCommand'));
            expect(Object.keys(befehl)).to.eql(['fields', 'time', 'action']);
            expect(befehl.action).to.equal('would');
            const demand = JSON.parse(a.wert('Neu_B.regulation.demand.wouldSend'));
            expect(Object.keys(demand)).to.eql(['value', 'time', 'action', 'current']);
            expect(demand.action).to.equal('would');
        });
    });
});
