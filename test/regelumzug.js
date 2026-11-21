'use strict';

/*
 * Umzug der Regelungs-Datenpunkte vom Vorabstand (`<Geraet>.regel.*`, `info.demandFaehig`) auf die
 * englischen IDs (`<Geraet>.regulation.*`, `info.demandCapable`) - lib/regel/umzug.js.
 */

process.env.TZ = 'Europe/Berlin';

const { expect } = require('chai');
const umzug = require('../lib/regel/umzug');
const regel = require('../lib/regel');
const zustand = require('../lib/regel/zustand');
const wochenplan = require('../lib/regel/wochenplan');
const { Anlage, aufbau, laufen } = require('./sim/simulator');

const { szenen } = wochenplan.szenenLesen(null);
const planText = JSON.stringify(wochenplan.vorgabePlan(szenen));
const START = new Date(2026, 10, 20, 21, 30).getTime();

/** Zustand des Vorabstands: Faehigkeit mit deutschem Wert, Verlauf, Aussenverlauf. */
const altZustand = () => {
    const z = zustand.leer();
    z.faehig = { wert: 'nein', code: 'keinDemand', grund: 'x' };
    z.bedarf.aussenVerlauf = [[START - 60000, 3]];
    z.verlauf = [[START - 3600000, 60]];
    return JSON.stringify(z);
};

/**
 * Legt den Altbestand eines Geraets an, wie ihn der Vorabstand hinterlassen hat.
 *
 * @param {object} a     Attrappe
 * @param {string} id    Geraete-ID
 * @param {object} werte alter Pfad -> Wert (ueberschreibt die Vorgaben)
 */
function altbestand(a, id, werte = {}) {
    a.objekte.set(id, { type: 'device', common: { name: id.replace('_', ' ') }, native: {} });
    a.objekte.set(`${id}.info`, { type: 'channel', common: {}, native: {} });
    for (const kanal of ['regel', 'regel.bedarf', 'regel.plan', 'regel.feuchte', 'regel.hand', 'regel.fuehler']) {
        a.objekte.set(`${id}.${kanal}`, { type: 'channel', common: {}, native: {} });
    }
    const vorgabe = {
        'regel.zustand': 'hand',
        'regel.grund': 'Handeingriff',
        'regel.betrieb': 'adapter',
        'regel.verlaufJson': JSON.stringify([[START - 3600000, 60]]),
        'regel.bedarf.aktiv': true,
        'regel.bedarf.probelauf': false,
        'regel.bedarf.zustand': 'nicht fähig',
        'regel.bedarf.strategie': 'vortag',
        'regel.bedarf.zustandJson': altZustand(),
        'regel.plan.aktiv': true,
        'regel.plan.wocheJson': planText,
        'regel.plan.abwesenheitJson': '',
        'regel.feuchte.aktiv': true,
        'regel.fuehler.raumStand': 'rueckfall',
        'regel.fuehler.feuchteStand': 'fehlt',
        'regel.fuehler.raumArt': 'intern',
        'regel.hand.aufheben': true,
        'info.demandFaehig': 'nein',
        ...werte,
    };
    for (const altPfad of Object.keys(umzug.PFADE)) {
        a.objekte.set(`${id}.${altPfad}`, { type: 'state', common: { name: altPfad }, native: { regel: true } });
        if (vorgabe[altPfad] !== undefined) {
            a.werte.set(`${id}.${altPfad}`, { val: vorgabe[altPfad], ack: true });
        }
    }
}

const alteIds = a => [...a.objekte.keys()].filter(k => /\.regel(\.|$)/.test(k) || k.endsWith('.demandFaehig'));

