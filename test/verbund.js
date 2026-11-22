'use strict';

/*
 * Multisplit - Kernlogik (lib/verbund.js): Konfiguration, Aufloesen gegen die Geraete, Vorschlag aus den
 * Daten, Aufteilung des Verbrauchs. Ohne ioBroker.
 */

const { expect } = require('chai');
const v = require('../lib/verbund');

const geraete = (...l) => new Map(l.map(([id, name, modulId]) => [id, { name, modulId: modulId || null }]));

/** Verlauf: je Minute comp/outside aus einer Funktion */
function verlauf(v0, id, fn, minuten = 60) {
    for (let m = 0; m < minuten; m++) {
        v.merken(v0, id, fn(m), 1e12 + m * 60000);
    }
    return v0;
}

describe('Multisplit: Konfiguration', () => {
    it('ohne Eintrag: leere Liste, niemand zugeordnet (Single-Split, nichts zu tun)', () => {
        expect(v.normalisieren(undefined)).to.deep.equal([]);
        const r = v.aufloesen([], geraete(['a', 'A']));
        expect(r.gruppen).to.deep.equal([]);
        expect(r.vonGeraet.size).to.equal(0);
    });

    it('säubert: Kennung eindeutig, Innengerät nur an EINEM Außengerät, Unsinn fällt weg', () => {
        const n = v.normalisieren([
            { id: 'a1', name: '  Garten  ', innen: ['wz', { geraet: 'sz', modulId: 'M2' }, null, { geraet: '' }] },
            { id: 'a1', name: 'Dach', weitere: 99, innen: ['wz', 'az'] },
            'quatsch',
        ]);
        expect(n.map(a => a.id)).to.deep.equal(['a1', 'a2']);
        expect(n[0].name).to.equal('Garten');
        expect(n[0].innen).to.deep.equal([
            { geraet: 'wz', modulId: null },
            { geraet: 'sz', modulId: 'M2' },
        ]);
        expect(n[1].innen.map(i => i.geraet)).to.deep.equal(['az']); // wz gehoert schon a1
        expect(n[1].weitere).to.equal(v.WEITERE_MAX);
        expect(v.kennungNeu(n)).to.equal('a3');
    });

    it('umbenanntes Modul: die Zuordnung folgt der Hardware-ID', () => {
        const r = v.aufloesen(
            [{ id: 'a1', name: 'Garten', innen: [{ geraet: 'Schlafzimmer', modulId: 'M2' }, { geraet: 'wz', modulId: 'M1' }] }],
            geraete(['wz', 'Wohnzimmer', 'M1'], ['Eltern', 'Eltern', 'M2']),
        );
        expect(r.gruppen[0].innen.map(i => [i.id, i.umbenannt, i.fehlt])).to.deep.equal([
            ['Eltern', true, false],
            ['wz', false, false],
        ]);
        expect(r.vonGeraet.get('Eltern')).to.equal('a1');
        expect(r.geaendert).to.equal(true);
        expect(r.konfig[0].innen[0]).to.deep.equal({ geraet: 'Eltern', modulId: 'M2' });
    });

    it('Modul getauscht (gleicher Name, neue Hardware): Zuordnung bleibt, Hardware-ID wird nachgeführt', () => {
        const r = v.aufloesen(
            [{ id: 'a1', innen: [{ geraet: 'wz', modulId: 'ALT' }] }],
            geraete(['wz', 'Wohnzimmer', 'NEU']),
        );
        expect(r.gruppen[0].innen[0]).to.include({ id: 'wz', getauscht: true, fehlt: false, modulId: 'NEU' });
        expect(r.konfig[0].innen[0].modulId).to.equal('NEU');
    });

    it('unbekanntes Gerät bleibt als "fehlt" stehen und zählt nicht als zugeordnet', () => {
        const r = v.aufloesen([{ id: 'a1', innen: ['wz', 'weg'] }], geraete(['wz', 'Wohnzimmer']));
        expect(r.gruppen[0].innen.map(i => i.fehlt)).to.deep.equal([false, true]);
        expect([...r.vonGeraet.keys()]).to.deep.equal(['wz']);
        expect(r.geaendert).to.equal(false);
    });
});

