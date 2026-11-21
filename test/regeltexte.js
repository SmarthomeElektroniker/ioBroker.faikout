'use strict';

/**
 * Texte der Klimaregelung (lib/regel/texte.js): Vollstaendigkeit der elf Sprachen, Platzhalter,
 * Abgleich mit dem Quelltext und eine Stichprobe in Englisch.
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

const texte = require('../lib/regel/texte');
const bedarf = require('../lib/regel/bedarf');
const feuchte = require('../lib/regel/feuchte');
const faehigkeit = require('../lib/regel/faehigkeit');
const koordinator = require('../lib/regel/koordinator');
const quellen = require('../lib/regel/quellen');
const schreiber = require('../lib/regel/schreiber');
const sender = require('../lib/regel/sender');
const wochenplan = require('../lib/regel/wochenplan');
const zustandSpeicher = require('../lib/regel/zustand');
const { Bedarfsregelung } = require('../lib/regel');

const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const REGEL = path.join(__dirname, '..', 'lib', 'regel');

/**
 * Sprachgleiche Kurztexte ("schluessel:sprache"), die in einer anderen Sprache wirklich genauso
 * heissen wie im Deutschen - jede Ausnahme mit Begruendung.
 */
const GLEICH_ERLAUBT = new Set([
    'szene.komfort:pl', // "Komfort" ist auch das polnische Wort
]);

/** Typische deutsche Woerter, die in einer englischen Begruendung nichts zu suchen haben. */
const DEUTSCH =
    /Fühler|fühler|Ziel|Anlage|Raum|Kennlinie|Rückfall|Gerät|Leistung|Bedarf|Feuchte|Szene|Plan:|Probelauf|Handeingriff|Wochenplan|Korrektur|Vortag|Senden|sende|würde|keine|nicht|ohne|unter |über |Außen|Datenpunkt|Regelung|Modul |Deckel|Betriebsart|Abtauen|Grenze|Haltezeit|Istwert|ruht|[äöüßÄÖÜ]/;

const platzhalter = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

/** Alle Schluessel, die der Quelltext mit t('...') anfordert, je Datei. */
function schluesselImCode() {
    const gefunden = new Map();
    for (const datei of fs.readdirSync(REGEL).filter(d => d.endsWith('.js') && d !== 'texte.js')) {
        const quelle = fs.readFileSync(path.join(REGEL, datei), 'utf8');
        for (const m of quelle.matchAll(/\bt\(\s*'([^']+)'/g)) {
            gefunden.set(m[1], datei);
        }
    }
    return gefunden;
}

