'use strict';

/*
 * Bedarfsregelung (lib/regel): Rechenkern, Schreiber, Faehigkeit, Zustand und - ueber den
 * Simulator test/sim - der ganze Weg vom MQTT-Status bis zum (nicht) gesendeten Befehl.
 */

const { expect } = require('chai');
const kennlinie = require('../lib/regel/kennlinie');
const fuehler = require('../lib/regel/fuehler');
const bedarf = require('../lib/regel/bedarf');
const schreiber = require('../lib/regel/schreiber');
const faehigkeit = require('../lib/regel/faehigkeit');
const zustand = require('../lib/regel/zustand');
const { konfigAusInstanz } = require('../lib/regel');
const { Anlage, aufbau, laufen } = require('./sim/simulator');

const T0 = Date.parse('2026-11-20T22:00:00');
const K = bedarf.konfigPruefen().konfig;
const eingang = (x = {}) => ({
    power: true,
    mode: 'heat',
    aussen: { wert: 0, zeit: T0 },
    raum: { wert: 21, zeit: T0 },
    ziel: 21,
    econo: false,
    abtauen: false,
    faehig: 'unknown',
    ...x,
});

describe('Regelung: Kennlinie', () => {
    it('rechnet stueckweise linear und haelt die Enden', () => {
        const p = kennlinie.VORGABE_HEIZEN;
        // Werksvorgabe seit 21.11.2026: oberster Punkt -10 °C -> 100 % (vorher 95)
        expect(kennlinie.wert(p, -20)).to.equal(100);
        expect(kennlinie.wert(p, -10)).to.equal(100);
        expect(kennlinie.wert(p, -5)).to.equal(87.5);
        expect(kennlinie.VORGABE_HEIZEN_ALT[0]).to.eql([-10, 95]);
        expect(kennlinie.wert(p, 0)).to.equal(75);
        expect(kennlinie.wert(p, 3.5)).to.equal(65);
        expect(kennlinie.wert(p, 11)).to.equal(47.5);
        expect(kennlinie.wert(p, 30)).to.equal(40);
        expect(kennlinie.wert(kennlinie.VORGABE_KUEHLEN, 27.5)).to.equal(52.5);
    });

    it('meldet Monotonie- und Formfehler als Konfigurationsfehler statt still zu rechnen', () => {
        expect(kennlinie.pruefen(kennlinie.VORGABE_HEIZEN, 'fallend')).to.equal(null);
        expect(kennlinie.pruefen(kennlinie.VORGABE_KUEHLEN, 'steigend')).to.equal(null);
        expect(kennlinie.pruefen([[0, 50], [5, 60]], 'fallend')).to.match(/nicht fallend/);
        expect(kennlinie.pruefen([[5, 50], [0, 40]], 'fallend')).to.match(/nicht aufsteigend/);
        expect(kennlinie.pruefen([[0, 50]], 'fallend')).to.match(/mindestens zwei/);
        expect(kennlinie.pruefen([[0, 150], [5, 40]], 'fallend')).to.match(/außerhalb/);
        const k = bedarf.konfigPruefen({ heizen: '-10:95, 0:75, 7:80' });
        expect(k.fehler).to.match(/^Heizkennlinie: Kennlinie nicht fallend/);
        expect(bedarf.konfigPruefen({ heizen: '-10:95; 0:75; 7:55; 15:40' }).fehler).to.equal(null);
    });

    it('fuehrt einen Konfigurationsfehler als Zustand "gestört" und sendet nichts', async () => {
        const { a, uhr } = aufbau({ regelKennlinieHeizen: '0:50, 5:60', regelProbelauf: false });
        const anlage = new Anlage({ name: 'Daikin K' });
        await laufen(a, uhr, anlage, 2);
        expect(a.wert('Daikin_K.regulation.demand.state')).to.equal('fault');
        expect(a.wert('Daikin_K.regulation.demand.reason')).to.match(/Konfigurationsfehler/);
        expect(a.gesendet).to.have.length(0);
    });
});

