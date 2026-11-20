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
            'wz.regel.bedarf.aussenMittel': 9,
            'wz.regel.bedarf.aktiv': true,
            'wz.regel.bedarf.sollwert': 45,
            'wz.regel.bedarf.rohwert': 44.3,
            'wz.control.power': true,
            'wz.control.mode': 'heat',
        });
        const { erledigt, antwort } = await frage(a, 'regelKennlinieBild', { richtung: 'heizen', punkte: '-10:95, 0:75, 7:55, 15:40', untergrenze: 40, obergrenze: 95, geraet: 'wz' });
        expect(erledigt).to.equal(true);
        expect(antwort).to.contain('<svg').and.to.contain('würde senden 45 %').and.to.contain('roh 44,3 %');
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
        const a = adapter({ 'wz.info.demandFaehig': 'nein', 'wz.regel.fuehler.raumQuelle': 'BLE-Fühler am Modul', 'wz.regel.fuehler.feuchte': 48 });
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
                szenen: [{ name: 'Tag', soll: 22 }],
                strategie: 'vortag',
                untergrenze: 50,
                kennlinieHeizen: [{ x: 0, y: 80 }],
            },
            { geraet: 'og', betrieb: 'faikout', szenen: [], frostAb: 8, obergrenze: 90 },
        ];
        const lauf = async was => {
            const a = adapter();
            a.gespeichert = [];
            a.extendForeignObjectAsync = async (id, obj) => a.gespeichert.push({ id, obj });
            const antwort = (await frage(a, 'regelUebernehmen', { zeilen, von: 'wz', nach: 'og', was })).antwort;
            return { a, antwort, ziel: a.gespeichert.length ? a.gespeichert[0].obj.native.regelGeraete[1] : null };
        };
        const s = await lauf('szenen');
        expect(s.antwort).to.eql({ reloadBrowser: true });
        expect(s.a.gespeichert[0].id).to.equal('system.adapter.faikout.0');
        expect(s.ziel.szenen).to.eql([{ name: 'Tag', soll: 22 }]);
        expect(s.ziel).to.include({ betrieb: 'faikout', frostAb: 8, obergrenze: 90 });
        expect(s.ziel.strategie).to.equal(undefined);
        const k = await lauf('kennlinie');
        expect(k.ziel).to.include({ strategie: 'vortag', untergrenze: 50, betrieb: 'faikout' });
        // was die Quelle nicht hat, faellt im Ziel auf die Vorgabe zurueck
        expect('obergrenze' in k.ziel).to.equal(false);
        expect(k.ziel.szenen).to.eql([]);
        const b = await lauf('beides');
        expect(b.ziel.szenen).to.eql([{ name: 'Tag', soll: 22 }]);
        expect(b.ziel.kennlinieHeizen).to.eql([{ x: 0, y: 80 }]);
        // die uebergebene Liste selbst bleibt unveraendert
        expect(zeilen[1].szenen).to.eql([]);
        // Quelle = Ziel: Fehlermeldung, nichts gespeichert
        const a = adapter();
        a.extendForeignObjectAsync = async () => {
            throw new Error('darf nicht speichern');
        };
        const gleich = (await frage(a, 'regelUebernehmen', { zeilen, von: 'wz', nach: 'wz', was: 'beides' })).antwort;
        expect(gleich.error).to.equal(o.TEXTE.kopieFehlt.de);
    });

    it('Szenen je Geraet: eigene Szenen der Zeile, sonst Vorgabe; szenenVon der Regelung hat Vorrang', () => {
        const a = adapter({}, { regelGeraete: [{ geraet: 'Wohnzimmer AC', szenen: [{ name: 'Tag', soll: 22 }] }] });
        expect([...o.szenen(a, 'wz').keys()]).to.eql(['tag']);
        expect([...o.szenen(a, 'og').keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
        a.regelung = { szenenVon: id => new Map(id === 'og' ? [['x', { id: 'x' }]] : []) };
        expect([...o.szenen(a, 'og').keys()]).to.eql(['x']);
        expect([...o.szenen(a, 'wz').keys()]).to.eql(['tag']);
    });
});