describe('Regelung: Umzug regel.* -> regulation.*', () => {
    it('Zuordnung ist vollstaendig: jede neue ID gibt es in den Definitionen, keine fehlt', () => {
        const neu = new Set([
            ...Object.keys(regel.DATENPUNKTE).map(f => `${regel.ZWEIG}.${f}`),
            ...Object.keys(regel.DATENPUNKTE_REGEL).map(f => `${regel.WURZEL}.${f}`),
            'info.demandCapable',
        ]);
        expect([...new Set(Object.values(umzug.PFADE))].sort()).to.eql([...neu].sort());
        expect(Object.keys(umzug.PFADE).length).to.equal(51);
        // jeder umgesetzte Zustandswert steht in common.states des neuen Datenpunkts
        const states = pfad =>
            pfad.startsWith(`${regel.ZWEIG}.`) && regel.DATENPUNKTE[pfad.slice(regel.ZWEIG.length + 1)]
                ? regel.DATENPUNKTE[pfad.slice(regel.ZWEIG.length + 1)].states
                : (regel.DATENPUNKTE_REGEL[pfad.slice(regel.WURZEL.length + 1)] || {}).states;
        for (const [alt, tabelle] of Object.entries(umzug.WERTE)) {
            if (alt === 'info.demandFaehig') {
                continue;
            }
            for (const wert of Object.values(tabelle)) {
                expect(states(umzug.PFADE[alt]), alt).to.have.property(wert);
            }
        }
    });

    it('Werte, Schalter, Plan und Zustand ziehen um; alte Objekte samt Kanaelen sind weg', async () => {
        const { a } = aufbau({ regelProbelauf: false }, START);
        altbestand(a, 'Alt_A');
        expect(await umzug.umziehen(a)).to.equal(1);
        expect(alteIds(a)).to.eql([]);
        expect([...a.werte.keys()].filter(k => k.includes('.regel.') || k.endsWith('demandFaehig'))).to.eql([]);
        const w = rel => a.wert(`Alt_A.${rel}`);
        expect(w('regulation.demand.active')).to.equal(true);
        expect(w('regulation.demand.dryRun')).to.equal(false);
        expect(w('regulation.schedule.active')).to.equal(true);
        expect(w('regulation.humidity.active')).to.equal(true);
        expect(w('regulation.schedule.weekJson')).to.equal(planText);
        expect(w('regulation.historyJson')).to.equal(JSON.stringify([[START - 3600000, 60]]));
        // Zustandswerte englisch
        expect(w('regulation.state')).to.equal('manual');
        expect(w('regulation.demand.state')).to.equal('notCapable');
        expect(w('regulation.demand.strategy')).to.equal('previousDay');
        expect(w('regulation.sensors.roomStatus')).to.equal('fallback');
        expect(w('regulation.sensors.humidityStatus')).to.equal('missing');
        expect(w('regulation.sensors.roomKind')).to.equal('internal');
        expect(w('regulation.mode')).to.equal('adapter');
        expect(w('info.demandCapable')).to.equal('no');
        // gespeicherter Zustand: Faehigkeit umgesetzt, der Rest unveraendert
        const z = JSON.parse(w('regulation.demand.stateJson'));
        expect(z.faehig).to.include({ wert: 'no', code: 'keinDemand' });
        expect(z.bedarf.aussenVerlauf).to.eql([[START - 60000, 3]]);
        expect(z.verlauf).to.eql([[START - 3600000, 60]]);
        // Tasten tragen keinen Wert hinueber
        expect(w('regulation.manual.resume')).to.equal(undefined);
        expect(a.objekte.get('Alt_A.regulation.manual.resume').common.role).to.equal('button');
        // Kanaele und Objekte nach den heutigen Definitionen
        expect(a.objekte.get('Alt_A.regulation.schedule').type).to.equal('channel');
        expect(a.objekte.get('Alt_A.regulation.state').common.states).to.have.property('manual');
        const zeile = a.zeilen.filter(z2 => z2.stufe === 'info' && /moved from "regel\.\*"/.test(z2.text));
        expect(zeile.length).to.equal(1);
        expect(zeile[0].text).to.match(/^Alt A: 17 control states moved from "regel\.\*" to "regulation\.\*"/);
    });

    it('ein zweiter Lauf tut nichts; ohne Altbestand keine Logzeile und kein Objekt', async () => {
        const { a } = aufbau({}, START);
        altbestand(a, 'Alt_B');
        a.objekte.set('Neu_C', { type: 'device', common: { name: 'Neu C' }, native: {} });
        await umzug.umziehen(a);
        const objekte = JSON.stringify([...a.objekte.entries()]);
        const werte = JSON.stringify([...a.werte.entries()]);
        const zeilen = a.zeilen.length;
        expect(await umzug.umziehen(a)).to.equal(0);
        expect(JSON.stringify([...a.objekte.entries()])).to.equal(objekte);
        expect(JSON.stringify([...a.werte.entries()])).to.equal(werte);
        expect(a.zeilen.length).to.equal(zeilen);
        expect([...a.objekte.keys()].filter(k => k.startsWith('Neu_C.'))).to.eql([]);
    });

    it('History-Einstellung (common.custom) wandert auf das neue Objekt', async () => {
        const { a } = aufbau({}, START);
        altbestand(a, 'Alt_D');
        const custom = { 'history.0': { enabled: true, changesOnly: true } };
        a.objekte.get('Alt_D.regel.bedarf.sollwert').common.custom = custom;
        a.werte.set('Alt_D.regel.bedarf.sollwert', { val: 60, ack: true });
        await umzug.umziehen(a);
        const neu = a.objekte.get('Alt_D.regulation.demand.setpoint');
        expect(neu.common.custom).to.eql(custom);
        expect(neu.common).to.include({ type: 'number', unit: '%', write: false });
        expect(a.wert('Alt_D.regulation.demand.setpoint')).to.equal(60);
        expect(a.objekte.get('Alt_D.regulation.demand.rawValue').common.custom).to.equal(undefined);
    });

    it('abgebrochener Umzug: was unter der neuen ID schon steht, behaelt seinen Wert', async () => {
        const { a } = aufbau({}, START);
        altbestand(a, 'Alt_E');
        await regel.objekteAnlegen(a, 'Alt_E', false);
        a.werte.set('Alt_E.regulation.schedule.active', { val: false, ack: true });
        a.objekte.delete('Alt_E.regulation.schedule.weekJson'); // dieses fehlte noch
        await umzug.umziehen(a);
        expect(a.wert('Alt_E.regulation.schedule.active')).to.equal(false);
        expect(a.wert('Alt_E.regulation.schedule.weekJson')).to.equal(planText);
        expect(alteIds(a)).to.eql([]);
    });

    it('unlesbarer Zustand und unbekannte Werte gehen unveraendert hinueber', () => {
        expect(umzug.wertUmsetzen('regel.bedarf.zustandJson', '{kaputt')).to.equal('{kaputt');
        expect(umzug.wertUmsetzen('regel.zustand', 'ok')).to.equal('ok');
        expect(umzug.wertUmsetzen('regel.zustand', 'gestört')).to.equal('fault');
        expect(umzug.wertUmsetzen('regel.zustand', 'einrichten')).to.equal('setup');
        expect(umzug.wertUmsetzen('regel.zustand', 'aus')).to.equal('off');
        expect(umzug.wertUmsetzen('regel.grund', 'aus')).to.equal('aus'); // Freitext bleibt
        expect(umzug.wertUmsetzen('info.demandFaehig', 'unbekannt')).to.equal('unknown');
        expect(umzug.wertUmsetzen('info.demandFaehig', 'ja')).to.equal('yes');
    });

    it('nach dem Umzug regelt der Adapter mit dem uebernommenen Plan weiter (scharf, kein Probelauf)', async () => {
        const { a, uhr } = aufbau({ regelProbelauf: false }, START);
        altbestand(a, 'Plan_U', { 'regel.feuchte.aktiv': false, 'regel.bedarf.aktiv': false, 'regel.zustand': 'ok' });
        await umzug.umziehen(a);
        const anlage = new Anlage({ name: 'Plan U', target: 21, mode: 'heat' });
        await laufen(a, uhr, anlage, 60); // ueber 22:00: Komfort -> Absenken
        expect(a.wert('Plan_U.regulation.schedule.scene')).to.equal('Absenken');
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_U.regulation.demand.dryRun')).to.equal(false);
        expect(alteIds(a)).to.eql([]);
        expect([...a.werte.keys()].filter(k => k.includes('.regel.'))).to.eql([]);
    });
});