describe('Regelung: Fuehler', () => {
    it('verwirft veraltete und unplausible Werte', () => {
        expect(fuehler.bewerten({ wert: 5, zeit: T0 - 61 * 60000 }, T0, fuehler.AUSSEN).gueltig).to.equal(false);
        expect(fuehler.bewerten({ wert: 5, zeit: T0 - 59 * 60000 }, T0, fuehler.AUSSEN).gueltig).to.equal(true);
        expect(fuehler.bewerten({ wert: 21, zeit: T0 - 16 * 60000 }, T0, fuehler.RAUM).gueltig).to.equal(false);
        expect(fuehler.bewerten({ wert: 99, zeit: T0 }, T0, fuehler.AUSSEN).grund).to.match(/unplausibel/);
        expect(fuehler.bewerten(null, T0, fuehler.AUSSEN).gueltig).to.equal(false);
    });

    it('uebernimmt einen Sprung erst bei Bestaetigung', () => {
        let r = fuehler.bewerten({ wert: 5, zeit: T0 }, T0, fuehler.AUSSEN);
        r = fuehler.bewerten({ wert: 20, zeit: T0 }, T0, fuehler.AUSSEN, r.merker);
        expect(r.wert).to.equal(5);
        expect(r.grund).to.match(/verworfen/);
        r = fuehler.bewerten({ wert: 20.5, zeit: T0 }, T0, fuehler.AUSSEN, r.merker);
        expect(r.wert).to.equal(20.5);
    });
});

