'use strict';

/**
 * Effizienz gegen den Simulator: Die Physik kennt die WAHRE Waerme an die Raumluft, den wahren Luftstrom und
 * die wahre Austrittsluft. Der Adapter-Kern (lib/effizienz schritt()) bekommt nur, was ein Modul meldet.
 * Geprueft wird, dass die Schaetzung innerhalb der ausgewiesenen Unsicherheit liegt und dass die Kalibrierung
 * mit dem simulierten Austrittssensor den Fehler messbar verkleinert.
 */

const { expect } = require('chai');
const { Physik } = require('./simwelt/physik');
const eff = require('../lib/effizienz');
const kalibrierung = require('../lib/effizienz/kalibrierung');

const FAN_NAMEN = { A: 'auto', 1: 'low', 2: 'lowMedium', 3: 'medium', 4: 'mediumHigh', 5: 'high', Q: 'night' };
const START = Date.UTC(2026, 10, 22, 6, 0, 0);

/**
 * Laesst die Physik laufen und fuettert den Adapter-Kern im Minutentakt.
 *
 * @param {object} o  {physik, stunden, plan(min, physik), z, k, sammeln}
 * @returns {object} Summen: wahr/geschaetzt (Wh), Strom, Abtau-Erkennung, Unsicherheiten, Messpunkte
 */
function lauf(o) {
    const p = o.physik;
    const z = o.z || eff.neuerZustand();
    const sum = { wahr: 0, geschaetzt: 0, strom: 0, abtauWahr: 0, abtauErkannt: 0, abtauFalsch: 0, unsicherheit: [], punkte: [], fehler: [], proben: 0 };
    for (let min = 0; min < o.stunden * 60; min++) {
        if (o.plan) {
            o.plan(min, p);
        }
        p.schritt(60);
        const m = p.messwerte();
        const wahr = p.zustand();
        const jetzt = START + min * 60000;
        const daten = {
            power: p.stell.power,
            mode: p.stell.power ? { H: 'heat', C: 'cool', A: 'heat_cool', D: 'dry' }[p.stell.mode] : 'off',
            fan: FAN_NAMEN[p.stell.fan],
            fanfreq: Math.round((m.fanrpm / 60) * 10) / 10,
            comp: m.comp,
            achome: m.home,
            liquid: m.liquid,
            outside: m.outside,
            consumption: m.consumption,
            energy: m.Whoutside,
        };
        const r = eff.schritt(z, daten, o.k, jetzt, { einheitFan: 'Hz' }).ergebnis;
        const q = Math.abs(wahr.waerme);
        sum.proben++;
        if (wahr.abtauen) {
            sum.abtauWahr++;
            if (r.abtauen) {
                sum.abtauErkannt++;
            }
        } else {
            if (r.abtauen) {
                sum.abtauFalsch++;
            }
            sum.wahr += Math.max(0, p.heizt ? wahr.waerme : -wahr.waerme) / 60;
            sum.geschaetzt += (r.leistungW || 0) / 60;
        }
        sum.strom += wahr.watt / 60;
        // eingeschwungene Punkte: Fehler der Leistung gegen die ausgewiesene Unsicherheit
        if (['heizen', 'kuehlen'].includes(r.art) && r.eingang.seitStart > 600 && q > 300 && !wahr.abtauen && !r.unsicher.length) {
            sum.fehler.push((r.leistungW - q) / q);
            sum.unsicherheit.push(r.unsicherheit / 100);
            if (o.sammeln) {
                sum.punkte.push({ zeit: jetzt, art: r.art, stufe: r.stufe, tEin: m.home, tRef: m.liquid, tAus: m.austritt, aussen: m.outside, rpm: m.fanrpm, comp: m.comp });
            }
        }
    }
    sum.z = z;
    return sum;
}

