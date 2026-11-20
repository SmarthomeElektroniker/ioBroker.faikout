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
    faehig: 'unbekannt',
    ...x,
});

describe('Regelung: Kennlinie', () => {
    it('rechnet stueckweise linear und haelt die Enden', () => {
        const p = kennlinie.VORGABE_HEIZEN;
        expect(kennlinie.wert(p, -20)).to.equal(95);
        expect(kennlinie.wert(p, -10)).to.equal(95);
        expect(kennlinie.wert(p, -5)).to.equal(85);
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
        expect(a.wert('Daikin_K.regel.bedarf.zustand')).to.equal('gestört');
        expect(a.wert('Daikin_K.regel.bedarf.grund')).to.match(/Konfigurationsfehler/);
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
        expect(kalt.sollwert).to.equal(95);
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
        expect(r.zustand).to.equal('gestört');
        expect(bedarf.berechnen(eingang({ aussen: null }), K, null, T0).ergebnis.zustand).to.equal('gestört');
    });

    it('meldet den Econo-Konflikt und "nicht fähig"', () => {
        const r = bedarf.berechnen(eingang({ econo: true, faehig: 'nein' }), K, null, T0).ergebnis;
        expect(r.konflikt).to.match(/Econo/);
        expect(r.zustand).to.equal('nicht fähig');
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

    it('faellt ohne Vortagsdaten auf 100 % zurueck', () => {
        const k = bedarf.konfigPruefen({ strategie: 'vortag' }).konfig;
        const r = bedarf.berechnen(eingang({ vortag: { spitzeW: 0, mittelW: 0, stunden: 0 } }), k, null, T0).ergebnis;
        expect(r.sollwert).to.equal(100);
        expect(r.grund).to.match(/zu wenig Daten/);
    });
});

describe('Regelung: Schreiber', () => {
    const schritt = (z, soll, ist, t, probelauf = false) =>
        schreiber.entscheiden({ sollwert: soll, istwert: ist, probelauf, faehig: 'ja', jetzt: t, zustand: z });

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
            const r = schreiber.entscheiden({ sollwert: soll, istwert: ist, probelauf: false, faehig: 'ja', jetzt: t, zustand: z, grenzen: { haltHochMs: 0, haltRunterMs: 0 } });
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
        const r = schreiber.entscheiden({ sollwert: 50, istwert: 100, probelauf: false, faehig: 'nein', jetzt: T0, zustand: null, grenzen: { haltRunterMs: 0 } });
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
        expect(f.wert).to.equal('unbekannt');
        expect(f.grund).to.match(/bei Gerät aus/);
        f = faehigkeit.bewerten(f, { art: 'abgelehnt', power: true, wert: 80 });
        expect(f.wert).to.equal('nein');
        expect(faehigkeit.bewerten(null, { art: 'angenommen', wert: 70 }).wert).to.equal('ja');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: true, demand: 70 }).wert).to.equal('ja');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: true }).wert).to.equal('nein');
        expect(faehigkeit.bewerten(null, { art: 'status', vollstaendig: false }).wert).to.equal('unbekannt');
        const fehlt = faehigkeit.bewerten(null, { art: 'status', vollstaendig: true });
        expect(faehigkeit.bewerten(fehlt, { art: 'status', vollstaendig: true, demand: 100 }).wert).to.equal('unbekannt');
    });
});

describe('Regelung: Zustand und Einstellungen', () => {
    it('liest Unsinn als leeren Zustand und bewahrt einen gueltigen', () => {
        expect(zustand.lesen('{kaputt').v).to.equal(1);
        expect(zustand.lesen('{"v":99}').bedarf.aussenVerlauf).to.eql([]);
        const z = zustand.leer();
        z.bedarf.aussenVerlauf = [[T0, 3]];
        z.schreiber.befehle = [T0];
        z.faehig = { wert: 'ja', grund: 'x' };
        const z2 = zustand.lesen(zustand.schreiben(z));
        expect(z2.bedarf.aussenVerlauf).to.eql([[T0, 3]]);
        expect(z2.schreiber.befehle).to.eql([T0]);
        expect(z2.faehig.wert).to.equal('ja');
    });

    it('Probelauf ist ohne Einstellung AN', () => {
        expect(konfigAusInstanz({}).probelaufGlobal).to.equal(true);
        expect(konfigAusInstanz({ regelProbelauf: 'x' }).probelaufGlobal).to.equal(true);
        expect(konfigAusInstanz({ regelProbelauf: false }).probelaufGlobal).to.equal(false);
    });
});