describe('Regelung: Rechenkern', () => {
    it('stuft auf 5 %, haelt 40..95 und bildet das Aussenmittel ueber 30 min', () => {
        let z = null;
        let erg;
        for (let i = 0; i <= 40; i++) {
            const t = T0 + i * 60000;
            ({ ergebnis: erg, zustand: z } = bedarf.berechnen(eingang({ aussen: { wert: i < 20 ? 0 : 7, zeit: t }, raum: { wert: 21, zeit: t } }), K, z, t));
        }
        // letzte 30 min: 10x 0 °C (Minuten 11..19 + Grenze) und 21x 7 °C
        expect(erg.aussenMittel).to.be.within(4, 5.5);
        expect(erg.sollwert % 5).to.equal(0);
        expect(erg.sollwert).to.be.within(55, 75);
        const kalt = bedarf.berechnen(eingang({ aussen: { wert: -30, zeit: T0 } }), K, null, T0).ergebnis;
        // Vorgabe-Obergrenze 100: die Kennlinie darf die volle Leistung selbst erreichen - das ist
        // aber keine "volle Freigabe" (voll), die an der Hoechstleistung einer Temperaturstufe vorbeigeht
        expect(kalt.sollwert).to.equal(100);
        expect(kalt.voll).to.equal(false);
        const begrenzt = bedarf.berechnen(eingang({ aussen: { wert: -30, zeit: T0 } }), { ...K, obergrenze: 95 }, null, T0).ergebnis;
        expect(begrenzt.sollwert).to.equal(95);
        const warm = bedarf.berechnen(eingang({ aussen: { wert: 20, zeit: T0 } }), K, null, T0).ergebnis;
        expect(warm.sollwert).to.equal(40);
    });

    it('korrigiert ueber den Raum: Totband, +10 %/K, Abregeln, 100 % ab 2 K', () => {
        const mit = raum => bedarf.berechnen(eingang({ raum: { wert: raum, zeit: T0 } }), K, null, T0).ergebnis;
        expect(mit(20.8).sollwert).to.equal(75); // im Totband
        expect(mit(20).sollwert).to.equal(80); // 1 K unter Ziel: +7 Pkt. -> 82 -> 80
        expect(mit(19.5).sollwert).to.equal(85); // 1,5 K: +12 -> 87 -> 85
        expect(mit(22).sollwert).to.equal(70); // 1 K drueber: -7 -> 68 -> 70
        expect(mit(19).sollwert).to.equal(100); // 2 K unter Ziel
        expect(mit(19).grund).to.match(/volle Leistung/);
    });

    it('Rechenweg als Daten (`weg`): dieselben Zahlen wie der Begruendungstext - Grundwert, Raumkorrektur, Grenze, Sonderfaelle', () => {
        const mit = (raum, mehr = {}, k = K) => bedarf.berechnen(eingang({ raum: raum === null ? null : { wert: raum, zeit: T0 }, ...mehr }), k, null, T0).ergebnis;
        // im Totband: keine Korrektur
        expect(mit(20.8).weg).to.include({ art: 'normal', strategie: 'kennlinie', richtung: 'heizen', basis: 75, aussen: 0, raum: 20.8, ziel: 21, abweichung: 0.2, korrektur: 0, grenze: null, sollwert: 75, totband: 0.3, prozentProK: 10 });
        // 1 K zu kalt: +7 Punkte (0,3 K Totband), 1 K zu warm: -7
        expect(mit(20).weg).to.include({ abweichung: 1, korrektur: 7, sollwert: 80 });
        expect(mit(22).weg).to.include({ abweichung: -1, korrektur: -7, sollwert: 70 });
        // die Zahlen stehen genauso im Text
        expect(mit(22).grund).to.contain('→ 75 %').and.to.contain('Korrektur -7 Pkt.');
        // volle Leistung und Ueberheizschutz mit ihrer Schwelle
        expect(mit(19).weg).to.include({ art: 'voll', schwelle: 2, sollwert: 100, abweichung: 2 });
        expect(mit(22.6).weg).to.include({ art: 'ueber', schwelle: 1.5, sollwert: 30, abweichung: -1.6 });
        // Grenzen: unten (warm draussen, Raum drueber) und oben (Obergrenze 80)
        expect(mit(21.9, { aussen: { wert: 15, zeit: T0 } }).weg).to.include({ basis: 40, korrektur: -6, grenze: 'unter', sollwert: 40 });
        const eng = bedarf.konfigPruefen({ obergrenze: 80 }).konfig;
        expect(mit(20, { aussen: { wert: -10, zeit: T0 } }, eng).weg).to.include({ basis: 100, korrektur: 7, grenze: 'ober', sollwert: 80 });
        // ohne Raumsensor: keine Abweichung, keine Korrektur
        expect(mit(null).weg).to.include({ raum: null, abweichung: null, korrektur: 0, sollwert: 75 });
        // Kuehlen: > 0 heisst "Raum zu warm"
        const kuehl = mit(25, { mode: 'cool', aussen: { wert: 30, zeit: T0 }, ziel: 24 });
        expect(kuehl.weg).to.include({ richtung: 'kuehlen', basis: 65, abweichung: 1, korrektur: 7, sollwert: 70 });
        // eigene Einstellungen der Raumkorrektur stehen im Weg
        const stark = bedarf.konfigPruefen({ prozentProK: 20, totband: 0.5 }).konfig;
        expect(mit(20, {}, stark).weg).to.include({ korrektur: 10, prozentProK: 20, totband: 0.5, sollwert: 85 });
        // neutral: kein Weg; Rueckfall und Abtauen: eigene Art
        expect(mit(21, { power: false }).weg).to.equal(null);
        expect(mit(21, { aussen: null }).weg).to.eql({ art: 'rueckfall', strategie: 'kennlinie', richtung: 'heizen', sollwert: 100 });
        const vorher = bedarf.berechnen(eingang(), K, null, T0);
        const taut = bedarf.berechnen(eingang({ abtauen: true }), K, vorher.zustand, T0 + 60000).ergebnis;
        expect(taut.weg).to.eql({ art: 'abtauen', richtung: 'heizen', sollwert: 75 });
    });

    it('ist neutral bei Geraet aus, Entfeuchten, Umluft - und kuehlt nach der Kuehlkennlinie', () => {
        expect(bedarf.berechnen(eingang({ power: false }), K, null, T0).ergebnis.zustand).to.equal('neutral');
        expect(bedarf.berechnen(eingang({ mode: 'dry' }), K, null, T0).ergebnis.sollwert).to.equal(null);
        expect(bedarf.berechnen(eingang({ mode: 'fan_only' }), K, null, T0).ergebnis.zustand).to.equal('neutral');
        const k = bedarf.berechnen(eingang({ mode: 'cool', aussen: { wert: 30, zeit: T0 }, ziel: 24, raum: { wert: 24, zeit: T0 } }), K, null, T0);
        expect(k.ergebnis.sollwert).to.equal(65);
        const auto = bedarf.berechnen(eingang({ mode: 'heat_cool', heat: false, aussen: { wert: 30, zeit: T0 }, ziel: 24, raum: { wert: 24, zeit: T0 } }), K, null, T0);
        expect(auto.ergebnis.sollwert).to.equal(65);
    });

    it('friert beim Abtauen ein, danach normale Rechnung (keine Sonderregel)', () => {
        let r = bedarf.berechnen(eingang(), K, null, T0);
        expect(r.ergebnis.sollwert).to.equal(75);
        r = bedarf.berechnen(eingang({ abtauen: true, aussen: { wert: -10, zeit: T0 + 60000 } }), K, r.zustand, T0 + 60000);
        expect(r.ergebnis.sollwert).to.equal(75);
        r = bedarf.berechnen(eingang({ aussen: { wert: 0, zeit: T0 + 120000 } }), K, r.zustand, T0 + 120000);
        expect(r.ergebnis.sollwert).to.be.below(100);
    });

    it('faellt bei fehlendem/veraltetem Aussenfuehler auf 100 % zurueck ("gestört")', () => {
        const r = bedarf.berechnen(eingang({ aussen: { wert: 3, zeit: T0 - 2 * 3600000 } }), K, null, T0).ergebnis;
        expect(r.sollwert).to.equal(100);
        expect(r.zustand).to.equal('fault');
        expect(bedarf.berechnen(eingang({ aussen: null }), K, null, T0).ergebnis.zustand).to.equal('fault');
    });

    it('meldet den Econo-Konflikt und "nicht fähig"', () => {
        const r = bedarf.berechnen(eingang({ econo: true, faehig: 'no' }), K, null, T0).ergebnis;
        expect(r.konflikt).to.match(/Econo/);
        expect(r.zustand).to.equal('notCapable');
    });
});

