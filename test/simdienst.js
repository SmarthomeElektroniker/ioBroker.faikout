'use strict';

/*
 * Simulator (sim/): Physik, Firmware-Nachbildung, HTTP-Seiten, Dienst.
 * Alles lokal: Broker nur auf 127.0.0.1, keine echten Wartezeiten ueber 2 s.
 */

const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const { Physik } = require('../sim/physik');
const { Modul } = require('../sim/modul');
const { Welt } = require('../sim/welt');
const { ModulHttp } = require('../sim/http');
const { SZENARIEN, szenario } = require('../sim/szenarien');
const { auswerten } = require('../sim/messung');
const { Dienst, konfigLesen, brokerErlaubt } = require('../sim/dienst');
const felder = require('../lib/fields');
const discovery = require('../lib/discovery');

/** Physik mit laufender Heizung. */
function heizPhysik(opt = {}, stell = {}) {
    const p = new Physik({ seed: 7, raum: 18, aussenMittel: 0, aussenHub: 0, ...opt });
    Object.assign(p.stell, { power: true, mode: 'H', temp: 22, ...stell });
    return p;
}

/** Ein Modul mit Mitschnitt; die Uhr laeuft mit den Ticks. */
function aufbau(typ = 's21', opt = {}) {
    const raus = [];
    const uhr = { t: Date.parse('2027-01-15T06:00:00Z') };
    const { physik: physikOpt, ...rest } = opt;
    const physik = new Physik({ seed: 3, raum: 20, aussenMittel: 2, aussenHub: 0, ...(physikOpt || {}) });
    const modul = new Modul({
        name: 'sim-test',
        id: '0A5100000001',
        typ,
        physik,
        uhr: () => uhr.t,
        transport: { publish: (topic, payload, o) => raus.push({ topic, payload, retain: !!(o && o.retain) }) },
        anlage: { power: true, mode: 'H', temp: 21 },
        ...rest,
    });
    const tick = (n = 1) => {
        for (let i = 0; i < n; i++) {
            uhr.t += 1000;
            physik.schritt(1);
            modul.tick();
        }
    };
    const letzte = topic => {
        const m = raus.filter(x => x.topic === topic).pop();
        return m ? JSON.parse(m.payload) : undefined;
    };
    const anzahl = topic => raus.filter(x => x.topic === topic).length;
    const start = () => {
        modul.verbinden();
        tick(3);
        raus.length = 0;
    };
    return { modul, physik, raus, tick, letzte, anzahl, start, uhr };
}

describe('Simulator: Physik', () => {
    it('Heizen erwaermt den Raum, Zaehler laufen nur vorwaerts', () => {
        const p = heizPhysik();
        let wh = 0;
        let heiz = 0;
        for (let i = 0; i < 180; i++) {
            p.schritt(60);
            expect(p.wh).to.be.at.least(wh);
            expect(p.whHeizen).to.be.at.least(heiz);
            wh = p.wh;
            heiz = p.whHeizen;
        }
        expect(p.luft).to.be.above(20.5);
        expect(p.masse).to.be.above(18.2);
        expect(p.wh).to.be.above(500);
        expect(p.messwerte().Whoutside % 100).to.equal(0); // S21 zaehlt in 100-Wh-Schritten
    });

    it('ausgeschaltet kuehlt der Raum aus und braucht nur Ruhestrom', () => {
        const p = heizPhysik({}, { power: false });
        p.schritt(3 * 3600);
        expect(p.luft).to.be.below(18);
        expect(p.comp).to.equal(0);
        expect(p.watt).to.be.below(10);
    });

    it('demand begrenzt die elektrische Aufnahme', () => {
        const voll = heizPhysik();
        const halb = heizPhysik({}, { demand: 40 });
        let maxVoll = 0;
        let maxHalb = 0;
        for (let i = 0; i < 1200; i++) {
            voll.schritt(1);
            halb.schritt(1);
            maxVoll = Math.max(maxVoll, voll.watt);
            maxHalb = Math.max(maxHalb, halb.watt);
        }
        expect(maxVoll).to.be.above(1200);
        expect(maxHalb).to.be.below(0.4 * 1300 + 25 + 5);
        expect(halb.luft).to.be.below(voll.luft);
    });

    it('Abtauen tritt bei Kaelte auf: keine Heizleistung, Anlage meldet es', () => {
        const p = heizPhysik({ raum: 20 });
        let gesehen = 0;
        let kalt = 0;
        for (let i = 0; i < 3 * 3600; i++) {
            p.schritt(1);
            if (p.abtauen) {
                gesehen++;
                expect(p.messwerte().antifreeze).to.equal(true);
                if (p.qWirksam < 0) {
                    kalt++;
                }
            }
        }
        expect(p.abtauungen).to.be.at.least(1);
        expect(gesehen).to.be.within(240, p.abtauungen * 481);
        expect(kalt).to.be.above(0);
    });

    it('kein Abtauen ueber 5 Grad aussen', () => {
        const p = heizPhysik({ aussenMittel: 8 });
        p.schritt(4 * 3600);
        expect(p.abtauungen).to.equal(0);
    });

    it('Schwachlast: der Verdichter taktet und haelt Mindestlauf- und Sperrzeit ein', () => {
        const p = heizPhysik({ raum: 21, aussenMittel: 15 }, { temp: 21 });
        const wechsel = [];
        let lief = false;
        for (let i = 0; i < 8 * 3600; i++) {
            p.schritt(1);
            if (p.laeuft !== lief) {
                wechsel.push(i);
                lief = p.laeuft;
            }
        }
        expect(p.starts).to.be.at.least(2);
        for (let i = 1; i < wechsel.length; i++) {
            expect(wechsel[i] - wechsel[i - 1]).to.be.at.least(180);
        }
    });

    it('Kuehlen im Sommer senkt Temperatur und Wassergehalt', () => {
        const p = new Physik({ seed: 1, raum: 27, feuchte: 70, aussenMittel: 30, aussenHub: 0, aussenFeuchte: 60 });
        Object.assign(p.stell, { power: true, mode: 'C', temp: 24 });
        const x0 = p.x;
        p.schritt(2 * 3600);
        expect(p.luft).to.be.below(25);
        expect(p.x).to.be.below(x0);
        expect(p.whKuehlen).to.be.above(0);
    });

    it('gleicher Seed = gleicher Verlauf, unabhaengig von der Portionierung der Zeit', () => {
        const a = heizPhysik();
        const b = heizPhysik();
        const c = heizPhysik({ seed: 8 });
        a.schritt(7200);
        for (let i = 0; i < 7200; i += 7) {
            b.schritt(Math.min(7, 7200 - i));
        }
        c.schritt(7200);
        expect(JSON.stringify(b.zustand())).to.equal(JSON.stringify(a.zustand()));
        expect(JSON.stringify(c.zustand())).to.not.equal(JSON.stringify(a.zustand()));
    });

    it('Sonne auf dem Aussenfuehler verfaelscht nur den Fuehler, eingefrorene Fuehler bleiben stehen', () => {
        const p = heizPhysik({}, { power: false });
        p.schritt(60);
        const vorher = p.messwerte().outside;
        p.einfluss.fuehlerZusatz = 12;
        expect(p.messwerte().outside).to.be.closeTo(vorher + 12, 0.11);
        expect(p.aussen()).to.be.within(-1, 1);
        p.einfluss.fuehlerZusatz = 0;
        p.einfrieren('home', true);
        const home = p.messwerte().home;
        p.schritt(4 * 3600);
        expect(p.messwerte().home).to.equal(home);
        p.einfrieren('home', false);
        expect(p.messwerte().home).to.be.below(home);
    });
});

