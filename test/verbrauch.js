'use strict';

const { expect } = require('chai');
const v = require('../lib/verbrauch');

/** Fester Zeitpunkt, damit die Tests nicht an der echten Uhr haengen. */
const zeit = (tag, stunde) => new Date(2026, 7, tag, stunde, 30, 0);

describe('Verbrauchsrechnung', () => {
    it('liefert beim ersten Wert überall null-Verbrauch, aber den Gesamtzähler', () => {
        const r = v.verarbeiten(null, 3774300, zeit(17, 10));
        expect(r.werte.gesamt).to.equal(3774.3);
        expect(r.werte.stunde).to.equal(0);
        expect(r.werte.heute).to.equal(0);
        expect(r.werte.letzteStunde).to.equal(null);
        expect(r.hinweise).to.be.empty;
    });

    it('rechnet innerhalb einer Stunde die Differenz', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 1000400, zeit(17, 10));
        expect(r.werte.stunde).to.equal(0.4);
        expect(r.werte.heute).to.equal(0.4);
        expect(r.werte.gesamt).to.equal(1000.4);
    });

    it('schließt die Stunde beim Stundenwechsel ab', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 1000500, zeit(17, 11));
        expect(r.werte.letzteStunde, 'die volle Stunde 10 Uhr').to.equal(0.4);
        expect(r.werte.stunde, 'in der neuen Stunde erst 100 Wh').to.equal(0.1);
        expect(r.werte.heute, 'der Tag läuft weiter').to.equal(0.5);
        expect(r.werte.ring).to.have.lengthOf(1);
        expect(r.werte.ring[0]).to.deep.equal({ stunde: '2026-08-17T10', kwh: 0.4 });
    });

    it('schließt den Tag beim Tageswechsel ab', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 23)).stand;
        s = v.verarbeiten(s, 1002000, zeit(17, 23)).stand;
        const r = v.verarbeiten(s, 1002100, zeit(18, 0));
        expect(r.werte.gestern).to.equal(2);
        expect(r.werte.heute).to.equal(0.1);
    });

    it('bucht einen zurückgesprungenen Zähler NICHT als Verbrauch', () => {
        // Passiert beim Neustart des Moduls - eine negative Differenz waere sonst ein
        // gewaltiger Fantasieverbrauch.
        let s = v.verarbeiten(null, 3774300, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 3774800, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 12, zeit(17, 10));
        expect(r.werte.stunde, 'nach dem Reset wieder bei null').to.equal(0);
        expect(r.werte.heute).to.equal(0);
        expect(r.werte.gesamt).to.equal(0.012);
        expect(r.hinweise.join(' ')).to.match(/zurückgesprungen/);
    });

    it('vermerkt Ausfallzeiten als Lücke statt sie einer Stunde zuzuschlagen', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // Der Adapter war 3 Stunden weg und meldet sich um 14 Uhr zurueck.
        const r = v.verarbeiten(s, 1002000, zeit(17, 14));
        expect(r.werte.letzteStunde, 'die 10-Uhr-Stunde ist sauber abgeschlossen').to.equal(0.4);
        const luecken = r.werte.ring.filter(e => e.kwh === null);
        expect(luecken, 'drei unbekannte Stunden').to.have.lengthOf(3);
        expect(r.hinweise.join(' ')).to.match(/Lücke/);
    });

    it('begrenzt den Ringpuffer auf 48 Stunden', () => {
        let s = v.verarbeiten(null, 0, zeit(1, 0)).stand;
        for (let i = 1; i < 60; i++) {
            s = v.verarbeiten(s, i * 100, new Date(2026, 7, 1 + Math.floor(i / 24), i % 24, 30)).stand;
        }
        expect(s.ring.length).to.be.at.most(v.RING_STUNDEN);
    });

    it('erkennt den Stundenwechsel auch ohne neuen Zählerstand', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // Das Modul sendet nur alle 60 s - um Punkt 11 Uhr kommt eventuell nichts.
        const r = v.pruefen(s, zeit(17, 11));
        expect(r.werte, 'der Timer schließt die Stunde ab').to.not.equal(null);
        expect(r.werte.letzteStunde).to.equal(0.4);
    });

    it('tut beim Prüfen nichts, wenn sich die Stunde nicht geändert hat', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        const r = v.pruefen(s, zeit(17, 10));
        expect(r.werte).to.equal(null);
    });

    it('überlebt einen Zustand aus einer älteren Fassung ohne die neuen Ringe', () => {
        // Genau so sah der gespeicherte Zustand in 0.0.1 aus. Fehlten ringTage/ringMonate,
        // brach der Tageswechsel mit "Cannot read properties of undefined (reading 'push')".
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 23)).stand;
        const alt = JSON.parse(JSON.stringify(s));
        delete alt.ringTage;
        delete alt.ringMonate;
        delete alt.monat;
        delete alt.basisMonat;
        delete alt.letzterMonat;

        const r = v.verarbeiten(alt, 1001000, zeit(18, 8));
        expect(r.werte.gestern, 'der Tageswechsel läuft durch').to.equal(0.4);
        expect(r.werte.ringTage, 'die Tagesreihe entsteht neu').to.be.an('array');
        expect(r.werte.ringMonate, 'die Monatsreihe entsteht neu').to.be.an('array');
    });

    it('bucht den ersten gesehenen Monat nicht als Vormonat', () => {
        // Aus 0.0.1 kam ein Zustand ohne Monatsfelder. Ohne Ausnahme wurde beim ersten
        // Wert der volle Zaehlerstand (3783 kWh) als Verbrauch des Vormonats gebucht.
        let s = v.verarbeiten(null, 3780000, zeit(17, 10)).stand;
        const alt = JSON.parse(JSON.stringify(s));
        delete alt.monat;
        delete alt.basisMonat;
        delete alt.letzterMonat;
        delete alt.ringMonate;

        const r = v.verarbeiten(alt, 3780500, zeit(17, 11));
        expect(r.werte.letzterMonat, 'es gibt keinen Vormonat').to.equal(null);
        // 0,5 statt 0: die Basis ist der zuletzt bekannte Stand, der Verbrauch seither zaehlt mit.
        expect(r.werte.dieserMonat, 'der laufende Monat zählt ab dem letzten Stand').to.equal(0.5);
        expect(r.stand.ringMonate, 'kein Phantom-Monat im Ring').to.be.empty;
    });

    it('überlebt einen Neustart, wenn der Zustand gespeichert wurde', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // So landet der Zustand im Geraeteobjekt und kommt wieder heraus.
        const gespeichert = JSON.parse(JSON.stringify(s));
        const r = v.verarbeiten(gespeichert, 1000900, zeit(17, 10));
        expect(r.werte.heute, 'die Tagesbasis ist erhalten geblieben').to.equal(0.9);
    });
});