describe('Regelung: Strategie Vortag + Zuschlag', () => {
    const stunden = [
        { hour: '2026-11-19T22', kwh: 0.4 },
        { hour: '2026-11-19T23', kwh: 0.6 },
        { hour: '2026-11-19T05', kwh: 0.2 },
        { hour: '2026-11-19T06', kwh: 0 },
        { hour: '2026-11-20T00', kwh: 0.9 },
    ];
    it('liest Spitze und Mittel des Vortags aus der Stundenreihe', () => {
        const v = bedarf.vortagAusStunden(stunden, '2026-11-19');
        expect(v.spitzeW).to.equal(600);
        expect(v.mittelW).to.be.closeTo(400, 0.001);
        expect(v.stunden).to.equal(3);
        expect(bedarf.vortagAusStunden(stunden, '2026-11-18').stunden).to.equal(0);
    });

    it('rechnet Bezug/Referenz + Zuschlag, rundet auf und begrenzt', () => {
        const k = bedarf.konfigPruefen({ strategie: 'vortag', vortag: { referenzW: 1000, zuschlag: 10 } }).konfig;
        const v = bedarf.vortagAusStunden(stunden, '2026-11-19');
        const r = bedarf.berechnen(eingang({ vortag: v }), k, null, T0).ergebnis;
        expect(r.sollwert).to.equal(70); // 600 W / 1000 W = 60 % + 10
        const m = bedarf.konfigPruefen({ strategie: 'vortag', vortag: { bezug: 'mittel', zuschlag: 12 } }).konfig;
        expect(bedarf.berechnen(eingang({ vortag: v }), m, null, T0).ergebnis.sollwert).to.equal(55); // 40+12 -> 55
        const klein = { spitzeW: 50, mittelW: 50, stunden: 2 };
        expect(bedarf.berechnen(eingang({ vortag: klein }), k, null, T0).ergebnis.sollwert).to.equal(40);
        const gross = { spitzeW: 2000, mittelW: 2000, stunden: 2 };
        expect(bedarf.berechnen(eingang({ vortag: gross }), k, null, T0).ergebnis.sollwert).to.equal(95);
    });

    it('Rechenweg Vortag: Prozent des Vortags + Zuschlag, dann die Raumkorrektur', () => {
        const k = bedarf.konfigPruefen({ strategie: 'vortag', vortag: { referenzW: 1000, zuschlag: 10 } }).konfig;
        const v = { spitzeW: 480, mittelW: 300, stunden: 5 };
        const r = bedarf.berechnen(eingang({ vortag: v, raum: { wert: 22, zeit: T0 } }), k, null, T0).ergebnis;
        expect(r.weg).to.include({ art: 'normal', strategie: 'vortag', basis: 58, aussen: null, korrektur: -7, sollwert: 55 });
        expect(r.weg.vortag).to.eql({ prozent: 48, zuschlag: 10 });
        expect(r.grund).to.contain('48 %').and.to.contain('10');
        const ohne = bedarf.berechnen(eingang({ vortag: { spitzeW: 0, mittelW: 0, stunden: 0 } }), k, null, T0).ergebnis;
        expect(ohne.weg).to.eql({ art: 'rueckfall', strategie: 'vortag', richtung: 'heizen', sollwert: 100 });
    });

    it('faellt ohne Vortagsdaten auf 100 % zurueck', () => {
        const k = bedarf.konfigPruefen({ strategie: 'vortag' }).konfig;
        const r = bedarf.berechnen(eingang({ vortag: { spitzeW: 0, mittelW: 0, stunden: 0 } }), k, null, T0).ergebnis;
        expect(r.sollwert).to.equal(100);
        expect(r.grund).to.match(/zu wenig Daten/);
    });
});

