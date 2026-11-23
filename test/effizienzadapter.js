'use strict';

/**
 * Laufzeit der Effizienz am Adapter (lib/effizienz/index.js) mit einer Adapter-Attrappe: Datenpunkte,
 * Sichern/Laden, Kalibriermessung mit Sensor, Handmessung, Befehle des Reiters.
 */

const { expect } = require('chai');
const { Effizienz, schritt, aufloesen, neuerZustand, drehzahl } = require('../lib/effizienz');

function attrappe(config = {}) {
    const a = {
        namespace: 'faikout.0',
        config: { effizienzGeraete: [{ geraet: 'Truhe', modell: 'FVXM35A' }], effizienzModelle: [], ...config },
        geraete: new Map(),
        einheiten: new Map(),
        objekte: {},
        werte: {},
        fremd: {},
        logs: [],
        log: { info: t => a.logs.push(t), debug: () => {}, warn: t => a.logs.push(`WARN ${t}`) },
        sprache: async () => 'de',
        getObjectAsync: async id => a.objekte[id] || null,
        extendObject: async (id, o) => {
            const alt = a.objekte[id] || { common: {}, native: {} };
            a.objekte[id] = { ...alt, ...o, common: { ...alt.common, ...(o.common || {}) }, native: { ...alt.native, ...(o.native || {}) } };
        },
        zaehlerObjekt: async (id, name, unit) => a.extendObject(id, { type: 'state', common: { name, unit } }),
        wertSchreiben: async (id, val) => {
            a.werte[id] = val;
        },
        getForeignStateAsync: async id => a.fremd[id] || null,
        geraetNochDa: async () => true,
    };
    a.geraete.set('Truhe', { name: 'Truhe', angelegt: new Set(), up: true });
    a.geraete.set('IR', { name: 'IR', angelegt: new Set(), up: true });
    a.objekte.Truhe = { common: { name: 'Truhe' }, native: {} };
    a.objekte.IR = { common: { name: 'IR' }, native: {} };
    return a;
}

const HEIZT = { power: true, mode: 'heat', fan: 'mediumHigh', fanfreq: 980, comp: 2400, achome: 22, liquid: 34, outside: 2, consumption: 600, energy: 5000000 };

