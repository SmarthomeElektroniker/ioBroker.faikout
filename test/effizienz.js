'use strict';

const { expect } = require('chai');
const luft = require('../lib/effizienz/luft');
const luftstrom = require('../lib/effizienz/luftstrom');
const wirksamkeit = require('../lib/effizienz/wirksamkeit');
const rechnen = require('../lib/effizienz/rechnen');
const zaehler = require('../lib/effizienz/zaehler');
const kalibrierung = require('../lib/effizienz/kalibrierung');
const tabelle = require('./fixtures/fvxm35a_leistung.json');

/** FVXM35A laut Daikin-Produkttabelle (m³/min). */
const FVXM35A = {
    modell: 'FVXM35A',
    luftstromHeizen: { SL: 4.1, L: 5.6, M: 7.2, H: 9.8 },
    luftstromKuehlen: { SL: 4.1, L: 4.9, M: 7.0, H: 9.2 },
    bypassfaktor: 0.11,
    bypassLuftstrom: 9.2,
};

/** Konfiguration, wie sie die Laufzeit aus Modell und Vorgaben bildet. */
function konfig(modell = FVXM35A, mehr = {}) {
    const heizen = luftstrom.kennlinie(modell && modell.luftstromHeizen, null, 'heizen');
    const kuehlen = luftstrom.kennlinie(modell && modell.luftstromKuehlen, null, 'kuehlen');
    const eps = art => ({ ...wirksamkeit.vorgabe(modell, (art === 'heizen' ? heizen : kuehlen).werte), guete: 'estimated' });
    return { heizen, kuehlen, eps: { heizen: eps('heizen'), kuehlen: eps('kuehlen') }, drehzahlen: {}, ...mehr };
}

describe('Effizienz: Luft', () => {
    it('Dichte trockener Luft bei 20 °C etwa 1,204 kg/m³, kalte Luft ist dichter', () => {
        expect(luft.dichte(20)).to.be.closeTo(1.204, 0.002);
        expect(luft.dichte(0)).to.be.greaterThan(luft.dichte(30));
    });

    it('fühlbarer Wärmestrom: 0,1 m³/s um 10 K erwärmt sind rund 1,2 kW', () => {
        expect(luft.fuehlbar(0.1, 20, 30)).to.be.closeTo(1211, 5);
        expect(luft.fuehlbar(0.1, 26, 14)).to.be.lessThan(0);
    });

    it('latent: nur wenn am Austritt weniger Wasser in der Luft ist', () => {
        // 26 °C / 60 % -> 14 °C / 90 %: 12,7 g/kg -> 9,0 g/kg
        const w = luft.latent(0.15, 26, 60, 14, 90);
        expect(w).to.be.within(1300, 2000);
        expect(luft.latent(0.15, 26, 30, 14, 90), 'trockene Luft: nichts faellt aus').to.equal(0);
    });
});