describe('Regelung: Schreiber', () => {
    const schritt = (z, soll, ist, t, probelauf = false) =>
        schreiber.entscheiden({ sollwert: soll, istwert: ist, probelauf, faehig: 'yes', jetzt: t, zustand: z });

    it('haelt nach oben 60 s, nach unten 600 s', () => {
        let r = schritt(null, 80, 100, T0);
        expect(r.aktion).to.equal('nichts');
        r = schritt(r.zustand, 80, 100, T0 + 599000);
        expect(r.aktion).to.equal('nichts');
        r = schritt(r.zustand, 80, 100, T0 + 600000);
        expect(r.aktion).to.equal('senden');
        expect(r.wert).to.equal(80);
        let h = schritt(null, 90, 80, T0);
        h = schritt(h.zustand, 90, 80, T0 + 60000);
        expect(h.aktion).to.equal('senden');
    });

    it('haelt 180 s Mindestabstand und hoechstens 12 Befehle je Stunde', () => {
        let z = null;
        let t = T0;
        let ist = 100;
        let gesendet = 0;
        for (let i = 0; i < 240; i++) {
            const soll = i % 2 ? 60 : 65; // wechselt staendig
            const r = schreiber.entscheiden({ sollwert: soll, istwert: ist, probelauf: false, faehig: 'yes', jetzt: t, zustand: z, grenzen: { haltHochMs: 0, haltRunterMs: 0 } });
            z = r.zustand;
            if (r.aktion === 'senden') {
                gesendet++;
                ist = r.wert;
                const vorige = z.befehle[z.befehle.length - 2];
                if (vorige !== undefined) {
                    expect(t - vorige).to.be.at.least(180000);
                }
            }
            expect(r.befehleStunde).to.be.at.most(12);
            t += 15000;
        }
        expect(gesendet).to.be.within(12, 21); // 1 h: 12er-Grenze/180 s-Abstand
    });

    it('sendet nichts bei gleichem Istwert, neutral oder nicht faehiger Anlage', () => {
        expect(schritt(null, 100, 100, T0).aktion).to.equal('nichts');
        expect(schritt(null, null, 100, T0).aktion).to.equal('nichts');
        const r = schreiber.entscheiden({ sollwert: 50, istwert: 100, probelauf: false, faehig: 'no', jetzt: T0, zustand: null, grenzen: { haltRunterMs: 0 } });
        expect(r.aktion).to.equal('nichts');
    });

    it('im Probelauf nie "senden", nur "wuerde" mit virtuellem Istwert', () => {
        let z = null;
        const aktionen = [];
        for (let i = 0; i < 200; i++) {
            const r = schritt(z, i < 100 ? 60 : 85, 100, T0 + i * 60000, true);
            z = r.zustand;
            aktionen.push(r.aktion);
        }
        expect(aktionen).to.not.include('senden');
        expect(aktionen.filter(x => x === 'wuerde')).to.have.length(2);
        expect(z.virtuell).to.equal(85);
    });
});

describe('Regelung: Faehigkeit', () => {
    it('unterscheidet "abgelehnt bei Geraet aus" von "nicht faehig"', () => {
        let f = faehigkeit.bewerten(null, { art: 'abgelehnt', power: false, wert: 80 });
        expect(f.wert).to.equal('unknown');
        expect(f.grund).to.match(/bei Gerät aus/);
        f = faehigkeit.bewerten(f, { art: 'abgelehnt', power: true, wert: 80 });
        expect(f.wert).to.equal('no');
        expect(faehigkeit.bewerten(null, { art: 'angenommen', wert: 70 }).wert).to.equal('yes');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: true, demand: 70 }).wert).to.equal('yes');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: true }).wert).to.equal('no');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: false }).wert).to.equal('unknown');
        const fehlt = faehigkeit.bewerten(null, { art: 'status', vollstaendig: true });
        expect(faehigkeit.bewerten(fehlt, { art: 'status', vollstaendig: true, demand: 100 }).wert).to.equal('unknown');
    });
});

describe('Regelung: Zustand und Einstellungen', () => {
    it('liest Unsinn als leeren Zustand und bewahrt einen gueltigen', () => {
        expect(zustand.lesen('{kaputt').v).to.equal(zustand.VERSION);
        expect(zustand.lesen('{"v":99}').bedarf.aussenVerlauf).to.eql([]);
        const z = zustand.leer();
        z.bedarf.aussenVerlauf = [[T0, 3]];
        z.schreiber.befehle = [T0];
        z.faehig = { wert: 'yes', grund: 'x' };
        const z2 = zustand.lesen(zustand.schreiben(z));
        expect(z2.bedarf.aussenVerlauf).to.eql([[T0, 3]]);
        expect(z2.schreiber.befehle).to.eql([T0]);
        expect(z2.faehig.wert).to.equal('yes');
    });

    it('Probelauf ist ohne Einstellung AN', () => {
        expect(konfigAusInstanz({}).probelaufGlobal).to.equal(true);
        expect(konfigAusInstanz({ regelProbelauf: 'x' }).probelaufGlobal).to.equal(true);
        expect(konfigAusInstanz({ regelProbelauf: false }).probelaufGlobal).to.equal(false);
    });
});