describe('Simulator: Modul-Protokoll', () => {
    it('meldet sich mit Discovery, Klartext- und nativem Status an (alles retained)', () => {
        const s = aufbau();
        s.modul.verbinden();
        s.tick(3);
        const klima = s.raus.find(x => x.topic === 'homeassistant/climate/0A5100000001/config');
        expect(klima.retain).to.equal(true);
        expect(JSON.parse(klima.payload)['~']).to.equal('command/sim-test');
        const z = s.letzte('state/sim-test');
        expect(z).to.include({
            id: '0A5100000001',
            up: true,
            power: true,
            mode: 'heat',
            target: 21,
            demand: 100,
            fan: 'auto',
        });
        expect(z.ts).to.match(/^2027-01-15T06:00:0\dZ$/);
        expect(z).to.include.keys('temp', 'achome', 'outside', 'liquid', 'comp', 'consumption', 'energy', 'action');
        expect(s.raus.find(x => x.topic === 'state/sim-test').retain).to.equal(true);
        // Schreibweise wie die Firmware: %.2f im Klartext, %.1f nativ
        expect(s.raus.filter(x => x.topic === 'state/sim-test').pop().payload).to.match(
            /"target":21\.00,"actarget":21\.00/,
        );
        const n = s.letzte('state/sim-test/status');
        expect(n).to.include({
            protocol: 'S21',
            online: true,
            power: true,
            mode: 'H',
            temp: 21,
            fan: 'A',
            autoe: true,
        });
        expect(n.auto0).to.equal('00:00');
        // unser Adapter erkennt die Sensor-Discovery
        const comp = s.raus.find(x => x.topic === 'homeassistant/sensor/0A5100000001comp/config');
        expect(felder.haSensorAuswerten(comp.topic, comp.payload)).to.include({ feld: 'comp' });
        expect(s.modul.clientId()).to.equal('Faikout:sim-test_000001');
        expect(s.modul.lwt()).to.eql({ topic: 'state/sim-test', payload: '{"up":false,"reason":"LWT"}', retain: true });
        expect(s.modul.abos()).to.include.members([
            'command/sim-test/#',
            'setting/0A5100000001/#',
            'command/Faikout/#',
        ]);
    });

    it('Befehl -> Status binnen 1 s, Anlage und Physik uebernehmen', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('command/sim-test/temp', '23');
        s.tick(1);
        expect(s.letzte('state/sim-test')).to.include({ target: 23, actarget: 23 });
        expect(s.letzte('state/sim-test/status').temp).to.equal(23);
        expect(s.physik.stell.temp).to.equal(23);
        s.modul.empfangen('command/sim-test', Buffer.from('{"mode":"C","fan":"3","econo":true}'));
        s.tick(1);
        expect(s.letzte('state/sim-test')).to.include({ mode: 'cool', fan: 'medium', econo: true, preset: 'eco' });
        s.modul.empfangen('command/sim-test/mode', 'off');
        s.tick(1);
        expect(s.letzte('state/sim-test')).to.include({ power: false, mode: 'off', action: 'off' });
        expect(s.letzte('state/sim-test/status')).to.include({ power: false, mode: 'C' });
        s.modul.empfangen('command/sim-test/on', '');
        s.modul.empfangen('command/sim-test/mode', 'heat');
        s.tick(1);
        expect(s.letzte('state/sim-test')).to.include({ power: true, mode: 'heat' });
        expect(s.modul.zaehler.befehle).to.eql({ 'command/temp': 1, command: 1, 'command/mode': 2, 'command/on': 1 });
        expect(s.modul.zaehler.failedSet).to.equal(0);
    });

    it('Befehle an andere Module und bei getrennter Verbindung bleiben ohne Wirkung', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('command/anderes/temp', '25');
        s.modul.abriss();
        s.modul.empfangen('command/sim-test/temp', '25');
        s.tick(2);
        expect(s.modul.ac.temp).to.equal(21);
        expect(s.raus).to.have.length(0);
    });

    it('Typ a uebernimmt demand und meldet es zurueck', () => {
        const s = aufbau('s21');
        s.start();
        s.modul.empfangen('command/sim-test/demand', '60');
        s.tick(1);
        expect(s.letzte('state/sim-test').demand).to.equal(60);
        expect(s.physik.stell.demand).to.equal(60);
        expect(s.modul.zaehler.failedSet).to.equal(0);
    });

    it('Typ b quittiert demand, uebernimmt nie: failed-set nach s21.tries Runden, Status bleibt 100', () => {
        const s = aufbau('nodemand');
        s.start();
        s.modul.empfangen('command/sim-test/demand', '90');
        s.tick(11);
        expect(s.anzahl('error/sim-test/failed-set')).to.equal(0);
        // solange die Aenderung offen ist, meldet das Modul keinen Status (Faikout.c Z. 4112)
        expect(s.anzahl('state/sim-test/status')).to.equal(0);
        s.tick(1);
        const fehler = s.raus.filter(x => x.topic === 'error/sim-test/failed-set');
        expect(fehler).to.have.length(1);
        expect(fehler[0].payload).to.equal('{"demand":90}');
        expect(fehler[0].retain).to.equal(false);
        expect(felder.abgelehntAuswerten('failed-set', fehler[0].payload).settings).to.eql({ demand: 90 });
        s.tick(1);
        expect(s.letzte('state/sim-test').demand).to.equal(100);
        expect(s.physik.stell.demand).to.equal(100);
        expect(s.modul.zaehler).to.include({ failedSet: 1 });
        expect(s.modul.zaehler.failedSetNach).to.eql({ demand: 1 });
        // auch bei ausgeschalteter Anlage
        s.modul.empfangen('command/sim-test/power', '0');
        s.tick(2);
        s.modul.empfangen('command/sim-test/demand', '70');
        s.tick(13);
        expect(s.modul.zaehler.failedSet).to.equal(2);
        // derselbe Wert wie gemeldet ist keine Aenderung: kein failed-set
        s.modul.empfangen('command/sim-test/demand', '100');
        s.tick(13);
        expect(s.modul.zaehler.failedSet).to.equal(2);
    });

    it('Typ c (TCL): kein demand, kein outside, keine Fuehler; demand endet in failed-set', () => {
        const s = aufbau('tcl');
        s.modul.verbinden();
        s.tick(3);
        const z = s.letzte('state/sim-test');
        expect(z).to.include({ power: true, mode: 'heat', target: 21, fan: 'auto', swing: 'off' });
        expect(z).to.not.have.any.keys(
            'demand',
            'outside',
            'temp',
            'achome',
            'comp',
            'consumption',
            'energy',
            'liquid',
        );
        const demand = s.raus.find(x => x.topic === 'homeassistant/select/0A5100000001demand/config');
        expect(demand.payload).to.equal(''); // Eintrag wird geloescht
        s.modul.empfangen('command/sim-test/temp', '24');
        s.tick(1);
        expect(s.letzte('state/sim-test').target).to.equal(24);
        expect(s.physik.stell.temp).to.equal(24);
        s.modul.empfangen('command/sim-test/demand', '60');
        s.tick(13);
        expect(s.modul.zaehler.failedSetNach).to.eql({ demand: 1 });
        // Fernbedienung an der IR-Bruecke vorbei: die Anlage folgt, das Modul merkt nichts
        s.modul.handeingriff({ temp: 19 });
        s.tick(3);
        expect(s.physik.stell.temp).to.equal(19);
        expect(s.letzte('state/sim-test').target).to.equal(24);
    });

    it('control {env,target}: Raumwert und Band von aussen, Ablauf nach tcontrol = 600 s', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('command/sim-test/control', '{"env":20.3,"target":[20.5,21.5]}');
        s.tick(2);
        expect(s.letzte('state/sim-test').temp).to.equal(20.3);
        const n = s.letzte('state/sim-test/status');
        expect(n).to.include({ env: 20.3, control: true, remote: true });
        expect(n).to.not.have.any.keys('autot', 'autor'); // "remote" blendet die eigenen Auto-Werte aus
        expect(s.letzte('state/sim-test').action).to.equal('heating');
        expect(s.modul.ac.temp).to.be.at.least(26); // Band-Mitte + heatover: die Anlage soll sicher heizen
        s.tick(596);
        expect(s.modul.bekannt.has('env')).to.equal(true);
        s.tick(4);
        expect(s.modul.bekannt.has('env')).to.equal(false);
        s.tick(2);
        const danach = s.letzte('state/sim-test/status');
        expect(danach).to.not.have.any.keys('env', 'remote');
        expect(danach).to.include({ control: false, temp: 21.5 }); // controlstop: Heizen -> oberes Bandende
        expect(s.letzte('state/sim-test').temp).to.equal(s.letzte('state/sim-test').achome);
        expect(s.modul.zaehler.flash).to.equal(0);
    });

    it('control ohne env: fehlende Felder sind NAN - "temp" wird null', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('command/sim-test/control', '{"target":21}');
        s.tick(2);
        expect(s.letzte('state/sim-test').temp).to.equal(null);
        expect(s.letzte('state/sim-test/status').env).to.equal(null);
        // ein Band ohne Raumwert regelt gegen den Fuehler der Anlage
        expect(s.modul.mintarget).to.equal(21);
    });

    it('control nur mit env, ohne Band und ohne autor: Regelung startet und stoppt jede Runde - Status im Sekundentakt', () => {
        // Faikout.c Z. 4428-4434: controlstop() wegen NAN-Band, gleich darauf controlstart(); beide
        // melden `control` um (set_uint8 setzt mode_changed) -> je Runde eine native und eine Klartext-Meldung.
        const s = aufbau();
        s.start();
        s.modul.empfangen('command/sim-test/control', '{"env":20.4}');
        s.tick(30);
        expect(s.anzahl('state/sim-test/status')).to.be.at.least(28);
        expect(s.anzahl('state/sim-test')).to.be.at.least(28);
        expect(s.letzte('state/sim-test')).to.include({ temp: 20.4, action: 'idle' });
        expect(s.modul.ac.temp).to.equal(21); // ohne Band stellt das Modul nichts
        // mit eigenem Band (autot/autor) ist Ruhe
        s.modul.empfangen('setting/sim-test', '{"autot":21,"autor":0.5}');
        s.tick(5);
        s.raus.length = 0;
        s.modul.empfangen('command/sim-test/control', '{"env":21.1}');
        s.tick(30);
        expect(s.anzahl('state/sim-test/status')).to.be.below(5);
    });

    it('BLE gekoppelt: env aus control wird ignoriert, bletemp/blehum/blebat erscheinen', () => {
        const s = aufbau();
        s.start();
        s.modul.bleSetzen(true, { versatz: -0.8 });
        s.tick(2);
        const erwartet = Math.round((s.physik.luft - 0.8) * 100) / 100;
        expect(s.letzte('state/sim-test')).to.include.keys('bletemp', 'blehum', 'blebat');
        expect(s.letzte('state/sim-test').temp).to.be.closeTo(erwartet, 0.02);
        s.modul.empfangen('command/sim-test/control', '{"env":30,"target":[20.5,21.5]}');
        s.tick(2);
        expect(s.letzte('state/sim-test').temp).to.be.closeTo(erwartet, 0.02);
        expect(s.letzte('state/sim-test/status').ble).to.include.keys('temp', 'hum', 'bat');
        expect(s.letzte('state/sim-test/status').autob).to.equal('SimBLE');
        expect(s.modul.remote).to.equal(false); // BLE aktiv: target-Feld macht das Modul nicht "remote"
        s.modul.bleSetzen(false);
        s.tick(2);
        expect(s.letzte('state/sim-test')).to.not.have.any.keys('bletemp');
    });

    it('autoe && autor: target aus control wird ignoriert, das Modul regelt selbst auf autot', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('setting/sim-test', '{"autot":21,"autor":0.5}');
        s.tick(2);
        s.modul.empfangen('command/sim-test/control', '{"env":20.9,"target":[25,26]}');
        s.tick(2);
        expect([s.modul.mintarget, s.modul.maxtarget]).to.eql([20.5, 21.5]);
        const z = s.letzte('state/sim-test');
        expect(z).to.include({ mode: 'heat_cool', target: 21, temp: 20.9 });
        expect(s.letzte('state/sim-test/status')).to.include({ autot: 21, autor: 0.5, control: true });
    });

    it('zaehlt Flash-Schreibvorgaenge: nur geaenderte Einstellungen, auch ueber command', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('setting/sim-test/autot', '21.5');
        expect(s.modul.zaehler.flash).to.equal(1);
        s.modul.empfangen('setting/sim-test/autot', '21.5');
        s.modul.empfangen('setting/sim-test', '{"autot":21.5,"autoe":true}');
        expect(s.modul.zaehler.flash).to.equal(1);
        s.modul.empfangen('setting/sim-test', '{"autor":0.5,"livestatus":true}');
        expect(s.modul.zaehler.flash).to.equal(3);
        // Solltemperatur bei laufendem Faikout-Auto landet als autot im Flash (Faikout.c Z. 1689)
        s.modul.empfangen('command/sim-test/temp', '22');
        expect(s.modul.zaehler.flash).to.equal(4);
        expect(s.modul.e.autot).to.equal(22);
        // ... ebenso autot/autor/auto0 im JSON-Befehl (daikin_control)
        s.modul.empfangen('command/sim-test', '{"autot":22.26,"auto0":"06:30"}');
        expect(s.modul.e).to.include({ autot: 22.2, auto0: 630 });
        expect(s.modul.zaehler.flash).to.equal(6);
        // faikout-ac schreibt die Zeiten ohne Doppelpunkt
        s.modul.empfangen('setting/sim-test', '{"auto1":"2200"}');
        expect(s.modul.e.auto1).to.equal(2200);
        expect(s.modul.zaehler.flashNach).to.eql({ autot: 3, autor: 1, livestatus: 1, auto0: 1, auto1: 1 });
        s.tick(1);
        expect(s.letzte('state/sim-test/status')).to.include({ auto0: '06:30', auto1: '22:00', autot: 22.2 });
        expect(s.modul.zaehler.neustarts).to.equal(0);
    });

    it('unbekannte Einstellung oder unbekannter Befehl: error/<Name>/..., kein Flash', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('setting/sim-test/gibtsnicht', '1');
        s.modul.empfangen('command/sim-test/autop', '1');
        s.modul.empfangen('command/sim-test', '{"mode":"X"}');
        expect(s.modul.zaehler.flash).to.equal(0);
        expect(s.letzte('error/sim-test/setting')).to.include({
            description: 'Not found',
            prefix: 'setting',
            location: 'gibtsnicht',
        });
        expect(s.letzte('error/sim-test/autop')).to.include({
            description: 'Unknown',
            prefix: 'command',
            suffix: 'autop',
            payload: '1',
        });
        expect(s.letzte('error/sim-test/control')).to.include({ field: 'mode', error: 'Value is not a valid value' });
    });

    it('nicht-live Einstellung (reporting, lockmode): Neustart nach 3 s, Wiederkehr mit Discovery', () => {
        const s = aufbau();
        s.start();
        s.modul.empfangen('setting/sim-test/lockmode', '1');
        expect(s.modul.zaehler.flash).to.equal(1);
        s.tick(3);
        const ab = s.raus.filter(x => x.topic === 'state/sim-test').pop();
        expect(JSON.parse(ab.payload)).to.include({ up: false, reason: 'Settings changed\n(Change lockmode)' });
        expect(ab.retain).to.equal(true);
        s.raus.length = 0;
        s.modul.empfangen('command/sim-test/temp', '25'); // waehrend des Neustarts taub
        s.tick(5);
        expect(s.raus).to.have.length(0);
        s.tick(4);
        expect(s.letzte('state/sim-test')).to.include({ up: true });
        expect(s.letzte('state/sim-test').uptime).to.be.below(5);
        expect(s.anzahl('homeassistant/climate/0A5100000001/config')).to.equal(1);
        expect(s.modul.zaehler.neustarts).to.equal(1);
        expect(s.modul.e.lockmode).to.equal(true);
        expect(s.modul.ac.temp).to.equal(21);
        // gleicher Wert noch einmal: weder Flash noch Neustart
        s.modul.empfangen('setting/sim-test/lockmode', '1');
        s.tick(10);
        expect(s.modul.zaehler).to.include({ flash: 1, neustarts: 1 });
    });

    it('Sammelbericht Faikout/<Name> je reporting = 60 s mit [min, mittel, max]', () => {
        const s = aufbau();
        s.start();
        s.tick(180);
        expect(s.anzahl('Faikout/sim-test')).to.equal(3);
        const b = s.letzte('Faikout/sim-test');
        expect(b).to.include({ protocol: 'S21', power: true, mode: 'H', temp: 21, demand: 100 });
        expect(b.ts).to.match(/:00Z$/);
        expect(b.comp).to.satisfy(x => typeof x === 'number' || (Array.isArray(x) && x.length === 3));
        expect(b.home).to.satisfy(x => typeof x === 'number' || (Array.isArray(x) && x.length === 3));
    });

    it('Fernbedienung aendert den Status ohne Befehl; verfaelschte Felder stehen in der Meldung', () => {
        const s = aufbau();
        s.start();
        s.modul.handeingriff({ temp: 24, mode: 'C' });
        s.tick(1);
        expect(s.letzte('state/sim-test')).to.include({ target: 24, mode: 'cool' });
        expect(s.letzte('state/sim-test/status')).to.include({ temp: 24, mode: 'C' });
        expect(Object.keys(s.modul.zaehler.befehle)).to.have.length(0);
        s.modul.unsinn.outside = 'n/a';
        s.modul.haStatus();
        s.tick(1);
        expect(s.letzte('state/sim-test').outside).to.equal('n/a');
        s.modul.stumm = true;
        s.raus.length = 0;
        s.tick(120);
        expect(s.raus).to.have.length(0);
    });

    it('Faikout-Auto haelt den Raum im Band und schaltet ueber die Solltemperatur der Anlage', function () {
        this.timeout(10000);
        const s = aufbau('s21', { einstellungen: { autot: 21, autor: 0.5 }, physik: { raum: 19 } });
        s.start();
        const ziele = new Set();
        const raum = [];
        for (let i = 0; i < 5 * 3600; i++) {
            s.tick(1);
            ziele.add(s.modul.ac.temp);
            if (i > 3 * 3600) {
                raum.push(s.physik.luft);
            }
        }
        expect(Math.min(...raum)).to.be.above(19.5); // Regelpunkt 20,5, Einbruch beim Abtauen
        expect(Math.max(...raum)).to.be.below(22.5);
        expect(Math.max(...ziele)).to.be.at.least(26); // heatover
        expect(Math.min(...ziele)).to.be.at.most(16); // heatback, begrenzt auf tmin
        expect(s.letzte('state/sim-test')).to.include({ mode: 'heat_cool', target: 21 });
        expect(s.anzahl('info/sim-test/automation')).to.be.at.least(15);
        expect(s.modul.zaehler.flash).to.equal(0);
    });
});

