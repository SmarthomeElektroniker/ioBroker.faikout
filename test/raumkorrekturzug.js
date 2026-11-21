'use strict';

/*
 * Ziehbare Raumkorrektur der Einstellungsseite (lib/raumkorrekturzug.js): Raster, Bereich, Tastenschritte,
 * Zahleneingabe - und dass das Bild dieselbe Rechnung zeigt wie der Rechenkern (lib/regel/bedarf.js).
 */

const { expect } = require('chai');
const zug = require('../lib/raumkorrekturzug');
const bedarf = require('../lib/regel/bedarf');

describe('Raumkorrektur zum Ziehen (lib/raumkorrekturzug.js)', () => {
    it('Bereich und Raster: Staerke 0..50 in ganzen Punkten, Totband 0..2 K in Zehnteln; Vorgaben wie der Rechenkern', () => {
        expect(zug.BEREICH.staerke).to.include({ min: 0, max: 50, raster: 1, vorgabe: bedarf.VORGABEN.prozentProK });
        expect(zug.BEREICH.totband).to.include({ min: 0, max: 2, raster: 0.1, vorgabe: bedarf.VORGABEN.totband });
        expect(zug.SCHWELLEN).to.eql({ vollAbK: bedarf.VORGABEN.vollAbK, ueberAbK: bedarf.VORGABEN.ueberAbK });
        expect([-3, 0, 9.4, 9.5, 50, 77, NaN].map(w => zug.rasten('staerke', w))).to.eql([0, 0, 9, 10, 50, 50, 10]);
        expect([-1, 0, 0.26, 0.34, 0.36, 1.999, 2.4, 'x'].map(w => zug.rasten('totband', w))).to.eql([0, 0, 0.3, 0.3, 0.4, 2, 2, 0.3]);
        // keine Rundungsreste wie 0.30000000000000004
        expect(String(zug.rasten('totband', 0.1 + 0.2))).to.equal('0.3');
    });

    it('lesen: leer oder Unsinn im Formular heisst Werksvorgabe; gespeicherte Werte bleiben, wie sie sind', () => {
        expect([undefined, null, '', 'abc'].map(w => zug.lesen('staerke', w))).to.eql([10, 10, 10, 10]);
        expect([0, '15', 7.5].map(w => zug.lesen('staerke', w))).to.eql([0, 15, 7.5]);
        expect([undefined, 0, '0.5'].map(w => zug.lesen('totband', w))).to.eql([0.3, 0, 0.5]);
    });

    it('Tastenschritte bleiben auf dem Raster und im Bereich', () => {
        expect(zug.schritt('staerke', 10, 1)).to.equal(11);
        expect(zug.schritt('staerke', 10, -5)).to.equal(5);
        expect(zug.schritt('staerke', 49, 5)).to.equal(50);
        expect(zug.schritt('staerke', 0, -1)).to.equal(0);
        expect(zug.schritt('totband', 0.3, 1)).to.equal(0.4);
        expect(zug.schritt('totband', 0.3, -1)).to.equal(0.2);
        expect(zug.schritt('totband', 0.1, -2)).to.equal(0);
        expect(zug.schritt('totband', 1.95, 1)).to.equal(2);
        // krummer gespeicherter Wert: der erste Schritt fuehrt aufs Raster
        expect(zug.schritt('staerke', 7.5, 1)).to.equal(9);
    });

    it('Zahleneingabe: Komma oder Punkt, Einheit erlaubt; ausserhalb des Bereichs und Nicht-Zahlen werden mit Grund abgelehnt', () => {
        expect(zug.eingabe('staerke', '15')).to.eql({ wert: 15, grund: '' });
        expect(zug.eingabe('staerke', ' 12 % je K')).to.eql({ wert: 12, grund: '' });
        expect(zug.eingabe('staerke', '12,4')).to.eql({ wert: 12, grund: '' });
        expect(zug.eingabe('staerke', '51')).to.eql({ wert: null, grund: 'bereich' });
        expect(zug.eingabe('staerke', '-1')).to.eql({ wert: null, grund: 'bereich' });
        expect(zug.eingabe('totband', '0,5')).to.eql({ wert: 0.5, grund: '' });
        expect(zug.eingabe('totband', '±0.25 K')).to.eql({ wert: 0.3, grund: '' });
        expect(zug.eingabe('totband', '2,1')).to.eql({ wert: null, grund: 'bereich' });
        for (const unsinn of ['', '  ', 'abc', '1 2', undefined]) {
            expect(zug.eingabe('totband', unsinn), String(unsinn)).to.eql({ wert: null, grund: 'zahl' });
        }
    });

    it('das Bild rechnet wie die Regelung (bedarf.raumKorrektur) - Heizen direkt, Kuehlen gespiegelt', () => {
        for (const [staerke, totband] of [[10, 0.3], [0, 0.3], [25, 0], [50, 2], [7, 1.2]]) {
            const k = { totband, prozentProK: staerke };
            for (let d = -3; d <= 3.001; d += 0.1) {
                const raumMinusZiel = Math.round(d * 10) / 10;
                const heizen = bedarf.raumKorrektur(21 + raumMinusZiel, 21, 'heizen', k).korrektur;
                const kuehlen = bedarf.raumKorrektur(21 - raumMinusZiel, 21, 'kuehlen', k).korrektur;
                const bild = zug.korrektur(raumMinusZiel, staerke, totband);
                expect(bild, `heizen ${staerke}/${totband} bei ${raumMinusZiel}`).to.be.closeTo(heizen, 1e-9);
                expect(bild, `kuehlen ${staerke}/${totband} bei ${raumMinusZiel}`).to.be.closeTo(kuehlen, 1e-9);
            }
        }
        // die Beispiele des Satzes: 1 K zu kalt = +7, 1 K zu warm = -7 (10 %/K, 0,3 K)
        expect(zug.korrektur(-1, 10, 0.3)).to.be.closeTo(7, 1e-9);
        expect(zug.korrektur(1, 10, 0.3)).to.be.closeTo(-7, 1e-9);
        expect(zug.korrektur(0.3, 10, 0.3)).to.equal(0);
    });
});
