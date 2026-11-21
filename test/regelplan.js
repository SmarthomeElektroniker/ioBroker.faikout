'use strict';

process.env.TZ = 'Europe/Berlin';

const { expect } = require('chai');
const wochenplan = require('../lib/regel/wochenplan');
const feuchte = require('../lib/regel/feuchte');
const handeingriff = require('../lib/regel/handeingriff');
const quellen = require('../lib/regel/quellen');
const sender = require('../lib/regel/sender');
const koordinator = require('../lib/regel/koordinator');
const bedarf = require('../lib/regel/bedarf');
const zustand = require('../lib/regel/zustand');

const ort = (j, mo, t, h = 0, mi = 0) => new Date(j, mo - 1, t, h, mi).getTime();
const { szenen } = wochenplan.szenenLesen(null);
const plan = wochenplan.vorgabePlan(szenen);

describe('Regelung: Szenen und Wochenplan', () => {
    it('Vorgabe-Szenen; fehlerhafte Szenen werden mit Klartext abgelehnt', () => {
        expect([...szenen.keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
        expect(wochenplan.szenenLesen([{ name: 'A', soll: 45 }]).fehler).to.match(/außerhalb 10\.\.32/);
        expect(wochenplan.szenenLesen([{ name: 'A', soll: 20, deckel: 10 }]).fehler).to.match(/Deckel/);
        expect(
            wochenplan.szenenLesen([
                { name: 'A', soll: 20 },
                { name: 'a', soll: 21 },
            ]).fehler,
        ).to.match(/doppelt/);
        const eigen = wochenplan.szenenLesen([{ name: 'Nacht kühl', soll: 24, mode: 'cool', fan: 'quatsch' }]).szenen;
        expect(eigen.get('nacht_k_hl')).to.include({ mode: 'cool', fan: 'auto', deckel: 100, power: true });
    });

    it('Plan lesen: Sortierung, Dubletten, Fehlertexte', () => {
        const p = wochenplan.planLesen(
            JSON.stringify([
                [
                    { t: 600, s: 'komfort' },
                    { t: 0, s: 'absenken' },
                    { t: 600, s: 'aus' },
                ],
                [],
                [],
                [],
                [],
                [],
                [],
            ]),
            szenen,
        );
        expect(p.fehler).to.equal(null);
        expect(p.plan[0]).to.eql([
            { t: 0, s: 'absenken' },
            { t: 600, s: 'aus' },
        ]);
        expect(wochenplan.planLesen('{kaputt', szenen).fehler).to.match(/JSON/);
        expect(wochenplan.planLesen([[], [], []], szenen).fehler).to.match(/sieben/);
        expect(wochenplan.planLesen([[{ t: 0, s: 'gibtsnicht' }], [], [], [], [], [], []], szenen).fehler).to.match(
            /gibt es nicht/,
        );
        expect(wochenplan.planLesen([[{ t: 1500, s: 'aus' }], [], [], [], [], [], []], szenen).fehler).to.match(
            /ungültig/,
        );
        expect(wochenplan.planLesen([[], [], [], [], [], [], []], szenen).fehler).to.match(/leer/);
    });

    it('Szene und naechster Schaltpunkt an einem Werktag', () => {
        // Freitag 20.11.2026 18:48 -> Komfort seit 16:30, naechster 22:00 Absenken
        const s = wochenplan.stand(plan, ort(2026, 11, 20, 18, 48));
        expect(s.szene).to.equal('komfort');
        expect(s.naechster).to.eql({ zeit: ort(2026, 11, 20, 22, 0), szene: 'absenken' });
        // 23:00 -> Absenken; naechster Samstag 07:30 (der Eintrag 00:00 ist dieselbe Szene)
        const n = wochenplan.stand(plan, ort(2026, 11, 20, 23, 0));
        expect(n.szene).to.equal('absenken');
        expect(n.naechster.zeit).to.equal(ort(2026, 11, 21, 7, 30));
    });

    it('Tag ohne Eintrag um 00:00 uebernimmt die letzte Szene des Vortags', () => {
        const p = wochenplan.planLesen([[{ t: 480, s: 'komfort' }], [], [], [], [], [], []], szenen).plan;
        expect(wochenplan.stand(p, ort(2026, 11, 18, 12, 0)).szene).to.equal('komfort'); // Mittwoch
        expect(wochenplan.stand(p, ort(2026, 11, 23, 7, 0)).szene).to.equal('komfort'); // Montag vor 08:00
    });

    it('Zeitumstellung Maerz: 06:00 bleibt 06:00 Ortszeit, die Nacht ist eine Stunde kuerzer', () => {
        // Sonntag 28.03.2027, 02:00 -> 03:00
        const vor = ort(2027, 3, 28, 1, 30);
        const s = wochenplan.stand(plan, vor);
        expect(s.szene).to.equal('absenken');
        expect(new Date(s.naechster.zeit).getHours()).to.equal(7);
        expect(new Date(s.naechster.zeit).getMinutes()).to.equal(30);
        expect(s.naechster.zeit - vor).to.equal(5 * 3600000); // 1:30 -> 7:30 sind nur 5 h
        // Schaltpunkt in der Luecke (02:30 gibt es nicht) faellt auf 03:30 Ortszeit
        const luecke = wochenplan.planLesen(
            [
                [],
                [],
                [],
                [],
                [],
                [],
                [
                    { t: 0, s: 'absenken' },
                    { t: 150, s: 'komfort' },
                ],
            ],
            szenen,
        ).plan;
        const l = wochenplan.stand(luecke, vor);
        expect(l.naechster.zeit - vor).to.equal(3600000);
        expect(wochenplan.stand(luecke, vor + 3600000).szene).to.equal('komfort');
    });

    it('Zeitumstellung Oktober: doppelte Stunde schaltet einmal, 06:00 bleibt 06:00', () => {
        // Sonntag 25.10.2026, 03:00 -> 02:00
        const doppelt = wochenplan.planLesen(
            [
                [],
                [],
                [],
                [],
                [],
                [],
                [
                    { t: 0, s: 'absenken' },
                    { t: 150, s: 'komfort' },
                    { t: 360, s: 'aus' },
                ],
            ],
            szenen,
        ).plan;
        const start = ort(2026, 10, 25, 1, 0);
        let wechsel = 0;
        let letzte = null;
        for (let t = start; t < start + 8 * 3600000; t += 60000) {
            const s = wochenplan.stand(doppelt, t).szene;
            if (s !== letzte) {
                wechsel++;
                letzte = s;
            }
        }
        expect(wechsel).to.equal(3); // absenken -> komfort -> aus, kein Zurueckspringen
        const sechs = ort(2026, 10, 25, 6, 0);
        expect(wochenplan.stand(doppelt, sechs - 60000).szene).to.equal('komfort');
        expect(wochenplan.stand(doppelt, sechs).szene).to.equal('aus');
        expect(sechs - start).to.equal(6 * 3600000); // 01:00 -> 06:00 dauert 6 h
    });

    it('Feiertage: Ostern, bundesweite Tage, eigene Liste; Feiertag nutzt den Sonntagsplan', () => {
        expect(wochenplan.ostern(2026)).to.eql([4, 5]);
        expect(wochenplan.ostern(2027)).to.eql([3, 28]);
        const f = wochenplan.feiertageDE(2026);
        for (const tag of [
            '2026-01-01',
            '2026-04-03',
            '2026-04-06',
            '2026-05-01',
            '2026-05-14',
            '2026-05-25',
            '2026-10-03',
            '2026-12-25',
            '2026-12-26',
        ]) {
            expect(f.has(tag), tag).to.equal(true);
        }
        const eigene = wochenplan.feiertageLesen('24.12., 2026-11-18; 31.12.2026');
        expect(wochenplan.istFeiertag(new Date(2026, 11, 24), { eigene })).to.equal(true);
        expect(wochenplan.istFeiertag(new Date(2027, 11, 24), { eigene })).to.equal(true);
        expect(wochenplan.istFeiertag(new Date(2026, 10, 18), { eigene })).to.equal(true);
        expect(wochenplan.istFeiertag(new Date(2027, 11, 31), { eigene })).to.equal(false);
        // Freitag 25.12.2026 07:00: Werktagsplan = Komfort (seit 06:00), Sonntagsplan = Absenken (bis 07:30)
        const zeit = ort(2026, 12, 25, 7, 0);
        expect(wochenplan.stand(plan, zeit).szene).to.equal('komfort');
        const mit = wochenplan.stand(plan, zeit, { feiertagSonntag: true, deutschland: true });
        expect(mit.szene).to.equal('absenken');
        expect(mit.quelle).to.equal('feiertag');
    });

    it('Abwesenheit ueberlagert den Plan und endet in der dann gueltigen Szene', () => {
        const abw = wochenplan.abwesenheitLesen(
            { von: ort(2026, 11, 21, 10), bis: ort(2026, 11, 23, 17), szene: 'abwesend' },
            szenen,
        );
        const vorher = wochenplan.stand(plan, ort(2026, 11, 21, 9), { abwesenheit: abw });
        expect(vorher.szene).to.equal('komfort');
        expect(vorher.naechster).to.eql({ zeit: abw.von, szene: 'abwesend' });
        const drin = wochenplan.stand(plan, ort(2026, 11, 22, 12), { abwesenheit: abw });
        expect(drin).to.include({ szene: 'abwesend', quelle: 'abwesenheit' });
        expect(drin.naechster).to.eql({ zeit: abw.bis, szene: 'komfort' }); // Montag 17:00 = Komfort
        expect(wochenplan.abwesenheitLesen('{"von":5,"bis":3,"szene":"aus"}', szenen)).to.equal(null);
        expect(wochenplan.abwesenheitLesen('{"von":1,"bis":3,"szene":"x"}', szenen)).to.equal(null);
        expect(wochenplan.abwesenheitLesen('kaputt', szenen)).to.equal(null);
    });
});

describe('Regelung: Feuchte und Taupunkt', () => {
    const k = feuchte.konfigPruefen({}).konfig;
    const T = ort(2026, 7, 15, 14);
    const min = n => n * 60000;

    it('Taupunkt nach Magnus', () => {
        expect(feuchte.taupunkt(20, 50)).to.be.closeTo(9.3, 0.15);
        expect(feuchte.taupunkt(25, 70)).to.be.closeTo(19.1, 0.15);
        expect(feuchte.taupunkt(20, 100)).to.be.closeTo(20, 0.05);
        expect(feuchte.taupunkt(20, 0)).to.equal(null);
        expect(feuchte.taupunkt(NaN, 50)).to.equal(null);
    });

    it('Konfiguration: verdrehte Grenzen werden abgelehnt', () => {
        expect(feuchte.konfigPruefen({ dtpEin: 6, dtpAus: 4 }).fehler).to.match(/ΔTP/);
        expect(feuchte.konfigPruefen({ rhEin: 50, rhAus: 60 }).fehler).to.match(/Feuchte/);
        expect(feuchte.konfigPruefen({ massnahme: 'quatsch' }).fehler).to.match(/Maßnahme/);
        expect(feuchte.konfigPruefen({ dtpEin: 'abc' }).fehler).to.match(/keine Zahl/);
    });

    it('Eingriff, Mindestlaufzeit, Ende mit Pause, erneuter Eingriff erst nach der Pause', () => {
        const kuehl = { power: true, mode: 'cool', heizt: false, erlaubt: true };
        let r = feuchte.bewerten({ ...kuehl, raum: 25, feuchte: 72 }, k, null, T);
        expect(r.ergebnis).to.include({ bedarf: true, massnahme: 'entfeuchten' });
        // nach 5 min schon trocken: Mindestlaufzeit haelt
        r = feuchte.bewerten({ ...kuehl, raum: 25, feuchte: 50 }, k, r.zustand, T + min(5));
        expect(r.ergebnis.bedarf).to.equal(true);
        expect(r.ergebnis.grund).to.match(/Mindestlaufzeit/);
        // nach 20 min: Ende, Pause
        r = feuchte.bewerten({ ...kuehl, raum: 25, feuchte: 50 }, k, r.zustand, T + min(20));
        expect(r.ergebnis.bedarf).to.equal(false);
        expect(r.zustand.pauseBis).to.equal(T + min(50));
        // wieder feucht waehrend der Pause: kein Eingriff
        r = feuchte.bewerten({ ...kuehl, raum: 25, feuchte: 75 }, k, r.zustand, T + min(30));
        expect(r.ergebnis.bedarf).to.equal(false);
        expect(r.ergebnis.grund).to.match(/Pause/);
        r = feuchte.bewerten({ ...kuehl, raum: 25, feuchte: 75 }, k, r.zustand, T + min(51));
        expect(r.ergebnis.bedarf).to.equal(true);
    });

    it('Hysterese: zwischen Ein- und Aus-Grenze bleibt der Zustand wie er ist', () => {
        const e = { power: true, mode: 'cool', heizt: false, erlaubt: true, raum: 25, feuchte: 62 };
        expect(feuchte.bewerten(e, k, null, T).ergebnis.bedarf).to.equal(false);
        const an = feuchte.bewerten({ ...e, feuchte: 70 }, k, null, T);
        expect(feuchte.bewerten(e, k, an.zustand, T + min(40)).ergebnis.bedarf).to.equal(true);
    });

    it('Hoechstlaufzeit beendet einen Eingriff, der sein Ziel nicht erreicht', () => {
        const e = { power: true, mode: 'cool', heizt: false, erlaubt: true, raum: 25, feuchte: 80 };
        const an = feuchte.bewerten(e, k, null, T);
        const r = feuchte.bewerten(e, k, an.zustand, T + min(121));
        expect(r.ergebnis.bedarf).to.equal(false);
        expect(r.ergebnis.grund).to.match(/Höchstlaufzeit/);
    });

    it('Heizbetrieb, Geraet aus, kaputter Fuehler: kein Eingriff in die Anlage', () => {
        const feucht = { raum: 20, feuchte: 80, erlaubt: true };
        expect(
            feuchte.bewerten({ ...feucht, power: true, mode: 'heat', heizt: true }, k, null, T).ergebnis.massnahme,
        ).to.equal('melden');
        expect(
            feuchte.bewerten({ ...feucht, power: false, mode: 'cool', heizt: false }, k, null, T).ergebnis.massnahme,
        ).to.equal('melden');
        const kaputt = feuchte.bewerten(
            { raum: 20, feuchte: null, erlaubt: true, power: true, mode: 'cool' },
            k,
            null,
            T,
        );
        expect(kaputt.ergebnis).to.include({ bedarf: false, zustand: 'gestört' });
        const senken = feuchte.konfigPruefen({ massnahme: 'zielSenken' }).konfig;
        expect(
            feuchte.bewerten({ ...feucht, power: true, mode: 'cool', heizt: false }, senken, null, T).ergebnis
                .massnahme,
        ).to.equal('zielSenken');
        expect(
            feuchte.bewerten({ ...feucht, power: true, mode: 'dry', heizt: false }, senken, null, T).ergebnis.massnahme,
        ).to.equal('melden');
    });

    it('Neustart mitten im Entfeuchten: die Mindestlaufzeit laeuft weiter', () => {
        const e = { power: true, mode: 'cool', heizt: false, erlaubt: true, raum: 25, feuchte: 72 };
        const an = feuchte.bewerten(e, k, null, T);
        const z = zustand.leer();
        z.feuchte = an.zustand;
        const wieder = zustand.lesen(zustand.schreiben(z));
        const r = feuchte.bewerten({ ...e, feuchte: 50 }, k, wieder.feuchte, T + min(21));
        expect(r.ergebnis.bedarf).to.equal(false); // 21 min seit dem urspruenglichen Beginn
    });
});

describe('Regelung: Handeingriff', () => {
    const k = handeingriff.konfigPruefen({});
    const T = ort(2026, 11, 20, 18);
    const st = { power: true, mode: 'heat', target: 21, fan: 'auto' };

    it('erste Meldung lernt nur; Aenderung ohne eigenen Befehl sperrt bis zum Schaltpunkt', () => {
        let r = handeingriff.auswerten(st, null, k, T);
        expect(r).to.include({ gesperrt: false });
        r = handeingriff.auswerten({ ...st, target: 23 }, r.zustand, k, T + 60000, {
            naechsterSchaltpunkt: T + 2 * 3600000,
        });
        expect(r.neu).to.eql(['target']);
        expect(r.zustand.bis).to.equal(T + 2 * 3600000);
        expect(r.gesperrt).to.equal(true);
    });

    it('laengstens 4 Stunden, auch wenn der naechste Schaltpunkt spaeter liegt oder fehlt', () => {
        const a = handeingriff.auswerten(st, null, k, T);
        const r = handeingriff.auswerten({ ...st, fan: 'high' }, a.zustand, k, T + 1000, {
            naechsterSchaltpunkt: T + 9 * 3600000,
        });
        expect(r.zustand.bis).to.equal(T + 1000 + 4 * 3600000);
        const o = handeingriff.auswerten({ ...st, fan: 'high' }, a.zustand, k, T + 1000, {});
        expect(o.zustand.bis).to.equal(T + 1000 + 4 * 3600000);
    });

    it('eigener Befehl ist kein Handeingriff - auch nicht die Folge power bei mode', () => {
        let z = handeingriff.auswerten({ power: false }, null, k, T).zustand;
        z = handeingriff.befehlMerken(z, { mode: 'heat', target: 21 }, T + 1000);
        const r = handeingriff.auswerten(st, z, k, T + 5000);
        expect(r.neu).to.eql([]);
        // derselbe Wert nach Ablauf der Erklaerfrist zaehlt als Hand
        const z2 = handeingriff.befehlMerken(r.zustand, { target: 19 }, T + 6000);
        const spaet = handeingriff.auswerten({ ...st, target: 19 }, z2, k, T + 6000 + 10 * 60000);
        expect(spaet.neu).to.eql(['target']);
    });

    it('Modus dauer und nie; ignorierte Felder; Aufheben', () => {
        const a = handeingriff.auswerten(st, null, k, T);
        const dauer = handeingriff.konfigPruefen({ modus: 'dauer', stunden: 2 });
        expect(
            handeingriff.auswerten({ ...st, target: 25 }, a.zustand, dauer, T, { naechsterSchaltpunkt: T + 60000 })
                .zustand.bis,
        ).to.equal(T + 2 * 3600000);
        const nie = handeingriff.konfigPruefen({ modus: 'nie' });
        expect(handeingriff.auswerten({ ...st, target: 25 }, a.zustand, nie, T).gesperrt).to.equal(false);
        expect(handeingriff.auswerten({ ...st, target: 25 }, a.zustand, k, T, { ignoriere: ['target'] }).neu).to.eql(
            [],
        );
        const g = handeingriff.auswerten({ ...st, target: 25 }, a.zustand, k, T);
        expect(handeingriff.aufheben(g.zustand).bis).to.equal(0);
        expect(handeingriff.konfigPruefen({ stunden: 99 }).stunden).to.equal(handeingriff.STUNDEN_MAX);
    });

    it('nach einem Neustart: Abweichung vom erwarteten Planstand zaehlt als Handeingriff', () => {
        const r = handeingriff.auswerten({ ...st, target: 24 }, null, k, T, {
            ersteMeldung: true,
            erwartet: { power: true, mode: 'heat', target: 21, fan: 'auto' },
        });
        expect(r.neu).to.eql(['target']);
        const gleich = handeingriff.auswerten(st, null, k, T, {
            ersteMeldung: true,
            erwartet: { power: true, mode: 'heat', target: 21, fan: 'auto' },
        });
        expect(gleich.neu).to.eql([]);
    });
});

describe('Regelung: Fuehlerquellen', () => {
    const T = ort(2026, 11, 20, 18);
    const frisch = w => ({ wert: w, zeit: T - 60000 });

    it('auto: BLE vor Datenpunkt vor intern; aussen: Datenpunkt vor Aussengeraet', () => {
        expect(quellen.waehlen('raum', 'auto', { ble: frisch(21), dp: frisch(22), intern: frisch(23) }, T)).to.include({
            quelle: 'ble',
            stand: 'ok',
        });
        expect(quellen.waehlen('raum', 'auto', { dp: frisch(22), intern: frisch(23) }, T).quelle).to.equal('dp');
        expect(quellen.waehlen('raum', 'auto', { intern: frisch(23) }, T).quelle).to.equal('intern');
        expect(quellen.waehlen('aussen', 'auto', { dp: frisch(4), intern: frisch(5) }, T).messung.wert).to.equal(4);
    });

    it('Rueckfall bei veraltetem, nicht numerischem oder unplausiblem Wert - mit Klartext', () => {
        const alt = quellen.waehlen('raum', 'dp', { dp: { wert: 22, zeit: T - 47 * 60000 }, intern: frisch(23) }, T);
        expect(alt).to.include({ quelle: 'intern', stand: 'rueckfall' });
        expect(alt.text).to.match(/Datenpunkt veraltet \(47 min\)/);
        expect(quellen.waehlen('raum', 'dp', { dp: frisch('n/a'), intern: frisch(23) }, T).text).to.match(/keine Zahl/);
        expect(quellen.waehlen('feuchte', 'auto', { dp: frisch(140), intern: frisch(50) }, T).quelle).to.equal(
            'intern',
        );
        expect(quellen.waehlen('raum', 'dp', { dp: null, intern: frisch(23) }, T).text).to.match(/kein Wert/);
    });

    it('nichts brauchbar: Messung null, Zustand fehlt', () => {
        const r = quellen.waehlen('aussen', 'auto', { intern: { wert: 5, zeit: T - 2 * 3600000 } }, T);
        expect(r).to.include({ messung: null, stand: 'fehlt' });
        expect(quellen.waehlen('aussen', 'auto', {}, T).text).to.equal('kein Fühler vorhanden');
    });

    it('traeger Fremdfuehler: schnelle Aenderungen vom Anlagenfuehler, auf Dauer der Fremdwert', () => {
        const tau = 30 * 60000;
        let r = quellen.mischen(20, 20.5, null, T, tau);
        expect(r.wert).to.equal(20); // Start: nur der Fremdwert
        // Anlage heizt: intern steigt um 1 K, fremd merkt noch nichts
        r = quellen.mischen(20, 21.5, r.zustand, T + 60000, tau);
        expect(r.wert).to.be.closeTo(21, 0.1);
        // intern bleibt oben, der schnelle Anteil klingt ab
        let z = r.zustand;
        for (let i = 2; i <= 180; i++) {
            r = quellen.mischen(20, 21.5, z, T + i * 60000, tau);
            z = r.zustand;
        }
        expect(r.wert).to.equal(20);
        // Luecke (Neustart): neu aufsetzen; ohne Anlagenfuehler oder ausgeschaltet: unveraendert
        expect(quellen.mischen(20, 25, z, T + 10 * 3600000, tau).wert).to.equal(20);
        expect(quellen.mischen(20, null, z, T, tau).wert).to.equal(20);
        expect(quellen.mischen(20, 21.5, z, T, 0).wert).to.equal(20);
        // Sprung des Anlagenfuehlers ist auf 2 K begrenzt
        const a = quellen.mischen(20, 20, null, T, tau);
        expect(quellen.mischen(20, 30, a.zustand, T + 60000, tau).wert).to.equal(22);
    });

    it('feste Wahl "intern" nimmt den BLE-Wert nicht', () => {
        expect(quellen.waehlen('raum', 'intern', { ble: frisch(21), intern: frisch(23) }, T)).to.include({
            quelle: 'intern',
            stand: 'ok',
        });
    });
});

describe('Regelung: Sender der Szenenfelder', () => {
    const T = ort(2026, 11, 20, 18);
    const an = { power: true, mode: 'heat', target: 21, fan: 'auto' };

    it('Einschalten geht ueber mode; aus nur power; nichts bei Gleichstand', () => {
        expect(sender.abweichung(an, { power: false, mode: 'heat', target: 19, fan: 'auto' })).to.eql({
            mode: 'heat',
            target: 21,
        });
        expect(sender.abweichung({ power: false }, an)).to.eql({ power: false });
        expect(sender.abweichung({ power: false }, { power: false })).to.eql({});
        expect(sender.abweichung(an, an)).to.eql({});
        expect(sender.abweichung({ target: 22 }, { power: false, target: 21 })).to.eql({});
    });

    it('nur Felder, die das Geraet meldet', () => {
        expect(sender.abweichung(an, { power: true, mode: 'cool', target: 21 })).to.eql({ mode: 'heat' });
        expect(sender.abweichung(an, { power: false, target: 20 })).to.eql({ power: true, target: 21 });
    });

    it('wartet auf Bestaetigung, wiederholt hoechstens dreimal, gibt dann Ruhe', () => {
        const status = { ...an, target: 19 };
        let r = sender.planen({ wunsch: an, status, zustand: null, jetzt: T });
        expect(r.befehle).to.eql({ target: 21 });
        r = sender.planen({ wunsch: an, status, zustand: r.zustand, jetzt: T + 30000 });
        expect(r.befehle).to.eql({});
        expect(r.wartet).to.eql(['target']);
        let gesendet = 1;
        for (let t = T + 60000; t < T + 3600000; t += 60000) {
            r = sender.planen({ wunsch: an, status, zustand: r.zustand, jetzt: t });
            gesendet += Object.keys(r.befehle).length;
        }
        expect(gesendet).to.equal(3);
        expect(r.abgelehnt).to.eql(['target']);
        // neuer Wunsch: wieder frei
        r = sender.planen({ wunsch: { ...an, target: 22 }, status, zustand: r.zustand, jetzt: T + 3600000 });
        expect(r.befehle).to.eql({ target: 22 });
    });

    it('failed-set beendet die Wiederholung sofort', () => {
        const status = { ...an, fan: 'high' };
        let r = sender.planen({ wunsch: an, status, zustand: null, jetzt: T });
        const z = sender.ablehnen(r.zustand, ['fan'], T + 13000);
        r = sender.planen({ wunsch: an, status, zustand: z, jetzt: T + 60000 });
        expect(r.befehle).to.eql({});
        expect(r.abgelehnt).to.eql(['fan']);
    });

    it('Obergrenze je Stunde', () => {
        let z = null;
        let gesendet = 0;
        for (let i = 0; i < 200; i++) {
            const r = sender.planen({
                wunsch: { ...an, target: 18 + (i % 5) },
                status: { ...an, target: 30 },
                zustand: z,
                jetzt: T + i * 10000,
            });
            z = r.zustand;
            gesendet += Object.keys(r.befehle).length;
        }
        expect(gesendet).to.equal(sender.GRENZEN.proStunde);
    });
});

describe('Regelung: Koordinator (Vorrang)', () => {
    const T = ort(2026, 11, 20, 18);
    const k = {
        betrieb: 'adapter',
        bedarf: bedarf.konfigPruefen({}).konfig,
        feuchte: feuchte.konfigPruefen({}).konfig,
        frostAb: 0,
        frostZiel: 10,
        band: 0.5,
        fuehlerWeg: 'modul',
        korrAbstandMs: 20 * 60000,
        korrTotK: 0.3,
        korrMaxK: 3,
    };
    const m = (wert, quelle = 'intern') => ({
        messung: wert === null ? null : { wert, zeit: T - 30000 },
        quelle: wert === null ? null : quelle,
        stand: 'ok',
        text: 'x',
    });
    const eingang = (ueber = {}) => ({
        status: { power: true, mode: 'heat', target: 21, fan: 'auto', demand: 100 },
        fuehler: { aussen: m(5), raum: m(21), feuchte: m(50) },
        schalter: { plan: true, feuchte: true, bedarf: true },
        szene: szenen.get('komfort'),
        gesperrt: false,
        faehig: 'ja',
        vortag: null,
        ...ueber,
    });

    it('Plan liefert den Wunsch, Bedarf die Grenze, der Deckel der Szene begrenzt', () => {
        const r = koordinator.koordinieren(eingang(), k, null, T);
        expect(r.wunsch).to.eql({ power: true, mode: 'heat', target: 21, fan: 'auto' });
        expect(r.demand).to.equal(60); // Kennlinie bei 5 °C: ~61 % -> 60
        const ab = koordinator.koordinieren(
            eingang({
                szene: { ...szenen.get('absenken'), deckel: 40 },
                fuehler: { aussen: m(5), raum: m(20.2), feuchte: m(50) },
            }),
            k,
            null,
            T,
        );
        expect(ab.demand).to.equal(40);
        expect(ab.gruende.join(' ')).to.match(/Höchstleistung/);
    });

    it('Szene Aus: Geraet aus, Leistungsgrenze frei', () => {
        const r = koordinator.koordinieren(eingang({ szene: szenen.get('aus') }), k, null, T);
        expect(r.wunsch).to.eql({ power: false });
        expect(r.demand).to.equal(100);
    });

    it('Handeingriff sperrt Plan und Szenen, die Leistungsgrenze laeuft weiter', () => {
        const r = koordinator.koordinieren(
            eingang({ gesperrt: true, status: { power: true, mode: 'heat', target: 24, fan: 'high', demand: 100 } }),
            k,
            null,
            T,
        );
        expect(r.wunsch).to.eql({});
        expect(r.zustandText).to.equal('hand');
        expect(r.demand).to.be.a('number');
        // 2 K unter dem von Hand gewaehlten Ziel (24) -> 100 %
        const kalt = koordinator.koordinieren(
            eingang({ gesperrt: true, status: { power: true, mode: 'heat', target: 24, fan: 'auto', demand: 60 } }),
            k,
            null,
            T,
        );
        expect(kalt.demand).to.equal(100);
    });

    it('2 K hinter dem Ziel: 100 % auch gegen den Deckel der Szene', () => {
        const r = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(5), raum: m(18.5), feuchte: m(50) }, szene: szenen.get('absenken') }),
            k,
            null,
            T,
        );
        expect(r.demand).to.equal(60); // Ziel der Szene ist 19 -> nur 0,5 K, Deckel 60 greift
        const weit = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(5), raum: m(16.5), feuchte: m(50) }, szene: szenen.get('absenken') }),
            k,
            null,
            T,
        );
        expect(weit.demand).to.equal(100);
    });

    it('Ueberheizschutz: 1,5 K ueber dem Ziel -> Mindeststufe 30 %, auch unter der Untergrenze und dem Deckel', () => {
        const warm = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(5), raum: m(22.6), feuchte: m(50) } }),
            k,
            null,
            T,
        );
        expect(warm.demand).to.equal(30);
        expect(warm.gruende.join(' ')).to.match(/Überheizschutz/);
        const knapp = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(5), raum: m(22.3), feuchte: m(50) } }),
            k,
            null,
            T,
        );
        expect(knapp.demand).to.be.above(30);
        const aus = { ...k, bedarf: bedarf.konfigPruefen({ ueberAbK: 0 }).konfig };
        expect(
            koordinator.koordinieren(eingang({ fuehler: { aussen: m(5), raum: m(23), feuchte: m(50) } }), aus, null, T)
                .demand,
        ).to.equal(45);
    });

    it('Frostschutz steht ueber dem Plan und ueber dem Handeingriff', () => {
        const kf = { ...k, frostAb: 8 };
        const e = eingang({
            szene: szenen.get('aus'),
            status: { power: false },
            fuehler: { aussen: m(-5), raum: m(6), feuchte: m(50) },
        });
        const r = koordinator.koordinieren(e, kf, null, T);
        expect(r.wunsch).to.include({ power: true, mode: 'heat', target: 10 });
        // Handeingriff sperrt nur Plan und Szenen - der Frostschutz bleibt
        const hand = koordinator.koordinieren({ ...e, gesperrt: true }, kf, null, T);
        expect(hand.wunsch).to.include({ power: true, mode: 'heat', target: 10 });
        // Hysterese: bei 8,5 °C bleibt der Schutz, bei 9,5 °C endet er
        const bleibt = koordinator.koordinieren(
            { ...e, fuehler: { ...e.fuehler, raum: m(8.5) } },
            kf,
            r.zustand,
            T + 60000,
        );
        expect(bleibt.zustand.koordinator.frost).to.equal(true);
        const ende = koordinator.koordinieren(
            { ...e, fuehler: { ...e.fuehler, raum: m(9.5) } },
            kf,
            bleibt.zustand,
            T + 120000,
        );
        expect(ende.wunsch).to.eql({ power: false });
    });

    it('Feuchte: Kuehlszene wird zu Entfeuchten; im Heizbetrieb nur Meldung; Szene ohne Feuchte laesst es', () => {
        const kuehl = { ...szenen.get('komfort'), mode: 'cool', soll: 24 };
        const e = eingang({
            szene: kuehl,
            status: { power: true, mode: 'cool', target: 24, fan: 'auto', demand: 100 },
            fuehler: { aussen: m(30), raum: m(25), feuchte: m(75) },
        });
        const r = koordinator.koordinieren(e, k, null, T);
        expect(r.wunsch.mode).to.equal('dry');
        expect(r.demand).to.equal(null); // dry = neutral fuer den Bedarf
        const heiz = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(5), raum: m(21), feuchte: m(80) } }),
            k,
            null,
            T,
        );
        expect(heiz.wunsch.mode).to.equal('heat');
        expect(heiz.feuchte.massnahme).to.equal('melden');
        const ohne = koordinator.koordinieren({ ...e, szene: { ...kuehl, feuchte: false } }, k, null, T);
        expect(ohne.wunsch.mode).to.equal('cool');
    });

    it('Feuchte ohne Plan: Betriebsart wird gemerkt und nach dem Eingriff wiederhergestellt', () => {
        const e = eingang({
            schalter: { plan: false, feuchte: true, bedarf: false },
            szene: null,
            status: { power: true, mode: 'cool', target: 24, fan: 'auto' },
            fuehler: { aussen: m(30), raum: m(25), feuchte: m(75) },
        });
        let r = koordinator.koordinieren(e, k, null, T);
        expect(r.wunsch).to.eql({ power: true, mode: 'dry' });
        // Anlage entfeuchtet, nach 25 min trocken
        const trocken = {
            ...e,
            status: { ...e.status, mode: 'dry' },
            fuehler: { aussen: m(30), raum: m(25), feuchte: m(50) },
        };
        r = koordinator.koordinieren(trocken, k, r.zustand, T + 25 * 60000);
        expect(r.wunsch).to.eql({ mode: 'cool' });
        r = koordinator.koordinieren(
            { ...trocken, status: { ...e.status, mode: 'cool' } },
            k,
            r.zustand,
            T + 26 * 60000,
        );
        expect(r.wunsch).to.eql({});
        expect(r.zustand.koordinator.feuchteVorMode).to.equal(undefined);
    });

    it('Ziel senken beim Kuehlen und Zuruecknehmen', () => {
        const ks = { ...k, feuchte: feuchte.konfigPruefen({ massnahme: 'zielSenken' }).konfig };
        const kuehl = { ...szenen.get('komfort'), mode: 'cool', soll: 24 };
        const e = eingang({
            szene: kuehl,
            status: { power: true, mode: 'cool', target: 24, fan: 'auto', demand: 100 },
            fuehler: { aussen: m(30), raum: m(25), feuchte: m(75) },
        });
        expect(koordinator.koordinieren(e, ks, null, T).wunsch.target).to.equal(23);
    });

    it('Faikout-Auto: keine Betriebsart vom Adapter; ohne autoe "einrichten" (keine Stoerung)', () => {
        const kf = { ...k, betrieb: 'faikout' };
        const ok = koordinator.koordinieren(
            eingang({
                status: {
                    power: true,
                    mode: 'heat_cool',
                    heat: true,
                    target: 21,
                    fan: 'auto',
                    demand: 100,
                    autoe: true,
                    autor: 1,
                },
            }),
            kf,
            null,
            T,
        );
        expect(ok.wunsch).to.eql({ power: true, target: 21, fan: 'auto' });
        expect(ok.zustandText).to.equal('ok');
        // Leistungsgrenze bei Faikout-Auto nur im Modus "Auto" (Vortag + Zuschlag)
        expect(ok.demand).to.equal(null);
        expect(ok.bedarfRuht).to.equal(true);
        const vortagK = { ...kf, bedarf: bedarf.konfigPruefen({ strategie: 'vortag' }).konfig };
        const st = {
            power: true,
            mode: 'heat_cool',
            heat: true,
            target: 21,
            fan: 'auto',
            demand: 100,
            autoe: true,
            autor: 1,
        };
        const mitVortag = koordinator.koordinieren(
            eingang({ status: st, vortag: { spitzeW: 500, mittelW: 400, stunden: 5 } }),
            vortagK,
            null,
            T,
        );
        expect(mitVortag.demand).to.equal(60); // 500 W von 1000 W + 10 Punkte
        const ohne = koordinator.koordinieren(eingang(), kf, null, T);
        expect(ohne.zustandText).to.equal('einrichten');
    });

    it('control: nur bei fremdem Raumfuehler, immer vollstaendig; BLE ohne env; Faikout-Auto nur env', () => {
        expect(koordinator.koordinieren(eingang(), k, null, T).control).to.equal(null);
        const dp = eingang({ fuehler: { aussen: m(5), raum: m(20.4, 'dp'), feuchte: m(50) } });
        expect(koordinator.koordinieren(dp, k, null, T).control).to.eql({ env: 20.4, target: 21 });
        const ble = eingang({
            status: { power: true, mode: 'heat', target: 21, fan: 'auto', ble: true },
            fuehler: { aussen: m(5), raum: m(20.4, 'ble'), feuchte: m(50) },
        });
        expect(koordinator.koordinieren(ble, k, null, T).control).to.eql({ target: 21 });
        const auto = koordinator.koordinieren(
            { ...dp, status: { ...dp.status, autoe: true, autor: 1 } },
            { ...k, betrieb: 'faikout' },
            null,
            T,
        );
        expect(auto.control).to.eql({ env: 20.4 });
        expect(koordinator.koordinieren({ ...dp, szene: szenen.get('aus') }, k, null, T).control).to.equal(null);
        expect(koordinator.koordinieren({ ...dp, gesperrt: true }, k, null, T).control).to.equal(null);
        // nie eine control nur mit env ohne laufendes Faikout-Auto (Modul wuerde im Sekundentakt melden)
        expect(koordinator.koordinieren(dp, { ...k, betrieb: 'faikout' }, null, T).control).to.equal(null);
        const trocken = { ...dp, szene: { ...szenen.get('komfort'), mode: 'dry' } };
        expect(koordinator.koordinieren(trocken, k, null, T).control).to.equal(null);
    });

    it('Zielband ohne Plan: der vom Modul nachgefuehrte Anlagen-Sollwert schaukelt das Band nicht hoch', () => {
        const ohnePlan = ueber =>
            eingang({
                schalter: { plan: false, feuchte: false, bedarf: true },
                szene: null,
                fuehler: { aussen: m(5), raum: m(20.4, 'dp'), feuchte: m(50) },
                ...ueber,
            });
        let r = koordinator.koordinieren(ohnePlan(), k, null, T);
        expect(r.control.target).to.equal(21);
        // das Modul stellt die Anlage auf 27,5 - das Band bleibt bei 21
        for (let i = 1; i <= 30; i++) {
            const st = { power: true, mode: 'heat', target: i % 2 ? 27.5 : 16, fan: 'auto', demand: 100 };
            r = koordinator.koordinieren(ohnePlan({ status: st }), k, r.zustand, T + i * 60000);
            expect(r.control.target).to.equal(21);
        }
    });

    describe('Fuehlerkorrektur (fremder Raumfuehler, Anlage regelt selbst)', () => {
        const ks = { ...k, fuehlerWeg: 'sollwert', korrAbstandMs: 30 * 60000, korrMittelMs: 45 * 60000 };
        const mit = (fremd, st = {}, ueber = {}) =>
            eingang({
                status: { power: true, mode: 'heat', target: 21, fan: 'auto', demand: 100, ...st },
                internRaum: st.target ?? 21,
                fuehler: { aussen: m(5), raum: m(fremd, 'dp'), feuchte: m(50) },
                ...ueber,
            });
        /**
         * Laeuft minutenweise; die Anlage uebernimmt jeden Sollwert sofort, ihr eigener Fuehler folgt ihm.
         * `fremd(soll, minute)` liefert den Fremdfuehler.
         */
        const lauf = (minuten, fremd, start = {}, ueber = {}) => {
            let z = start.zustand || null;
            let soll = start.soll ?? 21;
            const sollwerte = [];
            let r;
            const t0 = start.t0 || 0;
            for (let i = 0; i < minuten; i++) {
                const jetzt = T + (t0 + i) * 60000;
                const ein = mit(fremd(soll, i), { target: soll, ...(ueber.st || {}) }, ueber.e || {});
                // Fuehlerwerte sind frisch (die Hilfsfunktion m() stempelt sie auf T)
                ein.fuehler.aussen.messung.zeit = jetzt;
                ein.fuehler.raum.messung.zeit = jetzt;
                r = koordinator.koordinieren(ein, ks, z, jetzt);
                z = r.zustand;
                if (r.wunsch.target !== undefined && r.wunsch.target !== soll) {
                    soll = r.wunsch.target;
                    sollwerte.push([t0 + i, soll]);
                }
            }
            return { r, zustand: z, soll, sollwerte, t0: t0 + minuten };
        };

        it('keine control-Nachricht; der Sollwert der Anlage wandert langsam, bis der Fremdfuehler das Ziel zeigt', () => {
            // Fremdfuehler (anderer Raum) zeigt dauerhaft 1,2 K weniger als die Anlage einstellt
            const a = lauf(8 * 60, soll => Math.round((soll - 1.2) * 10) / 10);
            expect(a.r.control).to.equal(null);
            expect(a.soll).to.be.within(22, 22.5); // 21 + ~1,2 K
            expect(a.sollwerte[0][0]).to.be.at.least(30); // erste Korrektur fruehestens nach einem Abstand
            for (let i = 1; i < a.sollwerte.length; i++) {
                expect(a.sollwerte[i][0] - a.sollwerte[i - 1][0]).to.be.at.least(30);
                expect(Math.abs(a.sollwerte[i][1] - a.sollwerte[i - 1][1])).to.equal(0.5);
            }
            expect(a.sollwerte.length).to.be.at.most(4); // kein Pendeln
            expect(a.r.gruende.join(' ')).to.match(/Fühlerkorrektur: Ziel 21 °C, Anlage 22(\.5)? °C/);
            expect(a.r.bedarf.grund).to.match(/Ziel 21 °C/); // Leistungsgrenze rechnet mit dem Ziel im Raum
        });

        it('pendelnde Anlage und rauschender Fuehler loesen keine Schritte aus', () => {
            // +-0,5 K Schwingung mit 2 h Periode um das Ziel
            const a = lauf(
                12 * 60,
                (soll, i) => Math.round((21 + 0.5 * Math.sin((i / 120) * 2 * Math.PI) + (i % 2) * 0.1) * 10) / 10,
            );
            expect(a.sollwerte.length).to.be.at.most(2);
            expect(a.soll).to.be.within(20.5, 21.5);
        });

        it('korrigiert nicht waehrend des Aufheizens (Anlage hat ihren Sollwert noch nicht erreicht oder Fuehler steigt)', () => {
            const kalt = lauf(
                180,
                (soll, i) => Math.round((18 + i * 0.015) * 10) / 10,
                {},
                { e: { internRaum: 18.5 } },
            );
            expect(kalt.soll).to.equal(21);
            // ohne Anlagenfuehler (IR-Bruecke): der steigende Fremdfuehler haelt die Mittelung an
            const tcl = lauf(120, (soll, i) => Math.round((18 + i * 0.03) * 10) / 10, {}, { e: { internRaum: null } });
            expect(tcl.soll).to.equal(21);
        });

        it('begrenzt die Korrektur auf 3 K', () => {
            const a = lauf(24 * 60, () => 15);
            expect(a.soll).to.equal(24);
        });

        it('Anlage mit ganzen Grad: Schritte von 1 K, Totband passend', () => {
            const knapp = lauf(8 * 60, soll => soll - 0.5, {}, { st: { schritt: 1 } });
            expect(knapp.soll).to.equal(21); // 0,5 K liegt im Totband von 0,6 K
            const weit = lauf(8 * 60, soll => soll - 1.2, {}, { st: { schritt: 1 } });
            expect(weit.soll).to.equal(22);
        });

        it('ohne Plan: neuer Sollwert von aussen ist ein neues Ziel, der eigene Befehl nicht', () => {
            const ohne = { e: { schalter: { plan: false, feuchte: false, bedarf: true }, szene: null } };
            const a = lauf(6 * 60, soll => Math.round((soll - 1.2) * 10) / 10, {}, ohne);
            expect(a.zustand.koordinator.basisZiel).to.equal(21);
            expect(a.soll).to.be.above(21.5);
            // Fernbedienung: 24 -> neues Ziel 24, die Korrektur bleibt
            const korr = a.zustand.koordinator.zielKorr;
            const b = lauf(5, () => 21, { zustand: a.zustand, soll: 24, t0: a.t0 }, ohne);
            expect(b.zustand.koordinator.basisZiel).to.equal(24);
            expect(b.soll - 24).to.be.within(korr, korr + 0.5);
            // Anlage uebernimmt den korrigierten Wert nicht (meldet weiter 24): Ziel schaukelt nicht hoch
            let z = b.zustand;
            for (let i = 0; i < 30; i++) {
                z = koordinator.koordinieren(mit(21, { target: 24 }, ohne.e), ks, z, T + (b.t0 + i) * 60000).zustand;
            }
            expect(z.koordinator.basisZiel).to.equal(24);
        });

        it('Handeingriff, Geraet aus, Faikout-Auto: keine Korrektur', () => {
            expect(koordinator.koordinieren(mit(20, {}, { gesperrt: true }), ks, null, T).wunsch).to.eql({});
            expect(koordinator.koordinieren(mit(20, {}, { szene: szenen.get('aus') }), ks, null, T).wunsch).to.eql({
                power: false,
            });
            const auto = koordinator.koordinieren(
                mit(20, { autoe: true, autor: 1 }),
                { ...ks, betrieb: 'faikout' },
                null,
                T,
            );
            expect(auto.control).to.eql({ env: 20 });
        });
    });

    it('control-Takt: sofort, bei Aenderung fruehestens nach 2 min, spaetestens nach 5 min', () => {
        const c = { env: 20.4, target: 21 };
        const letzte = { text: JSON.stringify(c), zeit: T };
        expect(koordinator.controlFaellig(c, null, T)).to.equal(true);
        expect(koordinator.controlFaellig(c, letzte, T + 4 * 60000)).to.equal(false);
        expect(koordinator.controlFaellig(c, letzte, T + 5 * 60000)).to.equal(true);
        expect(koordinator.controlFaellig({ ...c, env: 20.6 }, letzte, T + 60000)).to.equal(false);
        expect(koordinator.controlFaellig({ ...c, env: 20.5 }, letzte, T + 2 * 60000)).to.equal(false); // Rauschen 0,1 K
        expect(koordinator.controlFaellig({ ...c, env: 20.6 }, letzte, T + 2 * 60000)).to.equal(true);
        expect(koordinator.controlFaellig(null, letzte, T + 3600000)).to.equal(false);
    });
});

