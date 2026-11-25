'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { Meldungsbremse, RUHE_MS, ERINNERN_MS, dauerText, sorte } = require('../lib/meldungsbremse');

const TIMEOUT = '{"protocol":"S21","timeout":true}';
const F6 = '{"protocol":"S21","cmd":"F6","payload":"","text":"","noack":true,"value":"86"}';

describe('Fehlermeldungen der Module gebremst (Issue #15)', () => {
    let uhr;
    beforeEach(() => {
        uhr = sinon.useFakeTimers({ now: new Date(2026, 10, 25, 7, 38, 55).getTime(), toFake: ['Date'] });
    });
    afterEach(() => uhr.restore());

    it('Flut wie im Issue (zwei Module, alle 0,5 s): je Modul eine Warnung, der Rest im Debug-Log', () => {
        const b = new Meldungsbremse();
        const zeilen = [];
        for (let i = 0; i < 240; i++) {
            zeilen.push(...b.melden('faik-bedroom', 'comms', TIMEOUT));
            zeilen.push(...b.melden('faik-attic', 'comms', TIMEOUT));
            uhr.tick(500);
        }
        const warn = zeilen.filter(z => z.stufe === 'warn');
        expect(warn.map(z => z.text.split(':')[0])).to.deep.equal(['faik-bedroom', 'faik-attic']);
        expect(warn[0].text).to.include(TIMEOUT);
        expect(zeilen.filter(z => z.stufe === 'info')).to.deep.equal([]); // 2 min: noch keine Zusammenfassung
        const debug = zeilen.filter(z => z.stufe === 'debug');
        expect(debug).to.have.length(478);
        expect(debug[debug.length - 1].text).to.match(/^faik-attic: comms: .*\(#240\)$/);
    });

    it('anhaltende Störung: alle 15 min eine Zusammenfassung; danach Ruhe -> "no more error messages" als info', () => {
        const b = new Meldungsbremse();
        const zeilen = [];
        // 20 Minuten lang alle 0,5 s
        for (let i = 0; i < 2400; i++) {
            zeilen.push(...b.melden('faik-attic', 'comms', TIMEOUT));
            uhr.tick(500);
        }
        const info = zeilen.filter(z => z.stufe === 'info');
        expect(info).to.have.length(1);
        expect(info[0].text).to.match(/^faik-attic: comms: timeout still failing for 15 min \(1800 messages/);
        // innerhalb der Ruhezeit: noch nichts
        uhr.tick(RUHE_MS - 1000);
        expect(b.pruefen()).to.deep.equal([]);
        uhr.tick(1000);
        const ende = b.pruefen();
        expect(ende).to.have.length(1);
        expect(ende[0]).to.deep.equal({
            stufe: 'info',
            text: 'faik-attic: comms: timeout - no more error messages - 2400 messages within 20 min',
        });
        expect(b.pruefen()).to.deep.equal([]);
        // die naechste Stoerung beginnt wieder mit einer Warnung
        expect(b.melden('faik-attic', 'comms', TIMEOUT)[0].stufe).to.equal('warn');
    });

    it('verschiedene Sorten (F6 noack, timeout) sind getrennte Störungen; eine einzelne Meldung bekommt keine Schlusszeile', () => {
        const b = new Meldungsbremse();
        expect(b.melden('faik-bedroom', 'comms', F6)[0].stufe).to.equal('warn');
        uhr.tick(32000);
        expect(b.melden('faik-bedroom', 'comms', TIMEOUT)[0].stufe).to.equal('warn');
        uhr.tick(500);
        expect(b.melden('faik-bedroom', 'comms', TIMEOUT)[0].stufe).to.equal('debug');
        uhr.tick(RUHE_MS);
        const ende = b.pruefen();
        expect(ende.map(z => z.text)).to.deep.equal([
            'faik-bedroom: comms: timeout - no more error messages - 2 messages within 1 s',
        ]);
        expect(b.stoerungen.size).to.equal(0);
    });

    it('ohne Takt: die nächste Meldung nach der Ruhezeit schließt die alte Störung ab und warnt neu', () => {
        const b = new Meldungsbremse();
        b.melden('faik-attic', 'comms', TIMEOUT);
        uhr.tick(500);
        b.melden('faik-attic', 'comms', TIMEOUT);
        uhr.tick(ERINNERN_MS);
        const z = b.melden('faik-attic', 'comms', TIMEOUT);
        expect(z.map(x => x.stufe)).to.deep.equal(['info', 'warn']);
        expect(z[0].text).to.include('no more error messages - 2 messages');
    });

    it('vergessen, Sorten und Dauertext', () => {
        const b = new Meldungsbremse();
        b.melden('a', 'comms', TIMEOUT);
        b.melden('b', 'comms', TIMEOUT);
        b.vergessen('a');
        expect([...b.stoerungen.values()].map(s => s.geraet)).to.deep.equal(['b']);
        expect(sorte(TIMEOUT)).to.equal('timeout');
        expect(sorte(F6)).to.equal('cmd F6');
        expect(sorte('kein JSON')).to.equal('');
        expect(sorte('null')).to.equal('');
        expect(dauerText(45000)).to.equal('45 s');
        expect(dauerText(12 * 60000)).to.equal('12 min');
        expect(dauerText(125 * 60000)).to.equal('2 h 5 min');
        // Text ohne Unterpfad
        expect(new Meldungsbremse().melden('x', '', 'oops')[0].text).to.match(/^x: oops - further/);
    });
});
