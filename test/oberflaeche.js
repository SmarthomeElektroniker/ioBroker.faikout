'use strict';

/*
 * Bedienoberflaeche der Klimaregelung: Kennlinienbild, Texte, Nachrichten der Einstellungsseite,
 * Wochenplan-Umrechnung, Modul-Einstellungen (nur lesen) - alles mit Attrappen.
 */

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const bild = require('../lib/kennlinienbild');
const o = require('../lib/oberflaeche');
const wochenplan = require('../lib/regel/wochenplan');

const HEIZEN = [
    [-10, 95],
    [0, 75],
    [7, 55],
    [15, 40],
];

function adapter(werte = {}, config = {}) {
    const a = {
        namespace: 'faikout.0',
        config,
        geraete: new Map([
            ['wz', { name: 'Wohnzimmer AC' }],
            ['og', { name: 'OG' }],
        ]),
        gesendet: [],
        log: { info() {}, warn() {}, debug() {} },
        sprache: async () => 'de',
        getStateAsync: async id => (id in werte ? { val: werte[id] } : null),
        sendTo: (an, befehl, antwort, cb) => a.gesendet.push({ an, befehl, antwort, cb }),
    };
    return a;
}
const frage = async (a, command, message) => {
    const erledigt = await o.nachricht(a, { command, message, from: 'admin', callback: {} });
    return { erledigt, antwort: a.gesendet.length ? a.gesendet[a.gesendet.length - 1].antwort : undefined };
};

describe('Kennlinienbild (SVG)', () => {
    it('Zahlen: Englisch und Chinesisch mit Punkt, alle anderen Sprachen mit Komma - auch im Bild und im Etikett', () => {
        expect(bild.zahl(95.94, 1)).to.equal('95,9'); // ohne Sprache wie bisher
        for (const s of o.SPRACHEN) {
            const punkt = s === 'en' || s === 'zh-cn';
            expect(bild.zahl(95.94, 1, s), s).to.equal(punkt ? '95.9' : '95,9');
            expect(bild.zahl(-3.3, 1, s), s).to.equal(punkt ? '−3.3' : '−3,3');
            const svg = o.kennlinieSvg({
                punkte: HEIZEN,
                richtung: 'heizen',
                untergrenze: 40,
                obergrenze: 95,
                sprache: s,
                punkt: { x: -3.3, wert: 85, roh: 85.9, richtung: 'heizen', probelauf: false, aktiv: true },
            });
            expect(svg, s).to.contain(punkt ? '85.9' : '85,9').and.to.contain(punkt ? '−3.3' : '−3,3');
            expect(svg, s).to.not.contain(punkt ? '85,9' : '85.9');
        }
    });

    it('zeichnet Achsen, Stuetzpunkte, Grenzen und Zonen', () => {
        const svg = bild.kennlinie({
            punkte: HEIZEN,
            richtung: 'heizen',
            untergrenze: 40,
            obergrenze: 95,
            texte: { untergrenze: 'Untergrenze', obergrenze: 'Obergrenze', titel: 'Heizkennlinie' },
        });
        expect(svg.startsWith('<svg')).to.equal(true);
        expect(svg.endsWith('</svg>')).to.equal(true);
        expect(svg).to.contain('°C').and.to.contain('100 %').and.to.contain('Untergrenze 40 %');
        expect(svg).to.contain('Obergrenze 95 %').and.to.contain('Heizkennlinie');
        // vier Stuetzpunkte, zwei Zonen (unter 40, ueber 95), kein Arbeitspunkt
        expect(svg.match(/<circle/g)).to.have.length(4);
        expect(svg.match(/fill-opacity="0.08"/g)).to.have.length(2);
        expect(svg).to.contain(bild.FARBEN.heizen);
        // hell/dunkel: Schrift und Raster erben die Farbe der Seite
        expect(svg).to.contain('currentColor');
    });

    it('Arbeitspunkt: Ring auf der Kennlinie, Punkt beim Ergebnis, Beschriftung', () => {
        const svg = bild.kennlinie({
            punkte: HEIZEN,
            untergrenze: 40,
            obergrenze: 95,
            arbeitspunkt: { x: 9, wert: 45, text: 'würde senden 45 %', unterzeile: 'roh 44,3 %' },
        });
        expect(svg.match(/<circle/g)).to.have.length(6);
        expect(svg).to.contain('würde senden 45 %').and.to.contain('roh 44,3 %');
    });

    it('Kuehlen in anderer Farbe, feste Farbe fuer <img>, kompakt ohne Beschriftung', () => {
        const svg = bild.kennlinie({ punkte: [{ x: 25, y: 40 }, { x: 35, y: 95 }], richtung: 'kuehlen', farbe: '#fff', kompakt: true });
        expect(svg).to.contain(bild.FARBEN.kuehlen).and.not.to.contain('currentColor');
        expect(svg).not.to.contain('<text');
    });

    it('zu wenige oder kaputte Punkte: Hinweis statt Absturz, Text wird maskiert', () => {
        const svg = bild.kennlinie({ punkte: [[1, 'x']], texte: { leer: '<zu wenig>' } });
        expect(svg).to.contain('&lt;zu wenig&gt;');
        expect(bild.kennlinie({ punkte: null })).to.contain('</svg>');
    });

    it('Wert auf der Kennlinie und Achsenbereich', () => {
        expect(bild.wertAuf(HEIZEN, -20)).to.equal(95);
        expect(bild.wertAuf(HEIZEN, 3.5)).to.equal(65);
        expect(bild.wertAuf(HEIZEN, 30)).to.equal(40);
        expect(bild.achse(HEIZEN, null)).to.eql({ min: -15, max: 20, schritt: 5 });
        expect(bild.achse(HEIZEN, 31).max).to.equal(35);
    });

    it('Verlauf 24 h: Treppenlinie, Wert vor dem Fenster gilt am linken Rand, leer mit Hinweis', () => {
        const jetzt = 1e12;
        const h = 3600000;
        const svg = bild.verlauf({ verlauf: [[jetzt - 30 * h, 60], [jetzt - 12 * h, 45], [jetzt + h, 99]], jetzt, texte: { jetzt: 'jetzt' } });
        expect(svg).to.match(/<path d="M44 [\d.]+ H[\d.]+ V[\d.]+ H626"/);
        expect(svg).to.contain('jetzt').and.to.contain('−24 h');
        expect(bild.verlauf({ verlauf: 'kaputt', jetzt, texte: { leer: 'nichts' } })).to.contain('nichts');
    });

    it('Stufenbalken 30..100 % in 5-%-Stufen', () => {
        expect(bild.BALKEN_ANZAHL).to.equal(15);
        expect([25, 30, 45, 100, 120, null].map(bild.balkenStufen)).to.eql([0, 1, 4, 15, 15, 0]);
    });
});

describe('Oberflaeche: Kennlinie pruefen und Bild fuer die Einstellungsseite', () => {
    it('Fehler als uebersetzbarer Schluessel', () => {
        expect(o.kennliniePruefen('-10:95, 0:75', 'heizen').fehler).to.equal(null);
        expect(o.kennliniePruefen([{ x: -10, y: 95 }, { x: 0, y: 75 }], 'heizen').fehler).to.equal(null);
        expect(o.kennliniePruefen('5:50', 'heizen').fehler.schluessel).to.equal('fZuWenig');
        expect(o.kennliniePruefen('0:50, 5:70', 'heizen').fehler.schluessel).to.equal('fFallend');
        expect(o.kennliniePruefen('25:60, 30:40', 'kuehlen').fehler.schluessel).to.equal('fSteigend');
        expect(o.kennliniePruefen('5:50, 5:40', 'heizen').fehler.schluessel).to.equal('fAufsteigend');
        expect(o.kennliniePruefen('0:120, 5:40', 'heizen').fehler.schluessel).to.equal('fBereich');
    });

    it('regelKennlinieBild: SVG mit Arbeitspunkt des Geraets, im Probelauf "würde senden"', async () => {
        const a = adapter({
            'wz.regulation.demand.outsideMean': 9,
            'wz.regulation.demand.active': true,
            'wz.regulation.demand.setpoint': 45,
            'wz.regulation.demand.rawValue': 44.3,
            'wz.control.power': true,
            'wz.control.mode': 'heat',
        });
        const { erledigt, antwort } = await frage(a, 'regelKennlinieBild', { richtung: 'heizen', punkte: '-10:95, 0:75, 7:55, 15:40', untergrenze: 40, obergrenze: 95, geraet: 'wz' });
        expect(erledigt).to.equal(true);
        expect(antwort).to.contain('<svg').and.to.contain('würde senden 45\u00a0%').and.to.contain('roh 44,3\u00a0%');
    });

    it('regelKennlinieBild: ungueltige Kennlinie und Grenzen werden im Klartext gemeldet', async () => {
        const { antwort } = await frage(adapter(), 'regelKennlinieBild', { richtung: 'heizen', punkte: [{ x: 0, y: 50 }, { x: 5, y: 70 }], untergrenze: 20, obergrenze: 95 });
        expect(antwort).to.contain(o.TEXTE.fFallend.de).and.to.contain('Untergrenze muss mindestens 30');
    });

    it('leere Angaben: Werksvorgabe, kein Absturz', async () => {
        const { antwort } = await frage(adapter(), 'regelKennlinieBild', { richtung: 'kuehlen', punkte: '', untergrenze: '', obergrenze: '' });
        expect(antwort).to.contain('<svg').and.to.contain('Kühlkennlinie').and.not.to.contain('border:1px solid #d9534f');
    });
});

describe('Oberflaeche: Arbeitspunkt fuer die ziehbare Kennlinie (regelArbeitspunkt)', () => {
    const werte = {
        'wz.regulation.demand.outsideMean': 9,
        'wz.regulation.demand.active': true,
        'wz.regulation.demand.setpoint': 45,
        'wz.regulation.demand.rawValue': 44.3,
        'wz.control.power': true,
        'wz.control.mode': 'heat',
    };

    it('ist als Befehl eingetragen', () => {
        expect(o.BEFEHLE.has('regelArbeitspunkt')).to.equal(true);
    });

    it('liefert die Daten von arbeitspunkt() und die fertigen Etiketten je Richtung', async () => {
        const a = adapter(werte);
        const { erledigt, antwort } = await frage(a, 'regelArbeitspunkt', { geraet: 'wz', obergrenze: 95 });
        expect(erledigt).to.equal(true);
        expect(antwort).to.include({ geraet: 'wz', x: 9, wert: 45, roh: 44.3, richtung: 'heizen', probelauf: true, aktiv: true });
        expect(antwort).to.deep.include(await o.arbeitspunkt(a, 'wz'));
        expect(antwort.etikett.heizen).to.eql({ x: 9, wert: 45, text: 'würde senden 45\u00a0%', unterzeile: 'roh 44,3\u00a0% · außen 9,0\u00a0°C' });
        // im Bild der anderen Richtung steht nur die Aussentemperatur, kein Wert
        expect(antwort.etikett.kuehlen).to.eql({ x: 9, wert: null, text: 'außen 9,0\u00a0°C' });
        // dieselben Texte wie im bisherigen Bild
        const svg = (await frage(a, 'regelKennlinieBild', { richtung: 'heizen', punkte: '-10:95, 0:75, 7:55, 15:40', untergrenze: 40, obergrenze: 95, geraet: 'wz' })).antwort;
        expect(svg).to.contain(antwort.etikett.heizen.text).and.to.contain(antwort.etikett.heizen.unterzeile);
    });

    it('volle Freigabe ueber der Obergrenze: Etikett "volle Leistung (2 K unter Ziel)", Obergrenze aus dem Formular', async () => {
        const a = adapter({ ...werte, 'wz.regulation.demand.setpoint': 100, 'wz.regulation.demand.rawValue': 102.5, 'wz.regulation.demand.dryRun': false }, { regelProbelauf: false, regelObergrenze: 100 });
        const voll = (await frage(a, 'regelArbeitspunkt', { geraet: 'Wohnzimmer AC', obergrenze: 95 })).antwort;
        expect(voll.geraet).to.equal('wz');
        expect(voll.vollAbK).to.equal(require('../lib/regel/bedarf').VORGABEN.vollAbK);
        expect(voll.etikett.heizen.text).to.equal(o.t('volleLeistungK', 'de', { k: String(voll.vollAbK).replace('.', ',') }));
        expect(voll.etikett.heizen.text).to.contain('volle Leistung').and.to.contain('K unter Ziel');
        expect(voll.etikett.heizen.unterzeile).to.contain('95').and.to.contain('9,0');
        // ohne Angabe gilt die gespeicherte Obergrenze der Instanz (hier 100 %): normales Etikett
        const normal = (await frage(a, 'regelArbeitspunkt', { geraet: 'wz' })).antwort;
        expect(normal.etikett.heizen.text).to.equal(o.t('sendet', 'de', { p: '100' }));
    });

    it('Rechenweg und Einstellungen der Raumkorrektur: aus dem letzten Durchlauf der Regelung bzw. der gespeicherten Konfiguration', async () => {
        const a = adapter(werte, { regelProzentProK: 15, regelTotband: 0.5 });
        // solange die Regelung fuer das Geraet nicht gerechnet hat: kein Weg, aber die Einstellungen
        const ohne = (await frage(a, 'regelArbeitspunkt', { geraet: 'wz' })).antwort;
        expect(ohne.weg).to.equal(null);
        expect(ohne.raumkorrektur).to.eql({ prozentProK: 15, totband: 0.5 });
        const weg = { art: 'normal', strategie: 'kennlinie', basis: 52, korrektur: -7, abweichung: -1, sollwert: 45, aus: false, probelauf: true, zeit: 1 };
        a.regelung = { geraete: new Map([['wz', { weg }]]) };
        const mit = (await frage(a, 'regelArbeitspunkt', { geraet: 'wz' })).antwort;
        expect(mit.weg).to.eql(weg);
        expect(mit.weg).to.not.equal(weg); // Kopie - die Seite kann den Stand der Regelung nicht veraendern
        // ohne gespeicherte Werte: die Vorgaben der Regelung
        const vorgabe = (await frage(adapter(werte), 'regelArbeitspunkt', { geraet: 'wz' })).antwort.raumkorrektur;
        expect(vorgabe).to.eql({ prozentProK: 10, totband: 0.3 });
    });

    it('ohne oder mit unbekanntem Geraet: kein Arbeitspunkt, kein Absturz', async () => {
        for (const geraet of ['', undefined, 'gibtsnicht']) {
            const { erledigt, antwort } = await frage(adapter(werte), 'regelArbeitspunkt', { geraet });
            expect(erledigt).to.equal(true);
            expect(antwort).to.eql({ geraet: null, etikett: { heizen: null, kuehlen: null } });
        }
        // Geraet ohne Aussentemperatur: Daten ja, Etikett nein
        const leer = (await frage(adapter({}), 'regelArbeitspunkt', { geraet: 'og' })).antwort;
        expect(leer).to.include({ geraet: 'og', x: null });
        expect(leer.etikett).to.eql({ heizen: null, kuehlen: null });
    });
});