describe('Regelung: Simulator (main.js + Anlage)', function () {
    this.timeout(20000);
    it('Probelauf sendet NIE - Instanz-Probelauf an (auch ohne Schluessel) oder Schalter der Geraetezeile; der Datenpunkt zeigt nur an', async () => {
        const SCHALTER = 'Daikin_Wohnzimmer.regulation.demand.dryRun';
        const zeile = probelauf => ({ regelGeraete: [{ geraet: 'Daikin_Wohnzimmer', probelauf }] });
        // bestand: was vor dem ersten Lauf schon da ist - der alte Schalter als Objekt (schreibbar), ggf. mit Wert
        for (const [config, bestand] of [
            [{}, null], // Schluessel fehlt = Bestand: Instanz-Probelauf gilt als AN
            [{ regelProbelauf: true }, null],
            [{ regelProbelauf: true }, true],
            [{ regelProbelauf: true }, false], // alter Geraeteschalter aus, Instanz an: bleibt Probelauf
            [{ regelProbelauf: true, ...zeile(false) }, false],
            [{ regelProbelauf: true, ...zeile(true) }, undefined],
            [{ regelProbelauf: false, ...zeile(true) }, null], // nur diese Anlage im Probelauf
            [{ regelProbelauf: false, ...zeile(true) }, false],
            [{ regelProbelauf: false, regelGeraete: [{ geraet: 'Daikin Wohnzimmer', probelauf: true }] }, null], // Zeile ueber den Namen
        ]) {
            const { a, uhr } = aufbau({ ...config, regelAktiv: true });
            if (bestand !== null) {
                a.objekte.set(SCHALTER, { type: 'state', common: { type: 'boolean', role: 'switch', write: true, def: true }, native: {} });
                if (bestand !== undefined) {
                    a.werte.set(SCHALTER, { val: bestand, ack: true });
                }
            }
            const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 9 });
            await laufen(a, uhr, anlage, 90, i => {
                anlage.outside = 9 - i / 10;
                anlage.temp = i > 40 ? 22.5 : 21;
                anlage.abtauen = i === 50;
            });
            const fall = JSON.stringify([config, bestand]);
            expect(a.gesendet, fall).to.have.length(0);
            const w = JSON.parse(a.wert('Daikin_Wohnzimmer.regulation.demand.wouldSend'));
            expect(w.action, fall).to.equal('would');
            // der Datenpunkt zeigt den wirksamen Probelauf und ist kein Schalter mehr
            expect(a.wert(SCHALTER), fall).to.equal(true);
            expect(a.objekte.get(SCHALTER).common, fall).to.include({ write: false, role: 'indicator' });
            expect(a.wert('Daikin_Wohnzimmer.regulation.demand.setpoint')).to.be.within(30, 100);
            expect(a.zeilen.filter(z => /would send/.test(z.text)).length).to.be.at.least(1);
        }
    });

    it('EIN Schalter: Instanz-Probelauf aus sendet - auch wenn der alte Geraeteschalter noch auf an stand (wird angeglichen, mit Warnung)', async () => {
        const SCHALTER = 'Daikin_Wohnzimmer.regulation.demand.dryRun';
        for (const [bestand, zeilen] of [
            [null, undefined],
            [true, undefined], // Geraet aus einer aelteren Version: Schalter stand auf an
            [false, undefined],
            [undefined, undefined], // Schalter da, Wert nicht lesbar
            [true, [{ geraet: 'Daikin_Wohnzimmer', probelauf: false }]],
            [true, [{ geraet: 'Andere_Anlage', probelauf: true }]], // der Probelauf einer ANDEREN Anlage wirkt hier nicht
        ]) {
            const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true, ...(zeilen ? { regelGeraete: zeilen } : {}) });
            if (bestand !== null) {
                a.objekte.set(SCHALTER, { type: 'state', common: { type: 'boolean', role: 'switch', write: true, def: true }, native: {} });
                if (bestand !== undefined) {
                    a.werte.set(SCHALTER, { val: bestand, ack: true });
                }
            }
            const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 5 });
            await laufen(a, uhr, anlage, 20);
            const fall = JSON.stringify([bestand, zeilen]);
            expect(a.gesendet.map(g => g.topic), fall).to.eql(['command/Daikin Wohnzimmer/demand']);
            expect(a.wert(SCHALTER), fall).to.equal(false);
            expect(a.objekte.get(SCHALTER).common, fall).to.include({ write: false, role: 'indicator' });
            // nur wer vorher im Geraete-Probelauf hing, bekommt die Warnung "jetzt scharf"
            expect(a.zeilen.filter(z => z.stufe === 'warn' && /now LIVE/.test(z.text)).length, fall).to.equal(bestand === true ? 1 : 0);
        }
    });

    it('Schreiben auf regulation.demand.dryRun schaltet nichts: abgelehnt, zurueckgestellt, Hinweis im Log', async () => {
        const SCHALTER = 'Daikin_Wohnzimmer.regulation.demand.dryRun';
        // Instanz im Probelauf: ein "false" von aussen schaltet NICHT scharf
        const probe = aufbau({ regelProbelauf: true, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 5 });
        await laufen(probe.a, probe.uhr, anlage, 2);
        await probe.a.onStateChange(`faikout.0.${SCHALTER}`, { val: false, ack: false });
        expect(await probe.a.regelung.schalter('Daikin_Wohnzimmer', 'dryRun', false)).to.equal(false);
        await laufen(probe.a, probe.uhr, anlage, 20);
        expect(probe.a.gesendet).to.have.length(0);
        expect(probe.a.wert(SCHALTER)).to.equal(true);
        expect(probe.a.werte.get(SCHALTER).ack).to.equal(true);
        expect(probe.a.zeilen.filter(z => z.stufe === 'warn' && /dryRun is read-only/.test(z.text))).to.have.length(2);
        // Instanz scharf: ein "true" von aussen haelt die Anlage nicht an (dafuer ist der Schalter der Geraetekarte da)
        const scharf = aufbau({ regelProbelauf: false, regelAktiv: true });
        const zweite = new Anlage({ name: 'Daikin Wohnzimmer', outside: 5 });
        await laufen(scharf.a, scharf.uhr, zweite, 1);
        await scharf.a.onStateChange(`faikout.0.${SCHALTER}`, { val: true, ack: false });
        await laufen(scharf.a, scharf.uhr, zweite, 20);
        expect(scharf.a.wert(SCHALTER)).to.equal(false);
        expect(scharf.a.gesendet.map(g => g.topic)).to.eql(['command/Daikin Wohnzimmer/demand']);
        expect(require('../lib/regel').SCHALTER).to.not.have.property('demand.dryRun');
    });

    it('neue Instanz (Vorgaben der io-package): Probelauf aus - ein neu erkanntes Geraet haengt nicht im Probelauf', async () => {
        const io = require('../io-package.json');
        expect(io.native.regelProbelauf).to.equal(false);
        expect(konfigAusInstanz(io.native).probelaufGlobal).to.equal(false);
        // Leistungsgrenze je Geraet eingeschaltet: das neue Geraet sendet ohne weiteren Schalter
        const { a, uhr } = aufbau({ ...io.native, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin Neu', outside: 5 });
        await laufen(a, uhr, anlage, 20);
        expect(a.wert('Daikin_Neu.regulation.demand.dryRun')).to.equal(false);
        expect(a.objekte.get('Daikin_Neu.regulation.demand.dryRun').common.def).to.equal(false);
        expect(a.gesendet.map(g => g.topic)).to.eql(['command/Daikin Neu/demand']);
        // ohne eingeschaltete Leistungsgrenze (Vorgabe der io-package) geht weiterhin nichts hinaus
        const still = aufbau(io.native);
        await laufen(still.a, still.uhr, new Anlage({ name: 'Daikin Neu', outside: 5 }), 20);
        expect(still.a.gesendet).to.have.length(0);
        expect(still.a.wert('Daikin_Neu.regulation.demand.active')).to.equal(false);
    });

    it('scharf (Probelauf der Instanz aus) sendet ueber command/<Name>/demand, Anlage uebernimmt -> faehig "ja"', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 5 });
        await laufen(a, uhr, anlage, 1);
        await laufen(a, uhr, anlage, 20);
        expect(a.gesendet.map(g => g.topic)).to.eql(['command/Daikin Wohnzimmer/demand']);
        expect(a.gesendet[0].nutzlast).to.equal('60');
        expect(anlage.demand).to.equal(60);
        expect(a.wert('Daikin_Wohnzimmer.info.demandCapable')).to.equal('yes');
        // Der Schalter ging NICHT als Befehl ans Modul
        expect(a.gesendet.some(g => /probelauf/.test(g.topic))).to.equal(false);
    });

    it('failed-set bei laufendem Geraet -> "nein", danach keine Befehle mehr', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin 1OG', outside: 5, nimmtDemand: 'nie' });
        await laufen(a, uhr, anlage, 1);
        await laufen(a, uhr, anlage, 60);
        expect(a.gesendet).to.have.length(1);
        expect(a.wert('Daikin_1OG.info.demandCapable')).to.equal('no');
        expect(a.wert('Daikin_1OG.regulation.demand.state')).to.equal('notCapable');
    });

    it('Geraet aus = neutral; Verbindungsabriss -> Fuehler veraltet -> Rueckfall 100', async () => {
        const { a, uhr, regel } = aufbau({ regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin X', power: false });
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Daikin_X.regulation.demand.state')).to.equal('neutral');
        anlage.power = true;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Daikin_X.regulation.demand.state')).to.equal('ok');
        anlage.verbunden = false;
        await laufen(a, uhr, anlage, 70);
        await regel.schritt('Daikin_X'); // Takt ohne Meldung (z. B. Stundenwechsel)
        expect(a.wert('Daikin_X.regulation.demand.setpoint')).to.equal(100);
        expect(a.wert('Daikin_X.regulation.demand.reason')).to.match(/veraltet/);
    });

    it('Neustart: Zustand (Aussenmittel, Befehlszaehler, Faehigkeit) kommt aus zustandJson zurueck', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin N', outside: 0 });
        await laufen(a, uhr, anlage, 20);
        await a.regelung.sichernAlle(); // wie beim Beenden des Adapters
        const gespeichert = a.wert('Daikin_N.regulation.demand.stateJson');
        expect(JSON.parse(gespeichert).bedarf.aussenVerlauf.length).to.be.at.least(15);
        // neuer Adapter, gleiche Datenbank
        const neu = aufbau({ regelAktiv: true }, uhr.t);
        neu.a.werte = a.werte;
        neu.a.objekte = a.objekte;
        anlage.outside = 10; // Mittel springt nicht sofort auf 10
        await laufen(neu.a, neu.uhr, anlage, 1);
        expect(neu.a.wert('Daikin_N.regulation.demand.outsideMean')).to.be.below(2);
        expect(JSON.parse(neu.a.wert('Daikin_N.regulation.demand.stateJson')).schreiber.befehle.length).to.equal(
            JSON.parse(gespeichert).schreiber.befehle.length,
        );
    });

    it('zwei Meldungen gleichzeitig: geschrieben wird erst, wenn die Objekte stehen', async () => {
        const { a } = aufbau({});
        const geschrieben = [];
        const setState = a.setState.bind(a);
        a.setState = async (id, w) => {
            if (id.includes('.regulation.') && !a.objekte.has(id)) {
                geschrieben.push(id);
            }
            return setState(id, w);
        };
        const daten = new Anlage({ name: 'Daikin P' }).status();
        await Promise.all([a.regelung.meldung('Daikin_P', 'Daikin P', daten), a.regelung.meldung('Daikin_P', 'Daikin P', daten)]);
        expect(geschrieben).to.eql([]);
    });

    it('legt die Datenpunkte mit Vorgaben an (Probelauf-Anzeige = wirksamer Zustand und nicht schreibbar, aktiv aus der Einstellung)', async () => {
        const { a, uhr } = aufbau({});
        await laufen(a, uhr, new Anlage({ name: 'Daikin V' }), 1);
        // ohne Schluessel gilt der Instanz-Probelauf als AN - das zeigt der Datenpunkt
        expect(a.wert('Daikin_V.regulation.demand.dryRun')).to.equal(true);
        expect(a.objekte.get('Daikin_V.regulation.demand.dryRun').common).to.include({ write: false, role: 'indicator', def: false });
        expect(a.wert('Daikin_V.regulation.demand.active')).to.equal(false);
        expect(a.wert('Daikin_V.regulation.demand.state')).to.equal('off');
        expect(a.objekte.get('Daikin_V.regulation.demand.active').common.write).to.equal(true);
        expect(a.objekte.get('Daikin_V.regulation.demand.setpoint').common.write).to.equal(false);
        expect(a.gesendet).to.have.length(0);
    });
});

