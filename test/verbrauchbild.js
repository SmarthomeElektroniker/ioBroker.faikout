'use strict';

const { expect } = require('chai');
const vb = require('../lib/verbrauchbild');

/** Samstag, 21.11.2026, 10:30 Ortszeit */
const JETZT = new Date(2026, 10, 21, 10, 30, 0);

const quelle = extra => ({
    hours: JSON.stringify([
        { hour: '2026-11-20T23', kwh: 0.7 },
        { hour: '2026-11-21T08', kwh: 0.4 },
        { hour: '2026-11-21T09', kwh: null },
    ]),
    days: JSON.stringify([
        { day: '2026-10-30', kwh: 3 },
        { day: '2026-11-16', kwh: 2 },
        { day: '2026-11-20', kwh: 4.2 },
    ]),
    months: JSON.stringify([
        { month: '2025-12', kwh: 80 },
        { month: '2026-10', kwh: 30.5 },
    ]),
    currentHour: 0.1,
    today: 0.5,
    thisMonth: 9.9,
    ...extra,
});

describe('Verbrauchsansicht', () => {
    describe('Fenster', () => {
        it('Tag: 24 Stunden des Tages, Versatz geht tageweise zurück', () => {
            const f = vb.fenster('tag', 0, JETZT);
            expect(f.raster).to.equal('stunde');
            expect(f.schluessel).to.have.lengthOf(24);
            expect(f.von).to.equal('2026-11-21T00');
            expect(f.bis).to.equal('2026-11-21T23');
            expect(f.laufend).to.equal('2026-11-21T10');
            expect(vb.fenster('tag', 1, JETZT).von).to.equal('2026-11-20T00');
        });

        it('Woche: Montag bis Sonntag, auch über den Monatswechsel', () => {
            const f = vb.fenster('woche', 0, JETZT);
            expect(f.schluessel).to.deep.equal([
                '2026-11-16',
                '2026-11-17',
                '2026-11-18',
                '2026-11-19',
                '2026-11-20',
                '2026-11-21',
                '2026-11-22',
            ]);
            expect(vb.fenster('woche', 3, JETZT).von).to.equal('2026-10-26');
            expect(vb.fenster('woche', 3, JETZT).bis).to.equal('2026-11-01');
        });

        it('Woche: ein Sonntag gehört zur Woche, die am Montag davor begann', () => {
            expect(vb.fenster('woche', 0, new Date(2026, 10, 22, 12)).von).to.equal('2026-11-16');
        });

        it('Monat: alle Tage, Februar im Schaltjahr hat 29', () => {
            expect(vb.fenster('monat', 0, JETZT).schluessel).to.have.lengthOf(30);
            expect(vb.fenster('monat', 1, JETZT).schluessel).to.have.lengthOf(31);
            expect(vb.fenster('monat', 0, new Date(2028, 1, 10)).schluessel).to.have.lengthOf(29);
            // 31. März minus ein Monat darf nicht im März landen
            expect(vb.fenster('monat', 1, new Date(2026, 2, 31)).von).to.equal('2026-02-01');
        });

        it('Jahr: zwölf Monate', () => {
            const f = vb.fenster('jahr', 1, JETZT);
            expect(f.raster).to.equal('monat');
            expect(f.von).to.equal('2025-01');
            expect(f.bis).to.equal('2025-12');
            expect(vb.fenster('jahr', 0, JETZT).laufend).to.equal('2026-11');
        });

        it('Unbekannter Zeitraum und unsinniger Versatz fallen auf Woche/0 zurück', () => {
            const f = vb.fenster('quatsch', -3, JETZT);
            expect(f.zeitraum).to.equal('woche');
            expect(f.versatz).to.equal(0);
        });
    });

    describe('Werte', () => {
        it('liest Listen als Text oder Feld, Lücken bleiben weg', () => {
            expect(vb.listeLesen('[{"day":"a","kwh":1},{"day":"b","kwh":null}]', 'day').size).to.equal(1);
            expect(vb.listeLesen([{ day: 'a', kwh: 2 }], 'day').get('a')).to.equal(2);
            expect(vb.listeLesen('kaputt', 'day').size).to.equal(0);
            expect(vb.listeLesen(null, 'day').size).to.equal(0);
        });

        it('Tag: Stundenwerte, die laufende Stunde kommt aus currentHour, Lücke bleibt null', () => {
            const r = vb.werteVon(quelle(), vb.fenster('tag', 0, JETZT));
            expect(r.werte[8]).to.equal(0.4);
            expect(r.werte[9]).to.equal(null);
            expect(r.werte[10]).to.equal(0.1);
            expect(r.werte[11]).to.equal(null);
            expect(r.aelteste).to.equal('2026-11-20T23');
        });

        it('Woche: der laufende Tag kommt aus today', () => {
            const r = vb.werteVon(quelle(), vb.fenster('woche', 0, JETZT));
            expect(r.werte).to.deep.equal([2, null, null, null, 4.2, 0.5, null]);
        });

        it('Jahr: der laufende Monat kommt aus thisMonth', () => {
            const r = vb.werteVon(quelle(), vb.fenster('jahr', 0, JETZT));
            expect(r.werte[9]).to.equal(30.5);
            expect(r.werte[10]).to.equal(9.9);
            expect(r.werte[11]).to.equal(null);
        });

        it('ein früheres Fenster bekommt den laufenden Wert nicht', () => {
            const r = vb.werteVon(quelle(), vb.fenster('woche', 1, JETZT));
            expect(r.werte.every(v => v === null)).to.equal(true);
        });

        it('ohne Quelle nur Lücken', () => {
            const r = vb.werteVon(null, vb.fenster('woche', 0, JETZT));
            expect(r.werte).to.deep.equal([null, null, null, null, null, null, null]);
            expect(r.aelteste).to.equal(null);
        });
    });

    const geraete = () => [
        {
            id: 'a',
            name: 'Wohnzimmer',
            platz: 0,
            leistung: 1190.4,
            arten: { total: quelle(), heating: quelle({ today: 0.4 }), cooling: quelle({ today: 0, days: '[]' }) },
        },
        {
            id: 'b',
            name: 'OG',
            platz: 1,
            leistung: null,
            arten: { total: quelle({ today: 6.3 }), heating: null, cooling: null },
        },
        { id: 'c', name: 'IR', platz: 2, leistung: null, arten: { total: null, heating: null, cooling: null } },
    ];

    describe('Sammeln', () => {

        it('liefert je Gerät Werte, Summe, feste Farbe und gerundete Leistung', () => {
            const r = vb.sammeln(geraete(), { zeitraum: 'woche' }, JETZT);
            expect(r.geraete.map(g => g.id)).to.deep.equal(['a', 'b', 'c']);
            // "alles" = Heizen + Kuehlen des Innengeraets (2 + 4,2 + 0,4 + 0), nicht total (Issue #8);
            // b meldet keinen Heiz-/Kuehlzaehler und behaelt total
            expect(r.geraete[0].summe).to.equal(6.6);
            expect(r.geraete[1].summe).to.equal(12.5);
            expect(r.geraete[0].farbe).to.deep.equal(vb.PALETTE[0]);
            expect(r.geraete[1].farbe).to.deep.equal(vb.PALETTE[1]);
            expect(r.geraete[0].leistung).to.equal(1190);
            expect(r.geraete[2].zaehler).to.equal(false);
            expect(r.geraete[2].hatWerte).to.equal(false);
            expect(r.hinweis).to.equal('');
        });

        it('Umschalter: nur Heizen / nur Kühlen nimmt die jeweilige Quelle', () => {
            expect(vb.sammeln(geraete(), { zeitraum: 'woche', art: 'heizen' }, JETZT).geraete[0].werte[5]).to.equal(
                0.4,
            );
            const k = vb.sammeln(geraete(), { zeitraum: 'woche', art: 'kuehlen' }, JETZT);
            expect(k.geraete[0].werte).to.deep.equal([null, null, null, null, null, 0, null]);
            expect(k.geraete[1].hatWerte).to.equal(false);
            expect(vb.sammeln(geraete(), { art: 'quatsch' }, JETZT).art).to.equal('alles');
        });

        it('Früher/Später: zurück nur, solange ältere Werte da sind', () => {
            const r0 = vb.sammeln(geraete(), { zeitraum: 'woche', versatz: 0 }, JETZT);
            expect(r0.zurueck).to.equal(true);
            expect(r0.vor).to.equal(false);
            // älteste Tagesliste: 30.10. -> die Woche ab 26.10. ist die letzte
            const r3 = vb.sammeln(geraete(), { zeitraum: 'woche', versatz: 3 }, JETZT);
            expect(r3.geraete[0].werte[4]).to.equal(3);
            expect(r3.zurueck).to.equal(false);
            expect(r3.vor).to.equal(true);
        });

        it('Hinweise statt leerer Achsen', () => {
            expect(vb.sammeln([], {}, JETZT).hinweis).to.equal('keinGeraet');
            expect(vb.sammeln([geraete()[2]], {}, JETZT).hinweis).to.equal('keinZaehler');
            const leer = [
                {
                    id: 'x',
                    name: 'x',
                    platz: 0,
                    leistung: 0,
                    arten: { total: { hours: '[]', days: '[]', months: '[]' } },
                },
            ];
            expect(vb.sammeln(leer, { zeitraum: 'jahr' }, JETZT).hinweis).to.equal('keineDaten');
        });

        it('mehr als acht Geräte: ab dem neunten keine eigene Farbe (Seite fasst sie als „Weitere“ zusammen)', () => {
            const g = { id: 'z', name: 'z', platz: 8, leistung: 0, arten: { total: quelle() } };
            expect(vb.sammeln([g], {}, JETZT).geraete[0].farbe).to.equal(null);
        });
    });

    describe('Multisplit (Issue #8)', () => {
        // Zwei Innengeraete an einem Aussengeraet: beide Module melden denselben total-Zaehler (Aussengeraet),
        // heating je Innengeraet. Vorher zaehlte die Summe das Aussengeraet doppelt.
        const multi = () => [
            {
                id: 'bedroom',
                name: 'Bedroom',
                platz: 0,
                leistung: 200,
                aussengeraet: 'attic',
                arten: {
                    total: quelle({ today: 0.9, days: '[]', hours: '[]', months: '[]' }),
                    heating: quelle({ today: 0.6, days: '[]', hours: '[]', months: '[]' }),
                    cooling: quelle({ today: 0, days: '[]', hours: '[]', months: '[]' }),
                },
            },
            {
                id: 'attic',
                name: 'Attic',
                platz: 1,
                leistung: 200,
                aussengeraet: 'attic',
                arten: {
                    total: quelle({ today: 0.9, days: '[]', hours: '[]', months: '[]' }),
                    heating: quelle({ today: 0.3, days: '[]', hours: '[]', months: '[]' }),
                    cooling: null,
                },
            },
        ];

        it('Alles je Innengerät = Heizen + Kühlen, die Summe zählt das Außengerät nicht doppelt', () => {
            const r = vb.sammeln(multi(), { zeitraum: 'woche' }, JETZT);
            expect(r.geraete.map(g => g.summe)).to.deep.equal([0.6, 0.3]);
            expect(r.geraete.reduce((x, g) => x + g.summe, 0)).to.be.closeTo(0.9, 1e-9);
            expect(r.geraete.map(g => g.aussengeraet)).to.deep.equal(['attic', 'attic']);
        });

        it('die Seite zählt die Leistung eines gemeinsamen Außengeräts nur einmal', () => {
            const html = require('node:fs').readFileSync(
                require('node:path').join(__dirname, '..', 'admin', 'verbrauch.html'),
                'utf8',
            );
            expect(html).to.match(/outdoor\.has\(g\.aussengeraet\)/);
        });

        it('Single-Split (Regression): ein Gerät ohne gemeinsames Außengerät, Alles = Heizen + Kühlen', () => {
            const r = vb.sammeln(
                [
                    {
                        id: 'og',
                        name: 'OG',
                        platz: 0,
                        leistung: 420,
                        arten: {
                            total: quelle({ today: 1.1, days: '[]', hours: '[]', months: '[]' }),
                            heating: quelle({ today: 0.7, days: '[]', hours: '[]', months: '[]' }),
                            cooling: quelle({ today: 0.4, days: '[]', hours: '[]', months: '[]' }),
                        },
                    },
                ],
                { zeitraum: 'woche' },
                JETZT,
            );
            expect(r.geraete[0].summe).to.equal(1.1);
            expect(r.geraete[0].aussengeraet).to.equal(null);
            expect(r.geraete[0].zaehler).to.equal(true);
        });

        it('antwort erkennt das gemeinsame Außengerät am gleichen energy-Zählerstand', async () => {
            const st = { 'x.consumption.heating.today': 0.6, 'y.consumption.heating.today': 0.3 };
            const a = {
                geraete: new Map([
                    ['x', { name: 'X', zaehler: { energy: { letzterWert: 812300 } } }],
                    ['y', { name: 'Y', zaehler: { energy: { letzterWert: 812300 } } }],
                    ['z', { name: 'Z', zaehler: { energy: { letzterWert: 3970200 } } }],
                ]),
                sprache: async () => 'en',
                getStateAsync: async id => (id in st ? { val: st[id] } : null),
                getObjectAsync: async () => ({ native: {} }),
                extendObjectAsync: async () => {},
            };
            const r = await vb.antwort(a, { zeitraum: 'woche' }, JETZT);
            const g = Object.fromEntries(r.geraete.map(x => [x.id, x]));
            expect(g.x.aussengeraet).to.equal('x');
            expect(g.y.aussengeraet).to.equal('x');
            expect(g.z.aussengeraet).to.equal(null);
            expect(g.x.summe).to.equal(0.6);
        });
    });

    describe('Ansicht Wärme & COP', () => {
        // Mengen wie aus lib/effizienz: je Menge dieselbe Form wie eine Zaehlerquelle
        const menge = (tage, heute) => ({ hours: [], days: tage.map(([day, kwh]) => ({ day, kwh })), months: [], today: heute, currentHour: 0, thisMonth: 0 });
        const mit = () => {
            const g = geraete();
            g[0].effizienz = {
                waerme: menge([['2026-11-16', 6], ['2026-11-20', 12]], 3),
                stromHeizen: menge([['2026-11-16', 2], ['2026-11-20', 3]], 1),
                kaelte: menge([['2026-11-16', 1]], 0),
                stromKuehlen: menge([['2026-11-16', 0.25]], 0),
            };
            g[0].guete = 'calibrated';
            g[0].unsicherheit = 14;
            return g;
        };

        it('die bisherige Ansicht bleibt Vorgabe; die Umschaltung gibt es nur, wenn ein Gerät Wärme liefert', () => {
            const ohne = vb.sammeln(geraete(), { zeitraum: 'woche' }, JETZT);
            expect(ohne.ansicht).to.equal('strom');
            expect(ohne.waermeDa).to.equal(false);
            const r = vb.sammeln(mit(), { zeitraum: 'woche' }, JETZT);
            expect(r.ansicht).to.equal('strom');
            expect(r.waermeDa).to.equal(true);
            expect(r.geraete[0].strom).to.equal(undefined);
            expect(r.geraete[0].werte).to.deep.equal(ohne.geraete[0].werte);
        });

        it('Wärme je Balken, dazu der Strom derselben Zeitabschnitte für den COP; Güte reist mit', () => {
            const r = vb.sammeln(mit(), { zeitraum: 'woche', art: 'heizen', ansicht: 'waerme' }, JETZT);
            expect(r.ansicht).to.equal('waerme');
            // Woche 16.-22.11.: Mo 6, Fr 12, Sa (laufend) 3
            expect(r.geraete[0].werte).to.deep.equal([6, null, null, null, 12, 3, null]);
            expect(r.geraete[0].strom).to.deep.equal([2, null, null, null, 3, 1, null]);
            expect(r.geraete[0]).to.include({ zaehler: true, guete: 'calibrated', unsicherheit: 14, summe: 21 });
            // Geraete ohne Effizienzwerte zaehlen in dieser Ansicht nicht mit
            expect(r.geraete[1].zaehler).to.equal(false);
            expect(r.hinweis).to.equal('');
        });

        it('Alles = Wärme + Kälte gegen den Strom beider Richtungen; nur Kühlen = Kälte', () => {
            const alles = vb.sammeln(mit(), { zeitraum: 'woche', ansicht: 'waerme' }, JETZT);
            expect(alles.geraete[0].werte[0]).to.equal(7);
            expect(alles.geraete[0].strom[0]).to.equal(2.25);
            const kalt = vb.sammeln(mit(), { zeitraum: 'woche', art: 'kuehlen', ansicht: 'waerme' }, JETZT);
            expect(kalt.geraete[0].werte[0]).to.equal(1);
            expect(kalt.geraete[0].strom[0]).to.equal(0.25);
        });

        it('kein Gerät mit Wärmewerten: klarer Hinweis', () => {
            expect(vb.sammeln(geraete(), { ansicht: 'waerme' }, JETZT).hinweis).to.equal('keineWaerme');
        });

        it('die Seite zeichnet COP-Linie und Umschalter (Strom bleibt Vorgabe)', () => {
            const seite = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin', 'verbrauch.html'), 'utf8');
            expect(seite).to.match(/mass: 'strom'/);
            expect(seite).to.match(/id="segMass"/);
            expect(seite).to.match(/class="copline"/);
            expect(seite).to.match(/ansicht: state\.mass/);
        });
    });

    describe('Adapter', () => {
        function attrappe(objekte = {}) {
            const st = {
                'a.consumption.total.hoursJson': '[]',
                'a.consumption.total.daysJson': '[{"day":"2026-11-20","kwh":4.2}]',
                'a.consumption.total.monthsJson': '[]',
                'a.consumption.total.today': 0.5,
                'a.consumption.total.currentHour': 0.1,
                'a.consumption.total.thisMonth': 4.7,
                'a.status.consumption': 800,
            };
            const geschrieben = [];
            return {
                geschrieben,
                geraete: new Map([
                    ['b', { name: 'Zweites' }],
                    ['a', { name: 'Erstes' }],
                ]),
                sprache: async () => 'de',
                getStateAsync: async id => (id in st ? { val: st[id] } : null),
                getObjectAsync: async id => objekte[id] || { native: {} },
                extendObjectAsync: async (id, o) => geschrieben.push([id, o.native.verbrauchFarbe]),
            };
        }

        it('vergibt Farbplätze einmal (nach ID sortiert) und merkt sie im Geräteobjekt', async () => {
            const a = attrappe();
            const r = await vb.antwort(a, { zeitraum: 'woche' }, JETZT);
            expect(a.geschrieben).to.deep.equal([
                ['a', 0],
                ['b', 1],
            ]);
            expect(r.geraete.map(g => [g.id, g.platz])).to.deep.equal([
                ['a', 0],
                ['b', 1],
            ]);
            expect(r.geraete[0].werte[4]).to.equal(4.2);
            expect(r.geraete[0].werte[5]).to.equal(0.5);
            expect(r.geraete[0].leistung).to.equal(800);
            expect(r.geraete[1].zaehler).to.equal(false);
            expect(r.lang).to.equal('de');
            expect(r.texte.summe).to.equal('Summe');
        });

        it('ein gemerkter Platz bleibt, ein neues Gerät bekommt den nächsten freien', async () => {
            const a = attrappe({ b: { native: { verbrauchFarbe: 0 } } });
            const r = await vb.antwort(a, {}, JETZT);
            expect(a.geschrieben).to.deep.equal([['a', 1]]);
            expect(r.geraete.map(g => g.id)).to.deep.equal(['b', 'a']);
        });

        it('doppelt gemerkter Platz wird neu vergeben statt zwei Geräte gleich zu färben', async () => {
            const a = attrappe({ a: { native: { verbrauchFarbe: 2 } }, b: { native: { verbrauchFarbe: 2 } } });
            const r = await vb.antwort(a, {}, JETZT);
            expect(new Set(r.geraete.map(g => g.platz)).size).to.equal(2);
        });
    });

    it('alle Texte in allen elf Sprachen, keiner leer', () => {
        for (const [k, v] of Object.entries(vb.TEXTE)) {
            for (const s of vb.SPRACHEN) {
                expect(v[s], `${k}/${s}`).to.be.a('string').and.not.equal('');
            }
        }
    });

    it('oberflaeche.js beantwortet verbrauchDaten', () => {
        expect(require('../lib/oberflaeche').BEFEHLE.has('verbrauchDaten')).to.equal(true);
    });
});