describe('Multisplit: Vorschlag aus den Daten', () => {
    it('gleicher Außengeräte-Zähler: Vorschlag mit hoher Sicherheit; die Single-Split-Anlage bleibt außen vor', () => {
        const r = v.vorschlaege({
            zaehler: new Map([
                ['wz', 2412300],
                ['sz', 2412400], // eine Zaehlerstufe spaeter gemeldet
                ['az', 2412300],
                ['gast', 815500],
            ]),
        });
        expect(r).to.have.length(1);
        expect(r[0]).to.deep.include({ art: 'neu', ids: ['az', 'sz', 'wz'], sicherheit: 'hoch', gruppe: null });
        expect(r[0].gruende).to.deep.equal(['zaehler']);
    });

    it('junge Zähler (unter 10 kWh) sagen nichts - dann zählt der Gleichlauf von Verdichter und Außentemperatur', () => {
        const lauf = m => ({ comp: m < 20 ? 0 : 30 + (m % 7) * 4, outside: 6.5 });
        const vl = new Map();
        verlauf(vl, 'wz', lauf);
        verlauf(vl, 'sz', lauf);
        verlauf(vl, 'gast', m => ({ comp: 30 + (m % 5) * 6, outside: 6.5 }));
        const r = v.vorschlaege({ zaehler: new Map([['wz', 300], ['sz', 300], ['gast', 300]]), verlauf: vl });
        expect(r).to.have.length(1);
        expect(r[0]).to.deep.include({ art: 'neu', ids: ['sz', 'wz'], sicherheit: 'mittel' });
        expect(r[0].gruende).to.deep.equal(['verdichter']);
    });

    it('Gleichlauf: beide aus oder immer dieselbe Frequenz reicht nicht', () => {
        const aus = verlauf(verlauf(new Map(), 'a', () => ({ comp: 0, outside: 5 })), 'b', () => ({ comp: 0, outside: 5 }));
        expect(v.gleichlauf(aus.get('a'), aus.get('b')).sicher).to.equal(false);
        const fest = verlauf(verlauf(new Map(), 'a', () => ({ comp: 60, outside: 5 })), 'b', () => ({ comp: 60, outside: 5 }));
        expect(v.gleichlauf(fest.get('a'), fest.get('b'))).to.include({ sicher: false, stufen: 1 });
    });

    it('verschiedene bekannte Zähler schließen ein gemeinsames Außengerät aus - auch bei gleichem Verdichterlauf', () => {
        const lauf = m => ({ comp: 30 + (m % 7) * 4, outside: 6.5 });
        const vl = verlauf(verlauf(new Map(), 'wz', lauf), 'og', lauf);
        expect(v.vorschlaege({ zaehler: new Map([['wz', 3131200], ['og', 3970200]]), verlauf: vl })).to.deep.equal([]);
    });

    it('schon zugeordnet: kein Vorschlag; ein neues Innengerät wird dem bestehenden Außengerät vorgeschlagen', () => {
        const zaehler = new Map([['wz', 50000], ['sz', 50000], ['az', 50000]]);
        const alle = new Map([['wz', 'a1'], ['sz', 'a1'], ['az', 'a1']]);
        expect(v.vorschlaege({ zaehler, vonGeraet: alle })).to.deep.equal([]);
        const r = v.vorschlaege({ zaehler, vonGeraet: new Map([['wz', 'a1'], ['sz', 'a1']]) });
        expect(r[0]).to.deep.include({ art: 'dazu', gruppe: 'a1', neu: ['az'] });
    });

    it('abgelehnter Vorschlag kommt nicht wieder; über zwei Außengeräte verteilt = Widerspruch', () => {
        const zaehler = new Map([['wz', 50000], ['sz', 50000]]);
        expect(v.vorschlaege({ zaehler, abgelehnt: [v.schluessel(['wz', 'sz'])] })).to.deep.equal([]);
        const r = v.vorschlaege({ zaehler, vonGeraet: new Map([['wz', 'a1'], ['sz', 'a2']]) });
        expect(r[0].art).to.equal('widerspruch');
    });

    it('Prüfung einer Zuordnung: bestätigt, widerspricht, unbekannt', () => {
        const z = new Map([['wz', 50000], ['sz', 50100], ['og', 90000], ['neu', 200]]);
        expect(v.pruefung(['wz', 'sz'], z)).to.equal('bestaetigt');
        expect(v.pruefung(['wz', 'og'], z)).to.equal('widerspricht');
        expect(v.pruefung(['wz', 'neu'], z)).to.equal('unbekannt');
        expect(v.pruefung(['wz'], z)).to.equal('unbekannt');
    });

    it('Verlauf: ein Wert je Minute, Teilmeldungen ergänzen, alte Minuten fallen heraus', () => {
        const vl = new Map();
        v.merken(vl, 'a', { comp: 40 }, 60000 * 10);
        v.merken(vl, 'a', { outside: 7 }, 60000 * 10 + 5000);
        v.merken(vl, 'a', {}, 60000 * 11);
        expect(vl.get('a')).to.deep.equal([{ t: 10, comp: 40, outside: 7 }]);
        v.merken(vl, 'a', { comp: 50 }, 60000 * (10 + v.VERLAUF_MIN + 1));
        expect(vl.get('a')).to.have.length(1);
        expect(vl.get('a')[0]).to.include({ comp: 50, outside: 7 });
    });
});