describe('Regelung: Einstellungen je Geraet', () => {
    const { konfigAusInstanz } = require('../lib/regel');

    it('Kennlinie, Grenzen und Szenen je Geraet; leer faellt auf Instanz- und Werksvorgabe zurueck', () => {
        const e = konfigAusInstanz({
            regelUntergrenze: 45,
            regelKennlinieHeizen: '-10:90, 15:45',
            regelGeraete: [
                { geraet: 'A', kennlinieHeizen: '-5:80, 10:50', obergrenze: 85, szenen: [{ name: 'Tag', soll: 22 }] },
                { geraet: 'B', strategie: 'vortag', vortagZuschlag: 15 },
            ],
        });
        const a = e.fuer('A', 'A').konfig;
        expect(a.bedarf.heizen).to.eql([
            [-5, 80],
            [10, 50],
        ]);
        expect([a.bedarf.untergrenze, a.bedarf.obergrenze]).to.eql([45, 85]);
        expect([...a.szenen.keys()]).to.eql(['tag']);
        const b = e.fuer('B', 'B').konfig;
        expect(b.bedarf.heizen).to.eql([
            [-10, 90],
            [15, 45],
        ]);
        expect(b.bedarf.strategie).to.equal('vortag');
        expect(b.bedarf.vortag.zuschlag).to.equal(15);
        expect([...b.szenen.keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
        expect(e.fuer('C', 'C').konfig.bedarf.obergrenze).to.equal(95);
    });

    it('fehlerhafte Szene oder Kennlinie stoert nur das eine Geraet', () => {
        const e = konfigAusInstanz({
            regelGeraete: [
                { geraet: 'A', szenen: [{ name: 'X', soll: 99 }] },
                { geraet: 'B', kennlinieHeizen: '0:50, 10:90' },
            ],
        });
        expect(e.fuer('A', 'A').fehler).to.match(/Zieltemperatur/);
        expect(e.fuer('B', 'B').fehler).to.match(/nicht fallend/);
        expect(e.fuer('C', 'C').fehler).to.equal(null);
    });
});

describe('Regelung: Zusammenspiel im Adapter (main.js + Anlage)', () => {
    const { Anlage, aufbau, laufen } = require('./sim/simulator');
    const planText = JSON.stringify(plan);
    const START = ort(2026, 11, 20, 21, 30); // Freitag, Komfort bis 22:00
    const scharf = async (a, id) => {
        await a.regelung.schalter(id, 'probelauf', false);
        await a.regelung.schalter(id, 'plan.wocheJson', planText);
        await a.regelung.schalter(id, 'plan.aktiv', true);
    };
    const themen = (anlage, feld) => anlage.befehle.filter(b => b.topic.endsWith(`/${feld}`)).map(b => b.nutzlast);

    it('Plan schaltet zur Schaltzeit um: ein Befehl je Feld, danach Ruhe', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan A', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_A');
        await laufen(a, uhr, anlage, 20);
        expect(anlage.befehle).to.eql([]); // Komfort passt schon
        expect(a.wert('Plan_A.regel.plan.szene')).to.equal('Komfort');
        expect(a.wert('Plan_A.regel.plan.naechster')).to.equal(ort(2026, 11, 20, 22, 0));
        await laufen(a, uhr, anlage, 30); // ueber 22:00
        expect(themen(anlage, 'temp')).to.eql(['19']);
        expect(themen(anlage, 'fan')).to.eql(['night']);
        expect(themen(anlage, 'mode')).to.eql([]);
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_A.regel.plan.szene')).to.equal('Absenken');
        expect(a.wert('Plan_A.regel.hand.gesperrt')).to.equal(false);
        expect(a.wert('Plan_A.regel.zustand')).to.equal('ok');
    });

    it('Probelauf: kein einziger Befehl, aber "würde senden" steht im Datenpunkt', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: true }, START);
        const anlage = new Anlage({ name: 'Plan B', target: 23, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_B');
        await laufen(a, uhr, anlage, 45);
        expect(anlage.befehle).to.eql([]);
        expect(a.gesendet).to.eql([]);
        expect(JSON.parse(a.wert('Plan_B.regel.letzterBefehl')).aktion).to.equal('wuerde');
        expect(a.zeilen.some(z => /dry run\) would send/.test(z.text))).to.equal(true);
    });

    it('Handeingriff an der Fernbedienung: Plan wartet bis zum Schaltpunkt, dann gilt er wieder', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan C', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_C');
        await laufen(a, uhr, anlage, 3);
        anlage.target = 24; // jemand dreht an der Fernbedienung
        await laufen(a, uhr, anlage, 10);
        expect(a.wert('Plan_C.regel.hand.gesperrt')).to.equal(true);
        expect(a.wert('Plan_C.regel.hand.bis')).to.equal(ort(2026, 11, 20, 22, 0));
        expect(a.wert('Plan_C.regel.zustand')).to.equal('hand');
        expect(anlage.target).to.equal(24);
        expect(anlage.befehle).to.eql([]);
        await laufen(a, uhr, anlage, 30); // ueber 22:00: Absenken
        expect(a.wert('Plan_C.regel.hand.gesperrt')).to.equal(false);
        expect(anlage.target).to.equal(19);
    });

    it('Knopf "Automatik fortsetzen" hebt die Sperre sofort auf', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan D', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_D');
        await laufen(a, uhr, anlage, 2);
        anlage.power = false;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Plan_D.regel.hand.gesperrt')).to.equal(true);
        await a.regelung.schalter('Plan_D', 'hand.aufheben', true);
        await laufen(a, uhr, anlage, 2);
        expect(anlage.power).to.equal(true);
        expect(themen(anlage, 'mode')).to.eql(['heat']);
    });

    it('Geraet uebernimmt einen Wert nicht: drei Versuche, dann gestoert statt Befehlsflut', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan E', target: 23, mode: 'heat' });
        anlage.befehl = function (topic, n) {
            this.befehle.push({ topic, nutzlast: n }); // quittiert nichts
        };
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_E');
        await laufen(a, uhr, anlage, 25);
        expect(themen(anlage, 'temp').length).to.equal(3);
        expect(a.wert('Plan_E.regel.zustand')).to.equal('gestört');
        expect(a.wert('Plan_E.regel.grund')).to.match(/nicht übernommen: target/);
    });

    it('Verbindungsabriss: offline, nichts wird gesendet; nach Wiederkehr gilt der Plan', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan F', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_F');
        anlage.verbunden = false;
        for (let i = 0; i < 40; i++) {
            uhr.t += 60000;
            await a.regelung.takt();
        }
        expect(a.wert('Plan_F.regel.zustand')).to.equal('offline');
        expect(a.gesendet).to.eql([]);
        anlage.verbunden = true;
        await laufen(a, uhr, anlage, 3);
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_F.regel.zustand')).to.equal('ok');
    });

    it('fremder Raumfuehler: vollstaendige control-Nachricht, hoechstens alle 2 min, mindestens alle 5 min', async () => {
        const konfig = {
            regelProbelauf: false,
            regelGeraete: [{ geraet: 'Plan G', raumQuelle: 'dp', raumDp: 'alias.0.raum', fuehlerWeg: 'modul' }],
        };
        const { a, uhr } = aufbau(konfig, START);
        const anlage = new Anlage({ name: 'Plan G', target: 21, mode: 'heat' });
        a.fremd.set('alias.0.raum', { val: 20.2, ts: START });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_G');
        await laufen(a, uhr, anlage, 20, i => a.fremd.set('alias.0.raum', { val: 20.2 + (i % 2) * 0.1, ts: uhr.t }));
        const ctl = themen(anlage, 'control').map(n => JSON.parse(n));
        expect(ctl.length).to.be.within(4, 6);
        for (const c of ctl) {
            expect(c).to.have.all.keys('env', 'target');
            expect(c.target).to.equal(21);
        }
        expect(a.wert('Plan_G.regel.fuehler.raumQuelle')).to.equal('Datenpunkt');
        // Fuehler friert ein: Rueckfall auf den Fuehler der Anlage, control hoert auf
        const vorher = themen(anlage, 'control').length;
        await laufen(a, uhr, anlage, 30);
        expect(a.wert('Plan_G.regel.fuehler.raumQuelle')).to.match(/Rückfall: Datenpunkt veraltet/);
        expect(themen(anlage, 'control').length - vorher).to.be.at.most(4);
    });

    it('Neustart mitten im Entfeuchten: Eingriff laeuft weiter, kein Handeingriff, kein zweiter Befehl', async () => {
        const sommer = ort(2026, 7, 15, 14, 0);
        const kuehlSzenen = [{ name: 'Tag', mode: 'cool', soll: 24 }];
        const konfig = { regelProbelauf: false, regelSzenen: kuehlSzenen };
        const woche = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(() => [{ t: 0, s: 'tag' }]));
        const { a, uhr } = aufbau(konfig, sommer);
        const anlage = new Anlage({ name: 'Plan H', target: 24, mode: 'cool', outside: 30, temp: 25, hum: 75 });
        await laufen(a, uhr, anlage, 2);
        await a.regelung.schalter('Plan_H', 'probelauf', false);
        await a.regelung.schalter('Plan_H', 'plan.wocheJson', woche);
        await a.regelung.schalter('Plan_H', 'plan.aktiv', true);
        await a.regelung.schalter('Plan_H', 'feuchte.aktiv', true);
        await laufen(a, uhr, anlage, 5);
        expect(anlage.mode).to.equal('dry');
        expect(a.wert('Plan_H.regel.feuchte.eingriff')).to.equal(true);
        await a.regelung.sichernAlle();
        // neuer Adapter, gleiche Datenbank
        const neu = aufbau(konfig, uhr.t);
        neu.a.werte = a.werte;
        neu.a.objekte = a.objekte;
        const davor = anlage.befehle.length;
        await laufen(neu.a, neu.uhr, anlage, 5);
        expect(anlage.befehle.length).to.equal(davor);
        expect(neu.a.wert('Plan_H.regel.hand.gesperrt')).to.equal(false);
        expect(neu.a.wert('Plan_H.regel.feuchte.eingriff')).to.equal(true);
        anlage.hum = 50; // trocken: nach Mindestlaufzeit (20 min ab urspruenglichem Beginn) zurueck auf Kuehlen
        await laufen(neu.a, neu.uhr, anlage, 15);
        expect(anlage.mode).to.equal('cool');
        expect(neu.a.wert('Plan_H.regel.feuchte.eingriff')).to.equal(false);
    });

    it('BLE an/aus: Quelle wechselt, Zielband ohne env solange BLE meldet', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan I', target: 21, mode: 'heat', ble: { temp: 20.8, hum: 44 } });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_I');
        await laufen(a, uhr, anlage, 6);
        expect(a.wert('Plan_I.regel.fuehler.raumQuelle')).to.equal('BLE-Fühler am Modul');
        expect(a.wert('Plan_I.regel.fuehler.raum')).to.equal(20.8);
        expect(themen(anlage, 'control').map(n => JSON.parse(n))[0]).to.eql({ target: 21 });
        anlage.ble = null;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Plan_I.regel.fuehler.raumQuelle')).to.equal('Fühler der Anlage');
    });

    it('Schreiblast: ein ruhiger Tag erzeugt wenige Schreibvorgaenge und kaum Befehle', async function () {
        this.timeout(60000);
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true }, ort(2026, 11, 20, 0, 0));
        const anlage = new Anlage({ name: 'Plan J', target: 19, mode: 'heat', fan: 'night', outside: 4 });
        let schreibvorgaenge = 0;
        const setState = a.setState.bind(a);
        const setStateAsync = a.setStateAsync.bind(a);
        a.setState = async (id, w) => {
            schreibvorgaenge += id.includes('.regel.') ? 1 : 0;
            return setState(id, w);
        };
        a.setStateAsync = async (id, w) => {
            schreibvorgaenge += id.includes('.regel.') ? 1 : 0;
            return setStateAsync(id, w);
        };
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_J');
        schreibvorgaenge = 0;
        await laufen(a, uhr, anlage, 24 * 60);
        // 4 Szenenwechsel (06:00, 08:30, 16:30, 22:00) mit je 2 Feldern + wenige demand-Befehle
        expect(themen(anlage, 'temp').length).to.equal(4);
        expect(themen(anlage, 'fan').length).to.equal(4);
        expect(themen(anlage, 'demand').length).to.be.at.most(12);
        expect(anlage.befehle.length).to.be.at.most(20);
        console.log(`        Schreibvorgaenge regel.* in 24 h: ${schreibvorgaenge}, Befehle: ${anlage.befehle.length}`);
        expect(schreibvorgaenge).to.be.below(24 * 60); // deutlich unter einem Schreibvorgang je Minute
    });
});
