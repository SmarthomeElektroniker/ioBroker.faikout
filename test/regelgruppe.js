'use strict';

/*
 * Multisplit: EINE Leistungsgrenze je Aussengeraet (lib/regel/gruppe.js + Einbindung in lib/regel/index.js).
 * Nutzerentscheid 22.11.2026: gleicher Wert fuer alle Innengeraete der Gruppe (auch ausgeschaltete) =
 * Maximum der Anforderungen der laufenden Geraete.
 */

const { expect } = require('chai');
const gruppe = require('../lib/regel/gruppe');
const texte = require('../lib/regel/texte');
const zustandSpeicher = require('../lib/regel/zustand');
const verbund = require('../lib/verbund');
const { Anlage, aufbau, warte } = require('./sim/simulator');

/** Mitglied fuer die reinen Tests */
const m = (name, x = {}) => ({
    id: name,
    name,
    bekannt: true,
    online: true,
    aktiv: true,
    faehig: 'yes',
    laeuft: false,
    anforderung: null,
    ist: 100,
    ...x,
});

describe('Multisplit-Gruppe: Rechenkern', () => {
    afterEach(() => texte.setzeSprache('de'));

    it('Gruppenwert = Maximum der laufenden Anforderungen; Leitgeraet ist das mit der hoechsten', () => {
        const g = gruppe.berechnen(
            [
                m('Wohnzimmer', { laeuft: true, anforderung: 65, abweichung: 0.8 }),
                m('Buero', { laeuft: true, anforderung: 45 }),
                m('Gast', { ist: 60 }),
            ],
            null,
        );
        expect(g.art).to.equal('max');
        expect(g.sollwert).to.equal(65);
        expect(g.leader.name).to.equal('Wohnzimmer');
        expect(g.aus.map(x => x.name)).to.eql(['Gast']);
        const satz = gruppe.satz(g, 'Garten', [m('Gast', { ist: 60 })]);
        expect(satz).to.equal(
            'Gruppe „Garten“: 65 % = Maximum aus Wohnzimmer 65, Buero 45; Gast aus – folgt der Gruppe; meldet noch: Gast 60',
        );
    });

    it('"voll" an einem Geraet gilt fuer alle; bei Gleichstand fuehrt der Raum, der weiter zurueckliegt', () => {
        const g = gruppe.berechnen(
            [m('A', { laeuft: true, anforderung: 60 }), m('B', { laeuft: true, anforderung: 100, voll: true })],
            null,
        );
        expect(g.sollwert).to.equal(100);
        expect(g.leader.name).to.equal('B');
        expect(gruppe.satz(g, 'Garten', [])).to.contain('B 100 (voll)');
        const gleich = gruppe.berechnen(
            [
                m('A', { laeuft: true, anforderung: 60, abweichung: 0.4 }),
                m('B', { laeuft: true, anforderung: 60, abweichung: 1.2 }),
            ],
            null,
        );
        expect(gleich.leader.name).to.equal('B');
    });

    it('keins laeuft: einmal 100, danach Ruhe; laeuft wieder eins, endet die Ruhe', () => {
        const g1 = gruppe.berechnen([m('A'), m('B')], null);
        expect(g1.art).to.equal('keinerLaeuft');
        expect(g1.sollwert).to.equal(100);
        const g2 = gruppe.berechnen([m('A'), m('B')], { ...g1.zustand, ruhe: true });
        expect(g2.art).to.equal('ruhe');
        expect(g2.sollwert).to.equal(null);
        const g3 = gruppe.berechnen([m('A', { laeuft: true, anforderung: 50 }), m('B')], g2.zustand);
        expect(g3.sollwert).to.equal(50);
        expect(g3.zustand.ruhe).to.equal(false);
    });

    it('regelt nicht, wenn die Bedarfsregelung an einem Mitglied aus ist oder eines nicht faehig ist', () => {
        const aus = gruppe.berechnen([m('A', { laeuft: true, anforderung: 50 }), m('B', { aktiv: false })], null);
        expect(aus.art).to.equal('nichtAktiv');
        expect(aus.sollwert).to.equal(null);
        const nf = gruppe.berechnen([m('A', { laeuft: true, anforderung: 50 }), m('B', { faehig: 'no' })], null);
        expect(nf.art).to.equal('nichtFaehig');
        expect(nf.faehig).to.equal('no');
        // ein unbekanntes (noch nie gemeldetes) Mitglied haelt die Gruppe nicht an
        const neu = gruppe.berechnen([m('A', { laeuft: true, anforderung: 50 }), m('B', { bekannt: false, aktiv: false })], null);
        expect(neu.sollwert).to.equal(50);
        expect(neu.offline.map(x => x.name)).to.eql(['B']);
    });

    it('Istwert fuer den Schreiber: Richtung stimmt auch bei abweichenden Mitgliedern', () => {
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 60 })])).to.equal(60);
        // eines noch auf 100: Senken (lange Haltezeit)
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 100 })])).to.equal(100);
        // eines mit altem niedrigen Wert: Anheben (kurze Haltezeit)
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 40 })])).to.equal(40);
        // ausgeschaltetes Mitglied hat genau diesen Wert abgelehnt: zaehlt nicht
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 100, abgelehnt: { wert: 60 } })])).to.equal(60);
        // ... laeuft es, zaehlt es wieder
        expect(
            gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 100, laeuft: true, abgelehnt: { wert: 60 } })]),
        ).to.equal(100);
        // ausgeschaltet, meldet nach dem Senden keinen Wert: nicht immer wieder senden
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: undefined, gesendet: { wert: 60 } })])).to.equal(60);
        // offline zaehlt nicht
        expect(gruppe.istwert(60, [m('A', { ist: 60 }), m('B', { ist: 100, online: false })])).to.equal(60);
    });

    it('Texte in allen Sprachen ohne offene Platzhalter (Stichprobe Englisch)', () => {
        texte.setzeSprache('en');
        const g = gruppe.berechnen([m('A', { laeuft: true, anforderung: 55 }), m('B')], null);
        expect(gruppe.satz(g, 'Garden', [])).to.equal('Group “Garden”: 55 % = request of A 55; B off – follows the group');
        for (const s of texte.SPRACHEN) {
            texte.setzeSprache(s);
            const satz = gruppe.satz(
                gruppe.berechnen([m('A', { laeuft: true, anforderung: 55 }), m('B', { online: false })], null),
                'G',
                [],
            );
            expect(satz, s).to.not.match(/\{\w+\}/);
        }
    });

    it('Zustand: die Kopie des Gruppenschreibers uebersteht das Speichern', () => {
        const z = zustandSpeicher.leer();
        z.gruppe = { id: 'a1', schreiber: { wunsch: null, wunschSeit: 0, befehle: [5], virtuell: null, letzter: null }, ruhe: true };
        const l = zustandSpeicher.lesen(zustandSpeicher.schreiben(z));
        expect(l.gruppe.id).to.equal('a1');
        expect(l.gruppe.ruhe).to.equal(true);
        expect(l.gruppe.schreiber.befehle).to.eql([5]);
        expect(zustandSpeicher.lesen(JSON.stringify({ ...z, gruppe: 'unsinn' })).gruppe).to.equal(null);
    });

    it('Zuordnung: eigene Bezugsleistung bleibt beim Saeubern erhalten, ohne Angabe kein Feld', () => {
        const mit = verbund.normalisieren([{ id: 'a1', innen: ['A'], vortagReferenzW: '2500' }]);
        expect(mit[0].vortagReferenzW).to.equal(2500);
        const ohne = verbund.normalisieren([{ id: 'a1', innen: ['A'], vortagReferenzW: 0 }]);
        expect(ohne[0]).to.not.have.property('vortagReferenzW');
        const s = verbund.aufloesen([{ id: 'a1', innen: ['A'], vortagReferenzW: 1800 }], new Map([['A', { name: 'A' }]]));
        expect(s.gruppen[0].vortagReferenzW).to.equal(1800);
        expect(s.konfig[0].vortagReferenzW).to.equal(1800);
    });
});