describe('Simulator: Faikout-Auto bei Frost', function () {
    this.timeout(10000);
    const lauf = physikOpt => {
        const s = aufbau('s21', {
            einstellungen: { autoe: true, autot: 21, autor: 0.5 },
            physik: { raum: 18, aussenMittel: -4, aussenHub: 0, ...physikOpt },
        });
        s.start();
        let imBand = null;
        const raum = [];
        for (let i = 0; i < 4 * 3600; i++) {
            s.tick(1);
            if (imBand === null && s.physik.luft >= 20.3) {
                imBand = i / 60;
            }
            if (i >= 2 * 3600 && !s.physik.abtauen) {
                raum.push(s.physik.luft);
            }
        }
        return { s, imBand, mittel: raum.reduce((a, b) => a + b, 0) / raum.length };
    };

    it('erreicht bei -4 Grad aussen binnen 60 min den Regelpunkt (untere Bandkante) und taktet nicht', () => {
        // Die Firmware heizt, bis der (vorhergesagte) Raumwert `min` + pushtemp erreicht (Z. 4201, 4460):
        // geregelt wird beim Heizen auf die UNTERE Bandkante 20,5/20,6, nicht auf die Bandmitte.
        const { s, imBand, mittel } = lauf({});
        expect(imBand).to.be.a('number');
        expect(imBand).to.be.below(60);
        expect(mittel).to.be.within(20.2, 21);
        expect(s.physik.starts).to.be.at.most(3); // 4 h: kein Takten
        expect(s.letzte('state/sim-test')).to.not.have.any.keys('inlet'); // S21 kennt kein inlet
    });

    it('grober 0,5-K-Fuehler und sofort abschaltende Anlage: die Vorhersage der Firmware laesst die Anlage takten', () => {
        // Faikout.c Z. 4180-4195: ein Sprung von 0,5 K in 30 s wird mit tpredictt/tpredicts = 4 zu +1 K
        // hochgerechnet -> "am Ziel" -> Sollwert der Anlage auf 16 -> Verdichter aus, 3 min Sperrzeit.
        // Beide Annahmen (0,1-K-Fuehler, 120 s Abschaltverzoegerung) entscheiden also ueber das Ergebnis.
        const { s, mittel } = lauf({ fuehlerAufloesung: 0.5, ausVerzoegerung: 0 });
        expect(s.physik.starts).to.be.at.least(12);
        expect(mittel).to.be.below(20.3);
    });
});