describe('Oberflaeche: Nachrichten der Einstellungsseite', () => {
    it('fremde Befehle bleiben unberuehrt', async () => {
        const a = adapter();
        expect(await o.nachricht(a, { command: 'suchen', message: {} })).to.equal(false);
        expect(a.gesendet).to.have.length(0);
    });

    it('regelGeraeteListe: bekannte Geraete mit Namen', async () => {
        const { antwort } = await frage(adapter(), 'regelGeraeteListe', {});
        expect(antwort).to.eql([
            { label: 'Wohnzimmer AC', value: 'Wohnzimmer AC' },
            { label: 'OG', value: 'OG' },
        ]);
    });

    it('regelKann: Faehigkeiten aus den Datenpunkten', async () => {
        const a = adapter({ 'wz.info.demandCapable': 'no', 'wz.regulation.sensors.roomSource': 'BLE-Sensor am Modul', 'wz.regulation.sensors.humidity': 48 });
        const { antwort } = await frage(a, 'regelKann', { geraet: 'wz' });
        expect(antwort).to.contain('nicht unterstützt').and.to.contain('verbunden').and.to.contain('vorhanden');
        expect((await frage(a, 'regelKann', { geraet: '' })).antwort).to.contain(o.TEXTE.kWaehlen.de);
        expect((await frage(a, 'regelKann', { geraet: 'fremd' })).antwort).to.contain(o.TEXTE.keineDaten.de);
    });

    it('regelUebernehmen: kopiert in die Zielzeile, speichert die Liste sofort und laedt die Seite neu', async () => {
        const zeilen = [
            {
                geraet: 'wz',
                betrieb: 'adapter',
                stufen: [{ name: 'Tag', soll: 22 }],
                strategie: 'vortag',
                untergrenze: 50,
                kennlinieHeizen: [{ x: 0, y: 80 }],
            },
            { geraet: 'og', betrieb: 'faikout', stufen: [], frostAb: 8, obergrenze: 90 },
        ];
        const lauf = async was => {
            const a = adapter();
            a.gespeichert = [];
            a.extendForeignObjectAsync = async (id, obj) => a.gespeichert.push({ id, obj });
            const antwort = (await frage(a, 'regelUebernehmen', { zeilen, von: 'wz', nach: 'og', was })).antwort;
            return { a, antwort, ziel: a.gespeichert.length ? a.gespeichert[0].obj.native.regelGeraete[1] : null };
        };
        // 'stufen' kopiert die Temperaturstufen; der alte Name 'szenen' der Auswahl wird weiter verstanden
        expect((await lauf('stufen')).ziel).to.eql((await lauf('szenen')).ziel);
        const s = await lauf('szenen');
        expect(s.antwort).to.eql({ reloadBrowser: true });
        expect(s.a.gespeichert[0].id).to.equal('system.adapter.faikout.0');
        expect(s.ziel.stufen).to.eql([{ name: 'Tag', soll: 22 }]);
        expect(s.ziel).to.include({ betrieb: 'faikout', frostAb: 8, obergrenze: 90 });
        expect(s.ziel.strategie).to.equal(undefined);
        const k = await lauf('kennlinie');
        expect(k.ziel).to.include({ strategie: 'vortag', untergrenze: 50, betrieb: 'faikout' });
        // was die Quelle nicht hat, faellt im Ziel auf die Vorgabe zurueck
        expect('obergrenze' in k.ziel).to.equal(false);
        expect(k.ziel.stufen).to.eql([]);
        const b = await lauf('beides');
        expect(b.ziel.stufen).to.eql([{ name: 'Tag', soll: 22 }]);
        expect(b.ziel.kennlinieHeizen).to.eql([{ x: 0, y: 80 }]);
        // die uebergebene Liste selbst bleibt unveraendert
        expect(zeilen[1].stufen).to.eql([]);
        // Quelle = Ziel: Fehlermeldung, nichts gespeichert
        const a = adapter();
        a.extendForeignObjectAsync = async () => {
            throw new Error('darf nicht speichern');
        };
        const gleich = (await frage(a, 'regelUebernehmen', { zeilen, von: 'wz', nach: 'wz', was: 'beides' })).antwort;
        expect(gleich.error).to.equal(o.TEXTE.kopieFehlt.de);
    });

    it('Temperaturstufen je Geraet: die eigenen der Zeile, wenn sie welche hat, sonst die Vorlage; szenenVon der Regelung hat Vorrang', () => {
        const stufen = [{ name: 'Tag', soll: 22 }];
        const ohne = adapter({}, { regelStufen: [{ name: 'Wach', soll: 20 }], regelGeraete: [{ geraet: 'Wohnzimmer AC', stufen: [] }] });
        expect([...o.szenen(ohne, 'wz').keys()]).to.eql(['wach']);
        expect([...o.szenen(ohne, '').keys()]).to.eql(['wach']);
        // ein stehengebliebenes `individuell: false` zaehlt nicht mehr - eigene Stufen gelten
        const alt = adapter({}, { regelStufen: [{ name: 'Wach', soll: 20 }], regelGeraete: [{ geraet: 'Wohnzimmer AC', individuell: false, stufen }] });
        expect([...o.szenen(alt, 'wz').keys()]).to.eql(['tag']);
        const a = adapter({}, { regelGeraete: [{ geraet: 'Wohnzimmer AC', stufen }] });
        expect([...o.szenen(a, 'wz').keys()]).to.eql(['tag']);
        expect([...o.szenen(a, 'og').keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
        a.regelung = { szenenVon: id => new Map(id === 'og' ? [['x', { id: 'x' }]] : []) };
        expect([...o.szenen(a, 'og').keys()]).to.eql(['x']);
        expect([...o.szenen(a, 'wz').keys()]).to.eql(['tag']);
    });
});

describe('Oberflaeche: Geraetename statt ID, Hinweise', () => {
    it('Zeilen duerfen Name oder ID tragen: Bild, Faehigkeiten und Auswahl finden das Geraet', async () => {
        const a = adapter({ 'wz.info.demandCapable': 'yes', 'wz.regulation.demand.outsideMean': 3 });
        expect(o.geraetId(a, 'Wohnzimmer AC')).to.equal('wz');
        expect(o.geraetId(a, 'wz')).to.equal('wz');
        expect(o.geraetId(a, 'fremd')).to.equal('fremd');
        expect((await frage(a, 'regelKann', { geraet: 'Wohnzimmer AC' })).antwort).to.contain('unterstützt');
        expect((await frage(a, 'regelKennlinieBild', { richtung: 'heizen', geraet: 'Wohnzimmer AC' })).antwort).to.contain('außen 3,0\u00a0°C');
        expect((await frage(a, 'regelZeilenListe', { zeilen: ['wz', 'OG', ''] })).antwort).to.eql([
            { label: 'Wohnzimmer AC', value: 'wz' },
            { label: 'OG', value: 'OG' },
        ]);
    });

    it('BLE-Fuehler: Art aus regulation.sensors.roomKind, ohne den Datenpunkt wie bisher aus dem Quellentext', async () => {
        const kann = async werte => (await frage(adapter(werte), 'regelKann', { geraet: 'wz' })).antwort;
        expect(await kann({ 'wz.regulation.sensors.roomKind': 'ble', 'wz.regulation.sensors.roomSource': 'BLE sensor' })).to.contain('verbunden');
        expect(await kann({ 'wz.regulation.sensors.roomKind': 'dp', 'wz.regulation.sensors.roomSource': 'BLE-Sensor am Modul' })).to.contain('keiner');
        expect(await kann({ 'wz.regulation.sensors.roomSource': 'BLE-Sensor am Modul' })).to.contain('verbunden');
    });

    it('Daikin-Hinweis haengt am Wert "nein" der Leistungsgrenze', async () => {
        const nein = (await frage(adapter({ 'wz.info.demandCapable': 'no' }), 'regelKann', { geraet: 'wz' })).antwort;
        expect(nein).to.contain('SP 1').and.to.contain('Leistungssteuerung auf „Ein“');
        for (const wert of ['yes', 'unknown']) {
            expect((await frage(adapter({ 'wz.info.demandCapable': wert }), 'regelKann', { geraet: 'wz' })).antwort).not.to.contain('SP 1');
        }
    });

    it('Faikout-Auto: Hinweis ab sechs Zielaenderungen an einem Tag, nicht bei "ioBroker-Adapter regelt"', async () => {
        const sz = wochenplan.szenenLesen([]).szenen;
        const tag = n => Array.from({ length: n }, (_, i) => ({ t: i * 60, s: i % 2 ? 'komfort' : 'absenken' }));
        const plan = n => [tag(n), [], [], [], [], [], []];
        expect(o.zielwechselMax(plan(6), sz)).to.equal(6);
        // der erste Schaltpunkt zaehlt nicht, wenn davor (Ende der Woche) schon dieses Ziel gilt
        expect(o.zielwechselMax(plan(5), sz)).to.equal(4);
        // gleiche Zieltemperatur zaehlt nicht, auch wenn die Szene wechselt
        const gleich = wochenplan.szenenLesen([{ name: 'A', soll: 21 }, { name: 'B', soll: 21, fan: 'night' }]).szenen;
        expect(o.zielwechselMax([[{ t: 0, s: 'a' }, { t: 60, s: 'b' }, { t: 120, s: 'a' }], [], [], [], [], [], []], gleich)).to.equal(0);
        expect(o.zielwechselMax(wochenplan.vorgabePlan(sz), sz)).to.equal(4);
        expect(o.zielwechselMax(null, sz)).to.equal(0);
        const a = n => adapter({ 'wz.regulation.schedule.weekJson': JSON.stringify(plan(n)) });
        expect((await frage(a(6), 'regelKann', { geraet: 'wz', betrieb: 'faikout' })).antwort).to.contain('ändert das Ziel an einem Tag 6-mal');
        expect((await frage(a(5), 'regelKann', { geraet: 'wz', betrieb: 'faikout' })).antwort).not.to.contain('Flash');
        expect((await frage(a(8), 'regelKann', { geraet: 'wz', betrieb: 'adapter' })).antwort).not.to.contain('Flash');
    });
});

describe('Oberflaeche: Wochenplan-Umrechnung', () => {
    const sz = wochenplan.szenenLesen([]).szenen;
    it('Plan -> Zeilen -> Plan ist verlustfrei', () => {
        const plan = wochenplan.vorgabePlan(sz);
        const zeilen = o.planZuProgramm(plan);
        expect(zeilen[1]).to.eql({ day: 'Mon', time: '06:00', type: 'komfort' });
        expect(o.programmZuPlan(zeilen, sz)).to.eql({ plan, fehler: null });
    });
    it('Fehler im Klartext: unbekannte Szene, kaputte Zeit, leer', () => {
        expect(o.programmZuPlan([{ day: 'Mon', time: '06:00', type: 'party' }], sz).fehler).to.contain('Temperaturstufe „party“ gibt es nicht');
        expect(o.programmZuPlan([{ day: 'Mon', time: '6 Uhr', type: 'komfort' }], sz).fehler).to.contain('ungültig');
        expect(o.programmZuPlan([], sz).fehler).to.equal('Wochenplan ist leer');
    });
    it('Ortszeit hin und zurueck', () => {
        const ms = new Date(2026, 11, 27, 8, 30).getTime();
        expect(o.ortszeitText(ms)).to.equal('2026-12-27T08:30');
        expect(o.ortszeitLesen('2026-12-27T08:30')).to.equal(ms);
        expect(Number.isNaN(o.ortszeitLesen('morgen'))).to.equal(true);
    });
    it('Szenenfarben: bekannte fest, weitere der Reihe nach, hell und dunkel', () => {
        const f = o.szenenFarben(new Map([['komfort', {}], ['party', {}], ['gaeste', {}]]));
        expect(Object.keys(f.hell)).to.eql(['komfort', 'party', 'gaeste']);
        expect(f.hell.party).not.to.equal(f.hell.gaeste);
        expect(f.dunkel.komfort).not.to.equal(f.hell.komfort);
    });
});

describe('Oberflaeche: Modul-Einstellungen lesen, pruefen, schreiben, wiederherstellen', () => {
    const seite = felder =>
        `<h1>Sim Wohnzimmer <b id=_msg class=status>MQTT connected</b></h1><form><table>${felder}</table></form>` +
        '<hr><address><a href=/>Home</a> Faikout<small>S3</small>: 1.2 2026-01-01</address>';
    const SEITEN = {
        '-1': seite('<input id="hostname" name="_hostname" value="Sim Wohnzimmer" placeholder="AABBCCDDEEFF"><input name="_mqtthost" value="1.2.3.4:1888"><input name="_mqttpass" type="password" value="geheim">'),
        0: seite('<input id="reporting" name="_reporting" value="60"><input type=checkbox id="livestatus" name="_livestatus"><input type=hidden name="__livestatus"><input type=checkbox name="_thermostat" checked>'),
        '-2': seite('<input type=checkbox name="_nodemand"><input type=checkbox name="_ha1c" checked>'),
        '-3': seite('<input name="_topicgroup1" value="">'),
    };
    const anfragen = [];
    const request = (opt, cb) => {
        anfragen.push(opt);
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            cb(res);
            res.emit('data', Buffer.from(SEITEN[/_page=(-?\d)/.exec(opt.path)[1]]));
            res.emit('end');
        };
        return req;
    };

    it('liest die vier Reiter per GET, Schalter als boolean, keine Passwoerter', async () => {
        const r = await o.modulLesen('10.0.0.5', { request });
        expect(r.ok).to.equal(true);
        expect(r.name).to.equal('Sim Wohnzimmer');
        expect(r.werte).to.include({ reporting: '60', livestatus: false, thermostat: true, nodemand: false, ha1c: true, topicgroup1: '' });
        expect('mqttpass' in r.werte).to.equal(false);
        expect(anfragen).to.have.length(4);
        expect(anfragen.every(q => q.method === 'GET' && q.path.startsWith('/revk-settings?_page='))).to.equal(true);
    });

    describe('Seiten eines Moduls mit TCL-Firmware (test/fixtures/modul-tcl, bereinigt)', () => {
        const vorlage = nr => fs.readFileSync(path.join(__dirname, 'fixtures', 'modul-tcl', `p${nr}.html`), 'utf8');
        const requestTcl = (opt, cb) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                cb(res);
                res.emit('data', Buffer.from(vorlage(/_page=(-?\d)/.exec(opt.path)[1])));
                res.emit('end');
            };
            return req;
        };

        it('findet die Felder unabhaengig vom Reiter (reporting/livestatus/thermostat stehen hier auf "Extra")', async () => {
            const r = await o.modulLesen('10.0.0.6', { request: requestTcl });
            expect(r.ok).to.equal(true);
            expect(r.name).to.equal('Labor_Modul');
            expect(r.werte.reporting).to.equal('60');
            expect(r.werte.livestatus).to.be.a('boolean');
            expect(r.werte.thermostat).to.be.a('boolean');
            expect(r.werte.topicgroup1).to.be.a('string');
            // Schalter: Checkbox plus verstecktes Begleitfeld "__x" - das Begleitfeld ist kein Wert
            expect(Object.keys(r.werte).some(k => k.startsWith('_'))).to.equal(false);
            // keine Passwoerter im gelesenen Stand
            // nur die Felder der festen Liste verlassen den Leser - keine Zugangsdaten, kein Netz, kein Broker
            expect(Object.keys(r.werte).sort()).to.eql(['livestatus', 'reporting', 'thermostat', 'topicgroup1']);
            const roh = o.modulSeiteLesen(vorlage(-1));
            expect(Object.keys(roh).filter(k => /pass|password|cookie/.test(k))).to.eql([]);
        });

        it('ha1c und nodemand gibt es bei dieser Firmware nicht: genannt, ausgeblendet, nie geschrieben', async () => {
            const a = adapter();
            a.modulEinstellungenLesen = ({ ip }) => o.modulLesen(ip, { request: requestTcl });
            const gelesen = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.6' })).antwort.native;
            expect(gelesen._modFehlt).to.equal('Bei diesem Modul nicht vorhanden (hängt von Firmware und Anlage ab): Ziel nur in ganzen Grad (ha1c), Leistungsgrenze ausblenden (nodemand)');
            expect(gelesen._modHa1c).to.equal(null);
            expect(gelesen._modNodemand).to.equal(null);
            expect(gelesen._modReporting).to.equal(60);
            // selbst wenn das Formular Werte fuer die fehlenden Felder schickt, entsteht keine Aenderung dafuer
            const formular = { _modReporting: 90, _modHa1c: true, _modNodemand: true };
            const p = (await frage(a, 'modulEinstellungenPruefen', { ip: '10.0.0.6', stand: gelesen._modStand, formular })).antwort.native;
            expect(JSON.parse(p._modPlan)).to.eql([['reporting', 90]]);
            expect(p._modVorschau).not.to.contain('ha1c').and.not.to.contain('nodemand');
        });
    });

    /** Adapter mit einem Modul "Sim Wohnzimmer" am Broker; die Seiten des Moduls folgen `modul`. */
    function mitModul() {
        const modul = { reporting: '60', livestatus: false, thermostat: true, nodemand: false, ha1c: true, topicgroup1: '' };
        const a = adapter();
        a.geraete = new Map([['sim', { name: 'Sim Wohnzimmer' }]]);
        a.objekte = { sim: { native: {} } };
        a.getObjectAsync = async id => JSON.parse(JSON.stringify(a.objekte[id] || null));
        a.extendObject = async (id, o) => Object.assign(a.objekte[id].native, o.native);
        a.setTimeout = f => f(); // keine echten Wartezeiten
        a.veroeffentlicht = [];
        a.erreichbar = true;
        a.uebernimmt = true;
        a.broker = {
            publish: async (topic, nutzlast) => {
                a.veroeffentlicht.push({ topic, nutzlast });
                if (a.uebernimmt) {
                    for (const [k, v] of Object.entries(JSON.parse(nutzlast))) {
                        modul[k] = typeof v === 'number' ? String(v) : v;
                    }
                }
                return a.sendet !== false;
            },
        };
        a.modulEinstellungenLesen = async () =>
            a.erreichbar ? { ok: true, name: 'Sim Wohnzimmer', werte: { ...modul } } : { ok: false, art: 'nichtErreicht', fehler: 'timeout' };
        return { a, modul };
    }
    const FORMULAR = { _modReporting: 60, _modLivestatus: false, _modHa1c: true, _modThermostat: true, _modNodemand: false, _modTopicgroup1: '' };
    /** Lesen und Pruefen wie auf der Einstellungsseite; liefert die Nachricht fuer "Schreiben". */
    async function vorbereiten(a, aenderung) {
        const gelesen = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.5' })).antwort.native;
        const basis = { ip: '10.0.0.5', stand: gelesen._modStand, formular: { ...FORMULAR, ...aenderung } };
        const p = (await frage(a, 'modulEinstellungenPruefen', basis)).antwort;
        return { gelesen, basis, pruefung: p, auftrag: { ...basis, plan: p.native && p.native._modPlan, zeitlimitMs: 50, abstandMs: 10 } };
    }

    it('Lesen schlaegt nach einem Erfolg fehl: alter Stand und Erfolgszeile weg, Fehler als eigene Zeile (kein Dialog)', async () => {
        const { a } = mitModul();
        const gut = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.5' })).antwort;
        expect(gut.native._modHinweis).to.match(/^✓ Gelesen von Sim Wohnzimmer/);
        expect(gut.native._modFehler).to.equal('');
        a.erreichbar = false;
        const schlecht = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.5' })).antwort;
        expect(schlecht.error).to.equal(undefined);
        expect(schlecht.native).to.include({ _modStand: '', _modHinweis: '', _modPlan: '', _modVorschau: '', _modSicherung: '', _modFehlt: '' });
        expect(schlecht.native._modFehler).to.contain('10.0.0.5').and.to.match(/ \(\d\d:\d\d:\d\d\)$/);
        // ohne Stand laesst sich nichts pruefen oder schreiben
        expect((await frage(a, 'modulEinstellungenPruefen', { ip: '10.0.0.5', stand: schlecht.native._modStand, formular: FORMULAR })).antwort.error).to.equal(o.TEXTE.mErstLesen.de);
        a.erreichbar = true;
        const wieder = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.5' })).antwort.native;
        expect(wieder._modFehler).to.equal('');
        expect(wieder._modStand).to.contain('Sim Wohnzimmer');
    });

    it('Auswahlfelder (selectSendTo) bekommen IMMER ein Array von {label, value} - auch bei Fehlern und ohne Angaben', async () => {
        // regelZeilenListe gehoerte zur alten Kopierfunktion - der Adapter beantwortet sie weiter, die Seite fragt nicht mehr
        const LISTEN = ['regelGeraeteListe', 'regelZeilenListe', 'modulEinstellungenListe', 'modulAuswahlListe', 'modulEinstellungenSicherungen'];
        const IN_SEITE = LISTEN.filter(x => x !== 'regelZeilenListe');
        const jsonConfig = fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8');
        const inSeite = new Set();
        JSON.parse(jsonConfig, (k, v) => {
            if (v && typeof v === 'object' && v.type === 'selectSendTo') {
                inSeite.add(v.command);
            }
            return v;
        });
        expect([...inSeite].sort()).to.eql([...IN_SEITE].sort());
        const pruefe = (antwort, wo) => {
            expect(Array.isArray(antwort), wo).to.equal(true);
            for (const x of antwort) {
                expect(x, wo).to.be.an('object');
                expect(x.label, wo).to.be.a('string');
                expect(x.value, wo).to.be.a('string');
            }
        };
        const nachrichten = [undefined, null, 'timeout', 42, {}, { zeilen: 'x' }, { zeilen: [null, 7, 'Sim Wohnzimmer'] }, { stand: '{kaputt' }, { stand: '"text"' }, { stand: '{"name":"Sim Wohnzimmer"}' }];
        for (const befehl of LISTEN) {
            for (const message of nachrichten) {
                // laufender Adapter
                const { a } = mitModul();
                pruefe((await frage(a, befehl, message)).antwort, `${befehl} ${JSON.stringify(message)}`);
                // startender Adapter: noch keine Geraete, kein Broker, Objektzugriff wirft
                const start = adapter();
                start.geraete = undefined;
                start.letzteSuche = undefined;
                start.broker = null;
                start.getObjectAsync = async () => {
                    throw new Error('DB closed');
                };
                pruefe((await frage(start, befehl, message)).antwort, `${befehl} (Start) ${JSON.stringify(message)}`);
                // alles wirft (Adapter stoppt gerade)
                const kaputt = adapter();
                kaputt.sprache = async () => {
                    throw new Error('Connection is closed');
                };
                Object.defineProperty(kaputt, 'geraete', {
                    get() {
                        throw new Error('Connection is closed');
                    },
                });
                pruefe((await frage(kaputt, befehl, message)).antwort, `${befehl} (Stopp) ${JSON.stringify(message)}`);
            }
        }
        // eine kaputte Sicherungsliste im Geraeteobjekt ergibt eine leere Auswahl, keinen Fehler
        const { a } = mitModul();
        a.objekte.sim.native.modulSicherung = 'timeout';
        pruefe((await frage(a, 'modulEinstellungenSicherungen', { stand: '{"name":"Sim Wohnzimmer"}' })).antwort, 'Sicherung');
        // die Modulliste nennt angebundene Module mit Text statt mit einem unerklaerten Haekchen
        a.letzteSuche = [{ ip: '10.0.0.7', name: 'Neu', status: 'verbunden' }, { ip: '10.0.0.8', name: 'Werk', status: 'werk' }];
        const liste = (await frage(a, 'modulEinstellungenListe', {})).antwort;
        expect(liste.map(x => x.label)).to.include('Neu (10.0.0.7) – verbunden').and.to.include('Werk (10.0.0.8)');
        expect(JSON.stringify(liste)).to.not.contain('✓');
    });

    it('Lesen fuellt das Formular, Pruefen nennt nur die Unterschiede', async () => {
        const { a } = mitModul();
        const { gelesen, basis, pruefung } = await vorbereiten(a, { _modLivestatus: true, _modTopicgroup1: 'Sim_Wohnzimmer' });
        expect(gelesen).to.include({ _modReporting: 60, _modLivestatus: false, _modThermostat: true, _modPlan: '' });
        expect(pruefung.native._modVorschau).to.contain('Statusmeldungen in Echtzeit (livestatus): aus → an').and.to.contain('Zusätzlicher Befehlsname (topicgroup1): (leer) → Sim_Wohnzimmer');
        expect(pruefung.native._modVorschau).not.to.contain('reporting');
        expect((await frage(a, 'modulEinstellungenPruefen', { ...basis, ip: '10.0.0.9' })).antwort.error).to.equal(o.TEXTE.mErstLesen.de);
        expect((await frage(a, 'modulEinstellungenPruefen', { ...basis, formular: FORMULAR })).antwort.native._modVorschau).to.equal(o.TEXTE.mKeineAenderung.de);
        // ungueltige Eingabe: klare Meldung statt stillem Uebergehen
        expect((await frage(a, 'modulEinstellungenPruefen', { ...basis, formular: { ...FORMULAR, _modReporting: 0 } })).antwort.error).to.equal('Ungültiger Wert für „reporting“.');
        expect((await frage(a, 'modulEinstellungenPruefen', { ...basis, formular: { ...FORMULAR, _modTopicgroup1: 'mit Leerzeichen' } })).antwort.error).to.contain('topicgroup1');
        expect(a.veroeffentlicht).to.eql([]);
    });

    it('Schreiben: Sicherung, EINE Nachricht setting/<Name> nur mit den geaenderten Feldern, Zuruecklesen, Ergebnis je Feld', async () => {
        const { a } = mitModul();
        const { auftrag } = await vorbereiten(a, { _modReporting: 90, _modLivestatus: true });
        const r = (await frage(a, 'modulEinstellungenSchreiben', auftrag)).antwort.native;
        expect(a.veroeffentlicht).to.eql([{ topic: 'setting/Sim Wohnzimmer', nutzlast: '{"reporting":90,"livestatus":true}' }]);
        expect(r._modVorschau).to.contain('alles übernommen').and.to.contain('✓ Statusintervall (Sekunden) (reporting) = 90: übernommen').and.to.contain('✓ Statusmeldungen in Echtzeit (livestatus) = an: übernommen');
        expect(r).to.include({ _modReporting: 90, _modLivestatus: true, _modPlan: '' });
        expect(JSON.parse(r._modStand).werte.reporting).to.equal('90');
        // der Stand VOR dem Schreiben ist gesichert - nur Felder der Liste
        const sicherung = a.objekte.sim.native.modulSicherung;
        expect(sicherung).to.have.length(1);
        expect(sicherung[0].werte).to.eql({ reporting: '60', livestatus: false, ha1c: true, thermostat: true, nodemand: false, topicgroup1: '' });
    });

    it('Schreiben ohne vorheriges Pruefen oder mit geaendertem Formular: nichts gesendet', async () => {
        const { a } = mitModul();
        const { auftrag } = await vorbereiten(a, { _modReporting: 90 });
        const anders = { ...auftrag, formular: { ...auftrag.formular, _modReporting: 30 } };
        expect((await frage(a, 'modulEinstellungenSchreiben', anders)).antwort.error).to.equal(o.TEXTE.mErstPruefen.de);
        expect((await frage(a, 'modulEinstellungenSchreiben', { ...auftrag, plan: '' })).antwort.error).to.equal(o.TEXTE.mErstPruefen.de);
        expect(a.veroeffentlicht).to.eql([]);
        expect(a.objekte.sim.native.modulSicherung).to.equal(undefined);
    });

    it('Fehlerfaelle: Modul nicht am Broker, Senden scheitert, Wert nicht uebernommen, Zeitueberschreitung', async () => {
        // nicht mit diesem Adapter verbunden
        let m = mitModul();
        let v = await vorbereiten(m.a, { _modReporting: 90 });
        m.a.geraete = new Map();
        expect((await frage(m.a, 'modulEinstellungenSchreiben', v.auftrag)).antwort.error).to.contain('nicht mit dem Broker dieses Adapters verbunden');
        expect(m.a.veroeffentlicht).to.eql([]);
        // Publish scheitert
        m = mitModul();
        v = await vorbereiten(m.a, { _modReporting: 90 });
        m.a.sendet = false;
        m.a.uebernimmt = false;
        expect((await frage(m.a, 'modulEinstellungenSchreiben', v.auftrag)).antwort.error).to.equal(o.TEXTE.mNichtGesendet.de);
        // Modul antwortet, uebernimmt den Wert aber nicht
        m = mitModul();
        v = await vorbereiten(m.a, { _modReporting: 90, _modLivestatus: true });
        m.a.broker.publish = async (topic, nutzlast) => (m.a.veroeffentlicht.push({ topic, nutzlast }), (m.modul.livestatus = true));
        let r = (await frage(m.a, 'modulEinstellungenSchreiben', v.auftrag)).antwort.native;
        expect(r._modVorschau).to.contain('nicht alles wurde übernommen').and.to.contain('✗ Statusintervall (Sekunden) (reporting) = 90: nicht übernommen (im Modul steht: 60)');
        expect(r._modVorschau).to.contain('✓ Statusmeldungen in Echtzeit (livestatus) = an: übernommen');
        expect(r._modReporting).to.equal(60);
        // Modul meldet sich nach dem Schreiben nicht mehr
        m = mitModul();
        v = await vorbereiten(m.a, { _modReporting: 90 });
        m.a.broker.publish = async () => ((m.a.erreichbar = false), true);
        r = (await frage(m.a, 'modulEinstellungenSchreiben', v.auftrag)).antwort.native;
        expect(r._modVorschau).to.contain('hat innerhalb von 0\u00a0s nicht geantwortet');
        expect(r._modStand).to.equal('');
    });

    it('Wiederherstellen: Sicherung waehlen, in das Formular laden, Unterschied zeigen, mit demselben Ablauf schreiben', async () => {
        const { a, modul } = mitModul();
        const { auftrag } = await vorbereiten(a, { _modReporting: 90 });
        const nach = (await frage(a, 'modulEinstellungenSchreiben', auftrag)).antwort.native;
        expect(modul.reporting).to.equal('90');
        const liste = (await frage(a, 'modulEinstellungenSicherungen', { stand: nach._modStand })).antwort;
        expect(liste).to.have.length(1);
        // Datum UND Uhrzeit mit Sekunden: zwei Staende derselben Minute bleiben unterscheidbar
        expect(liste[0].label).to.match(/^\d\d\.\d\d\.\d{4}, \d\d:\d\d:\d\d$/);
        const minute = new Date(2026, 10, 21, 14, 3).getTime();
        a.objekte.sim.native.modulSicherung = [
            { zeit: minute + 5000, werte: { reporting: '60' } },
            { zeit: minute + 27000, werte: { reporting: '90' } },
        ];
        const zwei = (await frage(a, 'modulEinstellungenSicherungen', { stand: nach._modStand })).antwort;
        expect(zwei.map(x => x.label)).to.eql(['21.11.2026, 14:03:27', '21.11.2026, 14:03:05']);
        a.objekte.sim.native.modulSicherung = [{ zeit: Number(liste[0].value), werte: { reporting: '60' } }];
        const basis = { ip: '10.0.0.5', stand: nach._modStand };
        expect((await frage(a, 'modulEinstellungenWiederherstellen', { ...basis, zeit: '' })).antwort.error).to.equal(o.TEXTE.mSicherungFehlt.de);
        const w = (await frage(a, 'modulEinstellungenWiederherstellen', { ...basis, zeit: liste[0].value })).antwort.native;
        expect(w._modReporting).to.equal(60);
        expect(w._modVorschau).to.contain('in das Formular übernommen').and.to.contain('(reporting): 90 → 60');
        const formular = Object.fromEntries(Object.entries(w).filter(([k]) => k.startsWith('_mod') && !['_modPlan', '_modVorschau'].includes(k)));
        await frage(a, 'modulEinstellungenSchreiben', { ...basis, formular, plan: w._modPlan, zeitlimitMs: 50, abstandMs: 10 });
        expect(a.veroeffentlicht[1]).to.eql({ topic: 'setting/Sim Wohnzimmer', nutzlast: '{"reporting":60}' });
        expect(modul.reporting).to.equal('60');
        // zweite Sicherung (Stand mit 90) ist dazugekommen
        expect(a.objekte.sim.native.modulSicherung.map(x => x.werte.reporting)).to.eql(['60', '90']);
    });
});