describe('Effizienz: Luftstrom', () => {
    it('ordnet die Werte von control.fan den Stufen zu, Auto hat keine', () => {
        expect(luftstrom.stufeVon('night')).to.equal('SL');
        expect(luftstrom.stufeVon('mediumHigh')).to.equal('MH');
        expect(luftstrom.stufeVon('auto')).to.equal(null);
    });

    it('Kennlinie: Datenblattstufen bleiben, Zwischenstufen werden interpoliert und gekennzeichnet', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        expect(k.werte).to.deep.include({ SL: 4.1, L: 5.6, M: 7.2, H: 9.8 });
        expect(k.werte.MH).to.equal(8.5);
        expect(k.werte.ML).to.equal(6.4);
        expect(k.herkunft).to.deep.include({ H: 'datenblatt', MH: 'interpoliert', ML: 'interpoliert' });
        expect(k.generisch).to.equal(false);
    });

    it('Kennlinie ohne Modell ist generisch, eigene Werte gehen vor', () => {
        const k = luftstrom.kennlinie(null, { H: 11 }, 'heizen');
        expect(k.generisch).to.equal(true);
        expect(k.herkunft.M).to.equal('generisch');
        expect(k.werte.H).to.equal(11);
        expect(k.herkunft.H).to.equal('eigen');
    });

    it('Kennlinie nur mit Hoch und Niedrig (Kanalgerät): Mitte und Leise gekennzeichnet ergänzt', () => {
        const k = luftstrom.kennlinie({ L: 6, H: 10 }, null, 'heizen');
        expect(k.werte.M).to.equal(8);
        expect(k.herkunft.M).to.equal('interpoliert');
        expect(k.werte.SL).to.equal(6);
        expect(k.herkunft.SL).to.equal('interpoliert');
    });

    it('feste Stufe ohne gelernte Drehzahl: Wert der Kennlinie', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        const r = luftstrom.bestimmen({ fan: 'mediumHigh', rpm: 750, werte: k.werte });
        expect(r).to.deep.include({ m3min: 8.5, stufe: 'MH', quelle: 'stufe' });
    });

    it('lernt die Drehzahl je Stufe (Median) und rechnet danach über die Drehzahl - auch bei Auto', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        let d = {};
        for (let i = 0; i < 6; i++) {
            d = luftstrom.lernen(d, 'MH', 750 + (i % 2) * 10);
            d = luftstrom.lernen(d, 'L', 500);
        }
        d = luftstrom.lernen(d, 'MH', 300); // ein Ausreisser (Anlauf) verschiebt den Median nicht
        expect(luftstrom.gelernt(d).MH).to.be.within(750, 760);
        const auto = luftstrom.bestimmen({ fan: 'auto', rpm: 500, werte: k.werte, drehzahlen: d });
        expect(auto.quelle).to.equal('drehzahl');
        expect(auto.m3min).to.be.closeTo(5.6, 0.01);
        expect(auto.stufe).to.equal('L');
        // zwischen zwei gelernten Punkten linear, unter dem niedrigsten durch den Ursprung
        expect(luftstrom.bestimmen({ fan: 'auto', rpm: 250, werte: k.werte, drehzahlen: d }).m3min).to.be.closeTo(2.8, 0.01);
        expect(luftstrom.bestimmen({ fan: 'auto', rpm: 625, werte: k.werte, drehzahlen: d }).m3min).to.be.within(6.9, 7.2);
        // ueber dem hoechsten proportional
        expect(luftstrom.bestimmen({ fan: 'high', rpm: 900, werte: k.werte, drehzahlen: d }).m3min).to.be.within(10, 10.3);
    });

    it('Lüfter steht: Luftstrom 0', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        expect(luftstrom.bestimmen({ fan: 'mediumHigh', rpm: 0, werte: k.werte })).to.deep.include({ m3min: 0, quelle: 'steht' });
    });

    it('Auto ohne gelernte Drehzahl: Mitte der Kennlinie mit großer Unsicherheit', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        const r = luftstrom.bestimmen({ fan: 'auto', rpm: 640, werte: k.werte });
        expect(r.quelle).to.equal('mitte');
        expect(r.m3min).to.equal(7.2);
        expect(r.unsicherheit).to.be.at.least(0.2);
    });
});