describe('Simulator: Welt und Szenarien', () => {
    it('jedes Szenario hat Start, Dauer, Startzustand und gueltige Ereignisse', () => {
        const pflicht = [
            'heizenKalterTag',
            'uebergang',
            'sonneAufAussenfuehler',
            'fuehlerFriertEin',
            'fuehlerNichtNumerisch',
            'abtauen',
            'geraetLehntDemandAb',
            'handeingriff',
            'neustartImEntfeuchten',
            'wochenplanZeitumstellung',
            'verbindungsabriss',
            'bleAnAus',
            'sommerSchwuel',
        ];
        expect(Object.keys(SZENARIEN)).to.include.members(pflicht);
        for (const name of Object.keys(SZENARIEN)) {
            const sz = szenario(name);
            expect(Number.isFinite(Date.parse(sz.start)), name).to.equal(true);
            expect(sz.dauerMin, name).to.be.above(0);
            expect(sz.raum.temp, name).to.be.a('number');
            // jedes Ereignis laesst sich ausfuehren
            const w = new Welt({ szenario: name, module: [{ typ: 's21' }], senden() {} });
            w.verbinden();
            for (const e of sz.ereignisse) {
                expect(e.nachMin, name).to.be.below(sz.dauerMin);
                w.ereignis(e);
            }
        }
        // Zeitumstellung: Start 01:30 MEZ bzw. 02:30 MESZ
        const ort = ms => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });
        expect(ort(Date.parse(SZENARIEN.wochenplanZeitumstellung.start))).to.equal('01:30:00');
        expect(ort(Date.parse(SZENARIEN.wochenplanZeitumstellung.start) + 31 * 60000)).to.equal('03:01:00');
        expect(ort(Date.parse(SZENARIEN.wochenplanZeitumstellungHerbst.start))).to.equal('02:30:00');
        expect(ort(Date.parse(SZENARIEN.wochenplanZeitumstellungHerbst.start) + 31 * 60000)).to.equal('02:01:00');
    });

    it('zwei Welten mit gleichem Szenario und Seed laufen identisch; Befehle trennen sie', function () {
        this.timeout(10000);
        const bau = name => {
            const zeilen = [];
            const gesendet = [];
            const w = new Welt({
                name,
                szenario: 'abtauen',
                seed: 5,
                module: [{ typ: 's21' }, { typ: 'nodemand' }],
                senden: (m, t, p) => gesendet.push(`${t} ${p}`),
                messung: z => zeilen.push({ ...z, welt: '' }),
            });
            w.verbinden();
            return { w, zeilen, gesendet };
        };
        const a = bau('a');
        const b = bau('b');
        a.w.vor(90 * 60000);
        for (let i = 0; i < 90 * 60; i++) {
            b.w.vor(1000);
        }
        expect(a.zeilen).to.have.length(180);
        expect(JSON.stringify(b.zeilen)).to.equal(JSON.stringify(a.zeilen));
        expect(b.gesendet).to.eql(a.gesendet);
        expect(a.zeilen.some(z => z.abtauen)).to.equal(true);
        b.w.empfangen('command/sim-s21/demand', '40');
        a.w.vor(30 * 60000);
        b.w.vor(30 * 60000);
        const letzte = x => x.zeilen.filter(z => z.modul === 'sim-s21').pop();
        expect(letzte(b)).to.include({ demand: 40, failedSet: 0 });
        expect(letzte(b).befehle).to.eql({ 'command/demand': 1 });
        expect(letzte(b).wh).to.be.below(letzte(a).wh);
        expect(a.w.module[0].id).to.equal(b.w.module[0].id);
    });

    it('Verbindungsabriss: Testament, Funkstille, Wiederkehr mit Discovery; Marken kommen an', () => {
        const gesendet = [];
        const marken = [];
        const w = new Welt({
            szenario: {
                start: '2027-01-15T06:00:00Z',
                dauerMin: 10,
                raum: { temp: 20 },
                anlage: { power: true, mode: 'H', temp: 21 },
                ereignisse: [
                    { nachMin: 1, art: 'verbindungsabriss', dauerSek: 30 },
                    { nachMin: 3, art: 'marke', name: 'adapterNeustart' },
                    { nachMin: 4, art: 'handeingriff', setze: { temp: 23 } },
                    { nachMin: 5, art: 'demandAblehnen', an: true },
                ],
            },
            module: [{ typ: 's21' }],
            senden: (m, topic, payload, o) => gesendet.push({ topic, payload, retain: o.retain }),
            beiMarke: m => marken.push(m),
        });
        w.verbinden();
        w.vor(60000);
        gesendet.length = 0;
        w.vor(2000);
        expect(gesendet).to.eql([{ topic: 'state/sim-s21', payload: '{"up":false,"reason":"LWT"}', retain: true }]);
        w.vor(25000);
        expect(gesendet).to.have.length(1);
        w.vor(10000);
        expect(gesendet.some(x => x.topic.startsWith('homeassistant/climate/'))).to.equal(true);
        expect(JSON.parse(gesendet.filter(x => x.topic === 'state/sim-s21').pop().payload).up).to.equal(true);
        expect(w.module[0].zaehler.verbindungsabrisse).to.equal(1);
        w.vor(4 * 60000);
        expect(marken.map(m => m.name)).to.eql(['adapterNeustart']);
        expect(w.module[0].ac.temp).to.equal(23);
        w.empfangen('command/sim-s21/demand', '50');
        w.vor(15000);
        expect(w.module[0].zaehler.failedSet).to.equal(1);
        w.vor(5 * 60000);
        expect(w.fertig).to.equal(true);
        expect(w.stand().module[0].zaehler.befehle).to.eql({ 'command/demand': 1 });
    });
});