const physik = (mehr = {}) => {
    const p = new Physik({ seed: 3, startMs: START, raum: 19, aussenMittel: 6, aussenHub: 2, nennLeistung: 1300, ...mehr });
    Object.assign(p.stell, { power: true, mode: 'H', temp: 22, fan: '4' });
    return p;
};
const mittel = l => l.reduce((s, x) => s + x, 0) / l.length;
const rms = l => Math.sqrt(mittel(l.map(x => x * x)));

describe('Effizienz gegen den Simulator', function () {
    this.timeout(60000);
    const k = eff.aufloesen({ geraet: 'sim', modell: 'FVXM35A' }, []);

    it('der Simulator ist in sich stimmig: wahre Wärme = Luftstrom · Dichte · c_p · (Austritt − Ansaug)', () => {
        const p = physik();
        for (let i = 0; i < 90; i++) {
            p.schritt(60);
        }
        const w = p.zustand();
        const rho = 101325 / (287.05 * (p.luft + 273.15));
        expect(w.waerme).to.be.greaterThan(500);
        expect(rho * 1006 * (w.luftstrom / 60) * (w.austritt - p.luft)).to.be.closeTo(w.waerme, 15);
        // liquid passt zur Austrittsluft mit dem wahren ε
        const m = p.messwerte();
        expect((w.austritt - p.luft) / (m.liquid - p.luft)).to.be.closeTo(1.12, 0.03);
    });

    it('Schätzung ohne Kalibrierung trifft die wahre Leistung innerhalb der ausgewiesenen Unsicherheit', () => {
        const s = lauf({ physik: physik(), stunden: 10, k });
        expect(s.fehler.length).to.be.greaterThan(200);
        const fehler = rms(s.fehler);
        const ausgewiesen = mittel(s.unsicherheit);
        // wahres ε 1,12 gegen die Datenblatt-Schaetzung um 0,9: rund 20 % zu wenig
        expect(fehler).to.be.within(0.1, 0.3);
        expect(ausgewiesen).to.be.within(0.25, 0.4);
        expect(fehler, 'Fehler kleiner als die ausgewiesene Unsicherheit').to.be.lessThan(ausgewiesen);
        // Tagesmenge und Arbeitszahl
        expect(Math.abs(s.geschaetzt - s.wahr) / s.wahr).to.be.lessThan(ausgewiesen);
        const copWahr = s.wahr / s.strom;
        expect(copWahr).to.be.within(2, 6);
    });

    it('Kalibrierung mit dem simulierten Austrittssensor verkleinert den Fehler messbar; die neue Unsicherheit deckt ihn', () => {
        const mess = lauf({ physik: physik(), stunden: 10, k, sammeln: true });
        const vorher = rms(mess.fehler);
        const erg = kalibrierung.auswerten(mess.punkte, k.vorgabe, { heizen: k.heizen.werte, kuehlen: k.kuehlen.werte });
        expect(erg.heizen.n).to.be.greaterThan(100);
        expect(erg.heizen.stufen.MH.herkunft).to.equal('gemessen');
        expect(erg.heizen.stufen.MH.eps, 'wahres ε 1,12 (traeger Sensor und Rauschen kosten etwas)').to.be.within(1.05, 1.16);
        expect(erg.heizen.restfehler).to.be.lessThan(0.08);
        // zweiter Lauf (anderer Tag, andere Witterung) mit der Kalibrierung
        const z = eff.neuerZustand();
        z.kalibrierungen = [{ id: 'k1', heizen: erg.heizen, kuehlen: null }];
        z.aktiv = 'k1';
        const danach = lauf({ physik: physik({ seed: 11, aussenMittel: 1 }), stunden: 10, k, z });
        const nachher = rms(danach.fehler);
        expect(nachher, `vorher ${vorher.toFixed(3)}, nachher ${nachher.toFixed(3)}`).to.be.lessThan(vorher / 2);
        expect(nachher).to.be.lessThan(0.1);
        expect(mittel(danach.unsicherheit)).to.be.within(0.1, 0.2);
        expect(nachher).to.be.lessThan(mittel(danach.unsicherheit));
        expect(danach.z.ergebnis.guete).to.equal('calibrated');
        expect(Math.abs(danach.geschaetzt - danach.wahr) / danach.wahr).to.be.lessThan(0.1);
    });

    it('Abtauen wird erkannt und zählt keine Wärme; außerhalb des Abtauens gibt es keinen Fehlalarm', () => {
        const p = physik({ aussenMittel: 0, aussenHub: 1 });
        const s = lauf({
            physik: p,
            stunden: 6,
            k,
            plan: (min, ph) => {
                if (min === 120 || min === 240) {
                    ph.abtauenAusloesen();
                }
            },
        });
        expect(s.abtauWahr).to.be.greaterThan(5);
        expect(s.abtauErkannt / s.abtauWahr).to.be.greaterThan(0.8);
        expect(s.abtauFalsch, 'Nachlauf nach dem Abtauen (Register noch kalt) zaehlt hoechstens kurz').to.be.at.most(4);
    });

    it('unterschiedliche Lüfterstufen: Drehzahlen werden gelernt, Auto rechnet danach über die Drehzahl', () => {
        const z = eff.neuerZustand();
        // je zwei Stunden auf festen Stufen, dann Auto
        const stufen = ['1', '3', '5'];
        const fest = lauf({
            physik: physik(),
            stunden: 6,
            k,
            z,
            plan: (min, ph) => {
                ph.stell.fan = stufen[Math.floor(min / 120)];
            },
        });
        const gelernt = require('../lib/effizienz/luftstrom').gelernt(fest.z.drehzahlen.heizen);
        expect(gelernt.L).to.be.closeTo(600, 6);
        expect(gelernt.M).to.be.closeTo(840, 6);
        expect(gelernt.H).to.be.closeTo(1140, 6);
        const p = physik();
        p.stell.fan = 'A';
        const auto = lauf({ physik: p, stunden: 4, k, z });
        expect(auto.z.ergebnis.luftstromQuelle).to.equal('drehzahl');
        expect(auto.z.ergebnis.unsicher).to.not.include('luefterAuto');
        expect(rms(auto.fehler)).to.be.lessThan(mittel(auto.unsicherheit));
    });

    it('ε je Stufe: unterscheidet der Simulator die Stufen, bleibt die Kalibrierung getrennt - sonst wird zusammengefasst', () => {
        const messen = gefaelle => {
            const stufen = ['1', '3', '5'];
            const s = lauf({
                physik: physik({ epsGefaelle: gefaelle, aussenMittel: 2 }),
                stunden: 9,
                k,
                sammeln: true,
                plan: (min, ph) => {
                    ph.stell.fan = stufen[Math.floor(min / 180)];
                },
            });
            return kalibrierung.auswerten(s.punkte, k.vorgabe, { heizen: k.heizen.werte, kuehlen: k.kuehlen.werte }).heizen;
        };
        const gleich = messen(0);
        expect(gleich.zusammengefasst, `Unterschied ${gleich.unterschied}`).to.equal(true);
        const verschieden = messen(0.4);
        expect(verschieden.zusammengefasst).to.equal(false);
        expect(verschieden.stufen.L.eps).to.be.greaterThan(verschieden.stufen.H.eps * 1.15);
        expect(verschieden.stufen.M.herkunft).to.equal('gemessen');
        expect(verschieden.stufen.MH.herkunft).to.equal('interpoliert');
    });

    it('Mengen: Wärme heute und COP heute aus denselben Zeitabschnitten', () => {
        const s = lauf({ physik: physik(), stunden: 8, k });
        const sum = eff.zusammenfassung(s.z.werte);
        expect(sum.heat.today).to.be.closeTo(s.geschaetzt / 1000, 0.15);
        expect(sum.cop.today).to.be.within(1.5, 6);
        const tage = eff.reihen(s.z.werte, 'days');
        expect(tage[tage.length - 1]).to.have.all.keys('day', 'heat', 'cold', 'elHeat', 'elCool');
        expect(tage[tage.length - 1].heat).to.equal(sum.heat.today);
    });
});