describe('Regelung: control-Nachricht (spaetere Etappe)', () => {
    const { controlNachricht } = require('../lib/regel/control');
    it('baut nie eine Teil-control: env und Band immer zusammen', () => {
        expect(controlNachricht({ betrieb: 'adapter', env: 21.3, min: 20.5, max: 21.5 })).to.eql({ env: 21.3, target: [20.5, 21.5] });
        expect(controlNachricht({ betrieb: 'adapter', env: 21.3 })).to.equal(null);
        expect(controlNachricht({ betrieb: 'adapter', min: 20, max: 21 })).to.equal(null);
        expect(controlNachricht({ betrieb: 'adapter', env: 21, min: 22, max: 21 })).to.equal(null);
        for (const env of [null, 20, 21.5]) {
            for (const min of [null, 20]) {
                for (const max of [null, 21]) {
                    const n = controlNachricht({ betrieb: 'adapter', env, min, max });
                    expect(n === null || ('env' in n && 'target' in n)).to.equal(true);
                }
            }
        }
    });
    it('BLE gekoppelt: kein env; Faikout-Auto: kein target', () => {
        expect(controlNachricht({ betrieb: 'adapter', env: 21, min: 20, max: 21, ble: true })).to.eql({ target: [20, 21] });
        expect(controlNachricht({ betrieb: 'faikoutAuto', env: 21, min: 20, max: 21 })).to.eql({ env: 21 });
        expect(controlNachricht({ betrieb: 'faikoutAuto', env: 21, ble: true })).to.equal(null);
    });
});