describe('Effizienz: Wirksamkeit (Vorabschätzung)', () => {
    it('FVXM35A: aus dem Bypassfaktor 0,11 bei 9,2 m³/min folgt ε 0,89 bei Hoch und rund 0,95 bei Leise', () => {
        const k = luftstrom.kennlinie(FVXM35A.luftstromKuehlen, null, 'kuehlen');
        const v = wirksamkeit.vorgabe(FVXM35A, k.werte);
        expect(v.stufen.H.eps).to.be.closeTo(0.89, 0.001);
        expect(v.stufen.SL.eps).to.be.within(0.94, 0.96);
        expect(v.stufen.H.herkunft).to.equal('datenblatt');
        expect(v.unsicherheit).to.equal(0.25);
        // ueber alle Stufen nur wenige Prozent Unterschied - deshalb darf zusammengefasst werden
        const werte = Object.values(v.stufen).map(s => s.eps);
        expect((Math.max(...werte) - Math.min(...werte)) / Math.min(...werte)).to.be.lessThan(0.08);
    });

    it('ohne Modell: generischer Bypassfaktor, als generisch gekennzeichnet, größere Unsicherheit', () => {
        const k = luftstrom.kennlinie(null, null, 'heizen');
        const v = wirksamkeit.vorgabe(null, k.werte);
        expect(v.generisch).to.equal(true);
        expect(v.stufen.M.herkunft).to.equal('generisch');
        expect(v.unsicherheit).to.equal(0.3);
    });

    it('Gegenprobe mit der Leistungstabelle: Nennpunkt Heizen (20/7 °C, 4,50 kW bei 9,8 m³/min) verlangt eine plausible Registertemperatur', () => {
        const zeile = tabelle.heizenNenn.zeilen.find(z => z.edb === 20);
        const tc = zeile.tc[tabelle.heizenNenn.aussenWB.indexOf(7)];
        expect(tc).to.equal(4.5);
        const dT = (tc * 1000) / (luft.dichte(20) * luft.CP_LUFT * (tabelle.luftstromHeizen / 60));
        expect(dT, 'Lufterwaermung am Nennpunkt').to.be.within(21, 24);
        const k = luftstrom.kennlinie(FVXM35A.luftstromHeizen, null, 'heizen');
        const eps = wirksamkeit.vorgabe(FVXM35A, k.werte).stufen.H.eps;
        // T_ref, bei dem die Schaetzung die Tabellenleistung trifft - muss im Bereich ueblicher Kondensation liegen
        expect(20 + dT / eps).to.be.within(40, 50);
    });

    it('Gegenprobe Kühlen: fühlbare Leistung 2,45 kW bei 27/19 °C innen, 35 °C außen ergibt eine Registertemperatur um 12 °C', () => {
        const zeile = tabelle.kuehlen.zeilen.find(z => z.edb === 27);
        const shc = zeile.shc[tabelle.kuehlen.aussen.indexOf(35)];
        const dT = (shc * 1000) / (luft.dichte(27) * luft.CP_LUFT * (tabelle.luftstromKuehlen / 60));
        expect(27 - dT / (1 - tabelle.bypassfaktor)).to.be.within(10, 14);
    });

    it('ε zwischen den Stufen über den Luftstrom interpoliert', () => {
        const stufen = { L: { eps: 1.0 }, H: { eps: 0.8 } };
        const werte = { L: 5, H: 10 };
        expect(wirksamkeit.fuer(stufen, werte, null, 7.5)).to.be.closeTo(0.9, 1e-9);
        expect(wirksamkeit.fuer(stufen, werte, 'H', 7.5)).to.equal(0.8);
        expect(wirksamkeit.fuer(stufen, werte, 'H', 7.5, true)).to.be.closeTo(0.9, 1e-9);
        expect(wirksamkeit.fuer(stufen, werte, null, 3)).to.equal(1.0);
        expect(wirksamkeit.fuer({}, werte, null, 3)).to.equal(null);
    });
});

