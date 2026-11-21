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
const kennlinie = require('../lib/regel/kennlinie');
const zustand = require('../lib/regel/zustand');

const ort = (j, mo, t, h = 0, mi = 0) => new Date(j, mo - 1, t, h, mi).getTime();
const { szenen } = wochenplan.szenenLesen(null);
const plan = wochenplan.vorgabePlan(szenen);

describe('Regelung: Szenen und Wochenplan', () => {
    it('Vorgabe-Szenen; fehlerhafte Szenen werden mit Klartext abgelehnt', () => {
        expect([...szenen.keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
        expect(wochenplan.szenenLesen([{ name: 'A', soll: 45 }]).fehler).to.match(/außerhalb 10\.\.32/);
        expect(wochenplan.szenenLesen([{ name: 'A', soll: 20, deckel: 10 }]).fehler).to.match(/Höchstleistung 10 außerhalb 30\.\.100/);
        expect(
            wochenplan.szenenLesen([
                { name: 'A', soll: 20 },
                { name: 'a', soll: 21 },
            ]).fehler,
        ).to.match(/doppelt/);
        // die Einstellungsseite schreibt `id` in den Eintrag: sie gilt (Umbenennen bricht den Plan nicht,
        // "Comfort" wird nicht zu `comfort`); nur ohne `id` entsteht die ID aus dem Namen
        const mitId = wochenplan.szenenLesen([
            { id: 'komfort', name: 'Comfort', soll: 21 },
            { id: 'stufe_5', name: 'Gäste', soll: 22 },
            { name: 'Spät Abends', soll: 20 },
        ]).szenen;
        expect([...mitId.keys()]).to.eql(['komfort', 'stufe_5', 'sp_t_abends']);
        expect(mitId.get('komfort').name).to.equal('Comfort');
        expect(wochenplan.planLesen([[{ t: 0, s: 'stufe_5' }], [], [], [], [], [], []], mitId).fehler).to.equal(null);
        expect(wochenplan.szenenLesen([{ id: 'a', name: 'X', soll: 20 }, { id: 'a', name: 'Y', soll: 20 }]).fehler).to.match(/doppelt/);
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
        expect(kaputt.ergebnis).to.include({ bedarf: false, zustand: 'fault' });
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
        expect(alt).to.include({ quelle: 'intern', stand: 'fallback' });
        expect(alt.text).to.match(/Datenpunkt veraltet \(47 min\)/);
        expect(quellen.waehlen('raum', 'dp', { dp: frisch('n/a'), intern: frisch(23) }, T).text).to.match(/keine Zahl/);
        expect(quellen.waehlen('feuchte', 'auto', { dp: frisch(140), intern: frisch(50) }, T).quelle).to.equal(
            'intern',
        );
        expect(quellen.waehlen('raum', 'dp', { dp: null, intern: frisch(23) }, T).text).to.match(/kein Wert/);
    });

    it('nichts brauchbar: Messung null, Zustand fehlt', () => {
        const r = quellen.waehlen('aussen', 'auto', { intern: { wert: 5, zeit: T - 2 * 3600000 } }, T);
        expect(r).to.include({ messung: null, stand: 'missing' });
        expect(quellen.waehlen('aussen', 'auto', {}, T).text).to.equal('kein Sensor vorhanden');
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
        faehig: 'yes',
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

    it('Rechenweg (`weg`): der Koordinator ergaenzt Hoechstleistung der Stufe, Stufe ohne Bedarfsregelung, "ruht" und "nicht faehig"', () => {
        const frei = koordinator.koordinieren(eingang(), k, null, T);
        expect(frei.weg).to.include({ art: 'normal', strategie: 'kennlinie', sollwert: 60 });
        expect(frei.weg.deckel).to.equal(undefined);
        const ab = koordinator.koordinieren(eingang({ szene: { ...szenen.get('absenken'), deckel: 40 }, fuehler: { aussen: m(5), raum: m(20.2), feuchte: m(50) } }), k, null, T);
        expect(ab.weg.deckel).to.eql({ stufe: szenen.get('absenken').name, wert: 40 });
        expect(ab.weg.sollwert).to.be.above(40); // der Wert der Regelung; gesendet wird der Deckel
        const ohne = koordinator.koordinieren(eingang({ szene: { ...szenen.get('komfort'), bedarf: false } }), k, null, T);
        expect(ohne.weg).to.eql({ art: 'stufeOhne', stufe: szenen.get('komfort').name, sollwert: 100 });
        expect(koordinator.koordinieren(eingang({ faehig: 'no' }), k, null, T).weg).to.eql({ art: 'nichtFaehig' });
        const auto = koordinator.koordinieren(eingang(), { ...k, betrieb: 'faikout' }, null, T);
        expect(auto.weg).to.eql({ art: 'ruhtAuto' });
        const aus = koordinator.koordinieren(eingang({ status: { power: false, mode: 'heat', target: 21, fan: 'auto', demand: 100 }, szene: null }), k, null, T);
        expect(aus.weg).to.eql({ art: 'neutral' });
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
        expect(r.zustandText).to.equal('manual');
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
        // 100 % aus der Kennlinie allein (Obergrenze 100, -10 °C, Raum am Ziel) ist KEINE volle Freigabe:
        // die Hoechstleistung der Temperaturstufe gilt weiter
        const kalt = koordinator.koordinieren(
            eingang({ fuehler: { aussen: m(-15), raum: m(19), feuchte: m(50) }, szene: szenen.get('absenken') }),
            k,
            null,
            T,
        );
        expect(kalt.demand).to.equal(60);
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
        expect(ohne.zustandText).to.equal('setup');
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
            expect(a.r.gruende.join(' ')).to.match(/Sensorkorrektur: Ziel 21 °C, Anlage 22(\.5)? °C/);
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

    it('eigene Werte je Teil: Kennlinie, Grenzen und Temperaturstufen je Geraet; leer faellt auf Vorlage und Werksvorgabe zurueck', () => {
        const e = konfigAusInstanz({
            regelUntergrenze: 45,
            regelKennlinieHeizen: '-10:90, 15:45',
            regelGeraete: [
                {
                    geraet: 'A',
                    individuell: true,
                    kennlinieHeizen: '-5:80, 10:50',
                    obergrenze: 85,
                    stufen: [{ name: 'Tag', soll: 22 }],
                },
                { geraet: 'B', individuell: true, strategie: 'vortag', vortagZuschlag: 15 },
            ],
        });
        // was eigen ist, sagt die Konfiguration je Teil - ohne Haken
        expect(e.fuer('A', 'A').konfig.eigen).to.eql(['kennlinieHeizen', 'grenzen', 'stufen']);
        expect(e.fuer('B', 'B').konfig.eigen).to.eql(['strategie']);
        expect(e.fuer('C', 'C').konfig.eigen).to.eql([]);
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
        expect(e.fuer('C', 'C').konfig.bedarf.obergrenze).to.equal(100);
    });

    it('kein Haken mehr: je Teil gilt der eigene Wert der Zeile, sonst die Vorlage; ein altes Feld `individuell` zaehlt nicht', () => {
        const zeile = {
            geraet: 'A',
            betrieb: 'faikout',
            frostAb: 8,
            raumQuelle: 'dp',
            raumDp: 'x.0.raum',
            strategie: 'vortag',
            kennlinieHeizen: '-5:80, 10:50',
            kennlinieKuehlen: '20:50, 30:90',
            untergrenze: 50,
            obergrenze: 85,
            vortagBezug: 'mittel',
            vortagZuschlag: 25,
            vortagReferenzW: 700,
            stufen: [{ name: 'Tag', soll: 22 }],
            feuchteMassnahme: 'melden',
        };
        const c = {
            regelUntergrenze: 45,
            regelKennlinieHeizen: '-10:90, 15:45',
            regelStufen: [{ name: 'Wach', soll: 20 }],
            regelFeuchteMassnahme: 'entfeuchten',
        };
        // alle Teile eigen - gleich, was in einem uebrig gebliebenen `individuell` steht
        for (const individuell of [true, false, undefined, 'true', 1]) {
            const mit = konfigAusInstanz({ ...c, regelGeraete: [{ ...zeile, individuell }] }).fuer('A', 'A').konfig;
            expect(mit.eigen, String(individuell)).to.eql(['kennlinieHeizen', 'kennlinieKuehlen', 'grenzen', 'stufen', 'strategie', 'feuchte']);
            expect(mit.bedarf.strategie).to.equal('vortag');
            expect([mit.bedarf.untergrenze, mit.bedarf.obergrenze]).to.eql([50, 85]);
            expect(mit.bedarf.vortag).to.include({ bezug: 'mittel', zuschlag: 25, referenzW: 700 });
            expect([...mit.szenen.keys()]).to.eql(['tag']);
            expect(mit.feuchte.massnahme).to.equal('melden');
            expect('individuell' in mit).to.equal(false);
        }
        // nur geraetebezogene Felder: alles aus der Vorlage
        const nur = { geraet: 'A', betrieb: 'faikout', frostAb: 8, raumQuelle: 'dp', raumDp: 'x.0.raum' };
        for (const leer of [{}, { strategie: '', kennlinieHeizen: [], kennlinieKuehlen: [], untergrenze: '', obergrenze: null, vortagBezug: '', stufen: [], feuchteMassnahme: ' ' }]) {
            const k = konfigAusInstanz({ ...c, regelGeraete: [{ ...nur, ...leer }] }).fuer('A', 'A').konfig;
            expect(k.eigen).to.eql([]);
            expect(k.bedarf.strategie).to.equal('kennlinie');
            expect(k.bedarf.heizen).to.eql([
                [-10, 90],
                [15, 45],
            ]);
            expect(k.bedarf.kuehlen).to.eql(kennlinie.VORGABE_KUEHLEN);
            expect([k.bedarf.untergrenze, k.bedarf.obergrenze]).to.eql([45, 100]);
            expect(k.bedarf.vortag).to.include({ bezug: 'spitze', zuschlag: 10, referenzW: 1000 });
            expect([...k.szenen.keys()]).to.eql(['wach']);
            expect(k.feuchte.massnahme).to.equal('entfeuchten');
            // immer geraetebezogen: Betrieb, Fuehler, Frostschutz
            expect(k.betrieb).to.equal('faikout');
            expect(k.frostAb).to.equal(8);
            expect(k.quellen.raum).to.eql({ wahl: 'dp', dp: 'x.0.raum' });
        }
        // je Teil einzeln: genau dieser Teil ist eigen, alles andere kommt aus der Vorlage
        for (const [teil, felder, pruefe] of [
            ['kennlinieHeizen', { kennlinieHeizen: zeile.kennlinieHeizen }, k => expect(k.bedarf.heizen[0]).to.eql([-5, 80])],
            ['kennlinieKuehlen', { kennlinieKuehlen: zeile.kennlinieKuehlen }, k => expect(k.bedarf.kuehlen[0]).to.eql([20, 50])],
            ['grenzen', { untergrenze: 50 }, k => expect([k.bedarf.untergrenze, k.bedarf.obergrenze]).to.eql([50, 100])],
            ['grenzen', { obergrenze: 85 }, k => expect([k.bedarf.untergrenze, k.bedarf.obergrenze]).to.eql([45, 85])],
            ['stufen', { stufen: zeile.stufen }, k => expect([...k.szenen.keys()]).to.eql(['tag'])],
            ['strategie', { strategie: 'vortag' }, k => expect(k.bedarf.strategie).to.equal('vortag')],
            ['strategie', { vortagZuschlag: 25 }, k => expect(k.bedarf.vortag.zuschlag).to.equal(25)],
            ['feuchte', { feuchteMassnahme: 'melden' }, k => expect(k.feuchte.massnahme).to.equal('melden')],
        ]) {
            const k = konfigAusInstanz({ ...c, regelGeraete: [{ ...nur, ...felder }] }).fuer('A', 'A').konfig;
            expect(k.eigen, JSON.stringify(felder)).to.eql([teil]);
            pruefe(k);
            if (teil !== 'stufen') {
                expect([...k.szenen.keys()]).to.eql(['wach']);
            }
            if (teil !== 'kennlinieHeizen') {
                expect(k.bedarf.heizen[0]).to.eql([-10, 90]);
            }
        }
        // die Zeile selbst wird nie veraendert (nichts geloescht)
        expect(zeile.stufen).to.eql([{ name: 'Tag', soll: 22 }]);
        // alte Feldnamen (szenen, regelSzenen) liest die Regelung nicht mehr - der Umzug beim Start setzt sie um
        const alt = konfigAusInstanz({ regelSzenen: [{ name: 'Alt', soll: 20 }], regelGeraete: [{ geraet: 'A', szenen: [{ name: 'Alt2', soll: 20 }] }] });
        expect([...alt.fuer('A', 'A').konfig.szenen.keys()]).to.eql(['komfort', 'absenken', 'abwesend', 'aus']);
    });

    it('fehlerhafte Szene oder Kennlinie stoert nur das eine Geraet', () => {
        const e = konfigAusInstanz({
            regelGeraete: [
                { geraet: 'A', individuell: true, stufen: [{ name: 'X', soll: 99 }] },
                { geraet: 'B', individuell: true, kennlinieHeizen: '0:50, 10:90' },
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
        await a.regelung.schalter(id, 'schedule.weekJson', planText);
        await a.regelung.schalter(id, 'schedule.active', true);
    };
    const themen = (anlage, feld) => anlage.befehle.filter(b => b.topic.endsWith(`/${feld}`)).map(b => b.nutzlast);

    it('Plan schaltet zur Schaltzeit um: ein Befehl je Feld, danach Ruhe', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan A', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_A');
        await laufen(a, uhr, anlage, 20);
        expect(anlage.befehle).to.eql([]); // Komfort passt schon
        expect(a.wert('Plan_A.regulation.schedule.level')).to.equal('Komfort');
        expect(a.wert('Plan_A.regulation.schedule.next')).to.equal(ort(2026, 11, 20, 22, 0));
        await laufen(a, uhr, anlage, 30); // ueber 22:00
        expect(themen(anlage, 'temp')).to.eql(['19']);
        expect(themen(anlage, 'fan')).to.eql(['night']);
        expect(themen(anlage, 'mode')).to.eql([]);
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_A.regulation.schedule.level')).to.equal('Absenken');
        expect(a.wert('Plan_A.regulation.manual.locked')).to.equal(false);
        expect(a.wert('Plan_A.regulation.state')).to.equal('ok');
    });

    it('Probelauf: kein einziger Befehl, aber "würde senden" steht im Datenpunkt', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: true }, START);
        const anlage = new Anlage({ name: 'Plan B', target: 23, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_B');
        await laufen(a, uhr, anlage, 45);
        expect(anlage.befehle).to.eql([]);
        expect(a.gesendet).to.eql([]);
        expect(JSON.parse(a.wert('Plan_B.regulation.lastCommand')).action).to.equal('would');
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
        expect(a.wert('Plan_C.regulation.manual.locked')).to.equal(true);
        expect(a.wert('Plan_C.regulation.manual.until')).to.equal(ort(2026, 11, 20, 22, 0));
        expect(a.wert('Plan_C.regulation.state')).to.equal('manual');
        expect(anlage.target).to.equal(24);
        expect(anlage.befehle).to.eql([]);
        await laufen(a, uhr, anlage, 30); // ueber 22:00: Absenken
        expect(a.wert('Plan_C.regulation.manual.locked')).to.equal(false);
        expect(anlage.target).to.equal(19);
    });

    it('Handeingriff ohne wartenden Plan: kein Hinweis (kein Plan hinterlegt, Plan aus, nur Feuchte an)', async () => {
        const faelle = {
            // Feuchteregelung an, Wochenplan aus und keiner hinterlegt
            Hand_A: async (a, id) => {
                await a.regelung.schalter(id, 'humidity.active', true);
            },
            // Plan hinterlegt, aber ausgeschaltet
            Hand_B: async (a, id) => {
                await a.regelung.schalter(id, 'schedule.weekJson', planText);
                await a.regelung.schalter(id, 'humidity.active', true);
            },
            // Plan eingeschaltet, aber keiner hinterlegt
            Hand_C: async (a, id) => {
                await a.regelung.schalter(id, 'schedule.active', true);
            },
        };
        for (const [id, einrichten] of Object.entries(faelle)) {
            const { a, uhr } = aufbau({ regelProbelauf: false }, START);
            const anlage = new Anlage({ name: id.replace('_', ' '), target: 21, mode: 'heat' });
            await laufen(a, uhr, anlage, 2);
            await einrichten(a, id);
            await laufen(a, uhr, anlage, 3);
            anlage.target = 24; // jemand dreht an der Fernbedienung
            await laufen(a, uhr, anlage, 10);
            expect(a.wert(`${id}.regulation.manual.locked`), id).to.equal(false);
            expect(a.wert(`${id}.regulation.manual.until`), id).to.equal(null);
            expect(a.wert(`${id}.regulation.state`), id).to.not.equal('manual');
            expect(a.zeilen.some(z => /manual change detected/.test(z.text)), id).to.equal(false);
            expect(anlage.target, id).to.equal(24);
        }
    });

    it('Wochenplan eingeschaltet, aber keiner hinterlegt: "einrichten" und plan.fehlt - keine Stoerung', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan X', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await a.regelung.schalter('Plan_X', 'schedule.active', true);
        await laufen(a, uhr, anlage, 2);
        expect(a.wert('Plan_X.regulation.state')).to.equal('setup');
        expect(a.wert('Plan_X.regulation.schedule.missing')).to.equal(true);
        expect(a.wert('Plan_X.regulation.reason')).to.contain('kein Wochenplan hinterlegt');
        await a.regelung.schalter('Plan_X', 'schedule.weekJson', planText);
        await laufen(a, uhr, anlage, 2);
        expect(a.wert('Plan_X.regulation.state')).to.equal('ok');
        expect(a.wert('Plan_X.regulation.schedule.missing')).to.equal(false);
    });

    it('hinterlegter Plan mit unbekannter Temperaturstufe: Warnung beim Start, Grund mit Wochentag - auch nach einem Sprachwechsel', async () => {
        // typisch: das Geraet folgt jetzt der Vorlage, sein Plan nennt noch die frueheren eigenen Stufen
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const alt = JSON.stringify([[{ t: 480, s: 'tag' }], [], [], [], [], [], []]);
        a.werte.set('Plan_Z.regulation.schedule.weekJson', { val: alt, ack: true });
        a.werte.set('Plan_Z.regulation.schedule.active', { val: true, ack: true });
        const anlage = new Anlage({ name: 'Plan Z', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        const warnungen = a.zeilen.filter(z => z.stufe === 'warn' && /weekly schedule cannot be used/.test(z.text));
        expect(warnungen).to.have.length(1);
        expect(warnungen[0].text).to.contain('Plan Z').and.to.contain('„tag“').and.to.contain('"Schedules"');
        expect(a.wert('Plan_Z.regulation.reason')).to.contain('Wochenplan: Montag: Temperaturstufe „tag“ gibt es nicht');
        // der Plan selbst bleibt stehen - nichts wird geloescht
        expect(a.wert('Plan_Z.regulation.schedule.weekJson')).to.equal(alt);
        // Sprachwechsel: der Grund bleibt (frueher wurde daraus "kein Wochenplan hinterlegt")
        a.getForeignObjectAsync = async id => (id === 'system.config' ? { common: { language: 'en' } } : null);
        try {
            expect(await a.regelung.sprachWechsel()).to.equal(true);
            expect(a.wert('Plan_Z.regulation.reason')).to.contain('Monday: temperature level “tag” does not exist');
        } finally {
            a.getForeignObjectAsync = async id => (id === 'system.config' ? { common: { language: 'de' } } : null);
            await a.regelung.sprachWechsel();
        }
        // ohne Plan und mit lesbarem Plan keine Warnung
        const { a: b, uhr: uhrB } = aufbau({ regelProbelauf: false }, START);
        b.werte.set('Plan_Q.regulation.schedule.weekJson', { val: planText, ack: true });
        b.werte.set('Plan_Q.regulation.schedule.active', { val: true, ack: true });
        await laufen(b, uhrB, new Anlage({ name: 'Plan Q', target: 21, mode: 'heat' }), 2);
        expect(b.zeilen.some(z => /weekly schedule cannot be used/.test(z.text))).to.equal(false);
    });

    it('entfernte Temperaturstufe mit Ersatzwahl: beim Start (nach "Speichern") ersetzt der Adapter sie in Plan und Abwesenheit - und nur dann', async () => {
        const alt = JSON.stringify([[{ t: 0, s: 'abwesend' }, { t: 480, s: 'komfort' }], [], [], [], [{ t: 600, s: 'abwesend' }], [], []]);
        const neu = JSON.stringify([[{ t: 0, s: 'absenken' }, { t: 480, s: 'komfort' }], [], [], [], [{ t: 600, s: 'absenken' }], [], []]);
        const abw = JSON.stringify({ from: ort(2030, 1, 1), to: ort(2030, 1, 8), level: 'abwesend' });
        // gespeichert: "Abwesend" entfernt; die Ersatzstufe "Absenken" nennt, wofuer sie einspringt
        const ohneAbwesend = [
            { id: 'komfort', name: 'Komfort', soll: 21 },
            { id: 'absenken', name: 'Absenken', soll: 19, fan: 'night', ersetzt: ['abwesend'] },
            { id: 'aus', name: 'Aus', power: false, soll: 17 },
        ];
        const { a, uhr } = aufbau({ regelProbelauf: false, regelStufen: ohneAbwesend }, START);
        a.werte.set('Plan_E.regulation.schedule.weekJson', { val: alt, ack: true });
        a.werte.set('Plan_E.regulation.schedule.absenceJson', { val: abw, ack: true });
        a.werte.set('Plan_E.regulation.schedule.active', { val: true, ack: true });
        await laufen(a, uhr, new Anlage({ name: 'Plan E', target: 21, mode: 'heat' }), 2);
        expect(a.wert('Plan_E.regulation.schedule.weekJson')).to.equal(neu);
        expect(JSON.parse(a.wert('Plan_E.regulation.schedule.absenceJson'))).to.eql({ from: ort(2030, 1, 1), to: ort(2030, 1, 8), level: 'absenken' });
        const meldungen = a.zeilen.filter(z => z.stufe === 'info' && /adapted to the temperature levels/.test(z.text));
        expect(meldungen.map(z => z.text)).to.eql([
            'Plan E: weekly schedule adapted to the temperature levels - removed level "abwesend" replaced by "Absenken"',
            'Plan E: absence adapted to the temperature levels - removed level "abwesend" replaced by "Absenken"',
        ]);
        // der Plan laeuft (keine Warnung "cannot be used")
        expect(a.zeilen.some(z => /weekly schedule cannot be used/.test(z.text))).to.equal(false);
        expect(a.wert('Plan_E.regulation.schedule.level')).to.equal('Absenken'); // Freitag 21:30: seit 10:00 der Ersatz

        // die Stufe gibt es (noch oder wieder): ein alter Ersatz-Eintrag aendert nichts
        const mitAbwesend = [...ohneAbwesend, { id: 'abwesend', name: 'Abwesend', soll: 17 }];
        const { a: b, uhr: uhrB } = aufbau({ regelProbelauf: false, regelStufen: mitAbwesend }, START);
        b.werte.set('Plan_F.regulation.schedule.weekJson', { val: alt, ack: true });
        await laufen(b, uhrB, new Anlage({ name: 'Plan F', target: 21, mode: 'heat' }), 2);
        expect(b.wert('Plan_F.regulation.schedule.weekJson')).to.equal(alt);
        expect(b.zeilen.some(z => /adapted to the temperature levels/.test(z.text))).to.equal(false);

        // individuelles Geraet: es zaehlt der Ersatz in SEINER Liste, nicht der der Vorlage
        const eigene = [
            { name: 'Tag', soll: 22, ersetzt: ['abend'] },
            { name: 'Nacht', soll: 18 },
        ];
        const planEigen = JSON.stringify([[{ t: 360, s: 'tag' }, { t: 1080, s: 'abend' }, { t: 1320, s: 'nacht' }], [], [], [], [], [], []]);
        const { a: c, uhr: uhrC } = aufbau(
            { regelProbelauf: false, regelStufen: ohneAbwesend, regelGeraete: [{ geraet: 'Plan G', individuell: true, stufen: eigene }] },
            START,
        );
        c.werte.set('Plan_G.regulation.schedule.weekJson', { val: planEigen, ack: true });
        await laufen(c, uhrC, new Anlage({ name: 'Plan G', target: 21, mode: 'heat' }), 2);
        expect(c.wert('Plan_G.regulation.schedule.weekJson')).to.equal(planEigen.replace('abend', 'tag'));

        // eigene Stufen auf die Vorlage zurueckgesetzt (Rueckfrage der Einstellungsseite): der Ersatz steht in der
        // Geraetezeile (stufenErsatz) und gilt nur fuer diese Anlage - eine zweite mit demselben Plan bleibt
        const planTagNacht = JSON.stringify([[{ t: 0, s: 'nacht' }, { t: 420, s: 'tag' }, { t: 1320, s: 'nacht' }], [], [], [], [], [], []]);
        const vorlageStufen = ohneAbwesend.map(s => ({ ...s, ersetzt: undefined }));
        const { a: d, uhr: uhrD } = aufbau(
            { regelProbelauf: false, regelStufen: vorlageStufen, regelGeraete: [{ geraet: 'Plan H', stufen: [], stufenErsatz: { tag: 'komfort', nacht: 'absenken', komfort: 'aus' } }] },
            START,
        );
        d.werte.set('Plan_H.regulation.schedule.weekJson', { val: planTagNacht, ack: true });
        d.werte.set('Plan_I.regulation.schedule.weekJson', { val: planTagNacht, ack: true });
        await laufen(d, uhrD, new Anlage({ name: 'Plan H', target: 21, mode: 'heat' }), 2);
        await laufen(d, uhrD, new Anlage({ name: 'Plan I', target: 21, mode: 'heat' }), 2);
        // vorhandene Stufen ("komfort") werden nie ersetzt - auch wenn die Zeile etwas anderes sagt
        expect(d.wert('Plan_H.regulation.schedule.weekJson')).to.equal(planTagNacht.replace(/nacht/g, 'absenken').replace('tag', 'komfort'));
        expect(d.wert('Plan_I.regulation.schedule.weekJson')).to.equal(planTagNacht);
        // hat die Anlage (wieder) eigene Stufen, ist der Ersatz der Zeile hinfaellig
        const { a: e, uhr: uhrE } = aufbau(
            { regelProbelauf: false, regelStufen: vorlageStufen, regelGeraete: [{ geraet: 'Plan J', stufen: [{ name: 'Wach', soll: 21 }], stufenErsatz: { tag: 'wach' } }] },
            START,
        );
        e.werte.set('Plan_J.regulation.schedule.weekJson', { val: planTagNacht, ack: true });
        await laufen(e, uhrE, new Anlage({ name: 'Plan J', target: 21, mode: 'heat' }), 2);
        expect(e.wert('Plan_J.regulation.schedule.weekJson')).to.equal(planTagNacht);
    });

    it('Ersatz entfernter Stufen: Kette, unbekannte ohne Ersatz bleiben, vorhandene Stufen werden nie ersetzt', () => {
        const liste = [
            { name: 'A', soll: 20, ersetzt: ['c', 'd'] }, // d wurde frueher durch c ersetzt, c jetzt durch a
            { name: 'B', soll: 18, ersetzt: ['b', 'A', 'x'] }, // sich selbst und Vorhandenes: wirkungslos
        ];
        const sz = wochenplan.szenenLesen(liste).szenen;
        const ersatz = wochenplan.ersatzLesen(liste);
        expect([...ersatz]).to.eql([['c', 'a'], ['d', 'a'], ['a', 'b'], ['x', 'b']]);
        expect(wochenplan.ersatzZiel('c', ersatz, sz)).to.equal('a');
        expect(wochenplan.ersatzZiel('gibtsnicht', ersatz, sz)).to.equal(null);
        // Kette ueber eine Stufe, die es selbst nicht mehr gibt
        expect(wochenplan.ersatzZiel('q', new Map([['q', 'r'], ['r', 'a']]), sz)).to.equal('a');
        expect(wochenplan.ersatzZiel('q', new Map([['q', 'r'], ['r', 'q']]), sz)).to.equal(null); // Kreis
        const roh = JSON.stringify([[{ t: 0, s: 'a' }, { t: 60, s: 'c' }], [{ t: 0, s: 'weg' }], [], [], [], [], [{ t: 5, s: 'd', x: 1 }]]);
        const r = wochenplan.planErsetzen(roh, ersatz, sz);
        expect(r.ersetzt).to.eql([{ von: 'c', nach: 'a' }, { von: 'd', nach: 'a' }]);
        // "a" bleibt "a", obwohl ein Eintrag a -> b existiert; "weg" hat keinen Ersatz und bleibt stehen
        expect(r.plan).to.eql([[{ t: 0, s: 'a' }, { t: 60, s: 'a' }], [{ t: 0, s: 'weg' }], [], [], [], [], [{ t: 5, s: 'a', x: 1 }]]);
        expect(wochenplan.planLesen(r.plan, sz).fehler).to.contain('weg');
        expect(wochenplan.planErsetzen('', ersatz, sz)).to.equal(null);
        expect(wochenplan.planErsetzen('{kaputt', ersatz, sz)).to.equal(null);
        expect(wochenplan.planErsetzen([[], []], ersatz, sz)).to.equal(null);
        expect(wochenplan.planStufen(roh)).to.eql(['a', 'c', 'weg', 'd']);
        expect(wochenplan.planStufen('')).to.eql([]);
        // ohne Ersatzangaben: leere Zuordnung, `ersetzt` stoert szenenLesen nicht
        expect(wochenplan.ersatzLesen([]).size).to.equal(0);
        expect(wochenplan.ersatzLesen(null).size).to.equal(0);
        // Ersatz aus der Geraetezeile (eigene Stufen zurueckgesetzt): ergaenzt, die Liste geht vor, Unsinn faellt weg
        expect([...wochenplan.ersatzLesen(liste, { Tag: 'a', c: 'b', a: 'a', leer: '', zahl: 5 })]).to.eql([['c', 'a'], ['d', 'a'], ['a', 'b'], ['x', 'b'], ['tag', 'a']]);
        expect([...wochenplan.ersatzLesen([], { tag: 'komfort' })]).to.eql([['tag', 'komfort']]);
        expect(wochenplan.ersatzLesen([], ['tag']).size).to.equal(0);
        expect([...sz.keys()]).to.eql(['a', 'b']);
    });

    it('Knoepfe +/- auf der Karte: ein Schritt der Anlage vom jetzigen Sollwert, in den Grenzen', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan Y', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        // Geschrieben wird control.target OHNE ack - den Befehl ans Modul schickt danach main.js
        // (onStateChange) wie bei jedem Schreiben im Objektbaum.
        const druecken = async feld => {
            expect(await a.regelung.schalter('Plan_Y', feld, true)).to.equal(true);
            return a.werte.get('Plan_Y.control.target');
        };
        expect(await druecken('target.up')).to.eql({ val: 21.5, ack: false });
        expect(await druecken('target.down')).to.eql({ val: 21, ack: false });
        expect(await druecken('target.down')).to.eql({ val: 20.5, ack: false });
        // an der Grenze der Anlage bleibt der Wert stehen
        a.geraete.get('Plan_Y').grenzen = { min: 18, max: 30, step: 1 };
        await a.setStateAsync('Plan_Y.control.target', { val: 18, ack: true });
        expect(await druecken('target.down')).to.eql({ val: 18, ack: true });
        expect(await druecken('target.up')).to.eql({ val: 19, ack: false });
    });

    it('Knopf "Automatik fortsetzen" hebt die Sperre sofort auf', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan D', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_D');
        await laufen(a, uhr, anlage, 2);
        anlage.power = false;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Plan_D.regulation.manual.locked')).to.equal(true);
        await a.regelung.schalter('Plan_D', 'manual.resume', true);
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
        expect(a.wert('Plan_E.regulation.state')).to.equal('fault');
        expect(a.wert('Plan_E.regulation.reason')).to.match(/nicht übernommen: target/);
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
        expect(a.wert('Plan_F.regulation.state')).to.equal('offline');
        expect(a.gesendet).to.eql([]);
        anlage.verbunden = true;
        await laufen(a, uhr, anlage, 3);
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_F.regulation.state')).to.equal('ok');
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
        expect(a.wert('Plan_G.regulation.sensors.roomSource')).to.equal('Datenpunkt');
        // Fuehler friert ein: Rueckfall auf den Fuehler der Anlage, control hoert auf
        const vorher = themen(anlage, 'control').length;
        await laufen(a, uhr, anlage, 30);
        expect(a.wert('Plan_G.regulation.sensors.roomSource')).to.match(/Rückfall: Datenpunkt veraltet/);
        expect(themen(anlage, 'control').length - vorher).to.be.at.most(4);
    });

    it('Neustart mitten im Entfeuchten: Eingriff laeuft weiter, kein Handeingriff, kein zweiter Befehl', async () => {
        const sommer = ort(2026, 7, 15, 14, 0);
        const kuehlSzenen = [{ name: 'Tag', mode: 'cool', soll: 24 }];
        const konfig = { regelProbelauf: false, regelStufen: kuehlSzenen };
        const woche = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(() => [{ t: 0, s: 'tag' }]));
        const { a, uhr } = aufbau(konfig, sommer);
        const anlage = new Anlage({ name: 'Plan H', target: 24, mode: 'cool', outside: 30, temp: 25, hum: 75 });
        await laufen(a, uhr, anlage, 2);
        await a.regelung.schalter('Plan_H', 'schedule.weekJson', woche);
        await a.regelung.schalter('Plan_H', 'schedule.active', true);
        await a.regelung.schalter('Plan_H', 'humidity.active', true);
        await laufen(a, uhr, anlage, 5);
        expect(anlage.mode).to.equal('dry');
        expect(a.wert('Plan_H.regulation.humidity.intervention')).to.equal(true);
        await a.regelung.sichernAlle();
        // neuer Adapter, gleiche Datenbank
        const neu = aufbau(konfig, uhr.t);
        neu.a.werte = a.werte;
        neu.a.objekte = a.objekte;
        const davor = anlage.befehle.length;
        await laufen(neu.a, neu.uhr, anlage, 5);
        expect(anlage.befehle.length).to.equal(davor);
        expect(neu.a.wert('Plan_H.regulation.manual.locked')).to.equal(false);
        expect(neu.a.wert('Plan_H.regulation.humidity.intervention')).to.equal(true);
        anlage.hum = 50; // trocken: nach Mindestlaufzeit (20 min ab urspruenglichem Beginn) zurueck auf Kuehlen
        await laufen(neu.a, neu.uhr, anlage, 15);
        expect(anlage.mode).to.equal('cool');
        expect(neu.a.wert('Plan_H.regulation.humidity.intervention')).to.equal(false);
    });

    it('BLE an/aus: Quelle wechselt, Zielband ohne env solange BLE meldet', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        const anlage = new Anlage({ name: 'Plan I', target: 21, mode: 'heat', ble: { temp: 20.8, hum: 44 } });
        await laufen(a, uhr, anlage, 2);
        await scharf(a, 'Plan_I');
        await laufen(a, uhr, anlage, 6);
        expect(a.wert('Plan_I.regulation.sensors.roomSource')).to.equal('BLE-Sensor am Modul');
        expect(a.wert('Plan_I.regulation.sensors.room')).to.equal(20.8);
        expect(themen(anlage, 'control').map(n => JSON.parse(n))[0]).to.eql({ target: 21 });
        anlage.ble = null;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Plan_I.regulation.sensors.roomSource')).to.equal('Sensor der Anlage');
    });

    it('Schreiblast: ein ruhiger Tag erzeugt wenige Schreibvorgaenge und kaum Befehle', async function () {
        this.timeout(60000);
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true }, ort(2026, 11, 20, 0, 0));
        const anlage = new Anlage({ name: 'Plan J', target: 19, mode: 'heat', fan: 'night', outside: 4 });
        let schreibvorgaenge = 0;
        const setState = a.setState.bind(a);
        const setStateAsync = a.setStateAsync.bind(a);
        a.setState = async (id, w) => {
            schreibvorgaenge += id.includes('.regulation.') ? 1 : 0;
            return setState(id, w);
        };
        a.setStateAsync = async (id, w) => {
            schreibvorgaenge += id.includes('.regulation.') ? 1 : 0;
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
        console.log(`        Schreibvorgaenge regulation.* in 24 h: ${schreibvorgaenge}, Befehle: ${anlage.befehle.length}`);
        expect(schreibvorgaenge).to.be.below(24 * 60); // deutlich unter einem Schreibvorgang je Minute
    });
});