describe('Regelung: Simulator (main.js + Anlage)', function () {
    this.timeout(20000);
    it('Probelauf sendet NIE - auch nicht mit Instanz-Probelauf aus, wenn der Geraeteschalter an ist', async () => {
        for (const config of [{}, { regelProbelauf: false }, { regelProbelauf: true }]) {
            const { a, uhr } = aufbau({ ...config, regelAktiv: true });
            const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 9 });
            await laufen(a, uhr, anlage, 90, i => {
                anlage.outside = 9 - i / 10;
                anlage.temp = i > 40 ? 22.5 : 21;
                anlage.abtauen = i === 50;
            });
            expect(a.gesendet, JSON.stringify(config)).to.have.length(0);
            const w = JSON.parse(a.wert('Daikin_Wohnzimmer.regel.bedarf.wuerdeSenden'));
            expect(w.aktion).to.equal('wuerde');
            expect(a.wert('Daikin_Wohnzimmer.regel.bedarf.probelauf')).to.equal(true);
            expect(a.wert('Daikin_Wohnzimmer.regel.bedarf.sollwert')).to.be.within(40, 100);
            expect(a.zeilen.filter(z => /would send/.test(z.text)).length).to.be.at.least(1);
        }
    });

    it('scharf (beide Probelauf-Schalter aus) sendet ueber command/<Name>/demand, Anlage uebernimmt -> faehig "ja"', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin Wohnzimmer', outside: 5 });
        await laufen(a, uhr, anlage, 1);
        await a.onStateChange('faikout.0.Daikin_Wohnzimmer.regel.bedarf.probelauf', { val: false, ack: false });
        await laufen(a, uhr, anlage, 20);
        expect(a.gesendet.map(g => g.topic)).to.eql(['command/Daikin Wohnzimmer/demand']);
        expect(a.gesendet[0].nutzlast).to.equal('60');
        expect(anlage.demand).to.equal(60);
        expect(a.wert('Daikin_Wohnzimmer.info.demandFaehig')).to.equal('ja');
        // Der Schalter ging NICHT als Befehl ans Modul
        expect(a.gesendet.some(g => /probelauf/.test(g.topic))).to.equal(false);
    });

    it('failed-set bei laufendem Geraet -> "nein", danach keine Befehle mehr', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false, regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin 1OG', outside: 5, nimmtDemand: 'nie' });
        await laufen(a, uhr, anlage, 1);
        await a.onStateChange('faikout.0.Daikin_1OG.regel.bedarf.probelauf', { val: false, ack: false });
        await laufen(a, uhr, anlage, 60);
        expect(a.gesendet).to.have.length(1);
        expect(a.wert('Daikin_1OG.info.demandFaehig')).to.equal('nein');
        expect(a.wert('Daikin_1OG.regel.bedarf.zustand')).to.equal('nicht fähig');
    });

    it('Geraet aus = neutral; Verbindungsabriss -> Fuehler veraltet -> Rueckfall 100', async () => {
        const { a, uhr, regel } = aufbau({ regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin X', power: false });
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Daikin_X.regel.bedarf.zustand')).to.equal('neutral');
        anlage.power = true;
        await laufen(a, uhr, anlage, 3);
        expect(a.wert('Daikin_X.regel.bedarf.zustand')).to.equal('ok');
        anlage.verbunden = false;
        await laufen(a, uhr, anlage, 70);
        await regel.schritt('Daikin_X'); // Takt ohne Meldung (z. B. Stundenwechsel)
        expect(a.wert('Daikin_X.regel.bedarf.sollwert')).to.equal(100);
        expect(a.wert('Daikin_X.regel.bedarf.grund')).to.match(/veraltet/);
    });

    it('Neustart: Zustand (Aussenmittel, Befehlszaehler, Faehigkeit) kommt aus zustandJson zurueck', async () => {
        const { a, uhr } = aufbau({ regelAktiv: true });
        const anlage = new Anlage({ name: 'Daikin N', outside: 0 });
        await laufen(a, uhr, anlage, 20);
        const gespeichert = a.wert('Daikin_N.regel.bedarf.zustandJson');
        expect(JSON.parse(gespeichert).bedarf.aussenVerlauf.length).to.be.at.least(15);
        // neuer Adapter, gleiche Datenbank
        const neu = aufbau({ regelAktiv: true }, uhr.t);
        neu.a.werte = a.werte;
        neu.a.objekte = a.objekte;
        anlage.outside = 10; // Mittel springt nicht sofort auf 10
        await laufen(neu.a, neu.uhr, anlage, 1);
        expect(neu.a.wert('Daikin_N.regel.bedarf.aussenMittel')).to.be.below(2);
        expect(JSON.parse(neu.a.wert('Daikin_N.regel.bedarf.zustandJson')).schreiber.befehle.length).to.equal(
            JSON.parse(gespeichert).schreiber.befehle.length,
        );
    });

    it('legt die Datenpunkte mit Vorgaben an (probelauf true, aktiv aus der Einstellung)', async () => {
        const { a, uhr } = aufbau({});
        await laufen(a, uhr, new Anlage({ name: 'Daikin V' }), 1);
        expect(a.wert('Daikin_V.regel.bedarf.probelauf')).to.equal(true);
        expect(a.wert('Daikin_V.regel.bedarf.aktiv')).to.equal(false);
        expect(a.wert('Daikin_V.regel.bedarf.zustand')).to.equal('aus');
        expect(a.objekte.get('Daikin_V.regel.bedarf.aktiv').common.write).to.equal(true);
        expect(a.objekte.get('Daikin_V.regel.bedarf.sollwert').common.write).to.equal(false);
        expect(a.gesendet).to.have.length(0);
    });
});
