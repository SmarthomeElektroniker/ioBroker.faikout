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
        // Werksvorgabe 1.0.0: der kaelteste Heizpunkt liegt bei 100 %, die Obergrenze ebenfalls
        expect(paare(zug.VORGABE.heizen)).to.eql([[-10, 100], [0, 75], [7, 55], [15, 40]]);
        expect(zug.VORGABE_GRENZEN).to.eql({ untergrenze: 40, obergrenze: 100 });
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

describe('Kennlinie ziehen: Punkt einfuegen und entfernen', () => {
    it('Doppelklick: der neue Punkt rastet ein und liegt zwischen den Nachbarn', () => {
        const r = zug.einfuegen(HEIZEN, { x: 3.4, y: 63.2 }, 'heizen');
        expect(r.neu).to.equal(2);
        expect(r.punkte[2]).to.eql({ x: 3, y: 65 });
        expect(r.punkte).to.have.length(5);
        expect(zug.pruefen(r.punkte, 'heizen')).to.equal(null);
        // die uebergebene Liste bleibt unveraendert
        expect(HEIZEN).to.have.length(4);
    });

    it('Monotonie: die Leistung des neuen Punktes wird von den Nachbarn begrenzt', () => {
        // Heizen faellt: zwischen 75 % (links) und 55 % (rechts)
        expect(zug.einfuegen(HEIZEN, { x: 3, y: 100 }, 'heizen').punkte[2]).to.eql({ x: 3, y: 75 });
        expect(zug.einfuegen(HEIZEN, { x: 3, y: 5 }, 'heizen').punkte[2]).to.eql({ x: 3, y: 55 });
        // Kuehlen steigt: zwischen 40 % (links) und 65 % (rechts)
        expect(zug.einfuegen(KUEHLEN, { x: 27, y: 90 }, 'kuehlen').punkte[1]).to.eql({ x: 27, y: 65 });
        expect(zug.einfuegen(KUEHLEN, { x: 27, y: 0 }, 'kuehlen').punkte[1]).to.eql({ x: 27, y: 40 });
    });

    it('ausserhalb der Kennlinie: der neue Punkt wird erster bzw. letzter', () => {
        const links = zug.einfuegen(HEIZEN, { x: -14.6, y: 60 }, 'heizen');
        expect(links.neu).to.equal(0);
        // links von der Heizkennlinie darf es nicht weniger sein als beim bisherigen ersten Punkt
        expect(links.punkte[0]).to.eql({ x: -15, y: 95 });
        const rechts = zug.einfuegen(HEIZEN, { x: 18, y: 20 }, 'heizen');
        expect(rechts.neu).to.equal(4);
        expect(rechts.punkte[4]).to.eql({ x: 18, y: 20 });
        expect(zug.einfuegen(KUEHLEN, { x: 38, y: 50 }, 'kuehlen').punkte[3]).to.eql({ x: 38, y: 95 });
    });

    it('auf einem vorhandenen Punkt: ausweichen zur Seite des Klicks, sonst nichts tun', () => {
        expect(zug.einfuegen(HEIZEN, { x: 0.3, y: 70 }, 'heizen').punkte[2]).to.eql({ x: 1, y: 70 });
        expect(zug.einfuegen(HEIZEN, { x: -0.3, y: 80 }, 'heizen').punkte[1]).to.eql({ x: -1, y: 80 });
        const eng = [{ x: 0, y: 90 }, { x: 1, y: 80 }, { x: 2, y: 70 }];
        const voll = zug.einfuegen(eng, { x: 1.2, y: 80 }, 'heizen', { xMin: 0, xMax: 2 });
        expect(voll.neu).to.equal(-1);
        expect(voll.punkte).to.eql(eng);
        // die sichtbare Achse begrenzt x
        expect(zug.einfuegen(HEIZEN, { x: 44, y: 10 }, 'heizen', { xMin: -15, xMax: 20 }).punkte[4].x).to.equal(20);
        expect(zug.einfuegen(HEIZEN, { x: NaN, y: 10 }, 'heizen').neu).to.equal(-1);
    });

    it('wo auch geklickt wird: die Kennlinie bleibt gueltig', () => {
        let zufall = 11;
        const wuerfel = () => (zufall = (zufall * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (const [start, richtung] of [[HEIZEN, 'heizen'], [KUEHLEN, 'kuehlen']]) {
            let p = start;
            for (let n = 0; n < 300; n++) {
                const r = zug.einfuegen(p, { x: wuerfel() * 110 - 50, y: wuerfel() * 130 - 15 }, richtung);
                expect(zug.pruefen(r.punkte, richtung), JSON.stringify(r.punkte)).to.equal(null);
                expect(o.kennliniePruefen(r.punkte, richtung).fehler, JSON.stringify(r.punkte)).to.equal(null);
                expect(r.punkte.length).to.equal(p.length + (r.neu >= 0 ? 1 : 0));
                p = r.punkte;
                if (p.length > 8) {
                    p = zug.entfernen(p, Math.floor(wuerfel() * p.length)).punkte;
                    expect(zug.pruefen(p, richtung)).to.equal(null);
                }
            }
        }
    });

    it('entfernen: zwei Punkte bleiben immer', () => {
        const r = zug.entfernen(HEIZEN, 1);
        expect(r.entfernt).to.equal(true);
        expect(paare(r.punkte)).to.eql([[-10, 95], [7, 55], [15, 40]]);
        expect(HEIZEN).to.have.length(4);
        const zwei = [{ x: 0, y: 90 }, { x: 10, y: 50 }];
        expect(zug.entfernen(zwei, 0)).to.eql({ punkte: zwei, entfernt: false });
        expect(zug.entfernen(HEIZEN, 9).entfernt).to.equal(false);
        expect(zug.entfernen(HEIZEN, -1).entfernt).to.equal(false);
    });
});

describe('Kennlinie ziehen: Unter- und Obergrenze als Linien', () => {
    const g = { untergrenze: 40, obergrenze: 95 };

    it('5-%-Raster: Untergrenze 30 ... Obergrenze, Obergrenze Untergrenze ... 100', () => {
        expect(zug.grenzeZiehen('unter', 52.4, g)).to.equal(50);
        expect(zug.grenzeZiehen('unter', 52.6, g)).to.equal(55);
        expect(zug.grenzeZiehen('unter', 3, g)).to.equal(30);
        expect(zug.grenzeZiehen('unter', 140, g)).to.equal(95);
        expect(zug.grenzeZiehen('ober', 77.6, g)).to.equal(80);
        expect(zug.grenzeZiehen('ober', 140, g)).to.equal(100);
        expect(zug.grenzeZiehen('ober', -20, g)).to.equal(40);
        expect(zug.grenzBereich('unter', g)).to.eql({ min: 30, max: 95 });
        expect(zug.grenzBereich('ober', g)).to.eql({ min: 40, max: 100 });
        // unlesbares Ziel: die Linie bleibt
        expect(zug.grenzeZiehen('unter', NaN, g)).to.equal(40);
    });

    it('krumme Gegenlinie: der Bereich zaehlt nach innen, die Grenzen bleiben gueltig', () => {
        const krumm = { untergrenze: 42, obergrenze: 93 };
        expect(zug.grenzBereich('unter', krumm)).to.eql({ min: 30, max: 90 });
        expect(zug.grenzBereich('ober', krumm)).to.eql({ min: 45, max: 100 });
        expect(zug.grenzeZiehen('unter', 99, krumm)).to.equal(90);
        expect(zug.grenzeZiehen('ober', 0, krumm)).to.equal(45);
        for (let ziel = -20; ziel <= 130; ziel += 3.5) {
            expect(zug.grenzenGueltig(zug.grenzeZiehen('unter', ziel, g), g.obergrenze), `unter ${ziel}`).to.equal(true);
            expect(zug.grenzenGueltig(g.untergrenze, zug.grenzeZiehen('ober', ziel, g)), `ober ${ziel}`).to.equal(true);
        }
    });

    it('dieselbe Regel wie die Regelung: 30 <= Untergrenze <= Obergrenze <= 100', () => {
        expect(zug.grenzenGueltig(40, 95)).to.equal(true);
        expect(zug.grenzenGueltig(30, 30)).to.equal(true);
        expect(zug.grenzenGueltig(100, 100)).to.equal(true);
        expect(zug.grenzenGueltig(25, 95)).to.equal(false);
        expect(zug.grenzenGueltig(60, 50)).to.equal(false);
        expect(zug.grenzenGueltig(40, 105)).to.equal(false);
        expect(zug.grenzenGueltig(NaN, 95)).to.equal(false);
    });

    it('Pfeiltasten: 5-%-Schritte mit denselben Anschlaegen, krumme Werte rasten in Laufrichtung ein', () => {
        expect(zug.grenzeSchritt('unter', 1, g)).to.equal(45);
        expect(zug.grenzeSchritt('unter', -1, g)).to.equal(35);
        expect(zug.grenzeSchritt('unter', -5, g)).to.equal(30);
        expect(zug.grenzeSchritt('ober', 1, g)).to.equal(100);
        expect(zug.grenzeSchritt('ober', 2, g)).to.equal(100);
        expect(zug.grenzeSchritt('ober', -20, g)).to.equal(40);
        expect(zug.grenzeSchritt('unter', 0, g)).to.equal(40);
        const krumm = { untergrenze: 42, obergrenze: 93 };
        expect(zug.grenzeSchritt('unter', 1, krumm)).to.equal(45);
        expect(zug.grenzeSchritt('unter', -1, krumm)).to.equal(40);
        expect(zug.grenzeSchritt('ober', 1, krumm)).to.equal(95);
        expect(zug.grenzeSchritt('ober', -1, krumm)).to.equal(90);
    });

    it('Zwischenablage: nur eine fuer die Richtung gueltige Kennlinie wird uebernommen', () => {
        const kopie = { punkte: HEIZEN, untergrenze: 45, obergrenze: 90 };
        expect(zug.inhaltLesen(kopie, 'heizen')).to.eql({ punkte: HEIZEN, untergrenze: 45, obergrenze: 90 });
        // eine Heizkennlinie ist keine Kuehlkennlinie
        expect(zug.inhaltLesen(kopie, 'kuehlen')).to.equal(null);
        expect(zug.inhaltLesen({ punkte: [] }, 'heizen')).to.equal(null);
        expect(zug.inhaltLesen(null, 'heizen')).to.equal(null);
        expect(zug.inhaltLesen('unsinn', 'heizen')).to.equal(null);
        // unbrauchbare Grenzen fallen weg, die Punkte bleiben
        expect(zug.inhaltLesen({ punkte: HEIZEN, untergrenze: 80, obergrenze: 50 }, 'heizen')).to.eql({
            punkte: HEIZEN,
            untergrenze: null,
            obergrenze: null,
        });
        expect(zug.inhaltLesen({ punkte: KUEHLEN }, 'kuehlen').untergrenze).to.equal(null);
    });

    it('Zahl mit fester Nachkommastelle: "−4,0", kein "−0,0"', () => {
        expect(zug.anzeigeFest(-4, 1, 'de')).to.equal('−4,0');
        expect(zug.anzeigeFest(-4.04, 1, 'en')).to.equal('−4.0');
        expect(zug.anzeigeFest(12.25, 1, 'zh-cn')).to.equal('12.3');
        expect(zug.anzeigeFest(-0.04, 1, 'de')).to.equal('0,0');
        expect(zug.anzeigeFest(7, 1, 'unsinn-sprache-xx')).to.equal('7.0');
    });
});

describe('Kennlinie ziehen: Komponente der Einstellungsseite', () => {
    const wurzel = path.join(__dirname, '..');
    const lies = datei => JSON.parse(fs.readFileSync(path.join(wurzel, datei), 'utf8'));

    it('Texte der Komponente: alle Sprachen, Fehlertexte wortgleich mit dem Adapter', () => {
        const de = lies('src-admin/src/i18n/de.json');
        for (const s of o.SPRACHEN) {
            const texte = lies(`src-admin/src/i18n/${s}.json`);
            expect(Object.keys(texte), s).to.eql(Object.keys(de));
            for (const k of ['fZuWenig', 'fZahl', 'fBereich', 'fAufsteigend', 'fFallend', 'fSteigend', 'fGrenzen', 'untergrenze', 'obergrenze']) {
                expect(texte[`fk_${k}`], `${s}/${k}`).to.equal(o.TEXTE[k][s].replace(/\{n\}/g, '%s'));
            }
            // ausgeliefert wird genau die Quelle
            expect(lies(`admin/custom/i18n/${s}.json`), s).to.eql(texte);
        }
    });

    // die neuen Texte stehen je Komponente in einer eigenen Datei; ihr Block TEXTE ist reines JavaScript
    const texteAus = datei => {
        const quelle = fs.readFileSync(path.join(wurzel, 'src-admin', 'src', datei), 'utf8');
        const block = quelle.match(/\nconst TEXTE = (\{[\s\S]*?\n\});\n/);
        expect(block, datei).not.to.equal(null);
        return new Function(`return ${block[1]}`)();
    };

    for (const datei of ['Kennlinie.texte.ts', 'Werkzeugleiste.texte.ts']) {
        it(`${datei}: alle 11 Sprachen, dieselben Schluessel und Platzhalter, uebersetzt`, () => {
            const texte = texteAus(datei);
            expect(Object.keys(texte).sort()).to.eql([...o.SPRACHEN].sort());
            const platzhalter = t => (String(t).match(/%s/g) || []).length;
            for (const s of o.SPRACHEN) {
                expect(Object.keys(texte[s]), s).to.eql(Object.keys(texte.en));
                for (const [k, text] of Object.entries(texte[s])) {
                    expect(text, `${s}/${k}`).to.be.a('string').and.not.to.equal('');
                    expect(platzhalter(text), `${s}/${k}`).to.equal(platzhalter(texte.en[k]));
                    // Gedankenstrich statt Bindestrich-Minus zwischen Leerzeichen
                    expect(text, `${s}/${k}`).not.to.match(/ - /);
                }
                if (s !== 'en') {
                    const gleich = Object.keys(texte.en).filter(k => texte[s][k] === texte.en[k]);
                    expect(gleich, `${s}: nicht uebersetzt`).to.eql([]);
                }
            }
        });
    }

    it('Texte der Schnittstelle: Legende, Grenzen, Jetzt-Marker, leere Kennlinie (de mit "du")', () => {
        const de = texteAus('Kennlinie.texte.ts').de;
        expect(de.legPunkt).to.equal('Stützpunkt (ziehbar)');
        expect(de.legVorlage).to.equal('Vorlage');
        expect(de.legJetzt).to.equal('jetzt');
        expect(de.etikettVorlage).to.equal('Vorlage (nicht angepasst)');
        expect(de.anlegen).to.equal('Eigene Kennlinie anlegen');
        expect(de.tabelle).to.equal('Werte als Tabelle');
        expect(de.jetzt).to.equal('Jetzt: außen %s °C → %s %');
        expect(de.unterLang).to.equal('Untergrenze %s % – weniger nimmt die Anlage nicht an');
        expect(de.oberLangHeizen).to.equal('Obergrenze %s % – mehr nur bei ‚volle Leistung‘ (%s K unter Ziel)');
        const leiste = texteAus('Werkzeugleiste.texte.ts').de;
        expect([leiste.kopieren, leiste.einfuegen, leiste.vorlage, leiste.werk, leiste.rueckgaengig]).to.eql([
            'Kopieren',
            'Einfügen',
            'Vorlage übernehmen',
            'Werksvorgabe',
            'Rückgängig',
        ]);
        expect(leiste.tipLeer).to.contain('wähle');
        expect(JSON.stringify([de, leiste])).not.to.match(/\bSie\b|\bIhre?\b/);
    });

    it('Zwischenablage und Knopfleiste: vereinbarte Schnittstelle', () => {
        const ablage = fs.readFileSync(path.join(wurzel, 'src-admin', 'src', 'zwischenablage.ts'), 'utf8');
        expect(ablage).to.contain(
            "export type Art = 'kennlinieHeizen' | 'kennlinieKuehlen' | 'stufen' | 'wochenplan' | 'feuchte';",
        );
        expect(ablage).to.contain('export function kopieren(art: Art, inhalt: unknown, quelle: string): void');
        expect(ablage).to.contain('export function lesen(art: Art): { inhalt: unknown; quelle: string } | null');
        expect(ablage).to.contain('export function abonnieren(cb: () => void): () => void');
        expect(ablage).to.contain("'faikout.zwischenablage'").and.to.contain('sessionStorage');
        const leiste = fs.readFileSync(path.join(wurzel, 'src-admin', 'src', 'Werkzeugleiste.tsx'), 'utf8');
        for (const prop of ['art', 'inhalt', 'onEinfuegen', 'onZuruecksetzen', 'zuruecksetzenText', 'istVorlage', 'quelle', 'sprache']) {
            expect(leiste, prop).to.match(new RegExp(`\\n    ${prop}\\??: `));
        }
        expect(leiste).to.contain('export default Werkzeugleiste;');
        // Sicherheitsabfrage im Formular - kein Browser-Dialog
        expect(leiste).not.to.match(/window\.confirm|\bconfirm\(|\balert\(/);
    });

    it('die Komponente rechnet mit lib/kennlinienzug.js und speichert nicht selbst', () => {
        const quelle = fs.readFileSync(path.join(wurzel, 'src-admin', 'src', 'Kennlinie.tsx'), 'utf8');
        expect(quelle).to.contain("from '../../lib/kennlinienzug.js'").and.to.contain("from '../../lib/kennlinienbild.js'");
        // geschrieben wird nur ins Formular (onChange) - kein Speichern am Formular vorbei
        expect(quelle).to.contain('this.onChange(this.props.attr, zeilen)');
        expect(quelle).not.to.match(/setObject|extendObject|setState\(|setNative/);
        expect(quelle.match(/sendTo\(/g)).to.have.length(1);
        expect(quelle).to.contain("'regelArbeitspunkt'");
        // Punkte und Grenzen: dieselbe Logik fuer Maus, Tastatur und Zahlenfeld
        for (const f of ['einfuegen', 'entfernen', 'grenzeZiehen', 'grenzeSchritt', 'grenzBereich', 'inhaltLesen']) {
            expect(quelle, f).to.contain(`zug.${f}(`);
        }
        // der Jetzt-Marker darf das Ziehen nie blockieren: keine Mausereignisse, vor den Griffen gezeichnet
        const jetzt = quelle.indexOf('className="fk-jetzt"');
        expect(jetzt).to.be.greaterThan(0);
        expect(quelle.slice(jetzt, jetzt + 80)).to.contain('pointerEvents="none"');
        const stelle = text => quelle.indexOf(text);
        expect(stelle('{jetztBild}')).to.be.greaterThan(0).and.to.be.lessThan(stelle('className="fk-streifen"'));
        expect(stelle('className="fk-streifen"')).to.be.lessThan(stelle('className="fk-greifer"'));
        expect(stelle('className="fk-greifer"')).to.be.lessThan(stelle('className={`fk-griff'));
    });

    it('Paket: admin/custom wird ausgeliefert, src-admin nicht', () => {
        const paket = lies('package.json');
        expect(paket.files).to.include('admin/').and.not.to.include('src-admin/');
        expect(paket.files.some(f => f.startsWith('src-admin'))).to.equal(false);
        expect(fs.existsSync(path.join(wurzel, 'admin', 'custom', 'customComponents.js'))).to.equal(true);
        expect(lies('admin/custom/mf-manifest.json').name).to.equal('ConfigCustomFaikoutSet');
    });
});