describe('Multisplit: Aufteilung', () => {
    it('Außengerät zählt einmal, Innengeräte anteilig, der Rest bleibt beim Außengerät (Zahlen aus Issue #8)', () => {
        const r = v.aufteilung(0.9, [
            { id: 'bedroom', kwh: 0.6 },
            { id: 'attic', kwh: 0.3 },
        ]);
        expect(r).to.deep.include({ aussen: 0.9, summeInnen: 0.9, rest: 0 });
        expect(r.innen.map(i => i.anteil)).to.deep.equal([0.667, 0.333]);
        const mitRest = v.aufteilung(6.3 + 0.7, [{ id: 'b', kwh: 4 }, { id: 'a', kwh: 2.5 }]);
        expect(mitRest.rest).to.equal(0.5);
        expect(mitRest.innen.map(i => i.anteil)).to.deep.equal([0.571, 0.357]);
    });

    it('Innengeräte zählen mehr als das Außengerät (Zählerstufen): kein negativer Rest, Anteile an der Summe', () => {
        const r = v.aufteilung(6.3, [{ id: 'b', kwh: 4 }, { id: 'a', kwh: 2.5 }]);
        expect(r.rest).to.equal(0);
        expect(r.innen.map(i => i.anteil)).to.deep.equal([0.615, 0.385]);
    });

    it('nur ein Innengerät läuft, ohne Außenzähler, alles null', () => {
        expect(v.aufteilung(1.2, [{ id: 'a', kwh: 1.1 }, { id: 'b', kwh: 0 }]).innen.map(i => i.anteil)).to.deep.equal([0.917, 0]);
        expect(v.aufteilung(null, [{ id: 'a', kwh: 1 }, { id: 'b', kwh: 3 }])).to.deep.include({ aussen: null, rest: 0, summeInnen: 4 });
        expect(v.aufteilung(0, [{ id: 'a', kwh: null }]).innen[0].anteil).to.equal(null);
    });

    it('Diagramm: höchste Reihe der Module als Außengerät, Rest je Abschnitt', () => {
        const aussen = v.hoechste([[1, null, 0.5], [0.9, null, 0.6], null]);
        expect(aussen).to.deep.equal([1, null, 0.6]);
        expect(v.restReihe(aussen, [[0.6, 0.1, 0.4], [0.3, null, 0.3]])).to.deep.equal([0.1, null, 0]);
    });

    it('System-Arbeitszahl: Wärme aller Innengeräte durch den Strom des Außengeräts', () => {
        expect(v.systemCop([2.4, 1.2, null], 0.9)).to.equal(4);
        expect(v.systemCop([0.5], 0.2)).to.equal(null); // zu wenig Strom fuer eine Aussage
        expect(v.systemCop([], 2)).to.equal(null);
    });
});

