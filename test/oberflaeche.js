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
            { label: 'Wohnzimmer AC', value: 'wz' },
            { label: 'OG', value: 'og' },
        ]);
    });

    it('regelKann: Faehigkeiten aus den Datenpunkten', async () => {
        const a = adapter({ 'wz.info.demandFaehig': 'nein', 'wz.regel.fuehler.raumQuelle': 'BLE-Fühler am Modul', 'wz.regel.fuehler.feuchte': 48 });
        const { antwort } = await frage(a, 'regelKann', { geraet: 'wz' });
        expect(antwort).to.contain('nicht unterstützt').and.to.contain('verbunden').and.to.contain('vorhanden');
        expect((await frage(a, 'regelKann', { geraet: '' })).antwort).to.contain(o.TEXTE.kWaehlen.de);
        expect((await frage(a, 'regelKann', { geraet: 'fremd' })).antwort).to.contain(o.TEXTE.keineDaten.de);
    });

    it('regelUebernehmen: kopiert Szenen bzw. Kennlinie in die Zielzeile, Quelle bleibt', async () => {
        const zeilen = [
            { geraet: 'wz', betrieb: 'adapter', szenen: [{ name: 'Tag', soll: 22 }], strategie: 'vortag', untergrenze: 50, kennlinieHeizen: [{ x: 0, y: 80 }] },
            { geraet: 'og', betrieb: 'faikout', szenen: [], frostAb: 8, obergrenze: 90 },
        ];
        const s = (await frage(adapter(), 'regelUebernehmen', { zeilen, von: 'wz', nach: 'og', was: 'szenen' })).antwort;
        expect(s.native.regelGeraete[1].szenen).to.eql([{ name: 'Tag', soll: 22 }]);
        expect(s.native.regelGeraete[1]).to.include({ betrieb: 'faikout', frostAb: 8, obergrenze: 90 });
        expect(s.native.regelGeraete[1].strategie).to.equal(undefined);
        const k = (await frage(adapter(), 'regelUebernehmen', { zeilen, von: 'wz', nach: 'og', was: 'kennlinie' })).antwort;
        expect(k.native.regelGeraete[1]).to.include({ strategie: 'vortag', untergrenze: 50, betrieb: 'faikout' });
        // was die Quelle nicht hat, faellt im Ziel auf die Vorgabe zurueck
        expect('obergrenze' in k.native.regelGeraete[1]).to.equal(false);
        expect(k.native.regelGeraete[1].szenen).to.eql([]);
        expect(zeilen[1].szenen).to.eql([]);
        expect((await frage(adapter(), 'regelUebernehmen', { zeilen, von: 'wz', nach: 'wz', was: 'beides' })).antwort.error).to.equal(o.TEXTE.kopieFehlt.de);
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

describe('Oberflaeche: Modul-Einstellungen (nur lesen)', () => {
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

    it('Lesen fuellt das Formular, Pruefen nennt nur die Unterschiede, Schreiben braucht das Backend', async () => {
        const a = adapter();
        a.modulEinstellungenLesen = ({ ip }) => o.modulLesen(ip, { request });
        const gelesen = (await frage(a, 'modulEinstellungenLesen', { ip: '10.0.0.5' })).antwort.native;
        expect(gelesen).to.include({ _modReporting: 60, _modLivestatus: false, _modThermostat: true, _modPlan: '' });
        const formular = { _modReporting: 60, _modLivestatus: true, _modHa1c: true, _modThermostat: true, _modNodemand: false, _modTopicgroup1: 'Sim_Wohnzimmer' };
        const basis = { ip: '10.0.0.5', stand: gelesen._modStand, formular };
        const p = (await frage(a, 'modulEinstellungenPruefen', basis)).antwort.native;
        expect(p._modVorschau).to.contain('livestatus: aus → an').and.to.contain('topicgroup1: (leer) → Sim_Wohnzimmer');
        expect(p._modVorschau).not.to.contain('reporting');
        // ohne Backend-Funktion: klare Meldung, nichts geschrieben
        expect((await frage(a, 'modulEinstellungenSchreiben', { ...basis, plan: p._modPlan })).antwort.error).to.equal(o.TEXTE.mSchreibenFehlt.de);
        // mit Backend: bekommt genau die Aenderungen
        let auftrag = null;
        a.modulEinstellungenSchreiben = async x => ((auftrag = x), { result: 'ok' });
        await frage(a, 'modulEinstellungenSchreiben', { ...basis, plan: p._modPlan });
        expect(auftrag.aenderungen.map(x => [x.feld, x.neu])).to.eql([['livestatus', true], ['topicgroup1', 'Sim_Wohnzimmer']]);
        // Formular nach dem Pruefen veraendert: erst neu pruefen
        const anders = { ...basis, formular: { ...formular, _modReporting: 30 }, plan: p._modPlan };
        expect((await frage(a, 'modulEinstellungenSchreiben', anders)).antwort.error).to.equal(o.TEXTE.mErstPruefen.de);
        expect((await frage(a, 'modulEinstellungenPruefen', { ip: '10.0.0.9', stand: gelesen._modStand, formular })).antwort.error).to.equal(o.TEXTE.mErstLesen.de);
        expect((await frage(a, 'modulEinstellungenPruefen', { ...basis, formular: { ...formular, _modLivestatus: false, _modTopicgroup1: '' } })).antwort.native._modVorschau).to.equal(o.TEXTE.mKeineAenderung.de);
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