describe('Oberflaeche: Geraetename statt ID, Hinweise', () => {
    it('Zeilen duerfen Name oder ID tragen: Bild, Faehigkeiten und Auswahl finden das Geraet', async () => {
        const a = adapter({ 'wz.info.demandFaehig': 'ja', 'wz.regel.bedarf.aussenMittel': 3 });
        expect(o.geraetId(a, 'Wohnzimmer AC')).to.equal('wz');
        expect(o.geraetId(a, 'wz')).to.equal('wz');
        expect(o.geraetId(a, 'fremd')).to.equal('fremd');
        expect((await frage(a, 'regelKann', { geraet: 'Wohnzimmer AC' })).antwort).to.contain('unterstützt');
        expect((await frage(a, 'regelKennlinieBild', { richtung: 'heizen', geraet: 'Wohnzimmer AC' })).antwort).to.contain('außen 3,0 °C');
        expect((await frage(a, 'regelZeilenListe', { zeilen: ['wz', 'OG', ''] })).antwort).to.eql([
            { label: 'Wohnzimmer AC', value: 'wz' },
            { label: 'OG', value: 'OG' },
        ]);
    });

    it('BLE-Fuehler: Art aus regel.fuehler.raumArt, ohne den Datenpunkt wie bisher aus dem Quellentext', async () => {
        const kann = async werte => (await frage(adapter(werte), 'regelKann', { geraet: 'wz' })).antwort;
        expect(await kann({ 'wz.regel.fuehler.raumArt': 'ble', 'wz.regel.fuehler.raumQuelle': 'BLE sensor' })).to.contain('verbunden');
        expect(await kann({ 'wz.regel.fuehler.raumArt': 'dp', 'wz.regel.fuehler.raumQuelle': 'BLE-Fühler am Modul' })).to.contain('keiner');
        expect(await kann({ 'wz.regel.fuehler.raumQuelle': 'BLE-Fühler am Modul' })).to.contain('verbunden');
    });

    it('Daikin-Hinweis haengt am Wert "nein" der Leistungsgrenze', async () => {
        const nein = (await frage(adapter({ 'wz.info.demandFaehig': 'nein' }), 'regelKann', { geraet: 'wz' })).antwort;
        expect(nein).to.contain('SP 1').and.to.contain('Leistungssteuerung auf „Ein“');
        for (const wert of ['ja', 'unbekannt']) {
            expect((await frage(adapter({ 'wz.info.demandFaehig': wert }), 'regelKann', { geraet: 'wz' })).antwort).not.to.contain('SP 1');
        }
    });

    it('Faikout-Auto: Hinweis ab sechs Zielaenderungen an einem Tag, nicht bei "Adapter regelt"', async () => {
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
        const a = n => adapter({ 'wz.regel.plan.wocheJson': JSON.stringify(plan(n)) });
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
        expect(o.programmZuPlan([{ day: 'Mon', time: '06:00', type: 'party' }], sz).fehler).to.contain('Szene "party" gibt es nicht');
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
            expect(gelesen._modFehlt).to.equal('Bei diesem Modul nicht vorhanden (hängt von Firmware und Anlage ab): ha1c, nodemand');
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

    it('Lesen fuellt das Formular, Pruefen nennt nur die Unterschiede', async () => {
        const { a } = mitModul();
        const { gelesen, basis, pruefung } = await vorbereiten(a, { _modLivestatus: true, _modTopicgroup1: 'Sim_Wohnzimmer' });
        expect(gelesen).to.include({ _modReporting: 60, _modLivestatus: false, _modThermostat: true, _modPlan: '' });
        expect(pruefung.native._modVorschau).to.contain('livestatus: aus → an').and.to.contain('topicgroup1: (leer) → Sim_Wohnzimmer');
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
        expect(r._modVorschau).to.contain('alles übernommen').and.to.contain('✓ reporting = 90: übernommen').and.to.contain('✓ livestatus = an: übernommen');
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
        expect(r._modVorschau).to.contain('nicht alles wurde übernommen').and.to.contain('✗ reporting = 90: nicht übernommen (im Modul steht: 60)');
        expect(r._modVorschau).to.contain('✓ livestatus = an: übernommen');
        expect(r._modReporting).to.equal(60);
        // Modul meldet sich nach dem Schreiben nicht mehr
        m = mitModul();
        v = await vorbereiten(m.a, { _modReporting: 90 });
        m.a.broker.publish = async () => ((m.a.erreichbar = false), true);
        r = (await frage(m.a, 'modulEinstellungenSchreiben', v.auftrag)).antwort.native;
        expect(r._modVorschau).to.contain('hat innerhalb von 0 s nicht geantwortet');
        expect(r._modStand).to.equal('');
    });

    it('Wiederherstellen: Sicherung waehlen, in das Formular laden, Unterschied zeigen, mit demselben Ablauf schreiben', async () => {
        const { a, modul } = mitModul();
        const { auftrag } = await vorbereiten(a, { _modReporting: 90 });
        const nach = (await frage(a, 'modulEinstellungenSchreiben', auftrag)).antwort.native;
        expect(modul.reporting).to.equal('90');
        const liste = (await frage(a, 'modulEinstellungenSicherungen', { stand: nach._modStand })).antwort;
        expect(liste).to.have.length(1);
        expect(liste[0].label).to.match(/\d\d\.\d\d\.,? \d\d:\d\d/);
        const basis = { ip: '10.0.0.5', stand: nach._modStand };
        expect((await frage(a, 'modulEinstellungenWiederherstellen', { ...basis, zeit: '' })).antwort.error).to.equal(o.TEXTE.mSicherungFehlt.de);
        const w = (await frage(a, 'modulEinstellungenWiederherstellen', { ...basis, zeit: liste[0].value })).antwort.native;
        expect(w._modReporting).to.equal(60);
        expect(w._modVorschau).to.contain('in das Formular übernommen').and.to.contain('reporting: 90 → 60');
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
        expect(r.regelGeraete.type).to.equal('accordion');
        const attrs = r.regelGeraete.items.map(i => i.attr);
        expect(attrs).to.include.members(['geraet', 'betrieb', 'strategie', 'kennlinieHeizen', 'kennlinieKuehlen', 'untergrenze', 'obergrenze', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW', 'szenen', 'aussenQuelle', 'aussenDp', 'raumQuelle', 'raumDp', 'feuchteQuelle', 'feuchteDp', 'feuchteMassnahme', 'frostAb']);
        expect(attrs).not.to.include('eigeneKennlinie');
        expect(JSON.stringify(konfig)).not.to.contain('regelQuellen');
        expect(Object.keys(r)[0]).to.equal('regelProbelauf');
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
        const zeile = Object.fromEntries(konfig.items.tabRegelung.items.regelGeraete.items.map(i => [i.attr, i]));
        expect(zeile.fuehlerWeg.options.map(x => x.value)).to.eql(['sollwert', 'modul']);
        expect(zeile.fuehlerWeg.default).to.equal('sollwert');
        expect(zeile.fuehlerWeg.hidden).to.equal("data.raumQuelle !== 'dp'");
        expect(zeile.raumTraegeMin).to.include({ min: 0, max: 240, default: 0, hidden: "data.raumQuelle !== 'dp'" });
        expect(zeile.korrAbstandMin).to.include({ min: 10, max: 180, default: 30 });
        expect(zeile.korrAbstandMin.hidden).to.contain("data.fuehlerWeg === 'modul'");
        // der Titel des Eintrags ist der Geraetename (Wert der Auswahl)
        expect(konfig.items.tabRegelung.items.regelGeraete.titleAttr).to.equal('geraet');
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
        // "Uebernehmen" speichert sofort und laedt neu - mit Rueckfrage
        const kopie = konfig.items.tabRegelung.items._pKopie.items._kopie;
        expect(kopie).to.include({ command: 'regelUebernehmen', reloadBrowser: true });
        expect(kopie.confirm.text).to.equal('confirmKopieText');
    });
});