describe('Effizienz am Adapter', () => {
    let uhr;
    let echteUhr;
    beforeEach(() => {
        echteUhr = Date.now;
        uhr = new Date(2026, 10, 22, 10, 0, 0).getTime();
        Date.now = () => uhr;
    });
    afterEach(() => {
        Date.now = echteUhr;
    });
    const minuten = n => {
        uhr += n * 60000;
    };

    it('Drehzahl: Hz und 1/min je nach Einheit, ohne Einheit nach dem Wert', () => {
        expect(drehzahl(12.5, 'Hz')).to.equal(750);
        expect(drehzahl(750, 'rpm')).to.equal(750);
        expect(drehzahl(12.5, undefined)).to.equal(750);
        expect(drehzahl(750, undefined)).to.equal(750);
        expect(drehzahl(null, 'rpm')).to.equal(null);
    });

    it('legt die Datenpunkte unter efficiency.* an und schreibt Leistung, COP, Güte und Mengen', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        for (let i = 0; i <= 30; i++) {
            await e.status('Truhe', a.geraete.get('Truhe'), { ...HEIZT, energy: 5000000 + i * 10 });
            minuten(1);
        }
        expect(a.objekte['Truhe.efficiency'].type).to.equal('channel');
        for (const id of ['heatOutput', 'coolingOutput', 'cop', 'airflow', 'outletTemperature', 'defrosting', 'state', 'quality', 'uncertainty', 'copToday', 'daysJson', 'heat.today', 'cold.thisMonth']) {
            expect(a.objekte[`Truhe.efficiency.${id}`], id).to.be.an('object');
        }
        expect(a.objekte['Truhe.efficiency.heatOutput'].common).to.deep.include({ unit: 'kW', role: 'value.power', write: false });
        expect(a.objekte['Truhe.efficiency.heatOutput'].common.name.de).to.equal('Wärmeleistung (geschätzt)');
        const w = k => a.werte[`Truhe.efficiency.${k}`];
        // 8,5 m³/min, ε ~0,90, 12 K -> rund 1,85 kW
        expect(w('heatOutput')).to.be.within(1.7, 2.0);
        expect(w('coolingOutput')).to.equal(0);
        expect(w('cop')).to.be.within(2.8, 3.3);
        expect(w('airflow')).to.equal(510);
        expect(w('state')).to.equal('heating');
        expect(w('quality')).to.equal('estimated');
        expect(w('uncertainty')).to.be.within(20, 35);
        expect(w('defrosting')).to.equal(false);
        expect(w('heat.today')).to.be.within(0.85, 1.0);
        // Strom aus dem Energiezaehler: 30 x 10 Wh = 0,3 kWh
        expect(w('copToday')).to.be.within(2.8, 3.4);
        expect(JSON.parse(w('daysJson')).pop()).to.include.keys('day', 'heat', 'elHeat');
        expect(a.objekte['Truhe.efficiency.heatPrice'], 'ohne Preis kein Kosten-Datenpunkt').to.equal(undefined);
    });

    describe('Multisplit (Issue #8)', () => {
        /**
         * Heizen. Das Modul meldet energy des gemeinsamen Aussengeraets (beide Raeume), energyheat zaehlt nur
         * dieses Innengeraet: +100 Wh alle 10 min (600 W). consumption ist die Leistung des Innengeraets (S21
         * "FX60", 1.2.1) - 600 W passt zum Zaehler, 1200 W waere die des ganzen Aussengeraets.
         *
         * @param {number} nachbarEnergy  energy-Zaehlerstand (Wh) des zweiten Moduls
         * @param {number} [leistung]  gemeldete Leistung (W)
         * @param {number} [dauer]  Minuten
         */
        const lauf = async (nachbarEnergy, leistung = 1200, dauer = 30) => {
            const a = attrappe();
            a.geraete.get('Truhe').zaehler = { energy: { letzterWert: 5000000 } };
            a.geraete.set('Nachbar', {
                name: 'Nachbar',
                angelegt: new Set(),
                up: true,
                zaehler: { energy: { letzterWert: nachbarEnergy } },
            });
            const e = new Effizienz(a);
            a.einheiten.set('Truhe', { fanfreq: 'rpm' });
            for (let i = 0; i <= dauer; i++) {
                await e.status('Truhe', a.geraete.get('Truhe'), {
                    ...HEIZT,
                    consumption: leistung,
                    energy: 5000000,
                    energyheat: 2000000 + Math.floor(i / 10) * 100,
                    energycool: 1000000,
                });
                minuten(1);
            }
            return { a, e, w: k => a.werte[`Truhe.efficiency.${k}`] };
        };

        it('gleicher Außengeräte-Zähler: Strom aus der Leistung des Innengeräts, Momentan-COP da, Kennzeichen gesetzt', async () => {
            const { a, w } = await lauf(5000000, 600);
            expect(w('sharedOutdoorUnit')).to.equal(true);
            // Waerme ~0,9 kWh gegen 0,3 kWh Strom des Innengeraets (600 W x 30 min)
            expect(w('cop')).to.be.within(2.8, 3.4);
            expect(w('heat.today')).to.be.within(0.85, 1.0);
            expect(w('copToday')).to.be.within(2.8, 3.4);
            expect(a.logs.filter(t => /multi split/.test(t))).to.have.length(1);
            expect(a.objekte['Truhe.efficiency.sharedOutdoorUnit'].common.name).to.include({
                de: 'Gemeinsames Außengerät (Multisplit)',
            });
        });

        it('Plausibilität: Leistung doppelt so groß wie der Innenzähler -> gemeinsam, ab dann Strom aus dem Innenzähler', async () => {
            const { a, e, w } = await lauf(5000000, 1200, 130);
            const z = e.zustand.get('Truhe');
            expect(z.leistungPruef.bezug).to.equal('aussen');
            expect(z.leistungPruef.faktor).to.be.within(1.8, 2.2);
            expect(w('cop')).to.equal(null);
            expect(a.logs.filter(t => /power of the whole outdoor unit/.test(t))).to.have.length(1);
            // gesichert im Geraeteobjekt (uebersteht den Neustart)
            expect(a.objekte.Truhe.native.effizienz.leistungPruef.bezug).to.equal('aussen');
        });

        it('Plausibilität: Leistung passt zum Innenzähler -> bleibt die des Innengeräts', async () => {
            const { e, w } = await lauf(5000000, 600, 130);
            expect(e.zustand.get('Truhe').leistungPruef.bezug).to.equal('innen');
            expect(w('cop')).to.be.within(2.8, 3.4);
        });

        it('Single-Split (Regression): eigener Außengeräte-Zähler, Strom wie bisher aus der Leistung', async () => {
            const { a, w } = await lauf(3131200);
            expect(w('sharedOutdoorUnit')).to.equal(false);
            expect(w('cop')).to.be.within(1.4, 1.7);
            // 1200 W x 30 min = 0,6 kWh
            expect(w('copToday')).to.be.within(1.4, 1.7);
            expect(a.logs.filter(t => /multi split/.test(t))).to.have.length(0);
        });
    });

    it('Schreiblast: schnelle Folgemeldungen schreiben nicht jedes Mal, ein Wechsel des Zustands sofort', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('Truhe');
        let n = 0;
        const schreiben = a.wertSchreiben;
        a.wertSchreiben = async (id, val) => {
            n++;
            return schreiben(id, val);
        };
        await e.status('Truhe', g, HEIZT);
        const erste = n;
        expect(erste).to.be.greaterThan(10);
        for (let i = 0; i < 5; i++) {
            uhr += 3000;
            await e.status('Truhe', g, { ...HEIZT, liquid: 34 + i * 0.5 });
        }
        expect(n, 'fuenf Meldungen in 15 s: nichts geschrieben').to.equal(erste);
        uhr += 3000;
        await e.status('Truhe', g, { ...HEIZT, fanfreq: 0, liquid: 5 });
        expect(n, 'Abtauen beginnt: sofort').to.be.greaterThan(erste);
        expect(a.werte['Truhe.efficiency.defrosting']).to.equal(true);
        const danach = n;
        minuten(1);
        await e.status('Truhe', g, { ...HEIZT, fanfreq: 0, liquid: 5 });
        expect(n).to.be.greaterThan(danach);
    });

    it('mit Strompreis: Kosten je kWh Wärme', async () => {
        const a = attrappe({ effizienzPreis: 0.3 });
        const e = new Effizienz(a);
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        for (let i = 0; i <= 30; i++) {
            await e.status('Truhe', a.geraete.get('Truhe'), { ...HEIZT, energy: 5000000 + i * 10 });
            minuten(1);
        }
        expect(a.werte['Truhe.efficiency.heatPrice']).to.be.within(0.085, 0.11);
    });

    it('Gerät ohne die nötigen Werte (IR-Brücke): nur Güte "nicht verfügbar" und die Liste, einmal im Log', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('IR');
        await e.status('IR', g, { power: true, mode: 'heat', fan: 'auto' });
        await e.status('IR', g, { power: true, mode: 'heat', fan: 'auto' });
        expect(a.werte['IR.efficiency.quality']).to.equal('unavailable');
        expect(a.werte['IR.efficiency.missing']).to.equal('achome, liquid');
        expect(a.objekte['IR.efficiency.heatOutput']).to.equal(undefined);
        expect(a.logs.filter(l => /not available/.test(l))).to.have.lengthOf(1);
        const stand = await e.befehl('effizienzStand', {});
        expect(stand.geraete.find(x => x.id === 'IR')).to.deep.include({ verfuegbar: false, fehlt: ['achome', 'liquid'] });
    });

    it('Abtauen: Kennzeichen gesetzt, Leistung 0', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        await e.status('Truhe', a.geraete.get('Truhe'), { ...HEIZT, fanfreq: 0, comp: 3960, achome: 23, liquid: 6.5 });
        expect(a.werte['Truhe.efficiency.defrosting']).to.equal(true);
        expect(a.werte['Truhe.efficiency.state']).to.equal('defrosting');
        expect(a.werte['Truhe.efficiency.heatOutput']).to.equal(0);
        expect(a.werte['Truhe.efficiency.cop']).to.equal(null);
    });

    it('sichert Mengen, Drehzahlen und Kalibrierungen im Geräteobjekt und lädt sie nach dem Neustart', async () => {
        const a = attrappe();
        let e = new Effizienz(a);
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        for (let i = 0; i <= 20; i++) {
            await e.status('Truhe', a.geraete.get('Truhe'), HEIZT);
            minuten(1);
        }
        await e.sichernAlle();
        const gesichert = a.objekte.Truhe.native.effizienz;
        expect(gesichert.zaehler.waerme).to.be.greaterThan(500);
        expect(gesichert.drehzahlen.heizen.MH.length).to.be.greaterThan(5);
        // Neustart
        e = new Effizienz(a);
        a.geraete.get('Truhe').angelegt = new Set();
        minuten(1);
        await e.status('Truhe', a.geraete.get('Truhe'), HEIZT);
        expect(a.werte['Truhe.efficiency.heat.today'], 'zaehlt weiter statt bei 0 zu beginnen').to.be.greaterThan(0.5);
    });

    it('Kalibriermessung: Start prüft den Sensor, Punkte kommen im Takt, Abdeckung je Stufe, Übernehmen macht sie zur geltenden Kalibrierung', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('Truhe');
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        expect((await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start' })).error).to.match(/Austrittssensor/);
        expect((await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start', austrittDp: 'x.0.fehlt' })).error).to.match(/x\.0\.fehlt/);
        expect((await e.befehl('effizienzMessung', { geraet: 'Nix', aktion: 'start', austrittDp: 'x' })).error).to.match(/Nix/);
        a.fremd['sensor.0.aus'] = { val: 35.2, ts: uhr };
        const start = await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start', austrittDp: 'sensor.0.aus', abstandSek: 60, anlaufSek: 120 });
        expect(start.ok).to.equal(true);
        expect(start.geraet.messung).to.deep.include({ status: 'laeuft', punkte: 0, sensorWert: 35.2 });
        // 40 min Heizen auf MH, wahres ε = 1,1 -> T_aus = 22 + 1,1 * 12
        for (let i = 0; i < 40; i++) {
            minuten(1);
            a.fremd['sensor.0.aus'] = { val: 35.2 + (i % 3) * 0.1, ts: uhr };
            await e.status('Truhe', g, HEIZT);
            await e.takt();
        }
        // dann Abtauen: wird gezaehlt, aber nicht aufgenommen
        for (let i = 0; i < 3; i++) {
            minuten(1);
            await e.status('Truhe', g, { ...HEIZT, fanfreq: 0, liquid: 5 });
            await e.takt();
        }
        let stand = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe');
        expect(stand.messung.punkte).to.be.within(35, 40);
        expect(stand.messung.verworfen.abtauen).to.equal(3);
        expect(stand.messung.verworfen.anlauf).to.be.at.least(1);
        expect(stand.messung.abdeckung.heizen.stufen.MH).to.deep.include({ stand: 'ok' });
        expect(stand.messung.abdeckung.heizen.naechste).to.be.oneOf(['M', 'H', 'L']);
        expect(stand.messung.heizen.stufen.MH.eps).to.be.closeTo(1.1, 0.02);
        expect(stand.eps.heizen.guete, 'noch gilt die Datenblatt-Schaetzung').to.equal('estimated');
        // die laufende Messung uebersteht den Neustart
        await e.sichernAlle();
        const e2 = new Effizienz(a);
        stand = (await e2.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe');
        expect(stand.messung.status).to.equal('laeuft');
        expect(stand.messung.punkte).to.be.within(35, 40);
        // uebernehmen
        const fertig = await e2.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'uebernehmen' });
        expect(fertig.geraet.messung).to.equal(null);
        expect(fertig.geraet.kalibrierungen).to.have.lengthOf(1);
        expect(fertig.geraet.kalibrierungen[0]).to.deep.include({ quelle: 'sensor', aktiv: true });
        expect(fertig.geraet.eps.heizen.guete).to.equal('calibrated');
        minuten(1);
        await e2.status('Truhe', g, HEIZT);
        minuten(4); // nach dem Neustart gilt der Verdichter erst nach der Anlaufzeit als eingeschwungen
        await e2.status('Truhe', g, HEIZT);
        expect(a.werte['Truhe.efficiency.quality']).to.equal('calibrated');
        expect(a.werte['Truhe.efficiency.outletTemperature']).to.be.closeTo(35.2, 0.3);
        expect(a.werte['Truhe.efficiency.uncertainty']).to.be.lessThan(20);
        // zurueck auf die Datenblatt-Schaetzung, wieder aktivieren, loeschen
        const id = fertig.geraet.kalibrierungen[0].id;
        expect((await e2.befehl('effizienzKalibrierung', { geraet: 'Truhe', aktion: 'datenblatt' })).geraet.eps.heizen.guete).to.equal('estimated');
        expect((await e2.befehl('effizienzKalibrierung', { geraet: 'Truhe', aktion: 'aktivieren', id })).geraet.aktiv).to.equal(id);
        const weg = await e2.befehl('effizienzKalibrierung', { geraet: 'Truhe', aktion: 'loeschen', id });
        expect(weg.geraet.kalibrierungen).to.eql([]);
        expect(weg.geraet.aktiv).to.equal(null);
        expect((await e2.befehl('effizienzKalibrierung', { geraet: 'Truhe', aktion: 'aktivieren', id })).error).to.match(/nicht mehr/);
    });

    it('Kalibriermessung: nach einem Wechsel der Lüfterstufe zählen die Punkte erst wieder nach der Wartezeit', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('Truhe');
        a.fremd['sensor.0.aus'] = { val: 35, ts: uhr };
        await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start', austrittDp: 'sensor.0.aus', abstandSek: 60, anlaufSek: 240 });
        const runde = async (fan, n) => {
            for (let i = 0; i < n; i++) {
                minuten(1);
                a.fremd['sensor.0.aus'] = { val: 35, ts: uhr };
                await e.status('Truhe', g, { ...HEIZT, fan });
                await e.takt();
            }
        };
        await runde('mediumHigh', 10);
        let m = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe').messung;
        const vorher = m.punkte;
        expect(vorher).to.be.within(5, 7);
        await runde('high', 3);
        m = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe').messung;
        expect(m.punkte, 'drei Minuten nach dem Wechsel: noch kein neuer Punkt').to.equal(vorher);
        expect(m.verworfen.wechsel).to.equal(3);
        await runde('high', 4);
        m = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe').messung;
        expect(m.abdeckung.heizen.stufen.H.n).to.be.within(2, 4);
    });

    it('Messung verwerfen und ein veralteter Sensorwert', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('Truhe');
        a.fremd['sensor.0.aus'] = { val: 35, ts: uhr };
        await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'start', austrittDp: 'sensor.0.aus', abstandSek: 60, anlaufSek: 0 });
        minuten(30);
        await e.status('Truhe', g, HEIZT);
        await e.takt();
        const stand = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe');
        expect(stand.messung.verworfen).to.eql({ sensorAlt: 1 });
        expect((await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'uebernehmen' })).error).to.match(/Messpunkte/);
        expect((await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'verwerfen' })).geraet.messung).to.equal(null);
        expect((await e.befehl('effizienzMessung', { geraet: 'Truhe', aktion: 'stopp' })).error).to.match(/keine Messung/);
    });

    it('Handmessung: die übrigen Werte kommen aus dem eigenen Verlauf; Abtauen wird mit Begründung abgelehnt', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const g = a.geraete.get('Truhe');
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        for (let i = 0; i < 10; i++) {
            await e.status('Truhe', g, HEIZT);
            minuten(1);
        }
        const zeit = uhr - 3 * 60000;
        const suche = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'suchen', zeit, tAus: 35.5 });
        expect(suche.quelle).to.equal('verlauf');
        expect(suche.fehlt).to.eql([]);
        expect(suche.gefunden).to.deep.include({ art: 'heizen', stufe: 'MH', tEin: 22, tRef: 34 });
        const dazu = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'hinzufuegen', zeit, tAus: 35.5 });
        expect(dazu.geraet.hand.punkte).to.have.lengthOf(1);
        expect(dazu.geraet.hand.heizen.stufen.MH.eps).to.be.closeTo(1.125, 0.001);
        // Abtauen zum Zeitpunkt
        await e.status('Truhe', g, { ...HEIZT, fanfreq: 0, comp: 3960, achome: 23, liquid: 6.5 });
        const schlecht = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'hinzufuegen', zeit: uhr, tAus: 29.9 });
        expect(schlecht.error).to.match(/nicht brauchbar/);
        // uebernehmen -> Kalibrierung aus Handmessung
        const fertig = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'uebernehmen' });
        expect(fertig.geraet.kalibrierungen[0]).to.deep.include({ quelle: 'hand', n: 1, aktiv: true });
        expect(fertig.geraet.hand.punkte).to.eql([]);
    });

    it('Handmessung ohne Verlauf: fragt die fehlenden Werte ab; mit History-Adapter liest sie dort', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        const alt = uhr - 3 * 86400000;
        const ohne = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'hinzufuegen', zeit: alt, tAus: 33 });
        expect(ohne.quelle).to.equal('keine');
        expect(ohne.fehlt).to.eql(['art', 'tEin', 'tRef']);
        // von Hand ergaenzt
        const mit = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'hinzufuegen', zeit: alt, tAus: 33, werte: { art: 'heizen', stufe: 'M', tEin: 21, tRef: 31 } });
        expect(mit.geraet.hand.punkte[0]).to.deep.include({ stufe: 'M', tEin: 21, tRef: 31, tAus: 33 });
        // History-Adapter: gefragt werden nur Datenpunkte, die die Instanz aufzeichnet (custom.enabled)
        a.config.historyInstance = 'influxdb.0';
        const historie = { 'control.mode': 'heat', 'control.fan': 'high', 'status.achome': 20.5, 'status.liquid': 33, 'status.fanfreq': 19, 'status.comp': 2100, 'status.outside': 3, 'status.consumption': 700 };
        const gefragt = [];
        a.getForeignObjectAsync = async id => {
            const rel = id.replace('faikout.0.Truhe.', '');
            return rel in historie ? { common: { custom: { 'influxdb.0': { enabled: true } } } } : { common: {} };
        };
        a.sendToAsync = async (inst, befehl, msg) => {
            expect(inst).to.equal('influxdb.0');
            expect(befehl).to.equal('getHistory');
            expect(msg.options).to.deep.include({ aggregate: 'none', returnNewestEntries: true });
            const rel = msg.id.replace('faikout.0.Truhe.', '');
            gefragt.push(rel);
            // wie influxdb: Wert vor dem Beginn als Randwert, dann der eigentliche
            return { result: [{ ts: msg.options.start - 1000, val: 'alt' }, { ts: msg.options.end - 120000, val: historie[rel] }] };
        };
        a.einheiten.set('Truhe', { fanfreq: 'Hz' });
        const h = await e.befehl('effizienzHand', { geraet: 'Truhe', aktion: 'suchen', zeit: alt - 3600000, tAus: 34 });
        expect(h.quelle).to.equal('history');
        expect(h.gefunden).to.deep.include({ art: 'heizen', stufe: 'H', tEin: 20.5, tRef: 33, rpm: 1140 });
        expect(gefragt).not.to.include('status.home'); // nicht aufgezeichnet: nicht gefragt
    });

    it('Stand rechnet mit den ungespeicherten Werten des Formulars (Modell, eigene Kennlinie)', async () => {
        const a = attrappe({ effizienzGeraete: [] });
        const e = new Effizienz(a);
        const ohne = (await e.befehl('effizienzStand', {})).geraete.find(x => x.id === 'Truhe');
        expect(ohne).to.deep.include({ modell: null, generisch: true, wartet: true });
        const mit = (await e.befehl('effizienzStand', { zeilen: [{ geraet: 'Truhe', modell: 'FVXM35A', luftstromHeizen: { H: 11 } }] })).geraete.find(x => x.id === 'Truhe');
        expect(mit.modell).to.equal('FVXM35A');
        expect(mit.kennlinie.heizen.werte.H).to.equal(11);
        expect(mit.kennlinie.heizen.herkunft).to.deep.include({ H: 'eigen', M: 'datenblatt', MH: 'interpoliert' });
        expect(mit.vorgabe.heizen.bf).to.equal(0.11);
    });

    it('der Kern übersteht Teilmeldungen und einen Zustand aus der Sicherung', () => {
        const k = aufloesen({ modell: 'FVXM35A' }, []);
        const z = JSON.parse(JSON.stringify(neuerZustand()));
        const t0 = new Date(2026, 10, 22, 9, 0).getTime();
        schritt(z, HEIZT, k, t0, { einheitFan: 'rpm' });
        const r = schritt(z, { liquid: 36 }, k, t0 + 60000, { einheitFan: 'rpm' });
        expect(r.ergebnis.art).to.equal('heizen');
        expect(r.ergebnis.eingang.tRef).to.equal(36);
    });

    it('Verbrauchsansicht bekommt Wärme und Strom aus der Laufzeit', async () => {
        const a = attrappe();
        const e = new Effizienz(a);
        a.effizienz = e;
        a.einheiten.set('Truhe', { fanfreq: 'rpm' });
        a.getStateAsync = async () => null;
        for (let i = 0; i <= 30; i++) {
            await e.status('Truhe', a.geraete.get('Truhe'), { ...HEIZT, energy: 5000000 + i * 10 });
            await e.status('IR', a.geraete.get('IR'), { power: true, mode: 'heat', fan: 'auto' });
            minuten(1);
        }
        const r = await require('../lib/verbrauchbild').antwort(a, { zeitraum: 'woche', art: 'heizen', ansicht: 'waerme' }, new Date(uhr));
        const truhe = r.geraete.find(g => g.id === 'Truhe');
        expect(r.waermeDa).to.equal(true);
        expect(truhe.zaehler).to.equal(true);
        expect(truhe.summe).to.be.within(0.85, 1.0);
        expect(truhe.strom.reduce((s, v) => s + (v || 0), 0)).to.be.closeTo(0.3, 0.01);
        expect(truhe.guete).to.equal('estimated');
        expect(r.geraete.find(g => g.id === 'IR').zaehler, 'ohne Werte keine Waerme').to.equal(false);
        expect(r.texte.waerme).to.equal('Wärme & COP');
    });

    it('Gerätekarte: Zeile "COP heute" mit Güte, sobald es den Datenpunkt gibt', () => {
        const quelle = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'devicemanager.js'), 'utf8');
        expect(quelle).to.match(/items\.copToday = \{/);
        expect(quelle).to.match(/efficiency\.copToday/);
        expect(quelle).to.match(/efficiency\.quality/);
    });
});