describe('Modul-Einstellungen: Rechenbausteine (lib/moduleinstellungen.js)', () => {
    const m = require('../lib/moduleinstellungen');

    it('feste Feldliste; Firmware/OTA, Broker, WLAN, Passwort und Name sind immer gesperrt', () => {
        expect(m.FELDER.map(f => f.feld)).to.eql(['reporting', 'livestatus', 'ha1c', 'thermostat', 'nodemand', 'topicgroup1']);
        for (const f of ['otahost', 'otaauto', 'upgrade', 'mqtthost', 'mqttuser', 'mqttpass', 'wifissid', 'wifipass', 'password', 'hostname', 'apssid', 'tmin']) {
            expect(m.feldVon(f), f).to.equal(null);
        }
        for (const f of ['otahost', 'mqtthost', 'mqttpass', 'wifipass', 'password', 'hostname']) {
            expect(m.VERBOTEN.test(f), f).to.equal(true);
        }
        expect(m.FELDER.every(f => !m.VERBOTEN.test(f.feld))).to.equal(true);
    });

    it('Typwandlung zahl / bool / text mit Grenzen', () => {
        expect(m.wandeln('zahl', '90')).to.eql({ wert: 90 });
        expect(m.wandeln('zahl', '1,5')).to.eql({ wert: 1.5 });
        expect(m.wandeln('zahl', '')).to.eql({ fehler: 'zahl' });
        expect(m.wandeln('zahl', 'abc')).to.eql({ fehler: 'zahl' });
        expect(m.wandeln('zahl', 0, { min: 1, max: 3600 })).to.eql({ fehler: 'bereich' });
        expect([true, 'true', 1, '1', 'on'].map(v => m.wandeln('bool', v).wert)).to.eql([true, true, true, true, true]);
        expect([false, 'false', 0, '0', ''].map(v => m.wandeln('bool', v).wert)).to.eql([false, false, false, false, false]);
        expect(m.wandeln('bool', 'vielleicht')).to.eql({ fehler: 'bool' });
        expect(m.wandeln('text', '  Sim_1 ')).to.eql({ wert: 'Sim_1' });
        expect(m.wandeln('text', 'a b', { muster: /^\w*$/ })).to.eql({ fehler: 'text' });
        expect(m.gleich('zahl', '60', 60)).to.equal(true);
        expect(m.gleich('bool', 'true', true)).to.equal(true);
        expect(m.gleich('zahl', '60', 90)).to.equal(false);
    });

    it('Unterschied: nur geaenderte Felder; unbekanntes Feld im Modul uebergangen; verbotenes Feld und Unsinn gemeldet', () => {
        const gelesen = { reporting: '60', livestatus: false, thermostat: true };
        const u = m.unterschied(gelesen, { reporting: 60, livestatus: true, thermostat: 'true', ha1c: true, otahost: 'x', nodemand: null });
        expect(u.aenderungen).to.eql([{ feld: 'livestatus', art: 'bool', alt: false, neu: true }]);
        expect(u.fehler).to.eql([{ feld: 'otahost', grund: 'verboten' }]);
        expect(m.unterschied(gelesen, { reporting: 'viel' }).fehler).to.eql([{ feld: 'reporting', grund: 'zahl' }]);
    });

    it('Nachricht: ein Topic, typrichtiges JSON; Feld ausserhalb der Liste oder leerer Auftrag wirft', () => {
        expect(m.nachricht('Daikin 1OG', [{ feld: 'reporting', neu: '90' }, { feld: 'livestatus', neu: 'true' }])).to.eql({
            topic: 'setting/Daikin 1OG',
            nutzlast: '{"reporting":90,"livestatus":true}',
        });
        expect(() => m.nachricht('x', [{ feld: 'reporting', neu: 90 }, { feld: 'otahost', neu: 'boese.example' }])).to.throw('must not be written');
        expect(() => m.nachricht('x', [{ feld: 'mqtthost', neu: '1.2.3.4' }])).to.throw('must not be written');
        expect(() => m.nachricht('x', [])).to.throw('nothing to write');
        expect(() => m.nachricht('a/b', [{ feld: 'reporting', neu: 90 }])).to.throw('invalid module name');
        expect(() => m.nachricht('#', [{ feld: 'reporting', neu: 90 }])).to.throw('invalid module name');
        expect(() => m.nachricht('x', [{ feld: 'reporting', neu: 99999 }])).to.throw('invalid value');
    });

    it('Ruecklese-Vergleich je Feld', () => {
        const a = [
            { feld: 'reporting', art: 'zahl', neu: 90 },
            { feld: 'livestatus', art: 'bool', neu: true },
        ];
        expect(m.ruecklesen(a, { reporting: '90', livestatus: false })).to.eql([
            { feld: 'reporting', soll: 90, ist: '90', ok: true },
            { feld: 'livestatus', soll: true, ist: false, ok: false },
        ]);
        expect(m.ruecklesen(a, null).every(f => !f.ok)).to.equal(true);
    });

    it('Sicherungen: nur Felder der Liste, hoechstens fuenf, neueste zuletzt', () => {
        let liste = 'kaputt';
        for (let i = 1; i <= 7; i++) {
            liste = m.sicherungAnhaengen(liste, { reporting: String(i), mqttpass: 'geheim', wifissid: 'x' }, i);
        }
        expect(liste.map(x => x.zeit)).to.eql([3, 4, 5, 6, 7]);
        expect(liste[4].werte).to.eql({ reporting: '7' });
    });

    describe('Ablauf Schreiben -> Zuruecklesen', () => {
        const AENDERUNG = [{ feld: 'reporting', art: 'zahl', alt: '60', neu: 90 }];
        /** Uhr, die beim Warten weiterlaeuft. */
        const lauf = (lesen, extra = {}) => {
            let jetzt = 0;
            const gesendet = [];
            return m
                .schreiben({
                    name: 'sim',
                    aenderungen: AENDERUNG,
                    senden: async (t, n) => (gesendet.push([t, n]), true),
                    lesen,
                    warten: async ms => void (jetzt += ms),
                    jetzt: () => jetzt,
                    zeitlimitMs: 60000,
                    abstandMs: 4000,
                    ...extra,
                })
                .then(r => ({ ...r, gesendet, dauer: jetzt }));
        };

        it('uebernommen: ok nach dem ersten Lesen', async () => {
            const r = await lauf(async () => ({ ok: true, werte: { reporting: '90' } }));
            expect(r).to.include({ ok: true, art: 'ok' });
            expect(r.gesendet).to.eql([['setting/sim', '{"reporting":90}']]);
            expect(r.dauer).to.equal(2500);
        });

        it('Modul startet neu: erst nicht erreichbar, dann uebernommen', async () => {
            let n = 0;
            const r = await lauf(async () => (++n < 4 ? { ok: false, art: 'nichtErreicht' } : { ok: true, werte: { reporting: '90' } }));
            expect(r.art).to.equal('ok');
            expect(n).to.equal(4);
        });

        it('Modul offline: Zeitueberschreitung mit klarer Art, hoert nach dem Zeitlimit auf', async () => {
            let n = 0;
            const r = await lauf(async () => (n++, { ok: false, art: 'nichtErreicht' }));
            expect(r).to.include({ ok: false, art: 'zeit' });
            expect(r.dauer).to.be.at.most(60000);
            expect(n).to.be.within(10, 16);
        });

        it('Wert nicht uebernommen: Abweichung mit Ist-Wert', async () => {
            const r = await lauf(async () => ({ ok: true, werte: { reporting: '60' } }), { zeitlimitMs: 9000 });
            expect(r).to.include({ ok: false, art: 'abweichung' });
            expect(r.felder).to.eql([{ feld: 'reporting', soll: 90, ist: '60', ok: false }]);
        });

        it('echtes Modul: Bestaetigung erst beim 8. Leseversuch (rund 30 s) ist "ok", nie "abweichung"', async () => {
            let n = 0;
            const r = await lauf(async () => {
                n++;
                // ein Leseversuch ohne Antwort dazwischen ist kein Fehler
                if (n === 4) {
                    return { ok: false, art: 'nichtErreicht' };
                }
                return { ok: true, werte: { reporting: n < 8 ? '60' : '90' } };
            });
            expect(n).to.equal(8);
            expect(r).to.include({ ok: true, art: 'ok' });
            expect(r.felder).to.eql([{ feld: 'reporting', soll: 90, ist: '90', ok: true }]);
            // 2,5 s bis zum ersten Versuch, dann sieben Abstaende von 4 s
            expect(r.dauer).to.equal(2500 + 7 * 4000);
        });

        it('Simulator-Testschalter: die Einstellungsseite zeigt einen neuen Wert erst nach der Verzoegerung', () => {
            const { ModulHttp } = require('./simwelt/http');
            let jetzt = 0;
            const h = new ModulHttp({ jetzt: () => jetzt });
            const modul = { name: 'sim', id: 'AABBCCDDEEFF', verbunden: true, e: { reporting: 60 } };
            h.anmelden(modul, { port: 1 });
            const seite = () => h.antwort({ method: 'GET', url: '/revk-settings?_page=0', host: 'x', port: 1 }).text;
            const wert = () => /name="_reporting"[^>]*value="(\d+)"/.exec(seite())[1];
            expect(wert()).to.equal('60');
            expect(JSON.parse(h.antwort({ method: 'GET', url: '/__test?rueckleseMs=30000', host: 'x', port: 1 }).text)).to.eql({ rueckleseMs: 30000 });
            modul.e.reporting = 90;
            expect(wert()).to.equal('60');
            jetzt = 29000;
            expect(wert()).to.equal('60');
            jetzt = 30000;
            expect(wert()).to.equal('90');
            // ohne Schalter sofort
            h.antwort({ method: 'GET', url: '/__test?rueckleseMs=0', host: 'x', port: 1 });
            modul.e.reporting = 120;
            expect(wert()).to.equal('120');
        });

        it('Senden scheitert oder Feld nicht in der Liste: nichts wird gelesen', async () => {
            let gelesen = 0;
            const lesen = async () => (gelesen++, { ok: true, werte: {} });
            expect((await lauf(lesen, { senden: async () => false })).art).to.equal('nichtGesendet');
            const r = await lauf(lesen, { aenderungen: [{ feld: 'otahost', art: 'text', neu: 'x' }] });
            expect(r).to.include({ ok: false, art: 'ungueltig' });
            expect(r.gesendet).to.eql([]);
            expect(gelesen).to.equal(0);
        });
    });
});