describe('Multisplit: Verbrauchsansicht', () => {
    const bild = require('../lib/verbrauchbild');
    const jetzt = new Date(2026, 10, 22, 14, 30);
    const tage = kwh => ({ hours: '[]', months: '[]', currentHour: 0, thisMonth: kwh, today: kwh, days: JSON.stringify([{ day: '2026-11-21', kwh: kwh * 2 }]) });
    const geraet = (id, platz, total, heizen) => ({
        id,
        name: id,
        platz,
        leistung: 900,
        arten: { total: tage(total), heating: tage(heizen), cooling: null },
    });
    const liste = () => [geraet('gast', 0, 2, 1.9), geraet('wz', 1, 5, 2.5), geraet('sz', 2, 5, 1.5), geraet('az', 3, 4.9, 0.6)];
    const aussen = [{ id: 'a1', name: 'Garten', innen: ['wz', 'sz', 'az'] }];

    it('zugeordnet: Innengeräte stehen zusammen, dahinter der Rest; der Stapel ergibt das Außengerät einmal', () => {
        const r = bild.sammeln(liste(), { zeitraum: 'woche', art: 'alles' }, jetzt, aussen);
        expect(r.geraete.map(g => g.id)).to.deep.equal(['gast', 'wz', 'sz', 'az', 'outdoor:a1']);
        expect(r.aussengeraete).to.deep.equal([{ id: 'a1', name: 'Garten', innen: ['wz', 'sz', 'az'], leistung: 900 }]);
        const rest = r.geraete[4];
        expect(rest).to.deep.include({ rest: true, gruppe: 'a1', aussengeraet: 'cfg:a1', leistung: null });
        const heute = r.schluessel.indexOf(r.laufend);
        expect(rest.werte[heute]).to.equal(0.4); // 5 - (2,5 + 1,5 + 0,6)
        const summeGruppe = r.geraete.filter(g => g.gruppe === 'a1').reduce((s, g) => s + g.werte[heute], 0);
        expect(Math.round(summeGruppe * 100) / 100).to.equal(5);
        expect(r.geraete.every(g => !('aussenWerte' in g))).to.equal(true);
        expect(r.geraete[0].gruppe).to.equal(undefined);
    });

    it('ohne Zuordnung bleibt alles wie bisher; in der Ansicht Heizen gibt es keinen Rest', () => {
        const ohne = bild.sammeln(liste(), { zeitraum: 'woche', art: 'alles' }, jetzt);
        expect(ohne.geraete.map(g => g.id)).to.deep.equal(['gast', 'wz', 'sz', 'az']);
        expect(ohne.aussengeraete).to.deep.equal([]);
        const heizen = bild.sammeln(liste(), { zeitraum: 'woche', art: 'heizen' }, jetzt, aussen);
        expect(heizen.geraete.map(g => g.id)).to.deep.equal(['gast', 'wz', 'sz', 'az']);
        expect(heizen.geraete[1].gruppe).to.equal('a1');
    });

    it('Texte der Ansicht gibt es in allen 11 Sprachen', () => {
        for (const k of ['aussengeraet', 'aussenRest', 'aussenRestTipp', 'aussenTipp']) {
            expect(Object.keys(bild.TEXTE[k])).to.have.length(11);
            expect(Object.values(bild.TEXTE[k]).every(t => typeof t === 'string' && t.length > 1)).to.equal(true);
        }
    });
});