describe('Effizienz: Schätzung', () => {
    const k = konfig();
    const basis = { power: true, mode: 'heat', fan: 'mediumHigh', rpm: 220, comp: 2400, tEin: 23, tRef: 31, pEl: 500 };

    it('Heizen im Dauerbetrieb: Leistung, Austrittstemperatur, COP und Güte "geschätzt"', () => {
        const r = rechnen.schaetzen(basis, k);
        expect(r.art).to.equal('heizen');
        // 8,5 m³/min, ε 0,90, 8 K -> etwa 1,2 kW
        expect(r.leistungW).to.be.within(1150, 1300);
        expect(r.tAus).to.be.within(30, 30.5);
        expect(r.cop).to.be.within(2.2, 2.7);
        expect(r.luftstromM3h).to.equal(510);
        expect(r.stufe).to.equal('MH');
        expect(r.guete).to.equal('estimated');
        expect(r.unsicherheit, 'ohne Kalibrierung grob 25-30 %').to.be.within(24, 32);
        expect(r.unsicher).to.eql([]);
    });

    it('die Handmessung vom 21.11.2026 (Lüfter 0, liquid 6,5 °C bei 23 °C Raum) ist Abtauen: Leistung 0, Kennzeichen gesetzt', () => {
        const r = rechnen.schaetzen({ ...basis, rpm: 0, comp: 3960, tRef: 6.5 }, k);
        expect(r.art).to.equal('abtauen');
        expect(r.abtauen).to.equal(true);
        expect(r.leistungW).to.equal(0);
        expect(r.cop).to.equal(null);
    });

    it('gemeldetes Abtauen (status.action) zählt auch ohne kaltes Register', () => {
        expect(rechnen.schaetzen({ ...basis, action: 'defrosting' }, k).art).to.equal('abtauen');
    });

    it('Verdichter steht: Stillstand mit Leistung 0; Anlage aus: aus', () => {
        expect(rechnen.schaetzen({ ...basis, comp: 0 }, k)).to.deep.include({ art: 'stillstand', leistungW: 0 });
        expect(rechnen.schaetzen({ ...basis, power: false }, k)).to.deep.include({ art: 'aus', leistungW: 0 });
        expect(rechnen.schaetzen({ ...basis, mode: 'fan_only' }, k)).to.deep.include({ art: 'aus', leistungW: 0 });
    });

    it('Anlauf nach dem Abtauen (Lüfter steht, Register schon warm): kein Luftstrom, keine Leistung', () => {
        const r = rechnen.schaetzen({ ...basis, rpm: 0, tRef: 35 }, k);
        expect(r.art).to.equal('heizen');
        expect(r.leistungW).to.equal(0);
    });

    it('kleine Last und Takten werden als unsicher gekennzeichnet, die Unsicherheit wächst', () => {
        const klein = rechnen.schaetzen({ ...basis, tRef: 25 }, k);
        expect(klein.unsicher).to.include('kleineLast');
        expect(klein.unsicherheit).to.be.greaterThan(35);
        const anlauf = rechnen.schaetzen({ ...basis, seitStart: 60 }, k);
        expect(anlauf.unsicher).to.include('anlauf');
        expect(anlauf.unsicherheit).to.be.greaterThan(rechnen.schaetzen(basis, k).unsicherheit);
    });

    it('fehlende Datenpunkte: nicht verfügbar, mit Liste - nichts wird geraten', () => {
        const r = rechnen.schaetzen({ power: true, mode: 'heat', pEl: 300 }, k);
        expect(r.art).to.equal('nichtVerfuegbar');
        expect(r.leistungW).to.equal(null);
        expect(r.guete).to.equal('unavailable');
        expect(r.fehlt).to.eql(['achome', 'liquid', 'fanfreq']);
    });

    it('ε wird nicht begrenzt: ein kalibrierter Wert über 1 gilt', () => {
        const kal = { ...k, eps: { ...k.eps, heizen: { stufen: { MH: { eps: 1.2 } }, unsicherheit: 0.06, guete: 'calibrated' } } };
        const r = rechnen.schaetzen(basis, kal);
        expect(r.tAus).to.be.closeTo(32.6, 0.05);
        expect(r.guete).to.equal('calibrated');
        expect(r.unsicherheit, 'kalibriert grob 10-15 %').to.be.within(10, 16);
    });

    it('Kühlen ohne Feuchtesensor: nur fühlbare Kälte, so gekennzeichnet; mit Feuchte am Ein- und Austritt kommt die latente dazu', () => {
        const kalt = { power: true, mode: 'cool', fan: 'high', rpm: 300, comp: 2000, tEin: 27, tRef: 12, pEl: 800 };
        const ohne = rechnen.schaetzen(kalt, k);
        expect(ohne.art).to.equal('kuehlen');
        expect(ohne.nurFuehlbar).to.equal(true);
        expect(ohne.latentW).to.equal(null);
        // Tabelle: 2,45 kW fuehlbar bei 27/19 innen, 35 aussen (Nennfrequenz)
        expect(ohne.leistungW).to.be.within(2100, 2800);
        const mit = rechnen.schaetzen({ ...kalt, rfEin: 60, rfAus: 92 }, k);
        expect(mit.nurFuehlbar).to.equal(false);
        expect(mit.latentW).to.be.greaterThan(300);
        expect(mit.leistungW).to.equal(ohne.leistungW + mit.latentW);
    });

    it('Kühlen mit warmem Register: die Anlage kühlt gerade nicht', () => {
        expect(rechnen.schaetzen({ power: true, mode: 'cool', fan: 'high', comp: 900, tEin: 24, tRef: 26, pEl: 100 }, k).art).to.equal('stillstand');
    });

    it('Automatik: die Richtung folgt dem Register', () => {
        expect(rechnen.richtung({ power: true, mode: 'heat_cool', tEin: 22, tRef: 35 })).to.equal('heizen');
        expect(rechnen.richtung({ power: true, mode: 'heat_cool', tEin: 26, tRef: 12 })).to.equal('kuehlen');
    });

    it('gemessene Austrittstemperatur geht vor: Güte "gemessen", ε spielt keine Rolle', () => {
        const r = rechnen.schaetzen({ ...basis, tAus: 33 }, k);
        expect(r.guete).to.equal('measured');
        expect(r.tAus).to.equal(33);
        expect(r.eps).to.equal(null);
        expect(r.unsicherheit).to.be.lessThan(15);
    });

    it('kein COP bei verschwindender elektrischer Leistung', () => {
        expect(rechnen.schaetzen({ ...basis, pEl: 20 }, k).cop).to.equal(null);
        expect(rechnen.schaetzen({ ...basis, pEl: null }, k).cop).to.equal(null);
    });

    it('ohne Modell: generische Kennlinie, größere Unsicherheit als mit Modell', () => {
        const g = rechnen.schaetzen(basis, konfig(null));
        expect(g.leistungW).to.be.greaterThan(800);
        expect(g.unsicherheit).to.be.greaterThan(rechnen.schaetzen(basis, k).unsicherheit);
    });

    it('Glättung: nähert sich mit der Zeitkonstante, springt nach einer langen Lücke', () => {
        expect(rechnen.glaetten(null, 5, 60)).to.equal(5);
        expect(rechnen.glaetten(0, 10, 300, 300)).to.be.closeTo(6.32, 0.01);
        expect(rechnen.glaetten(0, 10, 5000, 300)).to.equal(10);
    });
});