describe('Oberflaeche: Texte in allen elf Sprachen', () => {
    // Woerter, die in einer Sprache wirklich wie im Englischen heissen
    const GLEICH = new Set(['stunde', 'pMax', 'pAbwesenheit:fr', 'zOk:fr']);
    it('lib/oberflaeche.js: jeder Text in jeder Sprache, nichts englisch geblieben, Platzhalter erhalten', () => {
        const fehler = [];
        for (const [k, t] of Object.entries(o.TEXTE)) {
            const platzhalter = (t.en.match(/\{\w+\}/g) || []).sort().join();
            for (const l of o.SPRACHEN) {
                if (typeof t[l] !== 'string' || !t[l].trim()) {
                    fehler.push(`${k}: ${l} fehlt`);
                } else if (l !== 'en' && t[l] === t.en && !GLEICH.has(k) && !GLEICH.has(`${k}:${l}`)) {
                    fehler.push(`${k}: ${l} = englisch`);
                } else if ((t[l].match(/\{\w+\}/g) || []).sort().join() !== platzhalter) {
                    fehler.push(`${k}: ${l} Platzhalter`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    const admin = l => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'i18n', `${l}.json`), 'utf8'));
    const konfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
    const schluessel = new Set();
    const elemente = [];
    const lauf = x => {
        if (Array.isArray(x)) {
            return x.forEach(lauf);
        }
        if (x && typeof x === 'object') {
            if (x.type) {
                elemente.push(x);
            }
            for (const [k, v] of Object.entries(x)) {
                if (['label', 'text', 'help', 'title', 'ok', 'cancel', 'validatorErrorText'].includes(k) && typeof v === 'string' && v && !v.includes('${')) {
                    schluessel.add(v);
                }
                lauf(v);
            }
        }
    };
    lauf(konfig);

    it('admin/i18n: jeder Schluessel der Einstellungsseite in allen Sprachen, gleiche Schluesselmenge', () => {
        const en = admin('en');
        const fehler = [];
        for (const l of o.SPRACHEN) {
            const d = admin(l);
            for (const k of schluessel) {
                if (typeof d[k] !== 'string' || !d[k].trim()) {
                    fehler.push(`${l}: ${k} fehlt`);
                }
            }
            if (Object.keys(d).sort().join() !== Object.keys(en).sort().join()) {
                fehler.push(`${l}: andere Schluesselmenge als en`);
            }
        }
        expect(fehler).to.eql([]);
    });

    it('admin/i18n: neue Texte der Regelung sind uebersetzt (laengere Texte nie woertlich englisch)', () => {
        const en = admin('en');
        const fehler = [];
        for (const l of o.SPRACHEN.filter(x => x !== 'en')) {
            const d = admin(l);
            for (const k of schluessel) {
                if (/^(text|help|confirm|header)/.test(k) && en[k].length > 25 && d[k] === en[k]) {
                    fehler.push(`${l}: ${k}`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('jsonConfig: Rastergroessen xs >= sm >= md >= lg >= xl (Repochecker E5509)', () => {
        const fehler = [];
        for (const e of elemente) {
            const g = ['xs', 'sm', 'md', 'lg', 'xl'].map(k => e[k]).filter(v => typeof v === 'number');
            if (g.some((v, i) => i > 0 && v > g[i - 1])) {
                fehler.push(`${e.type} ${e.label || e.text || ''}: ${g.join('/')}`);
            }
        }
        expect(fehler).to.eql([]);
    });

    it('jsonConfig: Reiter Regelung ist geraeteweise aufgebaut, regelQuellen ist verschwunden', () => {
        const r = konfig.items.tabRegelung.items;
        // die Geraeteliste zeichnet die Komponente "Geraete" als Karten; die Felder der Zeile stehen unter custom.items
        expect(r.regelGeraete).to.include({ type: 'custom', url: 'custom/customComponents.js', name: 'ConfigCustomFaikoutSet/Components/Geraete', i18n: true, guiApi: 2, label: 'labelRegelGeraete' });
        expect(r.regelGeraete.items).to.equal(undefined);
        const attrs = r.regelGeraete.custom.items.map(i => i.attr);
        expect(attrs).to.include.members(['geraet', 'betrieb', 'strategie', 'kennlinieHeizen', 'kennlinieKuehlen', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW', 'aussenQuelle', 'aussenDp', 'raumQuelle', 'raumDp', 'feuchteQuelle', 'feuchteDp', 'feuchteMassnahme', 'frostAb']);
        expect(attrs).not.to.include('eigeneKennlinie');
        // die Grenzen zieht man in der Kennlinie, die Temperaturstufen sind eine Komponente - keine Zahlenfelder, keine Tabelle
        expect(attrs).not.to.include.members(['untergrenze', 'obergrenze', 'szenen']);
        const z = Object.fromEntries(r.regelGeraete.custom.items.map(i => [i.attr, i]));
        // Runde 2 (21.11.2026): kein Haken "individuell" mehr - eigen entsteht beim Aendern, je Teil. Nichts in der
        // Karte haengt noch an dem Feld; Hinweiskaesten und der Block "Eigene Temperaturstufen" sind weg.
        expect(attrs).not.to.include.members(['individuell', '_tFolgt', '_tFolgtStufen', '_tIndividuell', 'stufen', '_hStufen', '_tStufen']);
        expect(JSON.stringify(konfig)).to.not.contain('individuell');
        // die Reihenfolge der Karte: wer regelt - Kennlinie - Sensoren - Feuchte - Fuer Fortgeschrittene
        const kopf = attrs.filter(a => /^_h/.test(a) || ['geraet', 'kennlinieHeizen', 'aussenQuelle', 'feuchteMassnahme', 'strategie', 'frostAb', 'probelauf'].includes(a));
        expect(kopf).to.eql(['geraet', '_hKann', '_hBedarf', 'kennlinieHeizen', '_hFuehler', 'aussenQuelle', '_hFeuchte', 'feuchteMassnahme', '_hFort', 'strategie', 'frostAb', 'probelauf']);
        expect([z._hFuehler.text, z._hFeuchte.text, z._hFort.text]).to.eql(['headerGeraetFuehler', 'headerGeraetFeuchte', 'headerGeraetFort']);
        // immer sichtbar: Strategie und Feuchte-Massnahme mit "Wie Vorlage" als Vorgabe (leer = es gilt die Vorlage)
        for (const a of ['strategie', 'feuchteMassnahme', 'vortagBezug']) {
            expect(z[a], a).to.include({ type: 'select', default: '' });
            expect(z[a].options[0], a).to.eql({ label: 'optWieVorgabe', value: '' });
        }
        expect(z.strategie.hidden).to.equal(undefined);
        expect(z.feuchteMassnahme.hidden).to.equal(undefined);
        // Kennlinien bzw. Vortag-Werte folgen der GELTENDEN Strategie: der eigenen, sonst der der Vorlage
        const VORTAG = "(data.strategie || globalData.regelStrategie) === 'vortag'";
        for (const a of ['kennlinieHeizen', 'kennlinieKuehlen']) {
            expect(z[a].hidden, a).to.equal(VORTAG);
        }
        for (const a of ['_tVortag', '_rechenweg', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW']) {
            expect(z[a].hidden, a).to.equal("(data.strategie || globalData.regelStrategie) !== 'vortag'");
        }
        expect(z._tRuht.hidden).to.equal(`data.betrieb !== 'faikout' || ${VORTAG}`);
        for (const a of ['aussenQuelle', 'raumQuelle', 'feuchteQuelle', 'frostAb', 'betrieb']) {
            expect(z[a].hidden, a).to.equal(undefined);
        }
        // die Temperaturstufen der Anlage stehen im Reiter Zeitplaene; Export/Import der Geraeteliste kennt das Feld trotzdem
        expect(r.regelGeraete.custom.zusatzFelder).to.eql(['stufen', 'stufenErsatz']);
        // "So entsteht der Wert gerade" bei Strategie Vortag (bei Kennlinie steht es am Bild) und der Satz bei der Strategie
        expect(z._rechenweg).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Rechenweg' });
        expect(z._rechenweg.custom).to.eql({ art: 'weg' });
        expect(Object.keys(r).slice(Object.keys(r).indexOf('regelStrategie'), Object.keys(r).indexOf('regelStrategie') + 3)).to.eql(['regelStrategie', 'regelAktiv', '_raumSatz']);
        expect(r._raumSatz).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Rechenweg' });
        expect(r._raumSatz.custom).to.eql({ art: 'satz' });
        expect(JSON.stringify(konfig)).not.to.contain('regelQuellen');
        // ganz oben nur der Hinweis "Adapter laeuft nicht" (sichtbar bei gestoppter Instanz), dann - NUR bei
        // eingeschaltetem Probelauf - der farbige Kasten, die Erklaergrafik, die globale Vorlage, dann die Geraete
        expect(Object.keys(r).slice(0, 4)).to.eql(['_nichtAktiv', '_probeAn', '_erklaerung', '_hVorlage']);
        expect(r._probeAn).to.include({ type: 'staticText', text: 'textProbeAn', hidden: 'data.regelProbelauf === false' });
        expect(r._probeAus).to.equal(undefined);
        // der Schalter selbst steht eingeklappt unter "Fuer Fortgeschrittene", ohne default (ein fehlender Wert
        // bleibt beim Speichern fehlend - der Adapter wertet ihn als AN und schreibt das fest)
        expect(r.regelProbelauf).to.equal(undefined);
        expect(Object.keys(r._pFein.custom.items)[0]).to.equal('regelProbelauf');
        expect(r._pFein).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Abschnitt', label: 'headerFein' });
        expect(r._pFein.custom.items.regelProbelauf).to.eql({ type: 'checkbox', label: 'labelRegelProbelauf', xs: 12, sm: 12, md: 12, lg: 12, xl: 12, help: 'helpRegelProbelauf' });
        expect(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8')).native.regelProbelauf).to.equal(false);
        for (const l of o.SPRACHEN) {
            expect(admin(l).textProbeAus, l).to.equal(undefined);
            expect(admin(l).helpRegelProbelauf, l).to.contain('regulation.demand.dryRun');
        }
        expect(admin('de').textProbeAn).to.match(/^Probelauf ist an – der Adapter sendet nichts an die Anlagen\./).and.to.contain('Für Fortgeschrittene');
        expect(admin('de').labelRegelProbelauf).to.contain('nur rechnen und anzeigen, nichts an die Anlagen senden');
        expect(admin('de').textSchritt3).to.not.contain('Probelauf');
        // EIN Schalter: der Probelauf der Instanz. Je Anlage nur ein bewusster Haken in der Geraetekarte, ganz unten
        const zeile = r.regelGeraete.custom.items;
        expect(zeile.slice(-2).map(i => i.attr)).to.eql(['probelauf', '_tProbeInstanz']);
        // unter "Fuer Fortgeschrittene" stehen davor die eigene Strategie der Anlage (mit Vortag-Werten) und der Frostschutz
        expect(zeile.slice(zeile.findIndex(i => i.attr === '_hFort')).map(i => i.attr)).to.eql(['_hFort', 'strategie', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW', 'frostAb', 'probelauf', '_tProbeInstanz']);
        expect(zeile.find(i => i.attr === 'probelauf')).to.include({ type: 'checkbox', label: 'labelGeraetProbelauf', help: 'helpGeraetProbelauf' }).and.to.not.have.property('default');
        expect(zeile.find(i => i.attr === '_tProbeInstanz')).to.include({ type: 'staticText', hidden: 'globalData.regelProbelauf === false' });
        expect(admin('de').labelGeraetProbelauf).to.equal('Nur diese Anlage im Probelauf: rechnen und anzeigen, nichts senden');
        for (const l of o.SPRACHEN) {
            expect(admin(l).helpRegelProbelauf, l).to.not.match(/both|beide/);
        }
        const namen = Object.keys(r);
        expect(namen.indexOf('regelKennlinieHeizen')).to.be.below(namen.indexOf('regelGeraete'));
        expect(namen.indexOf('_feuchteGrafik')).to.be.below(namen.indexOf('regelGeraete'));
        // Heizen und Kuehlen gleichrangig: beide dauerhaft sichtbar, ab 1200 px nebeneinander - Vorlage und Geraet
        const gz = Object.fromEntries(r.regelGeraete.custom.items.map(i => [i.attr, i]));
        for (const [heizen, kuehlen] of [[r.regelKennlinieHeizen, r.regelKennlinieKuehlen], [gz.kennlinieHeizen, gz.kennlinieKuehlen]]) {
            expect(kuehlen.custom).to.equal(undefined);
            expect(heizen).to.include({ xs: 12, md: 12, lg: 6, xl: 6, newLine: true });
            expect(kuehlen).to.include({ xs: 12, md: 12, lg: 6, xl: 6, newLine: false });
            expect(kuehlen.hidden).to.equal(heizen.hidden);
        }
        expect(r._pKopie).to.equal(undefined);
        expect(r._nichtAktiv).to.include({ type: 'staticText', hidden: '_alive' });
    });

    it('jsonConfig: Hinweise des Volltests - Adapter gestoppt, Aufklappen, Szenenspalten, Feinabstimmung, lesbare Zwischenueberschriften', () => {
        // jeder Reiter sagt bei gestoppter Instanz, warum Listen leer und Knoepfe grau sind
        for (const [name, reiter] of Object.entries(konfig.items)) {
            const erstes = Object.entries(reiter.items)[0];
            expect(erstes[0], name).to.equal('_nichtAktiv');
            expect(erstes[1], name).to.include({ type: 'staticText', text: 'textNichtAktiv', hidden: '_alive' });
        }
        const r = konfig.items.tabRegelung.items;
        // Aufklapp-Hinweis direkt vor der Geraeteliste
        const namen = Object.keys(r);
        expect(namen[namen.indexOf('regelGeraete') - 1]).to.equal('_tAufklappen');
        expect(admin('de').textRegelAufklappen).to.contain('aufzuklappen');
        // Temperaturstufen sind eine Komponente (sie erklaert Hoechstleistung und Schalter selbst); die alten
        // Tabellen samt Spaltenerklaerung sind weg, und kein Text der Seite spricht mehr von Szenen
        const g = r.regelGeraete.custom.items;
        expect(JSON.stringify(konfig)).to.not.match(/[sS]zenen|textSzenenSpalten/);
        for (const l of o.SPRACHEN) {
            const benutzt = new Set(JSON.stringify(konfig).match(/"[a-zA-Z0-9_]+"/g).map(x => x.slice(1, -1)));
            for (const [k, v] of Object.entries(admin(l))) {
                if (benutzt.has(k)) {
                    expect(v, `${l} ${k}`).to.not.match(/szene|scene|scène|cenário|escena|scenari|сцен|场景/i);
                }
            }
        }
        // Feinabstimmung und "Fruehestens alle ... Minuten" erklaeren sich
        // Korrekturstaerke und Totband sind EIN Bild zum Ziehen (Komponente Raumkorrektur) statt zweier Zahlenfelder
        expect(r._pFein.custom.items.regelTotband).to.equal(undefined);
        expect(r._pFein.custom.items.regelProzentProK).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Raumkorrektur', default: 10 });
        expect(r._pFein.custom.items.regelProzentProK.custom).to.eql({ attrTotband: 'regelTotband' });
        expect(Object.keys(r._pFein.custom.items).slice(0, 3)).to.eql(['regelProbelauf', 'regelProzentProK', 'regelBand']);
        expect(r._pFein.custom.items.regelBand.help).to.equal('helpBand');
        expect(g.find(i => i.attr === 'korrAbstandMin').help).to.equal('helpKorrAbstand');
        // "Pruefen" grau ohne Adresse: der Grund steht daneben
        expect(konfig.items.tabSearch.items._bindAdresseFehlt.hidden).to.contain('data.moduleAddress');
        // Moduleinstellungen wirken sofort - das steht da
        expect(konfig.items.tabModule.items.modSofortText.text).to.equal('textModulSofort');
        // keine Zwischenueberschrift mehr in 10-px-Schrift (h5)
        const klein = [];
        const lauf = x => {
            if (x && typeof x === 'object') {
                if (x.type === 'header' && (x.size || 5) >= 5) {
                    klein.push(x.text);
                }
                Object.values(x).forEach(lauf);
            }
        };
        lauf(konfig);
        expect(klein).to.eql([]);
    });

    it('jsonConfig: Reiter Zeitplaene - zuerst die Wochenplaene, dann Temperaturstufen der Vorlage; Handeingriff und Feiertage eingeklappt', () => {
        const zp = konfig.items[o.REITER_ZEITPLAENE];
        expect(zp).to.include({ type: 'panel', label: 'tabZeitplaene' });
        const namen = Object.keys(zp.items);
        // der Wochenplan steht oben: ein Klick auf den Reiter genuegt, um ihn zu sehen (Volltest 21.11.2026)
        // die Erklaergrafik "So arbeitet die Regelung" steht im Reiter Regelung (Nutzerwunsch 21.11.2026); hier bleibt, was den Plan betrifft
        expect(namen).to.eql(['_nichtAktiv', '_tZeitplaene', '_hPlaene', 'regelPlanVorlage', '_hStufen', '_tStufen', 'regelStufen', '_pPlanFein']);
        expect(admin('de').textZeitplaene).to.contain('Reiter „Regelung“');
        // die Stufen je Anlage bearbeitet der Reiter Zeitplaene selbst (Komponente Zeitplaene). Hat die Anlage noch
        // keine Zeile in der Geraeteliste, entsteht eine mit GENAU den Vorgaben, die "Anlage hinzufuegen" eintraegt -
        // sonst waere nach dem Speichern "Speichern" schon beim Oeffnen der Geraetekarte wieder aktiv
        const karte = konfig.items.tabRegelung.items.regelGeraete.custom.items;
        const vorgaben = Object.fromEntries(karte.filter(x => 'default' in x).map(x => [x.attr, x.default]));
        expect(zp.items.regelPlanVorlage.custom).to.eql({ neueZeile: vorgaben });
        expect(vorgaben).to.include({ betrieb: 'adapter', fuehlerWeg: 'sollwert', strategie: '', feuchteMassnahme: '', frostAb: 0 });
        expect(Object.keys(vorgaben).some(k => k.startsWith('_'))).to.equal(false);
        for (const l of o.SPRACHEN) {
            expect(admin(l).textStufenVorlage, l).to.be.a('string').and.to.have.length.above(20);
            expect('textFolgtEigeneStufen' in admin(l), l).to.equal(false);
        }
        const k = name => ({ type: 'custom', url: 'custom/customComponents.js', name: `ConfigCustomFaikoutSet/Components/${name}`, i18n: true, xs: 12, xl: 12 });
        expect(konfig.items.tabRegelung.items._erklaerung).to.include(k('Erklaerung'));
        expect(konfig.items.tabRegelung.items._erklaerung.custom).to.eql({ reiterZeitplaene: 'tabZeitplaene', reiterRegelung: 'tabRegelung' });
        expect(zp.items.regelStufen).to.include(k('Stufen'));
        expect(zp.items.regelPlanVorlage).to.include(k('Zeitplaene'));
        expect(zp.items._pPlanFein).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Abschnitt', label: 'headerPlanFein' });
        expect(Object.keys(zp.items._pPlanFein.custom.items)).to.include.members(['regelHandModus', 'regelHandStunden', 'regelFeiertagSonntag', 'regelFeiertageDE', 'regelFeiertage']);
        for (const l of o.SPRACHEN) {
            expect(admin(l).tabZeitplaene, l).to.equal(o.t('reiterZeitplaene', l));
            expect(admin(l).headerSchritte, l).to.not.match(/drei|three|три|três|drie|trois|tre |tres|trzy|三/i);
        }
    });

    it('jsonConfig: jede Einstellung der Instanz hat ein Feld oder gehoert einer Komponente; kein default an _-Feldern', () => {
        const io = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'io-package.json'), 'utf8'));
        const felder = new Set();
        const mitVorgabe = [];
        const lauf = (x, schluessel) => {
            if (Array.isArray(x)) {
                x.forEach(y => lauf(y, y && y.attr));
            } else if (x && typeof x === 'object') {
                if (typeof x.type === 'string' && typeof schluessel === 'string') {
                    felder.add(schluessel);
                    if (schluessel.startsWith('_') && 'default' in x) {
                        mitVorgabe.push(schluessel);
                    }
                }
                Object.entries(x).forEach(([k, v]) => lauf(v, k));
            }
        };
        lauf(konfig.items, '');
        // diese Werte schreibt eine Komponente (Kennlinie: Grenzen, Feuchte: vier Schwellen) bzw. nur der Adapter
        const OHNE_FELD = {
            regelUntergrenze: 'Kennlinie', regelObergrenze: 'Kennlinie',
            regelFeuchteDtpEin: 'Feuchte', regelFeuchteDtpAus: 'Feuchte', regelFeuchteRhEin: 'Feuchte', regelFeuchteRhAus: 'Feuchte',
            regelUmzugStand: 'Adapter', externClientIdStandard: 'Adapter', regelQuellen: 'Altbestand',
            regelTotband: 'Raumkorrektur',
            effizienzModelle: 'Effizienz', effizienzPreis: 'Effizienz',
            aussengeraeteAbgelehnt: 'Aussengeraete',
        };
        expect(Object.keys(io.native).filter(k => !felder.has(k) && !OHNE_FELD[k])).to.eql([]);
        expect(Object.keys(OHNE_FELD).filter(k => felder.has(k))).to.eql([]);
        expect(felder.has('_feuchteGrafik')).to.equal(true);
        // ein default an einem _-Feld macht "Speichern" schon beim Oeffnen aktiv
        expect(mitVorgabe).to.eql([]);
        // die Werte ohne Feld behalten ihre Vorgaben
        expect(io.native).to.include({ regelUntergrenze: 40, regelObergrenze: 100, regelFeuchteDtpEin: 4, regelFeuchteDtpAus: 6, regelFeuchteRhEin: 65, regelFeuchteRhAus: 58 });
    });

    it('jsonConfig: Kennlinien je Geraet sind die ziehbare Komponente am Tabellen-Attribut, das reine Bild ist weg', () => {
        const g = konfig.items.tabRegelung.items.regelGeraete.custom.items;
        const zeile = Object.fromEntries(g.map(i => [i.attr, i]));
        for (const [attr, name] of [['kennlinieHeizen', 'KennlinieHeizen'], ['kennlinieKuehlen', 'KennlinieKuehlen']]) {
            expect(zeile[attr]).to.include({ type: 'custom', url: 'custom/customComponents.js', name: `ConfigCustomFaikoutSet/Components/${name}`, i18n: true, guiApi: 2 });
            // wie bisher: bei Strategie "Vortag" ausgeblendet; schmal volle Breite, ab 1200 px Heizen und Kuehlen nebeneinander
            expect(zeile[attr].hidden).to.contain("=== 'vortag'");
            expect(zeile[attr]).to.include({ newLine: attr === 'kennlinieHeizen', xs: 12, md: 12, lg: 6, xl: 6 });
        }
        expect(zeile._bildHeizen).to.equal(undefined);
        expect(zeile._bildKuehlen).to.equal(undefined);
        // kein Element fragt mehr das fertige Bild ab - der Befehl bleibt fuer aeltere Seiten erhalten
        expect(JSON.stringify(konfig)).not.to.contain('regelKennlinieBild');
        expect(o.BEFEHLE.has('regelKennlinieBild')).to.equal(true);
    });
});

describe('VIS-Baustein "Regelung" und gemeinsame Zeichenfunktion', () => {
    const vm = require('node:vm');
    const lies = datei => fs.readFileSync(path.join(__dirname, '..', 'widgets', datei), 'utf8');

    it('eine Quelle: lib/kennlinienbild.js ist die Datei der VIS-Bausteine', () => {
        expect(require('../lib/kennlinienbild')).to.equal(require('../widgets/faikout/js/kennlinienbild.js'));
    });

    it('im Browser (ohne module) steht die Zeichenfunktion als window.faikoutKennlinienbild bereit', () => {
        const fenster = {};
        vm.runInNewContext(lies('faikout/js/kennlinienbild.js'), { self: fenster });
        const svg = fenster.faikoutKennlinienbild.kennlinie({ punkte: HEIZEN, kompakt: true, arbeitspunkt: { x: 5, wert: 60 } });
        expect(svg).to.contain('<svg').and.not.to.contain('<text');
        // nichts, was es nur in Node gibt
        expect(lies('faikout/js/kennlinienbild.js')).not.to.match(/\bBuffer\b|\brequire\(/);
    });

    it('Vorlage, Einbindung und Funktion des Bausteins sind vorhanden; er schreibt nichts', () => {
        const html = lies('faikout.html');
        expect(html).to.contain('id="tplFaikoutRegelung"').and.to.contain('vis.binds.faikout.regelung(');
        // die Zeichenfunktion wird VOR den Bausteinen geladen
        expect(html.indexOf('js/kennlinienbild.js')).to.be.within(1, html.indexOf('js/faikout.js'));
        const js = lies('faikout/js/faikout.js');
        const start = js.indexOf('    regelung: function');
        const ende = js.indexOf('Zusatzfunktionen */', start);
        expect(start).to.be.above(0);
        expect(js.slice(start, ende)).not.to.contain('setValue');
    });

    it('Stuetzpunkte aus Text oder Liste, Rueckfall auf die Vorgabe', () => {
        const fenster = {};
        const umgebung = { self: fenster, window: fenster, vis: { binds: {} } };
        vm.runInNewContext(lies('faikout/js/kennlinienbild.js'), umgebung);
        vm.runInNewContext(lies('faikout/js/faikout.js'), umgebung);
        const b = umgebung.vis.binds.faikout;
        const klar = x => JSON.parse(JSON.stringify(x));
        expect(klar(b.kennliniePunkte('-10:95, 0:75', [[1, 1]]))).to.eql([
            [-10, 95],
            [0, 75],
        ]);
        expect(klar(b.kennliniePunkte([{ x: 5, y: 50 }, { x: 0, y: 80 }], [[1, 1]]))).to.eql([
            [0, 80],
            [5, 50],
        ]);
        expect(klar(b.kennliniePunkte('', [[1, 1]]))).to.eql([[1, 1]]);
        expect(klar(b.kennliniePunkte([], [[1, 1]]))).to.eql([[1, 1]]);
    });
});

describe('Einstellungsseite: neue Felder je Geraet und Modul-Reiter', () => {
    const konfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
    it('Fuehlerweg, traeger Fuehler und Nachstellabstand nur bei Raumquelle = Datenpunkt', () => {
        const zeile = Object.fromEntries(konfig.items.tabRegelung.items.regelGeraete.custom.items.map(i => [i.attr, i]));
        expect(zeile.fuehlerWeg.options.map(x => x.value)).to.eql(['sollwert', 'modul']);
        expect(zeile.fuehlerWeg.default).to.equal('sollwert');
        expect(zeile.fuehlerWeg.hidden).to.equal("data.raumQuelle !== 'dp'");
        expect(zeile.raumTraegeMin).to.include({ min: 0, max: 240, hidden: "data.raumQuelle !== 'dp'" });
        expect(zeile.korrAbstandMin).to.include({ min: 10, max: 180, help: 'helpKorrAbstand' });
        // ohne default: sonst traegt die Seite den Wert in aeltere Eintraege nach und "Speichern" ist schon beim
        // Oeffnen aktiv (Rauchtest 21.11.2026) - leer heisst im Adapter 30 Minuten bzw. 0
        expect(zeile.raumTraegeMin).to.not.have.property('default');
        expect(zeile.korrAbstandMin).to.not.have.property('default');
        expect(zeile.korrAbstandMin.hidden).to.contain("data.fuehlerWeg === 'modul'");
        // der Titel des Eintrags ist der Geraetename (Wert der Auswahl)
        expect(konfig.items.tabRegelung.items.regelGeraete.custom.titleAttr).to.equal('geraet');
    });
    it('Modul-Reiter: jedes Formularfeld der festen Liste, nichts wird in der Instanz gespeichert', () => {
        const m = konfig.items.tabModule.items;
        for (const f of o.MODUL_FELDER) {
            expect(m[f.form], f.form).to.include({ doNotSave: true });
        }
        for (const [k, v] of Object.entries(m)) {
            if (k.startsWith('_mod') && v.type !== 'sendTo') {
                expect(v.doNotSave, k).to.equal(true);
            }
        }
        expect(m._modWrite.confirm.text).to.equal('confirmModText');
        expect(m._modWrite.disabled).to.equal('!data._modPlan');
        // die alte Kopierfunktion ist weg - Kopieren/Einfuegen/Zuruecksetzen stehen unter jeder Grafik
        expect(JSON.stringify(konfig)).to.not.contain('regelUebernehmen');
    });
});

describe('MQTT-Broker: eigener oder externer Broker (Oberflaeche)', () => {
    const konfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
    // Client-ID und Topic-Praefix liegen im eingeklappten Abschnitt "Fuer Fortgeschrittene", der nur
    // beim externen Broker erscheint - fuer die Pruefungen zaehlt die Sichtbarkeit des Abschnitts
    const abschnitt = konfig.items.tabBroker.items._pFortgeschritten;
    const b = {
        ...konfig.items.tabBroker.items,
        ...Object.fromEntries(Object.entries(abschnitt.custom.items).map(([k, v]) => [k, { ...v, hidden: abschnitt.hidden }])),
    };

    it('Wahl intern/extern; je Betriebsart nur die eigenen Felder sichtbar', () => {
        expect(b.brokerModus.options.map(x => x.value)).to.eql(['intern', 'extern']);
        expect(b.brokerModus.default).to.equal('intern');
        for (const k of ['port', 'user', 'pass', '_tBrokerIntern']) {
            expect(b[k].hidden, k).to.contain("data.brokerModus === 'extern'");
        }
        for (const k of ['externHost', 'externPort', 'externTls', 'externUser', 'externPass', 'externClientId', 'externPraefix', '_brokerTesten', '_tExternModule', '_tBrokerExtern']) {
            expect(b[k].hidden, k).to.contain("data.brokerModus !== 'extern'");
        }
        expect(b.externPass.type).to.equal('password');
        expect(b.externPort).to.include({ default: 1883, help: 'helpExternPort' });
        // Hinweis auf das Ziel der Module auch in "Module suchen" und "Einrichtung"
        expect(konfig.items.tabSearch.items._externZiel.hidden).to.equal("data.brokerModus !== 'extern'");
        // "Einrichtung" und "Modul anbinden" haben fuer den Extern-Betrieb einen EIGENEN Text statt
        // eines Warnkastens ueber dem Text fuer den eigenen Broker
        const hilfe = konfig.items.tabHelp.items;
        // (die festen Schritt-Texte stehen nur bei gestopptem Adapter - sonst liefert der Adapter die
        // Schrittliste mit dem Stand in jeder Zeile)
        expect(hilfe.tS2.hidden).to.equal("_alive || data.brokerModus === 'extern'");
        expect(hilfe.tS2e).to.include({ text: 'textSchritt2Extern', hidden: "_alive || data.brokerModus !== 'extern'" });
        expect(hilfe._stand).to.include({ type: 'textSendTo', command: 'einrichtungStand', hidden: '!_alive' });
        for (const k of ['hS1', 'tS1', 'hS2', 'hS3', 'tS3', 'hS4', 'tS4']) {
            expect(hilfe[k].hidden, k).to.equal('_alive');
        }
        const such = konfig.items.tabSearch.items;
        expect(such.bindText.hidden).to.equal("data.brokerModus === 'extern'");
        expect(such.bindTextExtern).to.include({ text: 'textBindExtern', hidden: "data.brokerModus !== 'extern'" });
        expect(such.moduleAddress.hidden).to.equal("data.brokerModus === 'extern'");
        // Reiter: Wichtiges zuerst (Einrichtung, Regelung, Verbrauch), dahinter Module suchen und die
        // technischen Reiter, die im Namen als solche erkennbar sind
        expect(Object.keys(konfig.items)).to.eql(['tabHelp', 'tabZeitplaene', 'tabRegelung', 'tabMultisplit', 'tabConsumption', 'tabEfficiency', 'tabSearch', 'tabBroker', 'tabModule']);
        expect(Object.keys(konfig.items)[1]).to.equal(o.REITER_ZEITPLAENE);
        // Passwort: immer sichtbar, ohne Benutzername gesperrt - und das steht im Hilfetext
        expect(b.pass).to.include({ hidden: "data.brokerModus === 'extern'", disabled: '!data.user', help: 'helpPass' });
        expect(b.externPass).to.include({ hidden: "data.brokerModus !== 'extern'", disabled: '!data.externUser', help: 'helpExternPass' });
        const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin', 'i18n', 'de.json'), 'utf8'));
        expect([de.tabBroker, de.tabModule]).to.eql(['MQTT-Broker (Technik)', 'Moduleinstellungen (Technik)']);
        // Fortgeschrittenes ist eingeklappt und so benannt
        expect(abschnitt).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Abschnitt', label: 'headerBrokerFortgeschritten' });
        expect(de.headerBrokerFortgeschritten).to.match(/^Für Fortgeschrittene: /);
        const fein = konfig.items.tabRegelung.items._pFein;
        expect(fein).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Abschnitt' });
        expect(de.headerFein).to.match(/^Für Fortgeschrittene: /);
        expect(Object.keys(fein.custom.items)).to.include('regelFeuchteMinLauf').and.to.include('regelFeuchtePause');
        expect(Object.keys(konfig.items.tabRegelung.items).pop()).to.equal('_pFein'); // ganz unten
        expect(konfig.items.tabModule.items._pTabelle).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/Abschnitt', label: 'headerModule' });
        expect(konfig.items.tabSearch.items._pHand.custom.items._mqtthostValue.type).to.equal('textSendTo');
        // ein altes Testergebnis verschwindet, sobald Adresse/Port/TLS/Benutzer geaendert werden
        for (const k of ['_tTestOk', '_tTestAnmeldung', '_tTestNicht', '_tTestZeit', '_tTestEingabe', '_tTestFehler']) {
            expect(b[k].hidden, k).to.contain('data._brokerTestZiel !== ');
        }
    });

    it('jede Einstellung des Formulars hat eine Vorgabe in io-package (native), das Passwort ist geschuetzt', () => {
        const io = require('../io-package.json');
        for (const k of ['brokerModus', 'externHost', 'externPort', 'externTls', 'externUser', 'externPass', 'externClientId', 'externPraefix']) {
            expect(k in io.native, k).to.equal(true);
            expect(b[k], k).to.be.an('object');
        }
        expect(io.encryptedNative).to.include('externPass');
        expect(io.protectedNative).to.include('externPass');
        expect(io.common.news['1.0.0'].de).to.contain('externer MQTT-Broker');
    });

    it('Knopf "Verbindung testen": Werte aus dem Formular, fuer jede Art des Ergebnisses ein Text', () => {
        expect(b._brokerTesten).to.include({ command: 'brokerVerbindungTesten', useNative: true });
        for (const feld of ['externHost', 'externPort', 'externTls', 'externUser', 'externPass', 'externClientId']) {
            expect(b._brokerTesten.jsonData).to.contain(`data.${feld}`);
        }
        const arten = Object.values(b)
            .map(x => /data\._brokerTest !== '(\w+)'/.exec(x.hidden || ''))
            .filter(Boolean)
            .map(m => m[1]);
        expect(arten.sort()).to.eql(['anmeldung', 'eingabe', 'fehler', 'nichtErreichbar', 'ok', 'zeit']);
    });

    it('Antwortumwandlung: Art des Tests -> Formularwerte', () => {
        expect(o.brokerTestAntwort({ ok: true, art: 'ok' }, 'de')).to.eql({ native: { _brokerTest: 'ok', _brokerTestZiel: '', _brokerTestText: '' } });
        expect(o.brokerTestAntwort({ ok: true, art: 'ok' }, 'de', 'h:1883:false:').native._brokerTestZiel).to.equal('h:1883:false:');
        for (const art of ['anmeldung', 'nichtErreichbar', 'zeit', 'eingabe']) {
            expect(o.brokerTestAntwort({ ok: false, art }, 'de').native).to.eql({ _brokerTest: art, _brokerTestZiel: '', _brokerTestText: '' });
        }
        expect(o.brokerTestAntwort({ ok: false, art: 'fehler', fehler: 'self signed certificate' }, 'de').native).to.eql({
            _brokerTest: 'fehler',
            _brokerTestZiel: '',
            _brokerTestText: 'Verbindung fehlgeschlagen: self signed certificate',
        });
        // Unbekanntes oder Widerspruechliches wird nie als Erfolg gezeigt
        expect(o.brokerTestAntwort({ ok: false, art: 'ok' }, 'de').native._brokerTest).to.equal('fehler');
        expect(o.brokerTestAntwort({ ok: false, art: 'seltsam' }, 'de').native._brokerTest).to.equal('fehler');
        expect(o.brokerTestAntwort(null, 'en').native._brokerTestText).to.equal('Connection failed: ?');
    });

    it('Nachricht brokerVerbindungTesten: Formularwerte gehen an den Test, leeres Passwort = das gespeicherte', async () => {
        const a = adapter({}, { externPass: 'gespeichert' });
        a.instance = 0;
        const aufrufe = [];
        a.brokerTestFunktion = async x => (aufrufe.push(x), { ok: false, art: 'anmeldung' });
        const r = await frage(a, 'brokerVerbindungTesten', { host: ' mosquitto ', port: '', tls: true, user: 'u', pass: '', clientId: '' });
        expect(r.antwort.native._brokerTest).to.equal('anmeldung');
        expect(aufrufe[0]).to.eql({ host: 'mosquitto', port: 8883, tls: true, user: 'u', pass: 'gespeichert', clientId: require('../lib/brokerextern').standardClientId(0) });
        // nicht die ID, die ein anderer Adapter fuer dieselben Module nutzt (gegenseitiger Rauswurf am Broker)
        expect(require('../lib/brokerextern').standardClientId(0, 'nas')).to.match(/^iobroker-faikout-adapter-0-[0-9a-f]{6}$/).and.not.to.equal('iobroker-faikout-0');
        await frage(a, 'brokerVerbindungTesten', { host: 'h', port: 1884, tls: false, user: 'u', pass: 'neu', clientId: 'mein' });
        expect(aufrufe[1]).to.include({ port: 1884, pass: 'neu', clientId: 'mein', tls: false });
    });

    it('echter Test ohne Adresse: "eingabe", ohne Netzzugriff', async () => {
        const r = await frage(adapter(), 'brokerVerbindungTesten', { host: '' });
        expect(r.antwort.native._brokerTest).to.equal('eingabe');
    });
});

describe('UX-Funde 21.11.2026', () => {
    it('Modulauswahl: ALLE Geraete stehen in der Liste - auch ohne bekannte Adresse (Nutzerfund)', async () => {
        const a = adapter({ 'og.info.ipv4': '192.168.30.70' });
        a.getObjectAsync = async id => (id === 'wz' ? { native: {} } : null);
        a.letzteSuche = [{ ip: '10.0.0.9', name: 'Fremdes Modul', status: 'andererBroker' }];
        const liste = (await frage(a, 'modulEinstellungenListe', {})).antwort;
        expect(liste).to.eql([
            { label: 'Wohnzimmer AC – Adresse noch unbekannt', value: 'geraet:wz' },
            { label: 'OG (192.168.30.70)', value: '192.168.30.70' },
            { label: 'Fremdes Modul (10.0.0.9)', value: '10.0.0.9' },
        ]);
        // "Anbinden" braucht eine Adresse: dort nur Eintraege mit Adresse
        expect((await frage(a, 'modulAuswahlListe', {})).antwort.map(x => x.value)).to.eql(['192.168.30.70', '10.0.0.9']);
        // ein Treffer der Suche mit dem Namen des Geraets liefert dessen Adresse - kein doppelter Eintrag
        a.letzteSuche = [{ ip: '127.0.0.1:18101', name: 'Wohnzimmer AC', status: 'verbunden' }];
        expect((await frage(a, 'modulEinstellungenListe', {})).antwort.map(x => x.value)).to.eql(['127.0.0.1:18101', '192.168.30.70']);
        // die gemerkte Adresse aus dem Geraeteobjekt
        a.letzteSuche = [];
        a.getObjectAsync = async id => (id === 'wz' ? { native: { modulAdresse: '10.1.1.1:8080' } } : null);
        expect((await frage(a, 'modulEinstellungenListe', {})).antwort[0]).to.eql({ label: 'Wohnzimmer AC (10.1.1.1:8080)', value: '10.1.1.1:8080' });
    });

    it('Lesen mit einem Eintrag ohne Adresse: klare Meldung mit dem Namen statt eines Netzfehlers', async () => {
        const a = adapter();
        const r = (await frage(a, 'modulEinstellungenLesen', { ip: 'geraet:wz' })).antwort;
        // verstaendlich und mit Weg - nicht "Feld neben der Liste" (Nutzerfund 21.11.2026)
        expect(r.error).to.contain('Die Adresse von Wohnzimmer AC ist noch nicht bekannt').and.to.contain('bis zu 1 Minute').and.to.contain('Module suchen');
    });

    it('Adresse automatisch: Absenderadresse der Broker-Verbindung, geprueft am Namen des Moduls', async () => {
        const seite = name => `<html><head><title>${name}</title></head><body><form><input name="_hostname" value="${name}"><input name="_reporting" value="60"></form></body></html>`;
        const a = adapter();
        a.getObjectAsync = async () => ({ native: {} });
        a.extendObject = async (id, o) => (a.erweitert = { id, o });
        a.modulClientAdresse = name => (name === 'Wohnzimmer AC' ? '10.0.0.5' : '');
        // in der Liste steht das Geraet dann ohne den Zusatz "Adresse noch unbekannt"
        expect((await frage(a, 'modulEinstellungenListe', {})).antwort[0]).to.eql({ label: 'Wohnzimmer AC', value: 'geraet:wz' });
        const gefragt = [];
        a.modulEinstellungenLesen = async ({ ip }) => {
            gefragt.push(ip);
            return { ok: true, name: 'Wohnzimmer AC', werte: { reporting: '60' } };
        };
        // die Probe am Kandidaten laeuft ueber HTTP - hier antwortet niemand: dann bleibt es bei der Meldung
        const ohne = (await frage(a, 'modulEinstellungenLesen', { ip: 'geraet:wz' })).antwort;
        expect(ohne.error).to.contain('noch nicht bekannt');
        expect(gefragt).to.eql([]);
        // ist die Adresse inzwischen gemeldet (info.ipv4), wird sie ohne Zutun verwendet
        const b = adapter({ 'wz.info.ipv4': '192.168.30.71' });
        b.getObjectAsync = async () => ({ native: {} });
        b.extendObject = async () => {};
        b.modulEinstellungenLesen = a.modulEinstellungenLesen;
        const mit = (await frage(b, 'modulEinstellungenLesen', { ip: 'geraet:wz' })).antwort;
        expect(gefragt).to.eql(['192.168.30.71']);
        expect(JSON.parse(mit.native._modStand)).to.include({ ip: '192.168.30.71', name: 'Wohnzimmer AC' });
        // Pruefen mit demselben Listenwert findet den gelesenen Stand wieder
        const pruef = (await frage(b, 'modulEinstellungenPruefen', { ip: 'geraet:wz', stand: mit.native._modStand, formular: { _modReporting: 90 } })).antwort;
        expect(pruef.native._modVorschau).to.contain('(reporting): 60 → 90');
        expect(seite('x')).to.contain('x');
    });

    it('"Adresse pruefen" und "Aus Modul lesen" zerlegen host:port gleich', () => {
        const d = require('../lib/discovery');
        expect(d.zielZerlegen('127.0.0.1:18101')).to.eql({ host: '127.0.0.1', port: 18101 });
        expect(d.zielZerlegen(' nas.local ')).to.eql({ host: 'nas.local', port: 80 });
        expect(d.zielZerlegen('10.0.0.1:99999')).to.eql({ host: '10.0.0.1:99999', port: 80 });
    });

    it('seiteHolen fragt den angegebenen Port (derselbe Weg fuer Suche, Einzelpruefung und Lesen)', async () => {
        const d = require('../lib/discovery');
        let gefragt = null;
        const request = (opt, cb) => {
            gefragt = opt;
            const req = new EventEmitter();
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                cb(res);
                res.emit('end');
            };
            req.destroy = () => {};
            return req;
        };
        await d.seiteHolen('127.0.0.1:18101', { request });
        expect(gefragt).to.include({ host: '127.0.0.1', port: 18101, path: '/revk-settings' });
    });

    it('Fuehler-Livewert: fehlender Datenpunkt mit Namen in Rot, Wert mit Komma, alter Wert gewarnt', async () => {
        const a = adapter();
        const jetzt = Date.now();
        const objekte = { 'hm.0.raum': {}, 'hm.0.alt': {}, 'hm.0.text': {} };
        const werte = {
            'hm.0.raum': { val: 21.46, ts: jetzt - 30000 },
            'hm.0.alt': { val: 17, ts: jetzt - 10 * 3600000 },
            'hm.0.text': { val: 'offen', ts: jetzt },
        };
        a.getForeignObjectAsync = async id => objekte[id] || null;
        a.getForeignStateAsync = async id => werte[id] || null;
        const html = async (id, art = 'raum') => (await frage(a, 'fuehlerWert', { id, art })).antwort;
        expect(await html('')).to.contain('noch kein Datenpunkt gewählt');
        expect(await html('0_userdata.0.gibtsnicht')).to.contain('Datenpunkt existiert nicht: 0_userdata.0.gibtsnicht').and.to.contain(o.AMPEL.fehler);
        expect(await html('hm.0.raum')).to.contain('jetzt: 21,5\u00a0°C · vor 30\u00a0s').and.to.contain(o.AMPEL.gut);
        expect(await html('hm.0.alt')).to.contain('17,0\u00a0°C').and.to.contain('Wert ist alt').and.to.contain(o.AMPEL.warn);
        expect(await html('hm.0.text')).to.contain('Kein Zahlenwert: offen');
        expect(await html('hm.0.raum', 'feuchte')).to.contain('21,5\u00a0%');
        expect(o.alterText(45000)).to.equal('45 s');
        expect(o.alterText(600000)).to.equal('10 min');
        expect(o.alterText(7200000)).to.equal('2 h');
    });

    it('Einrichtung: Schrittliste mit dem Stand IN der Zeile - erledigt gruen abgehakt, offen mit Anweisung und Reiter', async () => {
        const a = adapter({}, { regelGeraete: [{ geraet: 'OG' }] });
        a.broker = {};
        a.brokerZiel = () => ({ extern: false, port: 1888 });
        const html = (await frage(a, 'einrichtungStand', {})).antwort;
        const zeilen = h => h.split('<div data-schritt="').slice(1);
        const klar = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const z = zeilen(html);
        expect(z).to.have.length(4);
        // Broker, Modul und Regelung erledigt: Haken in der Ampelfarbe "gut", Ueberschrift und Stand in derselben Zeile.
        // Die Schritte stehen in der Reihenfolge der Reiter: 3 = Zeitplan, 4 = Regelung.
        for (const [i, titel, stand] of [
            [0, '1 · MQTT-Broker', 'Eigener MQTT-Broker läuft auf Port 1888'],
            [1, '2 · Modul verbinden', 'Module, die sich gemeldet haben: 2 (Wohnzimmer AC, OG)'],
            [3, '4 · Regelung einrichten (freiwillig)', 'Regelung für 1 von 2 Anlagen eingerichtet'],
        ]) {
            expect(z[i].startsWith('erledigt"'), titel).to.equal(true);
            expect(z[i], titel).to.contain('✓').and.to.contain(o.AMPEL.gut).and.to.not.contain('○');
            expect(klar(z[i]), titel).to.contain(titel).and.to.contain(stand);
        }
        // erledigte Schritte nennen keinen Reiter mehr, keine getrennte Aufzaehlung "So weit bist du"
        expect([z[0], z[1], z[3]].join('')).to.not.contain('→');
        expect(html).to.not.contain('So weit bist du');
        // 3 · Zeitplan anlegen: offen, solange kein Geraet einen Wochenplan hat - mit Anweisung und dem Reiter "Zeitplaene"
        expect(z[2].startsWith('offen"')).to.equal(true);
        expect(klar(z[2]))
            .to.contain('3 · Zeitplan anlegen (freiwillig)')
            .and.to.contain('Noch kein Wochenplan hinterlegt')
            .and.to.contain('Reiter „Zeitpläne“: Temperaturstufen')
            .and.to.contain('Reiter „Zeitpläne“ öffnen');
        expect(z[2]).to.contain(`#tab-instances/config/system.adapter.faikout.0/${o.REITER_ZEITPLAENE}`);
        // gruener Haken, sobald EIN Geraet einen lesbaren Plan hat; ein unlesbarer zaehlt nicht
        const plan = JSON.stringify(wochenplan.vorgabePlan(wochenplan.szenenLesen([]).szenen));
        const mitPlan = adapter({ 'og.regulation.schedule.weekJson': plan, 'wz.regulation.schedule.weekJson': '{kaputt' }, {});
        mitPlan.broker = {};
        mitPlan.brokerZiel = () => ({ extern: false, port: 1888 });
        const p = zeilen((await frage(mitPlan, 'einrichtungStand', {})).antwort)[2];
        expect(p.startsWith('erledigt"')).to.equal(true);
        expect(klar(p)).to.contain('Wochenplan für 1 von 2 Anlagen hinterlegt');
        expect(p).to.contain('✓').and.to.not.contain('→');
        for (const l of o.SPRACHEN) {
            for (const k of ['esPlanTitel', 'esPlan', 'esPlanKeiner', 'esPlanText', 'reiterZeitplaene']) {
                expect(o.TEXTE[k][l], `${k} ${l}`).to.be.a('string').and.not.equal('');
            }
        }
        // offen: neutraler Kreis, Handlungsanweisung und der Reiter, in dem es weitergeht
        a.geraete = new Map();
        a.broker = { verbunden: false };
        a.brokerZiel = () => ({ extern: true, adresse: 'mq.lan', port: 1883 });
        const leer = (await frage(a, 'einrichtungStand', {})).antwort;
        const l = zeilen(leer);
        expect(l.every(x => x.startsWith('offen"') && x.includes('○') && !x.includes('✓'))).to.equal(true);
        expect(klar(l[0])).to.contain('Keine Verbindung zum externen Broker mq.lan:1883').and.to.contain('MQTT-Broker (Technik)');
        expect(klar(l[1])).to.contain('Noch hat sich kein Modul gemeldet').and.to.contain('Extern-Betrieb: Die Module müssen auf deinen externen Broker zeigen').and.to.contain('Module suchen');
        expect(klar(l[3])).to.contain('Noch keine Anlage eingerichtet').and.to.contain('globalen Vorlage').and.to.contain('Regelung');
        expect(leer).to.contain('→');
        // kein Skript, keine fremden Adressen
        expect(html + leer).to.not.match(/<script|https?:/);
        // jede Sprache hat Ueberschriften und Texte
        for (const s of o.SPRACHEN) {
            a.sprache = async () => s;
            const h = klar((await frage(a, 'einrichtungStand', {})).antwort);
            expect(h, s).to.match(/1 · .*2 · .*3 · .*4 · /).and.to.not.contain('headerSchritt').and.to.not.contain('textSchritt').and.to.not.contain('tabSearch');
        }
    });

    it('Einrichtung: kurz nach dem Start wartet der Stand auf das erste Modul statt sofort "kein Modul" zu melden', async () => {
        const a = adapter();
        a.broker = {};
        a.brokerZiel = () => ({ extern: false, port: 1888 });
        const alle = a.geraete;
        // gerade gestartet, noch kein Modul: die Antwort wartet, bis sich eines meldet
        a.geraete = new Map();
        a.startZeit = 1000;
        let uhr = 1500;
        let gewartet = 0;
        const warte = async ms => {
            gewartet += ms;
            uhr += ms;
            if (gewartet >= 1500) {
                a.geraete = alle; // die Module haben sich verbunden
            }
        };
        const html = await o.einrichtungStandHtml(a, { warte, jetzt: () => uhr });
        expect(gewartet).to.equal(1500);
        expect(html).to.contain('Module, die sich gemeldet haben: 2').and.not.to.contain('Noch hat sich kein Modul gemeldet');
        // meldet sich keines, endet das Warten nach START_WARTEN_MS mit der ehrlichen Auskunft
        a.geraete = new Map();
        uhr = 1500;
        gewartet = 0;
        const leer = await o.einrichtungStandHtml(a, { warte: async ms => void ((gewartet += ms), (uhr += ms)), jetzt: () => uhr });
        expect(leer).to.contain('Noch hat sich kein Modul gemeldet');
        expect(gewartet).to.be.within(o.START_WARTEN_MS - 1000, o.START_WARTEN_MS);
        // laeuft der Adapter schon laenger, wird gar nicht gewartet
        uhr = 1000 + o.START_WARTEN_MS + 1;
        gewartet = 0;
        await o.einrichtungStandHtml(a, { warte: async ms => void (gewartet += ms), jetzt: () => uhr });
        expect(gewartet).to.equal(0);
    });

    it('History-Hinweis: nur wenn kein History-Adapter installiert ist oder die Instanz fehlt', async () => {
        const a = adapter();
        let zeilen = [];
        a.getObjectViewAsync = async () => ({ rows: zeilen });
        expect((await frage(a, 'historyHinweis', { instanz: 'history.0', an: true })).antwort).to.contain('Es ist kein History-Adapter installiert');
        expect((await frage(a, 'historyHinweis', { instanz: 'history.0', an: false })).antwort).to.equal('');
        zeilen = [{ id: 'system.adapter.sql.0', value: { common: { getHistory: true } } }];
        expect((await frage(a, 'historyHinweis', { instanz: 'history.0', an: true })).antwort).to.contain('Die gewählte Instanz history.0 gibt es nicht');
        expect((await frage(a, 'historyHinweis', { instanz: 'sql.0', an: true })).antwort).to.equal('');
    });

    it('Obergrenze 95 % plus volle Freigabe: eigenes Etikett statt "100 % · roh 102,5 %"', () => {
        const svg = o.kennlinieSvg({
            punkte: HEIZEN,
            richtung: 'heizen',
            untergrenze: 40,
            obergrenze: 95,
            sprache: 'de',
            punkt: { x: -2.3, wert: 100, roh: 102.5, richtung: 'heizen', probelauf: false, vollAbK: 2 },
        });
        expect(svg).to.contain('volle Leistung (2\u00a0K unter Ziel)').and.to.contain('sonst höchstens 95\u00a0% · außen −2,3\u00a0°C');
        expect(svg).not.to.contain('roh');
        // ohne Freigabe bleibt es bei Wert und Rohwert
        const normal = o.kennlinieSvg({
            punkte: HEIZEN,
            richtung: 'heizen',
            untergrenze: 40,
            obergrenze: 95,
            sprache: 'de',
            punkt: { x: -2.3, wert: 80, roh: 79.6, richtung: 'heizen', probelauf: false, vollAbK: 2 },
        });
        expect(normal).to.contain('Leistungsgrenze 80\u00a0%').and.to.contain('roh 79,6\u00a0%');
    });

    it('Modul-Einstellungen: verstaendlicher Name, Schluessel des Moduls klein dahinter', () => {
        expect(o.modulFeldName('livestatus', 'de')).to.equal('Statusmeldungen in Echtzeit (livestatus)');
        expect(o.modulFeldName('ha1c', 'en')).to.match(/\(ha1c\)$/);
        expect(o.modulFeldName('unbekannt', 'de')).to.equal('unbekannt');
    });

    it('Einstellungsseite: Vorgabe-Kennlinie als Tabelle, Live-Wert neben jedem Fuehlerfeld, kein Rohtext helpBindIp', () => {
        const konfig = require('../admin/jsonConfig.json');
        const v = konfig.items.tabRegelung.items;
        // seit 21.11.2026 Tabelle UND ziehbares Bild in einer Komponente (derselbe Wert: Zeilen {x, y})
        expect(v.regelKennlinieHeizen).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/KennlinieHeizen' });
        expect(v.regelKennlinieKuehlen).to.include({ type: 'custom', name: 'ConfigCustomFaikoutSet/Components/KennlinieKuehlen' });
        expect(v._bildH).to.equal(undefined);
        expect(v._bildK).to.equal(undefined);
        const io = require('../io-package.json');
        // die Werksvorgabe steht an zwei Stellen - sie muss dieselbe sein
        expect(io.native.regelKennlinieHeizen).to.eql(v.regelKennlinieHeizen.default);
        expect(io.native.regelKennlinieKuehlen).to.eql(v.regelKennlinieKuehlen.default);
        expect(io.native.regelKennlinieHeizen[0]).to.eql({ x: -10, y: 100 });
        expect(io.native.regelObergrenze).to.equal(100);
        const g = konfig.items.tabRegelung.items.regelGeraete.custom.items;
        for (const [dp, art] of [['aussenDp', 'aussen'], ['raumDp', 'raum'], ['feuchteDp', 'feuchte']]) {
            const i = g.findIndex(x => x.attr === dp);
            expect(g[i + 1]).to.include({ type: 'textSendTo', command: 'fuehlerWert' });
            expect(g[i + 1].jsonData).to.contain(`"art":"${art}"`).and.to.contain(`data.${dp}`);
        }
        const s = konfig.items.tabSearch.items;
        expect(s._bindIp.noTranslation).to.equal(undefined); // mit noTranslation erschien "helpBindIp" als Rohtext
        expect(s._bindIp.command).to.equal('modulAuswahlListe');
        for (const l of o.SPRACHEN) {
            const texte = require(`../admin/i18n/${l}.json`);
            for (const k of ['helpBindIp', 'headerSchritt1', 'headerSchritt2', 'headerSchritt3', 'textSchritt2Extern', 'textBindExtern', 'colSzDeckel']) {
                expect(texte[k], `${l}/${k}`).to.be.a('string').and.not.equal('');
            }
        }
        expect(require('../admin/i18n/de.json').colSzDeckel).to.equal('Höchstleistung %');
    });
});