// ------------------------------------------------------------------ Simulator mit mehreren Innengeraeten

const GARTEN = (namen, x = {}) => ({
    aussengeraete: [{ id: 'a1', name: 'Garten', weitere: 0, innen: namen.map(geraet => ({ geraet })), ...x }],
});

/**
 * Laesst mehrere Anlagen `minuten` lang je Minute melden; Befehle gehen an die jeweilige Anlage.
 *
 * @param {object} a  Adapter
 * @param {{t: number}} uhr  Uhr
 * @param {Anlage[]} anlagen  Anlagen
 * @param {number} minuten  Dauer
 * @param {Function} [jedeMinute]  Eingriff je Minute (i)
 */
async function laufenAlle(a, uhr, anlagen, minuten, jedeMinute) {
    a.beimSenden = (topic, n) => anlagen.forEach(an => an.befehl(topic, n));
    for (let i = 0; i < minuten; i++) {
        if (jedeMinute) {
            jedeMinute(i);
        }
        for (const an of anlagen) {
            if (!an.verbunden) {
                continue;
            }
            a.onMqtt(`state/${an.name}`, Buffer.from(JSON.stringify(an.status())));
            await warte();
            while (an.fehler.length) {
                a.onMqtt(`error/${an.name}/failed-set`, Buffer.from(JSON.stringify(an.fehler.shift())));
                await warte();
            }
        }
        await a.regelung.takt();
        uhr.t += 60000;
    }
}