describe('Multisplit am Adapter', () => {
    const { Verbund, NAMEN, FELDER } = require('../lib/verbundlauf');

    function attrappe(config, werte) {
        const a = {
            namespace: 'faikout.0',
            config,
            geraete: new Map([
                ['wz', { name: 'Wohnzimmer', modulId: 'M1', up: true, zaehler: { energy: { letzterWert: 2412300 } } }],
                ['sz', { name: 'Schlafzimmer', modulId: 'M2', up: true, zaehler: { energy: { letzterWert: 2412300 } } }],
                ['gast', { name: 'Gast', modulId: 'M3', up: true, zaehler: { energy: { letzterWert: 815500 } } }],
            ]),
            objekte: new Map(),
            geschrieben: new Map(),
            meldungen: [],
            log: { info: t => a.meldungen.push(t), warn: t => a.meldungen.push(`WARN ${t}`), debug: () => {} },
            getStateAsync: async id => (id in werte ? { val: werte[id] } : null),
            extendObject: async (id, o) => a.objekte.set(id, o),
            wertSchreiben: async (id, val) => a.geschrieben.set(id, val),
            getChannelsOfAsync: async () => [{ _id: 'faikout.0.outdoorUnits.alt', native: { aussengeraet: 'alt' } }],
            delObjectAsync: async id => a.objekte.set(`geloescht:${id}`, true),
        };
        return a;
    }
    const werte = {
        'wz.consumption.total.today': 0.9,
        'sz.consumption.total.today': 0.9,
        'wz.consumption.total.thisMonth': 6.3,
        'sz.consumption.total.thisMonth': 6.3,
        'wz.consumption.heating.today': 0.6,
        'sz.consumption.heating.today': 0.2,
        'wz.consumption.heating.thisMonth': 4,
        'sz.consumption.heating.thisMonth': 2.5,
        'wz.control.power': true,
        'sz.control.power': false,
    };

    it('ohne Zuordnung: keine Datenpunkte, aber EIN Hinweis im Log mit dem Vorschlag', async () => {
        const a = attrappe({}, werte);
        const vb = new Verbund(a);
        await vb.takt();
        await vb.takt();
        expect([...a.geschrieben.keys()]).to.deep.equal([]);
        expect(a.meldungen.filter(m => m.includes('share one outdoor unit'))).to.have.length(1);
        expect(a.meldungen[a.meldungen.length - 1]).to.match(/^Schlafzimmer, Wohnzimmer appear/);
        expect(vb.aussengeraetVon('wz')).to.equal(null);
    });

    it('zugeordnet: Datenpunkte des Außengeräts - Leistung und Energie einmal, Anteile, System-COP; Altes wird gelöscht', async () => {
        const a = attrappe({ aussengeraete: [{ id: 'a1', name: 'Garten', innen: [{ geraet: 'wz' }, { geraet: 'sz' }] }] }, werte);
        a.effizienz = {
            zustand: new Map([
                ['wz', { werte: { waerme: { today: 2.4 }, stromHeizen: { today: 0.6 } } }],
                ['sz', { werte: { waerme: { today: 0.9 }, stromHeizen: { today: 0.2 } } }],
            ]),
        };
        const vb = new Verbund(a);
        const jetzt = 1e12;
        vb.melden('wz', { consumption: 200, comp: 40, outside: 7 }, jetzt - 20000);
        vb.melden('sz', { consumption: 210, comp: 40, outside: 7 }, jetzt - 5000);
        await vb.takt(jetzt);
        const g = k => a.geschrieben.get(`outdoorUnits.a1.${k}`);
        expect(g('power')).to.equal(210);
        expect(g('energyToday')).to.equal(0.9);
        expect(g('energyThisMonth')).to.equal(6.3);
        expect(g('otherToday')).to.equal(0.1);
        expect(g('copToday')).to.equal(3.7); // (2,4 + 0,9) / (0,8 Strom der Innengeraete x 0,9/0,8 Rest)
        expect(g('indoorUnits')).to.equal('Wohnzimmer, Schlafzimmer');
        expect(JSON.parse(g('sharesJson'))).to.deep.equal([
            { id: 'wz', name: 'Wohnzimmer', today: 0.6, share: 0.667 },
            { id: 'sz', name: 'Schlafzimmer', today: 0.2, share: 0.222 },
        ]);
        expect(a.objekte.get('outdoorUnits.a1').common.name).to.equal('Garten');
        expect(a.objekte.get('outdoorUnits.a1').type).to.equal('channel');
        expect(a.objekte.has('geloescht:outdoorUnits.alt')).to.equal(true);
        expect(a.meldungen.filter(m => m.includes('appear to share'))).to.deep.equal([]);
        expect(vb.aussengeraetVon('sz')).to.equal('a1');
        for (const f of FELDER) {
            expect(Object.keys(NAMEN[f.id]), f.id).to.have.length(11);
        }
    });

    it('verbundStand: rechnet mit dem ungespeicherten Formular, liefert Geräte, Gruppen mit Prüfung und Vorschläge', async () => {
        const a = attrappe({}, werte);
        const vb = new Verbund(a);
        const leer = await vb.befehl({});
        expect(leer.geraete.map(g => g.name)).to.deep.equal(['Gast', 'Schlafzimmer', 'Wohnzimmer']);
        expect(leer.geraete[2]).to.deep.include({ id: 'wz', heute: 0.6, laeuft: true, zaehler: true });
        expect(leer.gruppen).to.deep.equal([]);
        expect(leer.vorschlaege).to.have.length(1);
        const r = await vb.befehl({ aussengeraete: [{ id: 'a1', name: '', innen: [{ geraet: 'wz' }, { geraet: 'sz' }, { geraet: 'weg' }] }] });
        expect(r.vorschlaege).to.deep.equal([]);
        expect(r.gruppen[0]).to.deep.include({ id: 'a1', pruefung: 'bestaetigt', heute: 0.9, rest: 0.1 });
        expect(r.gruppen[0].innen.map(i => i.fehlt)).to.deep.equal([false, false, true]);
        expect(r.gruppen[0].anteile.wz).to.deep.equal({ heute: 0.6, anteil: 0.667 });
        expect(r.konfig[0].innen[0]).to.deep.equal({ geraet: 'wz', modulId: 'M1' });
        // Leistungsgrenze der Gruppenregelung: nur fuer die gespeicherte Gruppe, nicht fuer eine neue mit derselben Kennung
        werte['outdoorUnits.a1.demand'] = 60;
        werte['outdoorUnits.a1.leader'] = 'Wohnzimmer';
        a.config.aussengeraete = [{ id: 'a1', innen: ['wz', 'sz'] }];
        expect((await vb.befehl({})).gruppen[0]).to.deep.include({ grenze: 60, leitgeraet: 'Wohnzimmer' });
        expect((await vb.befehl({ aussengeraete: [{ id: 'a1', innen: ['wz', 'gast'] }] })).gruppen[0]).to.deep.include({ grenze: null, leitgeraet: null });
        a.config.aussengeraete = [];
        const falsch = await vb.befehl({ aussengeraete: [{ id: 'a1', innen: ['wz', 'gast'] }], abgelehnt: ['sz|wz'] });
        expect(falsch.gruppen[0].pruefung).to.equal('widerspricht');
    });
});