describe('Simulator: HTTP-Seiten', () => {
    const zwei = () => {
        const a = aufbau('s21', { name: 'sim-s21', id: '0A51000000A1' }).modul;
        const b = aufbau('tcl', { name: 'sim-tcl', id: '0A51000000B2', einstellungen: { nodemand: true } }).modul;
        const h = new ModulHttp();
        h.anmelden(a, { mqtthost: '127.0.0.1:1888', mqttuser: 'sim', hosts: ['alias-a'] });
        h.anmelden(b, { port: 0 });
        return { a, b, h };
    };
    const get = (h, url, host) => h.antwort({ method: 'GET', url, host, port: 8080 });

    it('liefert die Muster, die faikout-ac aus den Seiten liest', () => {
        const { h } = zwei();
        const start = get(h, '/', 'sim-s21').text;
        const gefunden = new Set((start.match(/\bo\.([a-zA-Z]\w*)\b/g) || []).map(x => x.slice(2)));
        expect([...gefunden]).to.include.members([
            'power',
            'mode',
            'temp',
            'demand',
            'fan',
            'outside',
            'home',
            'autot',
            'ble',
            'env',
        ]);
        const app = get(h, '/revk-settings?_page=0', 'sim-s21:8080').text;
        expect(app.match(/<h1>([^\s<]+)/)[1]).to.equal('sim-s21');
        expect(app.match(/Home<\/a>\s+([^\s<]+)<small>/)[1]).to.equal('Faikout');
        const extra = get(h, '/revk-settings?_page=-2', 'sim-s21').text;
        expect(/id="noled"[^>]*checked/i.test(extra)).to.equal(true);
        expect(/id="nodemand"[^>]*checked/i.test(extra)).to.equal(false);
        expect(/id="nodemand"[^>]*checked/i.test(get(h, '/revk-settings?_page=-2', 'sim-tcl').text)).to.equal(true);
        const block = extra.match(/name="_fantype"[\s\S]{0,600}?<\/select>/);
        expect(block[0].match(/<option value="(\d+)"[^>]*selected/)[1]).to.equal('0');
        const lib = get(h, '/revk-settings?_page=-3', 'sim-s21').text;
        for (const [id, wert] of [
            ['topiccommand', 'command'],
            ['topicsetting', 'setting'],
            ['topicstate', 'state'],
        ]) {
            expect(lib.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))[1]).to.equal(wert);
        }
        expect(/id="prefixapp"[^>]*checked/.test(lib)).to.equal(false);
        expect(/id="prefixhost"[^>]*checked/.test(lib)).to.equal(false);
        expect(get(h, '/revk-settings?_page=1', 'sim-s21').text).to.not.match(/xgpio/);
    });

    it('liefert, was unser "Module suchen" auswertet', () => {
        const { h } = zwei();
        const r = discovery.seiteAuswerten(get(h, '/revk-settings', 'sim-s21').text);
        expect(r).to.include({
            faikout: true,
            art: 'seite',
            app: 'Faikout',
            titel: 'sim-s21',
            hostname: 'sim-s21',
            revkId: '0A51000000A1',
            mqtthost: '127.0.0.1:1888',
            mqttuserGesetzt: true,
        });
        expect(r.mqttStatus).to.match(/^MQTT/);
    });

    it('unterscheidet Module ueber Host-Header, Alias und ID; POST -> 405 und Zaehler', () => {
        const { h } = zwei();
        expect(get(h, '/revk-settings?_page=0', 'SIM-TCL').text).to.match(/<h1>sim-tcl /);
        expect(get(h, '/revk-settings?_page=0', 'alias-a:80').text).to.match(/<h1>sim-s21 /);
        expect(get(h, '/revk-settings?_page=0', '0a51000000b2').text).to.match(/<h1>sim-tcl /);
        expect(get(h, '/', 'unbekannt').status).to.equal(200); // genau ein Modul ohne eigenen Port
        expect(get(h, '/status', 'sim-s21').status).to.equal(404);
        const post = h.antwort({ method: 'POST', url: '/revk-settings', host: 'sim-s21', port: 8080 });
        expect(post.status).to.equal(405);
        expect(post.kopf.Allow).to.equal('GET, HEAD');
        h.antwort({ method: 'PUT', url: '/', host: 'sim-tcl', port: 8080 });
        expect(h.zaehler).to.include({ verboten: 2 });
        expect(h.zaehler.verbotenNach).to.eql({ 'sim-s21': 1, 'sim-tcl': 1 });
    });

    it('lauscht auf 127.0.0.1: gemeinsamer Port und eigener Port je Modul', async () => {
        const { h } = zwei();
        const ports = await h.start(0);
        try {
            expect(ports).to.have.length(2);
            const hole = (port, opt = {}) =>
                new Promise((resolve, reject) => {
                    const req = http.request(
                        { host: '127.0.0.1', port, path: '/revk-settings?_page=0', ...opt },
                        res => {
                            let text = '';
                            res.on('data', t => (text += t));
                            res.on('end', () => resolve({ status: res.statusCode, text }));
                        },
                    );
                    req.on('error', reject);
                    req.end(opt.method === 'POST' ? 'hostname=boese' : undefined);
                });
            const eigener = h.eintraege[1].port;
            const gemeinsam = ports.find(p => p !== eigener);
            expect((await hole(eigener)).text).to.match(/<h1>sim-tcl /); // Host ist hier 127.0.0.1
            expect((await hole(gemeinsam, { headers: { Host: 'sim-s21' } })).text).to.match(/<h1>sim-s21 /);
            expect((await hole(gemeinsam, { method: 'POST', headers: { Host: 'sim-s21' } })).status).to.equal(405);
            expect(h.zaehler.verboten).to.equal(1);
            expect(h.eintraege[0].modul.name).to.equal('sim-s21');
        } finally {
            await h.stop();
        }
    });
});