const demandAn = (a, name) =>
    a.gesendet.filter(g => g.topic === `command/${name}/demand`).map(g => Number(g.nutzlast));

/** Drei Innengeraete: Wohnzimmer etwas zu kalt, Buero warm, Gast aus mit altem Wert 60. */
function dreiGeraete(opt = {}) {
    const wohn = new Anlage({ name: 'Wohnzimmer', outside: 5, temp: 20.2, target: 21 });
    const buero = new Anlage({ name: 'Buero', outside: 5, temp: 21.6, target: 21 });
    const gast = new Anlage({ name: 'Gast', outside: 5, temp: 19, target: 21, power: false, ...opt.gast });
    gast.demand = opt.gastDemand ?? 60;
    return { wohn, buero, gast, alle: [wohn, buero, gast] };
}

/** Eigene Anforderung je Geraet, wie sie ohne Gruppe (Single-Split) heute gesendet wuerde. */
async function einzelwerte(anlagenBauen, minuten = 20) {
    const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false });
    const x = anlagenBauen();
    await laufenAlle(a, uhr, x.alle, minuten);
    const w = {};
    for (const an of x.alle) {
        w[an.name] = a.wert(`${an.name}.regulation.demand.setpoint`);
    }
    return w;
}

describe('Multisplit-Gruppe: Simulator (main.js + mehrere Anlagen)', function () {
    this.timeout(30000);

    it('zwei laufen mit verschiedenen Anforderungen, eins aus mit altem Wert: alle bekommen das Maximum', async () => {
        const einzeln = await einzelwerte(dreiGeraete);
        expect(einzeln.Wohnzimmer).to.be.greaterThan(einzeln.Buero); // die Annahme des Tests
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        await laufenAlle(a, uhr, x.alle, 20);
        const max = einzeln.Wohnzimmer;
        for (const an of x.alle) {
            expect(an.demand, an.name).to.equal(max);
            expect(a.wert(`${an.name}.regulation.demand.setpoint`), an.name).to.equal(max);
        }
        // ein Befehl der Gruppe geht an alle zusammen
        expect(demandAn(a, 'Gast')).to.eql(demandAn(a, 'Wohnzimmer'));
        expect(demandAn(a, 'Buero')).to.eql(demandAn(a, 'Wohnzimmer'));
        expect(a.wert('outdoorUnits.a1.demand')).to.equal(max);
        expect(a.wert('outdoorUnits.a1.leader')).to.equal('Wohnzimmer');
        expect(a.objekte.get('outdoorUnits.a1.demand').common.name.de).to.contain('Gruppe');
        const grund = a.wert('Buero.regulation.demand.reason');
        expect(grund).to.contain(`Gruppe „Garten“: ${max} % = Maximum aus Wohnzimmer ${max}, Buero ${einzeln.Buero}`);
        expect(grund).to.contain('Gast aus – folgt der Gruppe');
        expect(grund).to.contain(`eigene Anforderung ${einzeln.Buero} %`);
        // Rechenweg fuer "So entsteht der Wert gerade": eigener Weg + Gruppe
        const weg = a.regelung.geraete.get('Buero').weg;
        expect(weg.gruppe).to.include({ name: 'Garten', wert: max, leader: 'Wohnzimmer', eigen: einzeln.Buero, laeuft: true });
        expect(weg.sollwert).to.equal(einzeln.Buero);
        expect(a.regelung.geraete.get('Gast').weg.gruppe.laeuft).to.equal(false);
        // Taktgrenze je Gruppe: hoechstens 12 Gruppenbefehle je Stunde
        expect(a.wert('Wohnzimmer.regulation.demand.commandsPerHour')).to.be.at.most(12);
    });

    it('eins verlangt "voll": 100 fuer alle', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        x.wohn.demand = 50;
        x.buero.demand = 50;
        x.wohn.temp = 18; // 3 K hinter dem Ziel
        await laufenAlle(a, uhr, x.alle, 5);
        for (const an of x.alle) {
            expect(an.demand, an.name).to.equal(100);
        }
        expect(a.wert('Buero.regulation.demand.reason')).to.contain('Wohnzimmer 100 (voll)');
    });

    it('keins laeuft: einmal 100 an alle, dann Ruhe - auch wenn ein Modul danach etwas anderes meldet', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        x.wohn.power = false;
        x.buero.power = false;
        x.wohn.demand = 55;
        x.buero.demand = 55;
        await laufenAlle(a, uhr, x.alle, 10);
        for (const an of x.alle) {
            expect(demandAn(a, an.name), an.name).to.eql([100]);
            expect(an.demand).to.equal(100);
        }
        x.buero.demand = 70; // z. B. ueber die Daikin-App gesetzt
        await laufenAlle(a, uhr, x.alle, 15);
        expect(demandAn(a, 'Buero')).to.eql([100]);
        expect(a.wert('outdoorUnits.a1.demandReason')).to.contain('keine weitere Vorgabe');
        // eins laeuft wieder an: die Gruppe regelt wieder
        x.wohn.power = true;
        await laufenAlle(a, uhr, x.alle, 15);
        expect(demandAn(a, 'Buero').length).to.equal(2);
        expect(x.buero.demand).to.equal(x.wohn.demand);
    });

    it('Probelauf: rechnet die Gruppe, sendet nichts', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: true, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        await laufenAlle(a, uhr, x.alle, 20);
        expect(a.gesendet.filter(g => g.topic.endsWith('/demand'))).to.have.length(0);
        const w = JSON.parse(a.wert('Gast.regulation.demand.wouldSend'));
        expect(w.action).to.equal('would');
        expect(w.value).to.equal(a.wert('outdoorUnits.a1.demand'));
        expect(a.wert('Gast.regulation.demand.reason')).to.contain('[Probelauf]');
        expect(a.zeilen.some(z => /Outdoor unit "Garten": demand control \(dry run\) would send/.test(z.text))).to.equal(true);
        // EIN Geraet im Probelauf haelt die ganze Gruppe an
        const teil = aufbau({
            regelAktiv: true,
            regelProbelauf: false,
            regelGeraete: [{ geraet: 'Buero', probelauf: true }],
            ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']),
        });
        await laufenAlle(teil.a, teil.uhr, dreiGeraete().alle, 20);
        expect(teil.a.gesendet.filter(g => g.topic.endsWith('/demand'))).to.have.length(0);
    });

    it('Handeingriff: ein von Hand eingeschaltetes Geraet bringt seine Anforderung ein', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        await laufenAlle(a, uhr, x.alle, 20);
        const vorher = x.wohn.demand;
        expect(vorher).to.be.below(100);
        x.gast.power = true; // Fernbedienung: Gast ein, Raum 2 K zu kalt -> volle Freigabe
        await laufenAlle(a, uhr, x.alle, 4);
        expect(x.wohn.demand).to.equal(100);
        expect(a.wert('outdoorUnits.a1.leader')).to.equal('Gast');
    });

    it('failed-set am ausgeschalteten Geraet: kein "nicht faehig", kein Dauerfeuer, Rest regelt weiter', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete({ gast: { nimmtDemand: 'nurEin' }, gastDemand: 100 });
        await laufenAlle(a, uhr, x.alle, 40);
        const ziel = x.wohn.demand;
        expect(ziel).to.be.below(100);
        expect(x.buero.demand).to.equal(ziel);
        expect(x.gast.demand).to.equal(100); // abgelehnt
        expect(a.wert('Gast.info.demandCapable')).to.not.equal('no');
        // nur einmal je Gruppenwert an das abgelehnte Geraet, nicht alle drei Minuten neu
        const anGast = demandAn(a, 'Gast');
        expect(anGast.filter(w => w === ziel)).to.have.length(1);
        expect(a.wert('outdoorUnits.a1.demandReason')).to.contain('Gast ist aus und lehnt den Wert ab');
        // eingeschaltet uebernimmt es den Wert
        x.gast.power = true;
        x.gast.temp = 20.8;
        await laufenAlle(a, uhr, x.alle, 20);
        expect(x.gast.demand).to.equal(x.wohn.demand);
    });

    it('Strategie "Auto" (Vortag): Zaehler des Aussengeraets und Summe der Bezugsleistungen', async () => {
        const config = { regelAktiv: true, regelProbelauf: false, regelStrategie: 'vortag', regelVortagZuschlag: 0 };
        const { a, uhr } = aufbau({ ...config, ...GARTEN(['Wohnzimmer', 'Buero']) });
        const tag = '2026-11-19';
        // Aussengeraet: Spitze 1,2 kWh in einer Stunde; das zweite Modul hat eine Stunde nicht gemeldet
        const reihe = [
            { hour: `${tag}T06`, kwh: 0.6 },
            { hour: `${tag}T07`, kwh: 1.2 },
        ];
        a.werte.set('Wohnzimmer.consumption.total.hoursJson', { val: JSON.stringify(reihe), ack: true });
        a.werte.set('Buero.consumption.total.hoursJson', { val: JSON.stringify(reihe.slice(0, 1)), ack: true });
        const x = dreiGeraete();
        await laufenAlle(a, uhr, [x.wohn, x.buero], 1);
        expect(a.regelung.gruppenReferenzW(a.regelung.gruppeVon('Wohnzimmer'))).to.equal(2000);
        const v = await a.regelung.gruppenVortag(a.regelung.gruppeVon('Buero'));
        expect(v.spitzeW).to.equal(1200);
        await laufenAlle(a, uhr, [x.wohn, x.buero], 15);
        const weg = a.regelung.geraete.get('Buero').weg;
        expect(weg.strategie).to.equal('vortag');
        expect(weg.vortag.prozent).to.equal(60); // 1200 W von 2000 W
        // eigene Bezugsleistung je Aussengeraet
        const eigen = aufbau({ ...config, ...GARTEN(['Wohnzimmer', 'Buero'], { vortagReferenzW: 3000 }) });
        await laufenAlle(eigen.a, eigen.uhr, dreiGeraete().alle.slice(0, 2), 1);
        expect(eigen.a.regelung.gruppenReferenzW(eigen.a.regelung.gruppeVon('Buero'))).to.equal(3000);
    });

    it('Bedarfsregelung an einem Mitglied aus: die Gruppe sendet nichts und sagt warum', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...GARTEN(['Wohnzimmer', 'Buero', 'Gast']) });
        const x = dreiGeraete();
        await laufenAlle(a, uhr, x.alle, 1);
        await a.regelung.schalter('Gast', 'active', false);
        const vorher = a.gesendet.length;
        await laufenAlle(a, uhr, x.alle, 20);
        expect(a.gesendet.slice(vorher).filter(g => g.topic.endsWith('/demand'))).to.have.length(0);
        expect(a.wert('Wohnzimmer.regulation.demand.reason')).to.contain('Bedarfsregelung an Gast aus');
        expect(a.wert('Wohnzimmer.regulation.demand.state')).to.equal('off');
    });

    it('Single-Split unveraendert: ein Geraet ausserhalb der Gruppe verhaelt sich wie ohne Zuordnung', async () => {
        const lauf = async config => {
            const { a, uhr } = aufbau({ regelAktiv: true, regelProbelauf: false, ...config });
            const x = dreiGeraete();
            x.gast.power = true;
            await laufenAlle(a, uhr, x.alle, 30, i => {
                x.gast.temp = 19 + i / 10;
            });
            return {
                gesendet: demandAn(a, 'Gast'),
                grund: a.wert('Gast.regulation.demand.reason'),
                weg: a.regelung.geraete.get('Gast').weg,
                setpoint: a.wert('Gast.regulation.demand.setpoint'),
            };
        };
        const ohne = await lauf({});
        const mit = await lauf(GARTEN(['Wohnzimmer', 'Buero']));
        expect(mit.gesendet).to.eql(ohne.gesendet);
        expect(mit.grund).to.equal(ohne.grund);
        expect(mit.setpoint).to.equal(ohne.setpoint);
        expect(mit.weg).to.not.have.property('gruppe');
        expect({ ...mit.weg, zeit: 0 }).to.eql({ ...ohne.weg, zeit: 0 });
    });
});