describe('Simulator: Multisplit', () => {
    const { Welt } = require('./simwelt/welt');

    it('ein Außengerät, drei Innengeräte: energy, consumption, comp und outside gleich; energyheat je Innengerät', () => {
        const w = new Welt({
            szenario: 'heizenKalterTag',
            praefix: '',
            senden: () => {},
            module: [
                { typ: 's21', name: 'Wohnen', aussengeraet: 'A', zaehler: { heizen: 1120000, kuehlen: 150000, aussen: 2412300 } },
                { typ: 's21', name: 'Schlafen', aussengeraet: 'A', zaehler: { heizen: 640000, kuehlen: 60000 }, anlage: { power: false } },
                { typ: 's21', name: 'Arbeiten', aussengeraet: 'A', zaehler: { heizen: 380000, kuehlen: 20000 } },
                { typ: 's21', name: 'Gast', zaehler: { heizen: 700000, kuehlen: 100000, aussen: 815500 } },
            ],
        });
        w.verbinden();
        for (let i = 0; i < 2400; i++) {
            w.sekunde();
        }
        const [wo, sl, ar, gast] = w.module.map(m => m.physik.messwerte());
        for (const feld of ['Whoutside', 'consumption', 'comp', 'outside']) {
            expect([sl[feld], ar[feld]], feld).to.deep.equal([wo[feld], wo[feld]]);
        }
        expect(wo.Whoutside).to.be.above(2412300);
        expect(wo.Whheating).to.be.above(1120000);
        expect(sl.Whheating).to.equal(640000); // ausgeschaltet: sein Zaehler steht
        expect(ar.Whheating).to.be.above(380000);
        expect(wo.consumption).to.be.above(gast.consumption); // zwei laufende Innengeraete
        expect(gast.Whoutside).to.be.within(815500, 2000000);
        // die Kernlogik erkennt daraus genau die eine Gruppe
        const r = v.vorschlaege({ zaehler: new Map(w.module.map((m, i) => [m.name, [wo, sl, ar, gast][i].Whoutside])) });
        expect(r.map(x => x.ids)).to.deep.equal([['Arbeiten', 'Schlafen', 'Wohnen']]);
    });
});

