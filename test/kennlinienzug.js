'use strict';

/*
 * Ziehbare Kennlinie der Einstellungsseite: die reine Zieh- und Grenzlogik (lib/kennlinienzug.js),
 * die die Komponente src-admin/src/Kennlinie.tsx benutzt.
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const zug = require('../lib/kennlinienzug');
const o = require('../lib/oberflaeche');
const kennlinie = require('../lib/regel/kennlinie');

const HEIZEN = [
    { x: -10, y: 95 },
    { x: 0, y: 75 },
    { x: 7, y: 55 },
    { x: 15, y: 40 },
];
const KUEHLEN = [
    { x: 25, y: 40 },
    { x: 30, y: 65 },
    { x: 35, y: 95 },
];
const paare = p => p.map(q => [q.x, q.y]);

describe('Kennlinie ziehen: Raster und Grenzen', () => {
    it('Vorgaben sind dieselben wie in der Regelung', () => {
        expect(paare(zug.VORGABE.heizen)).to.eql(kennlinie.VORGABE_HEIZEN);
        expect(paare(zug.VORGABE.kuehlen)).to.eql(kennlinie.VORGABE_KUEHLEN);
    });

    it('rastet x auf 1 °C und y auf 5 %', () => {
        const neu = zug.ziehen(HEIZEN, 1, { x: 2.4, y: 68.1 }, 'heizen');
        expect(neu[1]).to.eql({ x: 2, y: 70 });
        expect(zug.ziehen(HEIZEN, 1, { x: -3.6, y: 62.4 }, 'heizen')[1]).to.eql({ x: -4, y: 60 });
        // die uebergebene Liste bleibt unveraendert, die anderen Punkte auch
        expect(HEIZEN[1]).to.eql({ x: 0, y: 75 });
        expect([neu[0], neu[2], neu[3]]).to.eql([HEIZEN[0], HEIZEN[2], HEIZEN[3]]);
    });

    it('Nachbarn begrenzen x: streng aufsteigend, nie auf oder ueber den Nachbarn', () => {
        expect(zug.ziehen(HEIZEN, 1, { x: 30, y: 75 }, 'heizen')[1].x).to.equal(6);
        expect(zug.ziehen(HEIZEN, 1, { x: -30, y: 75 }, 'heizen')[1].x).to.equal(-9);
        // Nachbar neben dem Raster: der naechste ganze Wert echt dahinter bzw. davor
        const krumm = [{ x: -10.5, y: 95 }, { x: 0, y: 75 }, { x: 7.5, y: 55 }];
        expect(zug.ziehen(krumm, 1, { x: -30, y: 75 }, 'heizen')[1].x).to.equal(-10);
        expect(zug.ziehen(krumm, 1, { x: 30, y: 75 }, 'heizen')[1].x).to.equal(7);
        // kein freier Rasterwert zwischen den Nachbarn: x bleibt
        const eng = [{ x: 0, y: 90 }, { x: 1, y: 80 }, { x: 2, y: 70 }];
        expect(zug.ziehen(eng, 1, { x: 9, y: 80 }, 'heizen')[1].x).to.equal(1);
    });

    it('Randpunkte: x bis -40 bzw. 50, zusaetzlich begrenzt durch die sichtbare Achse', () => {
        expect(zug.ziehen(HEIZEN, 0, { x: -99, y: 95 }, 'heizen')[0].x).to.equal(-40);
        expect(zug.ziehen(HEIZEN, 3, { x: 99, y: 40 }, 'heizen')[3].x).to.equal(50);
        expect(zug.ziehen(HEIZEN, 0, { x: -99, y: 95 }, 'heizen', { xMin: -15, xMax: 20 })[0].x).to.equal(-15);
        expect(zug.ziehen(HEIZEN, 3, { x: 99, y: 40 }, 'heizen', { xMin: -15, xMax: 20 })[3].x).to.equal(20);
    });

    it('Heizen: y faellt mit x - nicht ueber den linken, nicht unter den rechten Nachbarn', () => {
        expect(zug.ziehen(HEIZEN, 1, { x: 0, y: 100 }, 'heizen')[1].y).to.equal(95);
        expect(zug.ziehen(HEIZEN, 1, { x: 0, y: 10 }, 'heizen')[1].y).to.equal(55);
        expect(zug.ziehen(HEIZEN, 0, { x: -10, y: 140 }, 'heizen')[0].y).to.equal(100);
        expect(zug.ziehen(HEIZEN, 0, { x: -10, y: 20 }, 'heizen')[0].y).to.equal(75);
        expect(zug.ziehen(HEIZEN, 3, { x: 15, y: -20 }, 'heizen')[3].y).to.equal(0);
        expect(zug.ziehen(HEIZEN, 3, { x: 15, y: 90 }, 'heizen')[3].y).to.equal(55);
    });

    it('Kuehlen: y steigt mit x - nicht unter den linken, nicht ueber den rechten Nachbarn', () => {
        expect(zug.ziehen(KUEHLEN, 1, { x: 30, y: 10 }, 'kuehlen')[1].y).to.equal(40);
        expect(zug.ziehen(KUEHLEN, 1, { x: 30, y: 100 }, 'kuehlen')[1].y).to.equal(95);
        expect(zug.ziehen(KUEHLEN, 0, { x: 25, y: -5 }, 'kuehlen')[0].y).to.equal(0);
        expect(zug.ziehen(KUEHLEN, 2, { x: 35, y: 130 }, 'kuehlen')[2].y).to.equal(100);
        expect(zug.bereich(KUEHLEN, 1, 'kuehlen')).to.eql({ xMin: 26, xMax: 34, yMin: 40, yMax: 95 });
        expect(zug.bereich(HEIZEN, 1, 'heizen')).to.eql({ xMin: -9, xMax: 6, yMin: 55, yMax: 95 });
    });

    it('was auch gezogen wird: die Kennlinie bleibt gueltig', () => {
        let zufall = 7;
        const wuerfel = () => (zufall = (zufall * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (const [start, richtung] of [[HEIZEN, 'heizen'], [KUEHLEN, 'kuehlen']]) {
            let p = start;
            for (let n = 0; n < 500; n++) {
                const i = Math.floor(wuerfel() * p.length);
                p = zug.ziehen(p, i, { x: wuerfel() * 140 - 70, y: wuerfel() * 160 - 30 }, richtung);
                expect(zug.pruefen(p, richtung), JSON.stringify(p)).to.equal(null);
                expect(o.kennliniePruefen(p, richtung).fehler, JSON.stringify(p)).to.equal(null);
                expect(p.every(q => Number.isInteger(q.x) && q.y % 5 === 0)).to.equal(true);
            }
        }
    });

    it('Pfeiltasten: links/rechts 1 °C, hoch/runter 5 %, mit denselben Grenzen', () => {
        expect(zug.schritt(HEIZEN, 1, 1, 0, 'heizen')[1]).to.eql({ x: 1, y: 75 });
        expect(zug.schritt(HEIZEN, 1, -1, 0, 'heizen')[1]).to.eql({ x: -1, y: 75 });
        expect(zug.schritt(HEIZEN, 1, 0, 1, 'heizen')[1]).to.eql({ x: 0, y: 80 });
        expect(zug.schritt(HEIZEN, 1, 0, -1, 'heizen')[1]).to.eql({ x: 0, y: 70 });
        // am Anschlag bleibt der Punkt stehen
        expect(zug.schritt(HEIZEN, 0, 0, 1, 'heizen')[0].y).to.equal(100);
        expect(zug.schritt(zug.schritt(HEIZEN, 0, 0, 1, 'heizen'), 0, 0, 1, 'heizen')[0].y).to.equal(100);
        const eng = [{ x: 0, y: 90 }, { x: 1, y: 90 }];
        expect(zug.schritt(eng, 0, 1, 0, 'heizen')).to.eql(eng);
        expect(zug.schritt(eng, 1, 0, 1, 'heizen')).to.eql(eng);
        // Werte neben dem Raster rasten in Laufrichtung ein
        const krumm = [{ x: -10, y: 95 }, { x: 0.5, y: 72 }, { x: 15, y: 40 }];
        expect(zug.schritt(krumm, 1, 0, 1, 'heizen')[1].y).to.equal(75);
        expect(zug.schritt(krumm, 1, 0, -1, 'heizen')[1].y).to.equal(70);
        expect(zug.schritt(krumm, 1, 1, 0, 'heizen')[1].x).to.equal(1);
        expect(zug.schritt(krumm, 1, -1, 0, 'heizen')[1].x).to.equal(0);
    });

    it('Pruefung nennt dieselben Fehler wie die Einstellungsseite bisher (kennliniePruefen)', () => {
        const faelle = [
            [[{ x: 5, y: 50 }], 'heizen'],
            [[{ x: 0, y: 50 }, { x: 5, y: 70 }], 'heizen'],
            [[{ x: 25, y: 60 }, { x: 30, y: 40 }], 'kuehlen'],
            [[{ x: 5, y: 50 }, { x: 5, y: 40 }], 'heizen'],
            [[{ x: 0, y: 120 }, { x: 5, y: 40 }], 'heizen'],
            [HEIZEN, 'heizen'],
            [KUEHLEN, 'kuehlen'],
            [HEIZEN, 'kuehlen'],
        ];
        for (const [p, richtung] of faelle) {
            const alt = o.kennliniePruefen(p, richtung).fehler;
            const neu = zug.pruefen(zug.punkte(p), richtung);
            expect(neu ? neu.schluessel : null, JSON.stringify(p)).to.equal(alt ? alt.schluessel : null);
        }
        // ein leeres Feld der Tabelle ist ein Fehler mit Zeilennummer, kein Punkt bei 0
        expect(zug.pruefen(zug.punkte([{ x: -10, y: 95 }, { x: '', y: 40 }]), 'heizen')).to.eql({ schluessel: 'fZahl', n: 2 });
        expect(zug.punkte([[1, 2], { x: '3,5', y: null }])).to.eql([{ x: 1, y: 2 }, { x: 3.5, y: NaN }]);
    });

    it('neuer Punkt: mitten in die groesste Luecke, die Kennlinie bleibt gueltig', () => {
        const r = zug.hinzu(HEIZEN);
        expect(r.neu).to.equal(1);
        expect(r.punkte[1]).to.eql({ x: -5, y: 85 });
        expect(zug.pruefen(r.punkte, 'heizen')).to.equal(null);
        const k = zug.hinzu(KUEHLEN);
        expect(zug.pruefen(k.punkte, 'kuehlen')).to.equal(null);
        expect(k.punkte).to.have.length(4);
        // ohne Luecke: aussen anfuegen
        const eng = zug.hinzu([{ x: 0, y: 90 }, { x: 1, y: 80 }]);
        expect(eng.punkte[2]).to.eql({ x: 6, y: 80 });
        // nichts mehr frei
        const voll = [{ x: -40, y: 90 }, { x: -39, y: 80 }];
        expect(zug.hinzu([...voll, ...Array.from({ length: 89 }, (_, i) => ({ x: -38 + i, y: 80 }))]).neu).to.equal(-1);
    });

    it('Etikett: echtes Minus, Dezimalzeichen der Sprache', () => {
        expect(zug.etikett({ x: -5, y: 85 }, 'de')).to.equal('−5 °C · 85 %');
        expect(zug.etikett({ x: 7.5, y: 55 }, 'de')).to.equal('7,5 °C · 55 %');
        expect(zug.etikett({ x: 7.5, y: 55 }, 'en')).to.equal('7.5 °C · 55 %');
        expect(zug.etikett({ x: 0, y: 100 }, 'unsinn-sprache-xx')).to.equal('0 °C · 100 %');
    });
});

describe('Kennlinie ziehen: Komponente der Einstellungsseite', () => {
    const wurzel = path.join(__dirname, '..');
    const lies = datei => JSON.parse(fs.readFileSync(path.join(wurzel, datei), 'utf8'));

    it('Texte der Komponente: alle Sprachen, Fehlertexte wortgleich mit dem Adapter', () => {
        const de = lies('src-admin/src/i18n/de.json');
        expect(de.fk_hinweis).to.contain('Punkte ziehen oder Werte in der Tabelle ändern');
        for (const s of o.SPRACHEN) {
            const texte = lies(`src-admin/src/i18n/${s}.json`);
            expect(Object.keys(texte), s).to.eql(Object.keys(de));
            for (const k of ['fZuWenig', 'fZahl', 'fBereich', 'fAufsteigend', 'fFallend', 'fSteigend', 'fGrenzen', 'untergrenze', 'obergrenze']) {
                expect(texte[`fk_${k}`], `${s}/${k}`).to.equal(o.TEXTE[k][s].replace(/\{n\}/g, '%s'));
            }
            if (s !== 'en') {
                expect(texte.fk_hinweis, s).not.to.equal(lies('src-admin/src/i18n/en.json').fk_hinweis);
            }
            // ausgeliefert wird genau die Quelle
            expect(lies(`admin/custom/i18n/${s}.json`), s).to.eql(texte);
        }
    });

    it('die Komponente rechnet mit lib/kennlinienzug.js und speichert nicht selbst', () => {
        const quelle = fs.readFileSync(path.join(wurzel, 'src-admin', 'src', 'Kennlinie.tsx'), 'utf8');
        expect(quelle).to.contain("from '../../lib/kennlinienzug.js'").and.to.contain("from '../../lib/kennlinienbild.js'");
        // geschrieben wird nur ins Formular (onChange) - kein Speichern am Formular vorbei
        expect(quelle).to.contain('this.onChange(this.props.attr, zeilen)');
        expect(quelle).not.to.match(/setObject|extendObject|setState\(|setNative/);
        expect(quelle.match(/sendTo\(/g)).to.have.length(1);
        expect(quelle).to.contain("'regelArbeitspunkt'");
    });

    it('Paket: admin/custom wird ausgeliefert, src-admin nicht', () => {
        const paket = lies('package.json');
        expect(paket.files).to.include('admin/').and.not.to.include('src-admin/');
        expect(paket.files.some(f => f.startsWith('src-admin'))).to.equal(false);
        expect(fs.existsSync(path.join(wurzel, 'admin', 'custom', 'customComponents.js'))).to.equal(true);
        expect(lies('admin/custom/mf-manifest.json').name).to.equal('ConfigCustomFaikoutSet');
    });
});