describe('Regeltexte (mehrsprachig)', () => {
    afterEach(() => {
        texte.setzeSprache('de'); // andere Tests pruefen deutsche Texte
    });

    it('jeder Schlüssel hat alle elf Sprachen, nicht leer', () => {
        expect(Object.keys(texte.TEXTE).length).to.be.greaterThan(90);
        expect([...texte.SPRACHEN].sort()).to.eql([...SPRACHEN].sort());
        for (const [k, v] of Object.entries(texte.TEXTE)) {
            expect(Object.keys(v).sort(), k).to.eql([...SPRACHEN].sort());
            for (const s of SPRACHEN) {
                expect(v[s], `${k}/${s}`).to.be.a('string');
                expect(v[s].trim(), `${k}/${s}`).to.not.equal('');
                expect(v[s], `${k}/${s}: Leerraum am Rand`).to.equal(v[s].trim());
            }
        }
    });

    it('alle Sprachen haben dieselben Platzhalter wie Deutsch', () => {
        for (const [k, v] of Object.entries(texte.TEXTE)) {
            for (const s of SPRACHEN) {
                expect(platzhalter(v[s]), `${k}/${s}`).to.eql(platzhalter(v.de));
            }
        }
    });

    it('kein Schlüssel im Code ohne Tabelleneintrag, kein verwaister Eintrag', () => {
        const code = schluesselImCode();
        expect(code.size).to.be.greaterThan(90);
        for (const [k, datei] of code) {
            expect(texte.TEXTE, `${datei}: t('${k}') fehlt in der Tabelle`).to.have.property(k);
        }
        for (const k of Object.keys(texte.TEXTE)) {
            expect(code.has(k), `Eintrag "${k}" wird im Code nicht benutzt`).to.equal(true);
        }
    });

    it('der Code ruft t() nur mit festen Schlüsseln auf (sonst fände der Abgleich sie nicht)', () => {
        for (const datei of fs.readdirSync(REGEL).filter(d => d.endsWith('.js') && d !== 'texte.js')) {
            const quelle = fs.readFileSync(path.join(REGEL, datei), 'utf8');
            const alle = [...quelle.matchAll(/\btexte\.t\(/g)].length;
            const fest = [...quelle.matchAll(/\btexte\.t\(\s*'[^']+'/g)].length;
            expect(fest, datei).to.equal(alle);
        }
    });

    it('keine Sprache außer Deutsch enthält den deutschen Text unverändert', () => {
        for (const [k, v] of Object.entries(texte.TEXTE)) {
            for (const s of SPRACHEN.filter(x => x !== 'de')) {
                if (!GLEICH_ERLAUBT.has(`${k}:${s}`)) {
                    expect(v[s], `${k}/${s} ist nicht übersetzt`).to.not.equal(v.de);
                }
            }
        }
        // die Ausnahmeliste enthaelt nichts Ueberfluessiges
        for (const eintrag of GLEICH_ERLAUBT) {
            const [k, s] = eintrag.split(':');
            expect(texte.TEXTE[k][s], eintrag).to.equal(texte.TEXTE[k].de);
        }
    });

    it('Zahlen in Platzhaltern: Dezimalzeichen und Minus der Sprache (de "−2,3", en "-2.3")', () => {
        texte.setzeSprache('de');
        expect(texte.zahlText(-2.3)).to.equal('−2,3');
        expect(texte.zahlText('19.5')).to.equal('19,5');
        expect(texte.zahlText(21)).to.equal('21');
        expect(texte.zahlText('8:30')).to.equal('8:30');
        expect(texte.zahlText('0_userdata.0.x')).to.equal('0_userdata.0.x');
        expect(texte.zahlText('1.2.3')).to.equal('1.2.3');
        expect(texte.t('bedarf.raumZiel', { raum: 19.5, ziel: 21, korr: '+3' })).to.contain('19,5 °C');
        texte.setzeSprache('en');
        expect(texte.zahlText(-2.3)).to.equal('-2.3');
        texte.setzeSprache('de');
    });

    it('t(): Platzhalter, fehlender Schlüssel, Sprache als Modulzustand', () => {
        expect(texte.sprache()).to.equal('de');
        expect(texte.t('fuehler.veraltet', { min: 70 })).to.equal('veraltet (70 min)');
        expect(texte.t('gibt.es.nicht')).to.equal('gibt.es.nicht');
        expect(texte.t('gibt.es.nicht', { a: 1 })).to.equal('gibt.es.nicht');
        // wie in einer Zeichenkettenvorlage: undefined/null werden ausgeschrieben, Fehlendes bleibt stehen
        expect(texte.t('plan.schaltzeit', { tag: 1, zeit: undefined })).to.equal(
            'Tag 1: Schaltzeit undefined ungültig',
        );
        expect(texte.t('fuehler.veraltet', {})).to.equal('veraltet ({min} min)');
        // ein eingesetzter Wert wird nicht noch einmal nach Platzhaltern durchsucht
        expect(texte.t('koord.feuchte', { grund: '{grund} {x}' })).to.equal('Feuchte: {grund} {x}');
        expect(texte.setzeSprache('en')).to.equal('en');
        expect(texte.t('fuehler.veraltet', { min: 70 })).to.equal('stale (70 min)');
        expect(texte.setzeSprache('ZH-CN')).to.equal('zh-cn');
        expect(texte.setzeSprache('xx')).to.equal('en');
        expect(texte.setzeSprache(undefined)).to.equal('en');
        expect(texte.setzeSprache('de')).to.equal('de');
    });

    it('Deutsch ist zeichengenau der bisherige Text (Stichproben)', () => {
        expect(faehigkeit.bewerten(null, { art: 'abgelehnt', power: true, wert: 80 }).grund).to.equal(
            'demand 80 im Betrieb abgelehnt (failed-set). Bei Daikin wirkt die Leistungsgrenze nur, ' +
                'wenn das originale Daikin-WLAN-Modul eingeschaltet ist (Fernbedienung: Powerful 5 s, Anzeige „SP 1“) ' +
                'und in der Daikin-App die Leistungssteuerung auf „Ein“ steht („Aus“ = immer 100 %, „Auto“ = die Cloud regelt)',
        );
        expect(faehigkeit.bewerten(null, { art: 'abgelehnt', power: false, wert: 80 }).grund).to.equal(
            'noch keine Rückmeldung; demand 80 bei Gerät aus abgelehnt – nicht aussagekräftig',
        );
        const q = quellen.waehlen(
            'raum',
            'dp',
            { dp: { wert: 21, zeit: 0 }, intern: { wert: 20, zeit: 3600000 } },
            3600000,
        );
        expect(q.text).to.equal('Fühler der Anlage (Rückfall: Datenpunkt veraltet (60 min))');
        expect(wochenplan.szenenLesen(null).szenen.get('absenken').name).to.equal('Absenken');
        expect(wochenplan.szenenLesen([{ name: 'A', soll: 45 }]).fehler).to.equal(
            'Szene "A": Zieltemperatur 45 außerhalb 10..32 °C',
        );
        expect(bedarf.konfigPruefen({ heizen: '0:50, 5:60' }).fehler).to.equal(
            'Heizkennlinie: Kennlinie nicht fallend (0 °C: 50 % → 5 °C: 60 %)',
        );
    });

    it('Daikin-Hinweis nennt in jeder Sprache WLAN-Modul, Powerful 5 s, „SP 1“, 100 % und Auto', () => {
        for (const s of SPRACHEN) {
            const v = texte.TEXTE['faehig.abgelehntBetrieb'][s];
            expect(v, s).to.match(/failed-set/);
            expect(v, s).to.match(/Daikin/);
            expect(v, s).to.match(/Wi-?Fi|wifi|WLAN/i);
            expect(v, s).to.match(/Powerful/);
            expect(v, s).to.match(/5\s?(s|с|秒)/);
            expect(v, s).to.match(/SP 1/);
            expect(v, s).to.match(/100\s?%/);
            expect(v, s).to.match(/Auto|Авто|自动/);
        }
    });

    it('der BLE-Fühler beginnt in jeder Sprache mit "BLE" (lib/oberflaeche.js erkennt ihn daran)', () => {
        for (const s of SPRACHEN) {
            expect(texte.TEXTE['quellen.ble'][s], s).to.match(/^BLE/);
        }
    });

    describe('Stichprobe Englisch', () => {
        const JETZT = Date.UTC(2026, 10, 20, 12, 0, 0);
        const kb = bedarf.konfigPruefen().konfig;
        const kf = feuchte.konfigPruefen({}).konfig;
        const k = { ...koordinator.VORGABEN, betrieb: 'adapter', bedarf: kb, feuchte: kf, frostAb: 8 };
        const messung = wert => ({ wert, zeit: JETZT });
        const eingang = extra => ({
            status: { power: true, mode: 'heat', target: 21, fan: 'auto', demand: 100, econo: true },
            fuehler: {
                aussen: quellen.waehlen('aussen', 'auto', { intern: messung(3) }, JETZT),
                raum: quellen.waehlen('raum', 'auto', { intern: messung(20) }, JETZT),
                feuchte: quellen.waehlen('feuchte', 'auto', { intern: messung(70) }, JETZT),
            },
            schalter: { plan: true, feuchte: true, bedarf: true },
            szene: {
                id: 'evening',
                name: 'Evening',
                power: true,
                mode: 'heat',
                soll: 21,
                fan: 'auto',
                bedarf: true,
                feuchte: true,
                deckel: 50,
            },
            gesperrt: false,
            faehig: 'yes',
            vortag: null,
            ...extra,
        });

        it('ein Regelschritt des Koordinators liefert englische Gründe ohne deutsche Wörter', () => {
            texte.setzeSprache('en');
            const faelle = [
                eingang(),
                eingang({ gesperrt: true }),
                eingang({ faehig: 'no' }),
                eingang({ szene: null }),
                eingang({
                    szene: null,
                    status: { power: false, mode: 'off' },
                    fuehler: {
                        aussen: quellen.waehlen('aussen', 'dp', { dp: { wert: 3, zeit: 0 }, intern: undefined }, JETZT),
                        raum: quellen.waehlen(
                            'raum',
                            'ble',
                            { ble: { wert: 2, zeit: JETZT }, intern: undefined },
                            JETZT,
                        ),
                        feuchte: quellen.waehlen('feuchte', 'auto', {}, JETZT),
                    },
                }),
                eingang({
                    status: { power: false, mode: 'off' },
                    szene: null,
                    schalter: { plan: false, feuchte: true, bedarf: true },
                }),
            ];
            const alle = [];
            for (const e of faelle) {
                const erg = koordinator.koordinieren(e, k, zustandSpeicher.leer(), JETZT);
                alle.push(...erg.gruende, erg.bedarf.grund, erg.feuchte.grund, erg.bedarf.konflikt || '');
                for (const art of ['aussen', 'raum', 'feuchte']) {
                    alle.push(e.fuehler[art].text);
                }
            }
            alle.push(
                schreiber.entscheiden({
                    sollwert: 60,
                    istwert: 100,
                    probelauf: true,
                    faehig: 'yes',
                    jetzt: JETZT,
                    zustand: null,
                }).grund,
            );
            alle.push(
                sender.planen({
                    wunsch: { power: true, mode: 'heat', target: 21 },
                    status: { power: false, mode: 'off', target: 19 },
                    zustand: null,
                    jetzt: JETZT,
                }).grund,
            );
            alle.push(faehigkeit.bewerten(null, { art: 'abgelehnt', power: true, wert: 80 }).grund);
            alle.push(wochenplan.planLesen('', new Map()).fehler);
            alle.push(feuchte.konfigPruefen({ dtpEin: 6, dtpAus: 4 }).fehler);
            alle.push(bedarf.konfigPruefen({ heizen: '0:50, 5:60' }).fehler);
            alle.push([...wochenplan.szenenLesen(null).szenen.values()].map(s => s.name).join(', '));
            const text = alle.filter(Boolean);
            expect(text.length).to.be.greaterThan(20);
            for (const zeile of text) {
                expect(zeile, zeile).to.not.match(DEUTSCH);
                expect(zeile, zeile).to.not.match(/\{\w+\}/); // kein offener Platzhalter
            }
            expect(text.join('\n')).to.match(/Schedule: scene Evening/);
            expect(text.join('\n')).to.match(/Heating curve at 3 °C/);
            expect(text.join('\n')).to.match(/cap of scene Evening: 50%/);
            expect(text.join('\n')).to.match(/Manual override/);
            expect(text.join('\n')).to.match(/Frost protection/);
            expect(text.join('\n')).to.match(/fallback/);
        });

        it('danach gilt wieder Deutsch (afterEach)', () => {
            expect(texte.sprache()).to.equal('de');
            const erg = koordinator.koordinieren(eingang(), k, zustandSpeicher.leer(), JETZT);
            expect(erg.gruende.join(' · '))
                .to.match(/Plan: Szene Evening/)
                .and.to.match(/Kennlinie Heizen bei 3 °C/);
        });
    });

    describe('Fähigkeit: Maschinenfeld code statt Textvergleich', () => {
        it('"kein demand" wird in jeder Sprache wieder aufgehoben', () => {
            for (const s of SPRACHEN) {
                texte.setzeSprache(s);
                const fehlt = faehigkeit.bewerten(null, { art: 'status', vollstaendig: true });
                expect(fehlt, s).to.include({ wert: 'no', code: 'keinDemand' });
                // dazwischen ein failed-set bei ausgeschaltetem Geraet: der Code bleibt
                const dazwischen = faehigkeit.bewerten(fehlt, { art: 'abgelehnt', power: false, wert: 80 });
                expect(dazwischen, s).to.include({ wert: 'no', code: 'keinDemand' });
                const wieder = faehigkeit.bewerten(dazwischen, { art: 'status', vollstaendig: true, demand: 100 });
                expect(wieder, s).to.include({ wert: 'unknown', code: 'wieder' });
            }
        });

        it('ein anderes "nein" (im Betrieb abgelehnt) bleibt bei demand 100 bestehen', () => {
            const nein = faehigkeit.bewerten(null, { art: 'abgelehnt', power: true, wert: 80 });
            expect(nein.code).to.equal('abgelehnt');
            expect(faehigkeit.bewerten(nein, { art: 'status', vollstaendig: true, demand: 100 })).to.equal(nein);
        });

        it('gespeicherter Altzustand ohne code (deutscher Text) wird weiter erkannt, auch in anderer Sprache', () => {
            texte.setzeSprache('en');
            const alt = zustandSpeicher.lesen(
                JSON.stringify({
                    ...zustandSpeicher.leer(),
                    faehig: {
                        wert: 'no',
                        grund: 'Modul meldet kein demand (Anlage ohne Bedarfssteuerung oder nodemand)',
                    },
                }),
            ).faehig;
            expect(alt.code).to.equal(undefined);
            const dazwischen = faehigkeit.bewerten(alt, { art: 'abgelehnt', power: false, wert: 80 });
            expect(dazwischen.wert).to.equal('no');
            expect(dazwischen).to.not.have.property('code');
            expect(dazwischen.grund).to.match(/^Modul meldet kein demand/);
            expect(faehigkeit.bewerten(dazwischen, { art: 'status', vollstaendig: true, demand: 100 }).wert).to.equal(
                'unknown',
            );
            expect(faehigkeit.bewerten(alt, { art: 'status', vollstaendig: true, demand: 100 }).wert).to.equal(
                'unknown',
            );
            // ein alter Zustand mit anderem deutschen Grund bleibt "nein"
            const anders = { wert: 'no', grund: 'demand 80 im Betrieb abgelehnt (failed-set). …' };
            expect(faehigkeit.bewerten(anders, { art: 'status', vollstaendig: true, demand: 100 })).to.equal(anders);
        });
    });

    describe('Sprache der Instanz', () => {
        const attrappe = extra => ({
            config: {},
            log: { warn() {}, info() {}, debug() {}, error() {} },
            ...extra,
        });
        const mitSprache = language =>
            attrappe({
                getForeignObjectAsync: async id => (id === 'system.config' ? { common: { language } } : null),
            });

        it('aus system.config (common.language); Instanzvorgaben tragen die Sprache', async () => {
            const r = new Bedarfsregelung(mitSprache('fr'));
            expect(await r.sprachBereit).to.equal('fr');
            expect(texte.sprache()).to.equal('fr');
            expect(r.einstellung.szenen.get('aus').name).to.equal('Arrêt');
            expect(await new Bedarfsregelung(mitSprache('zh-cn')).sprachBereit).to.equal('zh-cn');
        });

        it('unbekannte Sprache -> Englisch; Fehler, fehlendes Objekt oder fehlende Methode -> Deutsch', async () => {
            expect(await new Bedarfsregelung(mitSprache('tlh')).sprachBereit).to.equal('en');
            const wirft = attrappe({
                getForeignObjectAsync: async () => {
                    throw new Error('nicht verbunden');
                },
            });
            expect(await new Bedarfsregelung(wirft).sprachBereit).to.equal('de');
            expect(
                await new Bedarfsregelung(attrappe({ getForeignObjectAsync: async () => null })).sprachBereit,
            ).to.equal('de');
            // main.js kennt sprache(), meldet aber bei einem Fehler 'en' - ohne system.config bleibt es Deutsch
            expect(await new Bedarfsregelung(attrappe({ sprache: async () => 'en' })).sprachBereit).to.equal('de');
            expect(await new Bedarfsregelung(attrappe()).sprachBereit).to.equal('de');
        });
    });
});

describe('Regelung: Vorgabe-Szenen in der Systemsprache, Plan haengt an der ID', function () {
    this.timeout(20000);
    const { Anlage, aufbau, laufen } = require('./sim/simulator');
    const START = new Date(2026, 10, 20, 21, 30).getTime(); // Freitag, Komfort bis 22:00

    afterEach(() => {
        texte.setzeSprache('de');
    });

    it('Namen der Vorgabe-Szenen in jeder Sprache, IDs immer gleich', () => {
        for (const s of texte.SPRACHEN) {
            texte.setzeSprache(s);
            const { szenen, fehler } = wochenplan.szenenLesen([]);
            expect(fehler, s).to.equal(null);
            expect([...szenen.keys()], s).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
            expect(szenen.get('komfort').name, s).to.equal(texte.TEXTE['szene.komfort'][s]);
            // der Vorgabeplan gilt in jeder Sprache
            expect(wochenplan.planLesen(wochenplan.vorgabePlan(szenen), szenen).fehler, s).to.equal(null);
        }
        texte.setzeSprache('en');
        expect([...wochenplan.szenenLesen(null).szenen.values()].map(s => s.name)).to.eql([
            'Comfort',
            'Setback',
            'Away',
            'Off',
        ]);
    });

    it('gespeicherte Szenen behalten ihren Namen - auch wenn sie wie die Vorgabe heissen', () => {
        texte.setzeSprache('en');
        const eigene = [
            { id: 'komfort', name: 'Komfort', soll: 21 },
            { name: 'Mein Abend', soll: 22 },
        ];
        const { szenen } = wochenplan.szenenLesen(eigene);
        expect([...szenen.values()].map(s => s.name)).to.eql(['Komfort', 'Mein Abend']);
        expect(eigene[0].name).to.equal('Komfort');
    });

    it('bestehender Plan laeuft nach einem Sprachwechsel im Betrieb weiter; Szenenname und Begruendung folgen', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        let language = 'de';
        a.getForeignObjectAsync = async id => (id === 'system.config' ? { common: { language } } : null);
        a.regelung = new Bedarfsregelung(a, { jetzt: () => uhr.t });
        const anlage = new Anlage({ name: 'Sprach A', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        const { szenen } = wochenplan.szenenLesen(null);
        const planText = JSON.stringify(wochenplan.vorgabePlan(szenen));
        await a.regelung.schalter('Sprach_A', 'dryRun', false);
        await a.regelung.schalter('Sprach_A', 'schedule.weekJson', planText);
        await a.regelung.schalter('Sprach_A', 'schedule.active', true);
        await laufen(a, uhr, anlage, 5);
        expect(a.wert('Sprach_A.regulation.schedule.scene')).to.equal('Komfort');

        language = 'en';
        a.onObjectChange('system.config', { common: { language } });
        await new Promise(r => setTimeout(r, 30));
        expect(texte.sprache()).to.equal('en');
        expect(a.wert('Sprach_A.regulation.schedule.scene')).to.equal('Comfort');
        expect(a.wert('Sprach_A.regulation.schedule.nextScene')).to.equal('Setback');
        // der gespeicherte Plan ist unveraendert und gilt weiter
        expect(a.wert('Sprach_A.regulation.schedule.weekJson')).to.equal(planText);
        expect(a.regelung.geraete.get('Sprach_A').planFehler).to.equal(null);
        expect(a.wert('Sprach_A.regulation.state')).to.equal('ok');
        await laufen(a, uhr, anlage, 40); // ueber 22:00: der Plan schaltet auf Absenken
        expect(anlage.target).to.equal(19);
        expect(a.wert('Sprach_A.regulation.schedule.scene')).to.equal('Setback');
        expect(a.zeilen.some(z => /System language changed to "en"/.test(z.text))).to.equal(true);
    });
});