describe('Multisplit: automatisch zuordnen', () => {
    const MIN = 60000;
    /** n Minuten beobachten; staende(m) liefert {id: [wh, online?, alterMin?]} */
    function beobachte(n, staende, paare = new Map(), ab = 0) {
        for (let m = ab; m < ab + n; m++) {
            const jetzt = 1e12 + m * MIN;
            const z = new Map(Object.entries(staende(m)).map(([id, [wh, online = true, alt = 0]]) => [id, { wh, online, zeit: jetzt - alt * MIN }]));
            v.paarMerken(paare, z, jetzt);
        }
        return paare;
    }

    it('zwei getrennte Multisplit-Anlagen und eine einzelne: zwei Gruppen, die einzelne bleibt frei', () => {
        const paare = beobachte(12, m => ({
            wz: [2412300 + 100 * Math.floor(m / 4)],
            sz: [2412300 + 100 * Math.floor((m + 1) / 4)], // meldet zeitversetzt: zeitweise eine Stufe voraus
            az: [2412300 + 100 * Math.floor(m / 4)],
            bad: [640000],
            flur: [640100],
            gast: [815500],
        }));
        const r = v.automatisch({ paare });
        expect(r.gruppen.map(g => g.ids)).to.deep.equal([['az', 'sz', 'wz'], ['bad', 'flur']]);
        expect(r.gruppen[0]).to.deep.include({ gruppe: null, gewandert: true });
        expect(r.gruppen[1].gewandert).to.equal(false);
        expect(r.wartend).to.deep.equal([]);
    });

    it('ein Schnappschuss genügt nie: erst nach zehn Minuten gleicher Zähler', () => {
        const paare = beobachte(4, () => ({ wz: [50000], sz: [50000] }));
        let r = v.automatisch({ paare });
        expect(r.gruppen).to.deep.equal([]);
        expect(r.wartend).to.deep.equal([{ ids: ['sz', 'wz'], minuten: 4 }]);
        expect(r.noetig).to.equal(v.AUTO_MINUTEN);
        beobachte(6, () => ({ wz: [50000], sz: [50100] }), paare, 4);
        r = v.automatisch({ paare });
        expect(r.gruppen.map(g => g.ids)).to.deep.equal([['sz', 'wz']]);
    });

    it('laufen die Zähler auseinander (zufällig gleich gewesen), ist das Paar endgültig raus', () => {
        const paare = beobachte(15, m => ({ wz: [50000 + 100 * m], sz: [50000] }));
        expect(v.paarUrteil(paare.get('sz|wz'))).to.include({ gleich: false, sicher: false });
        expect(v.automatisch({ paare })).to.deep.include({ gruppen: [], wartend: [] });
    });

    it('zählt nicht: Zähler unter 10 kWh, Modul offline, alter Wert eines stummen Moduls', () => {
        const paare = beobachte(15, () => ({
            neu1: [3000],
            neu2: [3000],
            a: [70000],
            weg: [70000, false],
            alt: [70000, true, 30],
        }));
        expect([...paare.keys()]).to.deep.equal([]);
        expect(v.automatisch({ paare }).gruppen).to.deep.equal([]);
    });

    it('bestehende Zuordnungen bleiben: freies Gerät kommt dazu, fertige Gruppen und Widersprüche werden nicht angefasst', () => {
        const paare = beobachte(12, () => ({ wz: [50000], sz: [50000], az: [50000], x: [90000], y: [90000], p: [70000], q: [70000] }));
        const r = v.automatisch({
            paare,
            vonGeraet: new Map([['wz', 'a1'], ['sz', 'a1'], ['x', 'a2'], ['y', 'a2'], ['p', 'a3'], ['q', 'a4']]),
        });
        expect(r.gruppen).to.deep.equal([{ ids: ['az', 'sz', 'wz'], neu: ['az'], gruppe: 'a1', gewandert: false }]);
    });

    it('Einstufung: sicher nur mit bestätigtem Zähler, sonst "wird noch geprüft"; Verdichter-Gleichlauf bleibt unsicher', () => {
        const zaehler = new Map([['wz', 50000], ['sz', 50000], ['x', 300], ['y', 300]]);
        const lauf = m => ({ comp: 30 + (m % 7) * 4, outside: 6.5 });
        const vl = verlauf(verlauf(new Map(), 'x', lauf), 'y', lauf);
        const liste = v.vorschlaege({ zaehler, verlauf: vl });
        const kurz = v.einstufen(liste, v.automatisch({ paare: beobachte(4, () => ({ wz: [50000], sz: [50000] })) }));
        expect(kurz.map(e => [e.ids.join('+'), e.stufe, e.minuten])).to.deep.equal([['sz+wz', 'pruefung', 4], ['x+y', 'unsicher', 0]]);
        const lang = v.einstufen(liste, v.automatisch({ paare: beobachte(12, () => ({ wz: [50000], sz: [50000] })) }));
        expect(lang.map(e => e.stufe)).to.deep.equal(['sicher', 'unsicher']);
    });

    it('am Adapter: Meldungen und Takt füllen die Beobachtung, verbundStand liefert das Ergebnis', async () => {
        const { Verbund } = require('../lib/verbundlauf');
        const a = {
            config: {},
            geraete: new Map([
                ['wz', { name: 'Wohnzimmer', up: true, zaehler: {} }],
                ['sz', { name: 'Schlafzimmer', up: true, zaehler: {} }],
                ['gast', { name: 'Gast', up: true, zaehler: {} }],
            ]),
            log: { info: () => {}, warn: () => {}, debug: () => {} },
            getStateAsync: async () => null,
        };
        const vb = new Verbund(a);
        for (let m = 0; m < 11; m++) {
            const jetzt = 1e12 + m * MIN;
            vb.melden('wz', { energy: 2412300 }, jetzt - 20000);
            vb.melden('sz', { energy: 2412300 }, jetzt - 5000);
            vb.melden('gast', { energy: 815500 }, jetzt - 1000);
            vb.beobachten(jetzt);
        }
        // der Schnappschuss-Vorschlag braucht den gemerkten Zaehlerstand der Geraete
        a.geraete.get('wz').zaehler = { energy: { letzterWert: 2412300 } };
        a.geraete.get('sz').zaehler = { energy: { letzterWert: 2412300 } };
        const frueh = new Verbund(a);
        expect((await frueh.befehl({})).vorschlaege[0]).to.deep.include({ stufe: 'pruefung', minuten: 0, noetig: v.AUTO_MINUTEN });
        const r = await vb.befehl({}, 1e12 + 10 * MIN);
        expect(r.vorschlaege).to.have.length(1);
        expect(r.vorschlaege[0]).to.deep.include({ ids: ['sz', 'wz'], stufe: 'sicher', art: 'neu' });
        vb.vergessen('sz');
        expect(vb.paare.size).to.equal(1); // nur noch gast|wz
    });
});