describe('Simulator: Messung', () => {
    it('Kennzahlen aus einer Messdatei', function () {
        this.timeout(10000);
        const zeilen = [];
        const w = new Welt({
            name: 'w',
            szenario: 'handeingriff',
            module: [{ typ: 's21' }],
            senden() {},
            messung: z => zeilen.push(z),
        });
        w.verbinden();
        w.empfangen('command/sim-s21/demand', '80');
        w.empfangen('setting/sim-s21/autop', '1');
        w.vor(360 * 60000);
        const text = `${zeilen.map(z => JSON.stringify(z)).join('\n')}\n{"abgeschn`;
        const k = auswerten(text).module['w/sim-s21'];
        expect(k.zeilen).to.equal(360);
        expect(k.dauerStunden).to.equal(6);
        expect(k.anteilEin).to.be.within(0.8, 0.85); // 60 von 360 Minuten aus
        expect(k.mittlereAbweichung).to.be.within(0.05, 1.5);
        expect(k.anteilImBand).to.be.within(0.3, 1);
        expect(k.leistungMax).to.be.at.least(k.leistungP95);
        expect(k.leistungMax).to.be.below(0.8 * 1300 * 1.1 + 40); // demand 80
        expect(k.energieKWh).to.be.within(0.5, 6);
        expect(k.befehle['command/demand']).to.eql({ anzahl: 1, jeStunde: 0.17 });
        expect(k).to.include({ flash: 1, failedSet: 0, befehleJeStunde: 0.33 });
        expect(k.verdichterstarts).to.be.at.least(1);
        expect(k.sollwertspruenge.map(s => [s.von, s.nach])).to.eql([
            [21, 23],
            [23, 21],
        ]);
        expect(k.sollwertspruenge[0].einschwingMin).to.be.a('number');
    });

    it('Ueberschwingen nach Sollwertsprung, Starts aus comp-Flanken', () => {
        const z = [];
        const raum = [20, 20, 20.4, 21.2, 21.9, 22.4, 22.1, 21.7, 22, 22];
        raum.forEach((r, i) =>
            z.push({
                sek: 60 * (i + 1),
                modul: 'm',
                raum: r,
                ziel: i < 2 ? 20 : 22,
                power: true,
                comp: i % 3 ? 30 : 0,
                watt: 100 * i,
                wh: 10 * i,
            }),
        );
        const k = auswerten(z).module['welt/m'];
        expect(k.sollwertspruenge).to.have.length(1);
        expect(k.sollwertspruenge[0]).to.include({
            von: 20,
            nach: 22,
            ueberschwingen: 0.4,
            unterschwingen: 0.3,
            einschwingMin: 2,
        });
        expect(k.verdichterstarts).to.equal(3);
        expect(k.leistungMax).to.equal(900);
        expect(k.energieKWh).to.equal(0.09);
    });
});