describe('Effizienz: Mengenzähler', () => {
    const t0 = Date.UTC(2026, 10, 22, 10, 0, 0);
    const min = n => t0 + n * 60000;

    it('summiert Wärme und Strom über denselben Zeitraum; COP = Wärme / Strom', () => {
        let s = null;
        for (let i = 0; i <= 60; i++) {
            s = zaehler.probe(s, { zeit: min(i), richtung: 'heizen', leistung: 1500, pEl: 500 }).stand;
        }
        expect(s.waerme).to.be.closeTo(1500, 0.01);
        expect(s.stromHeizen).to.be.closeTo(500, 0.01);
        expect(zaehler.arbeitszahl(s.waerme / 1000, s.stromHeizen / 1000)).to.equal(3);
        expect(s.kaelte).to.equal(0);
    });

    it('nimmt den Energiezähler der Anlage, wenn er da ist (auch in 100-Wh-Schritten)', () => {
        let s = null;
        for (let i = 0; i <= 120; i++) {
            // 600 W: alle 10 min 100 Wh mehr; die gemeldete Leistung waere falsch (0)
            s = zaehler.probe(s, { zeit: min(i), richtung: 'heizen', leistung: 2000, pEl: 0, energie: 5000000 + Math.floor(i / 10) * 100 }).stand;
        }
        expect(s.stromHeizen).to.equal(1200);
        expect(s.waerme).to.be.closeTo(4000, 0.01);
    });

    it('ein zurückgesprungener Energiezähler wird nicht als Verbrauch gebucht', () => {
        let s = zaehler.probe(null, { zeit: min(0), richtung: 'heizen', leistung: 1000, energie: 5000000 }).stand;
        s = zaehler.probe(s, { zeit: min(1), richtung: 'heizen', leistung: 1000, energie: 5000100 }).stand;
        s = zaehler.probe(s, { zeit: min(2), richtung: 'heizen', leistung: 1000, energie: 12 }).stand;
        s = zaehler.probe(s, { zeit: min(3), richtung: 'heizen', leistung: 1000, energie: 112 }).stand;
        expect(s.stromHeizen).to.equal(200);
    });

    it('eine Lücke (Adapter weg) zählt auf beiden Seiten nicht', () => {
        let s = zaehler.probe(null, { zeit: min(0), richtung: 'heizen', leistung: 1000, energie: 1000 }).stand;
        s = zaehler.probe(s, { zeit: min(1), richtung: 'heizen', leistung: 1000, energie: 1100 }).stand;
        const r = zaehler.probe(s, { zeit: min(181), richtung: 'heizen', leistung: 1000, energie: 3100 });
        expect(r.luecke).to.equal(true);
        expect(r.stand.stromHeizen).to.equal(100);
        expect(r.stand.waerme).to.be.closeTo(1000 / 60, 0.01);
        expect(r.stand.luecken).to.equal(1);
    });

    it('Abtauen und Stillstand im Heizbetrieb: keine Wärme, der Strom zählt zum Heizen', () => {
        let s = zaehler.probe(null, { zeit: min(0), richtung: 'heizen', leistung: 0, pEl: 600 }).stand;
        s = zaehler.probe(s, { zeit: min(5), richtung: 'heizen', leistung: 0, pEl: 600 }).stand;
        expect(s.waerme).to.equal(0);
        expect(s.stromHeizen).to.be.closeTo(50, 0.01);
    });

    it('Kühlen zählt getrennt; ausgeschaltet zählt nichts', () => {
        let s = zaehler.probe(null, { zeit: min(0), richtung: 'kuehlen', leistung: 2000, pEl: 500 }).stand;
        s = zaehler.probe(s, { zeit: min(3), richtung: null, leistung: 0, pEl: 3 }).stand;
        s = zaehler.probe(s, { zeit: min(6), richtung: null, leistung: 0, pEl: 3 }).stand;
        // der erste Abschnitt gehoert dem Kuehlen (Anfang), mit dem Mittel aus 2000 und 0
        expect(s.kaelte).to.be.closeTo(50, 0.01);
        expect(s.waerme).to.equal(0);
        expect(s.stromKuehlen).to.be.closeTo(12.575, 0.01);
    });

    it('Arbeitszahl nur bei nennenswerter Strommenge', () => {
        expect(zaehler.arbeitszahl(0.1, 0.01)).to.equal(null);
        expect(zaehler.arbeitszahl(3.8, 1)).to.equal(3.8);
        expect(zaehler.arbeitszahl(null, 1)).to.equal(null);
    });
});