describe('Simulator: Dienst (Ende-zu-Ende, lokaler aedes-Broker)', function () {
    this.timeout(15000);
    let broker;
    let server;
    let port;
    let dienst;
    let kunde;
    let ausgabe;
    const nachrichten = [];

    const warteAuf = (pruef, ms = 2000) =>
        new Promise((resolve, reject) => {
            const start = Date.now();
            const schau = () => {
                const t = nachrichten.find(pruef);
                if (t) {
                    resolve(t);
                } else if (Date.now() - start > ms) {
                    reject(new Error('timeout waiting for message'));
                } else {
                    setTimeout(schau, 10);
                }
            };
            schau();
        });
    const json = n => {
        try {
            return JSON.parse(n.payload);
        } catch {
            return {};
        }
    };
    const steuer = (methode, pfad, daten) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port: dienst.steuerPort, path: pfad, method: methode },
                res => {
                    let text = '';
                    res.on('data', t => (text += t));
                    res.on('end', () => resolve({ status: res.statusCode, daten: JSON.parse(text) }));
                },
            );
            req.on('error', reject);
            req.end(daten ? JSON.stringify(daten) : undefined);
        });

    before(async () => {
        const { Aedes } = require('aedes');
        broker = await Aedes.createBroker();
        server = net.createServer(broker.handle);
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
        ausgabe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faikout-sim-')), 'messung.jsonl');
        const konfig = konfigLesen({
            SIM_BROKER: `mqtt://127.0.0.1:${port}`,
            SIM_MODULE: 's21,nodemand',
            SIM_SZENARIO: 'heizenKalterTag',
            SIM_ZEITFAKTOR: '60',
            SIM_TAKT_MS: '20',
            SIM_HTTP_PORT: '0',
            SIM_AUSGABE: ausgabe,
        });
        konfig.steuerPortZufall = true;
        dienst = new Dienst(konfig, { log() {} });
        kunde = require('mqtt').connect(`mqtt://127.0.0.1:${port}`, { clientId: 'pruefer' });
        await new Promise(r => kunde.on('connect', r));
        await kunde.subscribeAsync('#');
        kunde.on('message', (topic, payload) => nachrichten.push({ topic, payload: payload.toString() }));
        await dienst.start();
    });

    after(async () => {
        await dienst.stop();
        await kunde.endAsync(true);
        await new Promise(r => broker.close(r));
        await new Promise(r => server.close(r));
        fs.rmSync(path.dirname(ausgabe), { recursive: true, force: true });
    });

    it('lehnt Broker im Heimnetz ab und liest die Umgebung', () => {
        for (const url of [
            'mqtt://192.168.30.70:1883',
            'mqtt://192.168.30.71',
            'mqtt://192.168.10.90:1888',
            'mqtt://nas.fritz.box',
            'x',
        ]) {
            expect(brokerErlaubt(url), url).to.equal(false);
        }
        for (const url of [
            'mqtt://127.0.0.1:1883',
            'mqtt://localhost',
            'mqtt://mosquitto:1883',
            'mqtt://172.20.0.5:1883',
            'mqtt://10.5.0.2',
        ]) {
            expect(brokerErlaubt(url), url).to.equal(true);
        }
        const k = konfigLesen({
            SIM_WELTEN: '[{"name":"a","broker":"mqtt://a"},{"name":"b","broker":"mqtt://b"}]',
            SIM_HTTP_PORT: '',
        });
        expect(k.welten.map(w => w.name)).to.eql(['a', 'b']);
        expect(k).to.include({ steuerPort: 18900, bind: '127.0.0.1', taktMs: 1000 });
        expect(k.http.port).to.equal(null);
        expect(konfigLesen({}).welten[0]).to.include({
            broker: 'mqtt://127.0.0.1:1883',
            praefix: 'sim-',
            szenario: 'heizenKalterTag',
        });
    });

    it('verweigert den Start mit einem Broker im Heimnetz', async () => {
        const boese = new Dienst(
            konfigLesen({ SIM_BROKER: 'mqtt://192.168.10.90:1888', SIM_HTTP_PORT: '', SIM_STEUER_PORT: '0' }),
            { log() {} },
        );
        let fehler;
        await boese.start().catch(e => (fehler = e));
        expect(fehler.message).to.match(/refused/);
        expect(boese.clients.size).to.equal(0);
    });

    it('Module melden sich am Broker, Statusmeldungen kommen an', async () => {
        const z = json(await warteAuf(n => n.topic === 'state/sim-s21' && json(n).up === true && 'outside' in json(n)));
        expect(z).to.include({ power: true, mode: 'heat', target: 21 });
        await warteAuf(n => n.topic === 'state/sim-nodemand/status');
        await warteAuf(n => n.topic.startsWith('homeassistant/climate/') && n.payload.includes('command/sim-nodemand'));
        await warteAuf(n => n.topic === 'Faikout/sim-s21', 0).catch(() => {}); // kommt erst zur vollen Minute
        expect([...Object.keys(broker.clients || {})].filter(c => c.startsWith('Faikout:sim-'))).to.have.length(2);
    });

    it('Befehl wirkt: Solltemperatur, demand angenommen bzw. abgelehnt', async () => {
        await kunde.publishAsync('command/sim-s21/temp', '24');
        await warteAuf(n => n.topic === 'state/sim-s21' && json(n).target === 24);
        await kunde.publishAsync('command/sim-s21/demand', '50');
        await kunde.publishAsync('command/sim-nodemand/demand', '50');
        await warteAuf(n => n.topic === 'state/sim-s21' && json(n).demand === 50);
        const fehler = await warteAuf(n => n.topic === 'error/sim-nodemand/failed-set');
        expect(fehler.payload).to.equal('{"demand":50}');
    });

    it('HTTP-Seiten und Steuerung: Stand, Ereignis (Verbindungsabriss), Szenariowechsel', async () => {
        const seite = await new Promise((resolve, reject) => {
            http.get(
                {
                    host: '127.0.0.1',
                    port: dienst.httpPorts[0],
                    path: '/revk-settings',
                    headers: { Host: 'sim-nodemand' },
                },
                res => {
                    let text = '';
                    res.on('data', t => (text += t));
                    res.on('end', () => resolve(text));
                },
            ).on('error', reject);
        });
        expect(discovery.seiteAuswerten(seite)).to.include({ hostname: 'sim-nodemand', mqtthost: `127.0.0.1:${port}` });

        const stand = await steuer('GET', '/stand');
        expect(stand.status).to.equal(200);
        const s21 = stand.daten.welten[0].module.find(m => m.name === 'sim-s21');
        expect(s21.zaehler.befehle).to.eql({ 'command/temp': 1, 'command/demand': 1 });
        expect(s21.anlage).to.include({ temp: 24, demand: 50 });
        expect(stand.daten.welten[0].module.find(m => m.name === 'sim-nodemand').zaehler.failedSet).to.equal(1);

        nachrichten.length = 0;
        const r = await steuer('POST', '/ereignis', { modul: 'sim-s21', art: 'verbindungsabriss', dauerSek: 300 });
        expect(r.daten.ok).to.equal(true);
        const lwt = await warteAuf(n => n.topic === 'state/sim-s21' && json(n).up === false);
        expect(lwt.payload).to.equal('{"up":false,"reason":"LWT"}');
        await warteAuf(n => n.topic === 'state/sim-s21' && json(n).up === true); // 300 s Szenariozeit = 5 Takte
        await warteAuf(n => n.topic.startsWith('homeassistant/climate/') && n.payload.includes('command/sim-s21'));

        expect((await steuer('POST', '/ereignis', { art: 'gibtsnicht' })).status).to.equal(400);
        expect((await steuer('POST', '/ereignis', { modul: 'fehlt', art: 'abtauen' })).status).to.equal(404);
        expect((await steuer('POST', '/szenario', { name: 'gibtsnicht' })).status).to.equal(400);
        expect((await steuer('POST', '/szenario', { welt: 'welt', name: 'sommerSchwuel' })).daten).to.include({
            szenario: 'sommerSchwuel',
        });
        await warteAuf(n => n.topic === 'state/sim-s21' && json(n).mode === 'cool');
        expect((await steuer('GET', '/szenarien')).daten.szenarien).to.include('sommerSchwuel');
    });

    it('schreibt die Messdatei, messung.js wertet sie aus', async () => {
        await new Promise(r => setTimeout(r, 100));
        const k = auswerten(fs.readFileSync(ausgabe, 'utf8'));
        expect(Object.keys(k.module)).to.have.members(['welt/sim-s21', 'welt/sim-nodemand']);
        const m = k.module['welt/sim-s21'];
        expect(m.zeilen).to.be.at.least(5);
        expect(m.energieKWh).to.be.above(0);
        expect(m.befehle['command/temp'].anzahl).to.equal(1);
    });
});