describe('Effizienz: Kalibrierung', () => {
    const k = konfig();
    const vorgaben = k.eps;
    const werte = { heizen: k.heizen.werte, kuehlen: k.kuehlen.werte };

    /** Punkte mit wahrem ε und etwas Streuung (fest, kein Zufall). */
    function punkte(stufe, eps, n, opt = {}) {
        const liste = [];
        for (let i = 0; i < n; i++) {
            const tEin = 21 + (i % 5) * 0.5;
            const tRef = tEin + 8 + (i % 7);
            const streu = 1 + ((i % 5) - 2) * (opt.streuung ?? 0.01);
            liste.push({ art: opt.art || 'heizen', stufe, tEin, tRef, tAus: tEin + eps * streu * (tRef - tEin), aussen: opt.aussen ?? (i % 3) * 4 - 2, comp: 2000, rpm: 500 });
        }
        return liste;
    }

    it('verwirft Abtauen, Stillstand, kleinen Abstand und falsches Vorzeichen', () => {
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 6.5, tAus: 29.9, comp: 3960 }).grund).to.equal('abtauen');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 31, tAus: 30, comp: 0 }).grund).to.equal('steht');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 31, tAus: 30, rpm: 0 }).grund).to.equal('steht');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 25, tAus: 24.5 }).grund).to.equal('kleinerAbstand');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 31, tAus: 22 }).grund).to.equal('vorzeichen');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 31 }).grund).to.equal('unvollstaendig');
        expect(kalibrierung.pruefen({ art: 'heizen', tEin: 23, tRef: 31, tAus: 32 }).ok).to.equal(true);
        expect(kalibrierung.pruefen({ art: 'kuehlen', tEin: 26, tRef: 12, tAus: 15 }).ok).to.equal(true);
    });

    it('die Handmessung vom 21.11.2026 wird als Abtauen verworfen und ergibt keine Kalibrierung', () => {
        const hand = [{ art: 'heizen', stufe: 'MH', tEin: 23, tRef: 6.5, tAus: 29.9, comp: 3960, rpm: 0 }];
        const r = kalibrierung.auswerten(hand, vorgaben, werte);
        expect(r.heizen).to.equal(null);
        expect(r.verworfen).to.eql({ steht: 1 });
    });

    it('je Stufe getrennt, wenn die Stufen sich unterscheiden; fehlende Stufen interpoliert bzw. übertragen und gekennzeichnet', () => {
        const p = [...punkte('L', 1.2, 25), ...punkte('H', 1.0, 25)];
        const r = kalibrierung.auswerten(p, vorgaben, werte).heizen;
        expect(r.zusammengefasst).to.equal(false);
        expect(r.stufen.L).to.deep.include({ herkunft: 'gemessen', n: 25 });
        expect(r.stufen.L.eps).to.be.closeTo(1.2, 0.01);
        expect(r.stufen.H.eps).to.be.closeTo(1.0, 0.01);
        // M liegt zwischen L (5,6) und H (9,8) bei 7,2 m³/min
        expect(r.stufen.M.herkunft).to.equal('interpoliert');
        expect(r.stufen.M.eps).to.be.closeTo(1.2 - (0.2 * (7.2 - 5.6)) / (9.8 - 5.6), 0.01);
        // SL liegt ausserhalb: Wert von L mit dem Verlauf der Datenblatt-Schaetzung
        expect(r.stufen.SL.herkunft).to.equal('uebertragen');
        expect(r.stufen.SL.eps).to.be.closeTo((1.2 * vorgaben.heizen.stufen.SL.eps) / vorgaben.heizen.stufen.L.eps, 0.01);
        expect(r.restfehler).to.be.lessThan(0.03);
        expect(r.unsicherheit, 'Streuung plus Zuschlag fuer nicht gemessene Stufen').to.be.within(0.08, 0.1);
        expect(r.guete).to.equal('calibrated');
    });

    it('fasst zu einem Wert zusammen, wenn ε über die Stufen praktisch gleich ist, und nennt den Unterschied', () => {
        const p = [...punkte('L', 1.1, 25), ...punkte('M', 1.12, 25), ...punkte('H', 1.08, 25)];
        const r = kalibrierung.auswerten(p, vorgaben, werte).heizen;
        expect(r.zusammengefasst).to.equal(true);
        expect(r.unterschied).to.be.lessThan(0.05);
        expect(r.stufen.SL.eps).to.equal(r.stufen.H.eps);
        expect(r.stufen.SL.herkunft).to.equal('zusammengefasst');
        expect(r.stufen.M.herkunft).to.equal('gemessen');
        expect(r.stufen.M.eps).to.be.closeTo(1.1, 0.015);
    });

    it('der Restfehler folgt der Streuung der Messpunkte', () => {
        const ruhig = kalibrierung.auswerten(punkte('M', 1.1, 40, { streuung: 0.01 }), vorgaben, werte).heizen;
        const unruhig = kalibrierung.auswerten(punkte('M', 1.1, 40, { streuung: 0.06 }), vorgaben, werte).heizen;
        expect(unruhig.restfehler).to.be.greaterThan(ruhig.restfehler * 3);
        expect(unruhig.unsicherheit).to.be.greaterThan(ruhig.unsicherheit);
    });

    it('einzelne Handmessungen: Wert wird übernommen, die Unsicherheit bleibt mangels Streuung pauschal', () => {
        const hand = [{ art: 'heizen', stufe: 'MH', tEin: 22, tRef: 34, tAus: 35.2, comp: 2400, rpm: 220 }];
        const r = kalibrierung.auswerten(hand, vorgaben, werte).heizen;
        expect(r.n).to.equal(1);
        expect(r.restfehler).to.equal(null);
        expect(r.stufen.MH.eps).to.be.closeTo(1.1, 0.001);
        expect(r.unsicherheit).to.be.at.least(kalibrierung.UNSICHER_WENIG);
    });

    it('Heizen und Kühlen getrennt', () => {
        const p = [...punkte('M', 1.1, 25), ...punkte('M', 0.8, 25, { art: 'kuehlen' }).map(x => ({ ...x, tRef: x.tEin - 12, tAus: x.tEin - 0.8 * 12 }))];
        const r = kalibrierung.auswerten(p, vorgaben, werte);
        expect(r.heizen.stufen.M.eps).to.be.closeTo(1.1, 0.02);
        expect(r.kuehlen.stufen.M.eps).to.be.closeTo(0.8, 0.001);
    });

    it('Abdeckung: Punkte je Stufe mit Stand, Außentemperaturbereiche und die Stufe, die als nächste gefahren werden sollte', () => {
        const p = [...punkte('M', 1.1, 42), ...punkte('H', 1.1, 8), ...punkte('L', 1.1, 2), { art: 'heizen', stufe: 'M', tEin: 23, tRef: 6, tAus: 20 }];
        const a = kalibrierung.abdeckung(p, 'heizen');
        expect(a.gesamt).to.equal(52);
        expect(a.stufen.M).to.eql({ n: 42, stand: 'ok' });
        expect(a.stufen.H).to.eql({ n: 8, stand: 'knapp' });
        expect(a.stufen.L).to.eql({ n: 2, stand: 'wenig' });
        expect(a.naechste, 'die angefangene Stufe zuerst fertig machen').to.equal('H');
        expect(a.aussen.reduce((s, b) => s + b.n, 0)).to.equal(52);
        expect(a.fertig).to.equal(false);
        expect(kalibrierung.abdeckung([], 'heizen').naechste).to.equal('M');
    });
});
