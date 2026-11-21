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
        expect(a.wert('Plan_U.regulation.schedule.level')).to.equal('Absenken');
        expect(anlage.target).to.equal(19);
        expect(a.wert('Plan_U.regulation.demand.dryRun')).to.equal(false);
        expect(alteIds(a)).to.eql([]);
        expect([...a.werte.keys()].filter(k => k.includes('.regel.'))).to.eql([]);
    });
});

describe('Regelung: Umzug schedule.scene -> schedule.level (Zwischenstand vor "Temperaturstufen")', () => {
    /** Legt die beiden Datenpunkte des Zwischenstands an, wie sie der Adapter bis 21.11.2026 fuehrte. */
    const zwischenstand = (a, id, custom) => {
        a.objekte.set(id, { type: 'device', common: { name: id }, native: {} });
        for (const [alt, wert] of [
            ['regulation.schedule.scene', 'Komfort'],
            ['regulation.schedule.nextScene', 'Absenken'],
        ]) {
            a.objekte.set(`${id}.${alt}`, { type: 'state', common: { name: alt, ...(custom ? { custom } : {}) }, native: {} });
            a.werte.set(`${id}.${alt}`, { val: wert, ack: true });
        }
    };

    it('Zuordnung: beide alten IDs, die neuen stehen in den Definitionen; regel.plan.szene zieht direkt nach level', () => {
        expect(umzug.PFADE_ZWISCHEN).to.eql({
            'regulation.schedule.scene': 'regulation.schedule.level',
            'regulation.schedule.nextScene': 'regulation.schedule.nextLevel',
        });
        expect(umzug.PFADE['regel.plan.szene']).to.equal('regulation.schedule.level');
        expect(umzug.PFADE['regel.plan.naechsteSzene']).to.equal('regulation.schedule.nextLevel');
        expect(regel.DATENPUNKTE_REGEL).to.include.keys('schedule.level', 'schedule.nextLevel');
        expect(regel.DATENPUNKTE_REGEL).to.not.have.any.keys('schedule.scene', 'schedule.nextScene');
    });

    it('Wert und eigene Einstellungen (History) ziehen um, die alten Objekte sind weg; ein zweiter Lauf tut nichts', async () => {
        const { a } = aufbau({}, START);
        zwischenstand(a, 'Zw_A', { 'history.0': { enabled: true } });
        expect(await umzug.geraetUmziehen(a, 'Zw_A')).to.eql({ umgezogen: 2, geloescht: false, umbenannt: 2 });
        expect(a.objekte.has('Zw_A.regulation.schedule.scene')).to.equal(false);
        expect(a.objekte.has('Zw_A.regulation.schedule.nextScene')).to.equal(false);
        expect(a.werte.has('Zw_A.regulation.schedule.scene')).to.equal(false);
        expect(a.wert('Zw_A.regulation.schedule.level')).to.equal('Komfort');
        expect(a.wert('Zw_A.regulation.schedule.nextLevel')).to.equal('Absenken');
        expect(a.objekte.get('Zw_A.regulation.schedule.level').common.custom).to.eql({ 'history.0': { enabled: true } });
        expect(a.objekte.get('Zw_A.regulation.schedule.level').common.name.de).to.equal('Aktuelle Temperaturstufe');
        expect(a.zeilen.filter(z => /renamed/.test(z.text))).to.have.length(0); // geloggt wird in umziehen()
        expect(await umzug.geraetUmziehen(a, 'Zw_A')).to.eql({ umgezogen: 0, geloescht: false, umbenannt: 0 });
    });

    it('gibt es level schon, bleibt sein Wert; umziehen() meldet die Umbenennung im Log', async () => {
        const { a } = aufbau({}, START);
        zwischenstand(a, 'Zw_B');
        await regel.objekteAnlegen(a, 'Zw_B', false);
        a.werte.set('Zw_B.regulation.schedule.level', { val: 'Abwesend', ack: true });
        await umzug.umziehen(a);
        expect(a.wert('Zw_B.regulation.schedule.level')).to.equal('Abwesend');
        expect(a.objekte.has('Zw_B.regulation.schedule.scene')).to.equal(false);
        expect(a.zeilen.filter(z => /2 control states renamed/.test(z.text))).to.have.length(1);
    });

    it('Vorabstand regel.plan.szene: landet in einem Schritt unter level', async () => {
        const { a } = aufbau({}, START);
        altbestand(a, 'Alt_L', { 'regel.plan.szene': 'Komfort', 'regel.plan.naechsteSzene': 'Absenken' });
        await umzug.umziehen(a);
        expect(a.wert('Alt_L.regulation.schedule.level')).to.equal('Komfort');
        expect(a.wert('Alt_L.regulation.schedule.nextLevel')).to.equal('Absenken');
        expect([...a.objekte.keys()].filter(k => /scene|Scene|szene|Szene/.test(k))).to.eql([]);
    });
});

describe('Einstellungen: Umzug beim Start (konfigUmziehen in main.js)', () => {
    const kennlinie = require('../lib/regel/kennlinie');
    const HEIZEN_ALT = [
        { x: -10, y: 95 },
        { x: 0, y: 75 },
        { x: 7, y: 55 },
        { x: 15, y: 40 },
    ];
    const HEIZEN_NEU = [{ x: -10, y: 100 }, ...HEIZEN_ALT.slice(1)];
    /** Felder mit Vorgabe, die jede gespeicherte Geraetezeile nach dem Start hat (lib/regel/vorlage.js) */
    const V = require('../lib/regel/vorlage').ZEILEN_VORGABEN;
    /** Stand "schon umgezogen" - damit ein Test genau EINE Regel zeigt. */
    const FERTIG = { externClientIdStandard: 'iobroker-faikout-0-abc', externClientId: 'iobroker-faikout-0-abc', regelUmzugStand: 3, regelProbelauf: true };

    /**
     * Adapter mit einer gespeicherten Instanzkonfiguration; konfigUmziehen schreibt sie ganz zurueck.
     *
     * @param {object} native  gespeicherte Einstellungen
     * @returns {object} Adapter mit `gespeichert` (Objekt der Instanz) und `geschrieben` (Zahl der Schreibvorgaenge)
     */
    const instanz = native => {
        const { a } = aufbau(JSON.parse(JSON.stringify(native)), START);
        a.instance = 0;
        a.gespeichert = { _id: 'system.adapter.faikout.0', type: 'instance', common: {}, native: JSON.parse(JSON.stringify(native)) };
        a.geschrieben = 0;
        a.getForeignObjectAsync = async id => (id === 'system.adapter.faikout.0' ? JSON.parse(JSON.stringify(a.gespeichert)) : null);
        a.setForeignObjectAsync = async (id, obj) => {
            a.geschrieben++;
            a.gespeichert = JSON.parse(JSON.stringify(obj));
        };
        a.extendForeignObjectAsync = async () => {
            throw new Error('konfigUmziehen muss das Objekt ganz schreiben');
        };
        return a;
    };
    /** Zweiter Start mit dem, was der erste gespeichert hat: nichts mehr zu tun. */
    const zweiterStart = async a => {
        const b = instanz(a.gespeichert.native);
        expect(await b.konfigUmziehen(), 'zweiter Start').to.equal(false);
        expect(b.geschrieben).to.equal(0);
    };

    it('ist alles auf dem Stand, schreibt der Start nichts', async () => {
        const a = instanz({ ...FERTIG, user: 'u', regelObergrenze: 95, regelKennlinieHeizen: HEIZEN_ALT, regelGeraete: [{ ...V, geraet: 'A' }] });
        expect(await a.konfigUmziehen()).to.equal(false);
        expect(a.geschrieben).to.equal(0);
    });

    it('User -> user: der Benutzername des eigenen Brokers aus dem Vorabstand 0.5.0-alpha bleibt erhalten, pass bleibt verschluesselt wie es ist', async () => {
        const a = instanz({ ...FERTIG, User: 'klima', pass: 'VERSCHLUESSELT' });
        a.config.pass = 'geheim'; // der Adapter sieht das entschluesselte Passwort - gespeichert bleibt das verschluesselte
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.gespeichert.native).to.include({ user: 'klima', User: '', pass: 'VERSCHLUESSELT' });
        expect(a.config.user).to.equal('klima'); // gilt schon in diesem Lauf (bis zum Neustart)
        expect(a.zeilen.some(z => z.stufe === 'info' && /Settings completed \(.*user.*\)/.test(z.text))).to.equal(true);
        await zweiterStart(a);
        // leeres user-Feld als '' gespeichert (Formular): zaehlt wie leer
        const leer = instanz({ ...FERTIG, user: '  ', User: 'klima' });
        await leer.konfigUmziehen();
        expect(leer.gespeichert.native.user).to.equal('klima');
        // ein gesetztes user gewinnt, User wird nicht angefasst; ohne User nichts zu tun
        for (const native of [{ ...FERTIG, user: 'neu', User: 'alt' }, { ...FERTIG, user: '' }, { ...FERTIG, User: '' }]) {
            const b = instanz(native);
            expect(await b.konfigUmziehen(), JSON.stringify(native)).to.equal(false);
        }
    });

    it('regelSzenen -> regelStufen, je Geraet szenen -> stufen; die alten Felder sind danach weg', async () => {
        const stufen = [{ name: 'Tag', soll: 22 }];
        const a = instanz({ ...FERTIG, regelSzenen: stufen, regelGeraete: [{ geraet: 'A', individuell: false, szenen: stufen, frostAb: 8 }, { geraet: 'B', individuell: true }] });
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.gespeichert.native.regelStufen).to.eql(stufen);
        expect('regelSzenen' in a.gespeichert.native).to.equal(false);
        expect(a.gespeichert.native.regelGeraete).to.eql([
            { ...V, geraet: 'A', individuell: false, stufen, frostAb: 8 },
            { ...V, geraet: 'B', individuell: true },
        ]);
        expect(regel.konfigAusInstanz(a.config).szenen.has('tag')).to.equal(true);
        await zweiterStart(a);
        // schon gefuellte neue Felder werden nie ueberschrieben; leere alte Listen loesen nichts aus
        const beide = instanz({ ...FERTIG, regelSzenen: stufen, regelStufen: [{ name: 'Neu', soll: 20 }], regelGeraete: [{ geraet: 'A', individuell: true, szenen: stufen, stufen: [{ name: 'Eigen', soll: 19 }] }] });
        await beide.konfigUmziehen();
        expect(beide.gespeichert.native.regelStufen).to.eql([{ name: 'Neu', soll: 20 }]);
        expect(beide.gespeichert.native.regelGeraete[0]).to.eql({ ...V, geraet: 'A', individuell: true, stufen: [{ name: 'Eigen', soll: 19 }] });
        // ein leeres altes Feld wird nur entfernt (kein toter Schluessel `regelSzenen: []`), die Stufen bleiben unberuehrt
        const leer = instanz({ ...FERTIG, regelSzenen: [], regelGeraete: [{ ...V, geraet: 'A', individuell: true, szenen: [], fuehlerWeg: 'modul' }] });
        expect(await leer.konfigUmziehen()).to.equal(true);
        expect('regelSzenen' in leer.gespeichert.native).to.equal(false);
        expect('regelStufen' in leer.gespeichert.native).to.equal(false);
        expect(leer.gespeichert.native.regelGeraete).to.eql([{ ...V, geraet: 'A', individuell: true, szenen: [], fuehlerWeg: 'modul' }]);
        await zweiterStart(leer);
    });

    it('Geraeteeintrag ohne fuehlerWeg bekommt die Vorgabe "sollwert" - sonst waere "Speichern" beim Oeffnen der Seite aktiv', async () => {
        const a = instanz({ ...FERTIG, regelGeraete: [{ geraet: 'A', individuell: true }, { geraet: 'B', fuehlerWeg: 'modul' }, { geraet: 'C', fuehlerWeg: 'quatsch' }] });
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.gespeichert.native.regelGeraete).to.eql([
            { ...V, geraet: 'A', individuell: true, fuehlerWeg: 'sollwert' },
            { ...V, geraet: 'B', fuehlerWeg: 'modul' },
            { ...V, geraet: 'C', fuehlerWeg: 'sollwert' },
        ]);
        await zweiterStart(a);
    });

    it('jedes fehlende Feld mit Vorgabe wird nachgetragen (wie in der Geraetekarte) - vorhandene Werte bleiben, das Regelverhalten auch', async () => {
        const io = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin', 'jsonConfig.json'), 'utf8'));
        const karte = io.items.tabRegelung.items.regelGeraete.custom.items;
        // dieselben Vorgaben wie die Felder der Karte - sonst macht das Oeffnen einer Karte "Speichern" aktiv
        expect(V).to.eql(Object.fromEntries(karte.filter(f => 'default' in f).map(f => [f.attr, f.default])));
        const zeilen = [
            { geraet: 'A' },
            { geraet: 'B', betrieb: 'faikout', strategie: 'vortag', vortagBezug: 'mittel', frostAb: 8, raumQuelle: 'dp', raumDp: 'x.0.r', feuchteMassnahme: 'melden', aussenQuelle: 'intern', feuchteQuelle: 'ble', fuehlerWeg: 'modul' },
            { geraet: 'C', strategie: '', frostAb: 0, betrieb: null },
        ];
        const a = instanz({ ...FERTIG, regelGeraete: zeilen });
        const vorher = zeilen.map(z => JSON.stringify(regel.geraeteKonfig(a.config, z).konfig.bedarf) + regel.geraeteKonfig(a.config, z).konfig.betrieb);
        expect(await a.konfigUmziehen()).to.equal(true);
        const neu = a.gespeichert.native.regelGeraete;
        expect(neu[0]).to.eql({ ...V, geraet: 'A' });
        expect(neu[1]).to.eql(zeilen[1]); // vollstaendig: unveraendert
        expect(neu[2]).to.eql({ ...V, geraet: 'C', betrieb: null }); // null ist ein vorhandener Wert der Seite - bleibt
        expect(neu.map(z => JSON.stringify(regel.geraeteKonfig(a.gespeichert.native, z).konfig.bedarf) + regel.geraeteKonfig(a.gespeichert.native, z).konfig.betrieb)).to.eql(vorher);
        await zweiterStart(a);
    });

    it('einmalig: Geraeteeintraege des Vorabstands behalten ihre Werte (Verhalten bleibt gleich), der Haken entfaellt', async () => {
        const geraete = [{ geraet: 'A', obergrenze: 85 }, { geraet: 'B', individuell: false }, { geraet: 'C', individuell: true }];
        const a = instanz({ externClientIdStandard: 'x', externClientId: 'x', regelGeraete: geraete });
        const vorher = regel.geraeteKonfig(a.config, { ...geraete[0] }).konfig.bedarf.obergrenze;
        expect(await a.konfigUmziehen()).to.equal(true);
        // der Haken von Stand 1 faellt mit Stand 3 im selben Start wieder weg - die Werte bleiben
        expect(a.gespeichert.native.regelGeraete).to.eql([
            { ...V, geraet: 'A', obergrenze: 85 },
            { ...V, geraet: 'B' },
            { ...V, geraet: 'C' },
        ]);
        expect(a.gespeichert.native.regelUmzugStand).to.equal(3);
        expect(regel.konfigAusInstanz(a.config).fuer('A', 'A').konfig.bedarf.obergrenze).to.equal(vorher).and.to.equal(85);
        await zweiterStart(a);
        // nach dem Umzug angelegt: der eigene Wert der Zeile gilt, angefasst wird nichts mehr
        const spaeter = instanz({ ...a.gespeichert.native, regelGeraete: [...a.gespeichert.native.regelGeraete, { ...V, geraet: 'D', obergrenze: 70 }] });
        expect(await spaeter.konfigUmziehen()).to.equal(false);
        expect(regel.konfigAusInstanz(spaeter.config).fuer('D', 'D').konfig.bedarf.obergrenze).to.equal(70);
    });

    it('Stand 3: der Haken `individuell` entfaellt - mit Haken bleiben die Werte, ohne Haken werden die ignorierten geleert; das Regelverhalten bleibt in jeder Kombination gleich', async () => {
        const vorlage = require('../lib/regel/vorlage');
        const stufen = [{ name: 'Tag', soll: 22 }];
        const eigeneWerte = {
            strategie: 'vortag',
            kennlinieHeizen: [{ x: -5, y: 80 }, { x: 10, y: 50 }],
            kennlinieKuehlen: [{ x: 20, y: 50 }, { x: 30, y: 90 }],
            untergrenze: 50,
            obergrenze: 85,
            vortagBezug: 'mittel',
            vortagZuschlag: 25,
            vortagReferenzW: 700,
            stufen,
            feuchteMassnahme: 'melden',
        };
        const eigenes = { ...V, geraet: 'X', betrieb: 'faikout', frostAb: 8, raumQuelle: 'dp', raumDp: 'x.0.raum', fuehlerWeg: 'modul', probelauf: true };
        const basis = {
            externClientIdStandard: 'x',
            externClientId: 'x',
            regelProbelauf: false,
            regelUntergrenze: 45,
            regelObergrenze: 90,
            regelKennlinieHeizen: [{ x: -10, y: 90 }, { x: 15, y: 45 }],
            regelStufen: [{ name: 'Wach', soll: 20 }],
            regelFeuchteMassnahme: 'entfeuchten',
        };
        // so rechnete der Stand mit Haken (Schnittstelle Runde 1): ohne Haken nur die geraetebezogenen Felder
        const alteRegel = (c, zeile) =>
            regel.geraeteKonfig(c, zeile.individuell === true ? zeile : Object.fromEntries(Object.entries(zeile).filter(([f]) => !vorlage.VORLAGEN_FELDER.includes(f)))).konfig;
        const vergleich = k => JSON.stringify({ bedarf: k.bedarf, feuchte: k.feuchte, szenen: [...k.szenen], betrieb: k.betrieb, frostAb: k.frostAb, quellen: k.quellen, fuehlerWeg: k.fuehlerWeg });
        // jede Teilmenge der Vorlagenfelder x Haken (true / false / fehlt) x Umzugsstand davor (1, 2)
        const felder = Object.keys(eigeneWerte);
        const teilmengen = [[], felder, ...felder.map(f => [f]), ['kennlinieHeizen', 'stufen'], ['untergrenze', 'strategie', 'feuchteMassnahme']];
        let faelle = 0;
        for (const stand of [1, 2]) {
            for (const haken of [true, false, undefined]) {
                for (const menge of teilmengen) {
                    const zeile = { ...eigenes, ...Object.fromEntries(menge.map(f => [f, eigeneWerte[f]])) };
                    if (haken !== undefined) {
                        zeile.individuell = haken;
                    }
                    const fall = JSON.stringify({ stand, haken, menge });
                    const a = instanz({ ...basis, regelUmzugStand: stand, regelGeraete: [zeile] });
                    const vorher = vergleich(alteRegel(a.config, zeile));
                    const noetig = stand < 3;
                    expect(await a.konfigUmziehen(), fall).to.equal(noetig);
                    const neu = a.gespeichert.native.regelGeraete[0];
                    expect('individuell' in neu, fall).to.equal(false);
                    expect(a.gespeichert.native.regelUmzugStand, fall).to.equal(3);
                    // Regelverhalten: gespeicherte Zeile mit der neuen Regel == alte Zeile mit der alten Regel
                    expect(vergleich(regel.konfigAusInstanz(a.gespeichert.native).fuer('X', 'X').konfig), fall).to.equal(vorher);
                    expect(vergleich(regel.konfigAusInstanz(a.config).fuer('X', 'X').konfig), `${fall} (laufende Konfiguration)`).to.equal(vorher);
                    // geraetebezogene Felder bleiben in jedem Fall
                    expect(neu, fall).to.include({ geraet: 'X', betrieb: 'faikout', frostAb: 8, raumQuelle: 'dp', raumDp: 'x.0.raum', fuehlerWeg: 'modul', probelauf: true });
                    if (haken === true) {
                        // mit Haken: kein Wert geht verloren
                        for (const f of menge) {
                            expect(neu[f], `${fall} ${f}`).to.eql(eigeneWerte[f]);
                        }
                        expect(vorlage.eigeneTeile(neu).length > 0, fall).to.equal(menge.length > 0);
                    } else {
                        // ohne Haken: nichts wird wirksam - alles aus der Vorlage
                        expect(vorlage.eigeneTeile(neu), fall).to.eql([]);
                    }
                    const gemeldet = a.zeilen.filter(z => /unused own values were cleared/.test(z.text));
                    expect(gemeldet.length, fall).to.equal(haken !== true && menge.length ? 1 : 0);
                    await zweiterStart(a);
                    faelle++;
                }
            }
        }
        expect(faelle).to.equal(2 * 3 * teilmengen.length);
        // Vorabstand (Stand 0, ohne Haken): Stand 1 setzt den Haken, Stand 3 nimmt ihn im selben Start wieder weg - die Werte gelten weiter
        const vorab = instanz({ ...basis, regelGeraete: [{ ...eigenes, ...eigeneWerte }] });
        const vorabVorher = vergleich(regel.geraeteKonfig(vorab.config, { ...eigenes, ...eigeneWerte }).konfig);
        expect(await vorab.konfigUmziehen()).to.equal(true);
        expect(vorab.gespeichert.native.regelGeraete[0]).to.eql({ ...eigenes, ...eigeneWerte });
        expect(vergleich(regel.konfigAusInstanz(vorab.gespeichert.native).fuer('X', 'X').konfig)).to.equal(vorabVorher);
        // mehrere Zeilen: jede fuer sich; kaputte Eintraege bleiben, wie sie sind
        const viele = instanz({ ...basis, regelUmzugStand: 2, regelGeraete: [{ ...V, geraet: 'A', individuell: true, stufen }, null, { ...V, geraet: 'B', individuell: false, stufen, obergrenze: 70 }, { ...V, geraet: 'C' }] });
        expect(await viele.konfigUmziehen()).to.equal(true);
        expect(viele.gespeichert.native.regelGeraete).to.eql([
            { ...V, geraet: 'A', stufen },
            null,
            { ...V, geraet: 'B', stufen: [] },
            { ...V, geraet: 'C' },
        ]);
        expect(viele.zeilen.filter(z => /unused own values were cleared \(B: obergrenze, stufen\)/.test(z.text)).length).to.equal(1);
        // schon auf Stand 3: ein stehengebliebener Haken wird nicht mehr angefasst (und zaehlt nicht)
        const fertig = instanz({ ...FERTIG, regelGeraete: [{ ...V, geraet: 'A', individuell: false, stufen }] });
        expect(await fertig.konfigUmziehen()).to.equal(false);
    });

    it('vorlage.js: eigene Teile einer Zeile und Umzug einer einzelnen Zeile (auch fuer den Import der Geraeteliste)', () => {
        const v = require('../lib/regel/vorlage');
        expect(v.eigeneTeile(undefined)).to.eql([]);
        // der Ersatz fuer zurueckgesetzte Stufen macht eine Zeile nicht "eigen"
        expect(v.eigeneTeile({ geraet: 'A', stufen: [], stufenErsatz: { tag: 'komfort' } })).to.eql([]);
        // Ersatzvorschlag beim Zuruecksetzen der Stufen: nur Stufen des Plans, die die Vorlage nicht kennt; naechste
        // Zieltemperatur, "aus" zu "aus"
        const eigene = [
            { id: 'tag', name: 'Tag', power: true, soll: 22 },
            { id: 'nacht', name: 'Nacht', power: true, soll: 18 },
            { id: 'weg', name: 'Weg', power: false, soll: 30 },
            { id: 'komfort', name: 'Mein Komfort', power: true, soll: 25 },
        ];
        const ziel = [
            { id: 'komfort', name: 'Komfort', power: true, soll: 21 },
            { id: 'absenken', name: 'Absenken', power: true, soll: 19 },
            { id: 'abwesend', name: 'Abwesend', power: true, soll: 17 },
            { id: 'aus', name: 'Aus', power: false, soll: 17 },
        ];
        expect(v.ersatzVorschlag(eigene, ziel, ['nacht', 'tag', 'komfort', 'weg', 'fremd', 'tag'])).to.eql([
            { id: 'nacht', name: 'Nacht', ersatz: 'absenken' },
            { id: 'tag', name: 'Tag', ersatz: 'komfort' },
            { id: 'weg', name: 'Weg', ersatz: 'aus' },
            { id: 'fremd', name: 'fremd', ersatz: 'komfort' },
        ]);
        // der Plan benutzt nur Stufen, die es in der Vorlage auch gibt: keine Rueckfrage
        expect(v.ersatzVorschlag(eigene, ziel, ['komfort'])).to.eql([]);
        expect(v.ersatzVorschlag(eigene, ziel, [])).to.eql([]);
        expect(v.ersatzVorschlag(null, null, null)).to.eql([]);
        // ohne "Aus"-Stufe in der Vorlage: die naechstliegende eingeschaltete
        expect(v.ersatzVorschlag(eigene, ziel.slice(0, 3), ['weg'])).to.eql([{ id: 'weg', name: 'Weg', ersatz: 'komfort' }]);
        expect(v.eigeneTeile({ geraet: 'A', betrieb: 'adapter', frostAb: 5, strategie: '', stufen: [], kennlinieHeizen: [], untergrenze: '', obergrenze: null })).to.eql([]);
        expect(v.eigeneTeile({ kennlinieKuehlen: [{ x: 1, y: 2 }], obergrenze: 0, feuchteMassnahme: 'melden' })).to.eql(['kennlinieKuehlen', 'grenzen', 'feuchte']);
        expect(v.eigeneTeile({ vortagReferenzW: 800 })).to.eql(['strategie']);
        expect(v.VORLAGEN_FELDER).to.have.members(['strategie', 'untergrenze', 'obergrenze', 'kennlinieHeizen', 'kennlinieKuehlen', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW', 'stufen', 'feuchteMassnahme']);
        // ohne Haken geleert: Listen leer, Auswahlfelder '', Zahlen entfernt
        const ohne = v.zeileUmziehen({ geraet: 'A', individuell: false, strategie: 'vortag', untergrenze: 50, stufen: [{ name: 'T' }], frostAb: 3 });
        expect(ohne).to.eql({ zeile: { geraet: 'A', strategie: '', stufen: [], frostAb: 3 }, geaendert: true, verworfen: ['untergrenze', 'stufen', 'strategie'] });
        const mit = v.zeileUmziehen({ geraet: 'A', individuell: true, untergrenze: 50 });
        expect(mit).to.eql({ zeile: { geraet: 'A', untergrenze: 50 }, geaendert: true, verworfen: [] });
        // Import: eine Datei im neuen Format (ohne das Feld) bleibt unberuehrt, ihre Werte gelten
        const neuesFormat = { geraet: 'A', untergrenze: 50 };
        expect(v.zeileUmziehen(neuesFormat, { nurMitHaken: true })).to.eql({ zeile: neuesFormat, geaendert: false, verworfen: [] });
        expect(v.zeileUmziehen({ geraet: 'A', individuell: false, untergrenze: 50 }, { nurMitHaken: true }).zeile).to.eql({ geraet: 'A' });
        // die Eingabe wird nie veraendert
        const eingabe = { geraet: 'A', individuell: false, stufen: [{ name: 'T' }] };
        v.zeileUmziehen(eingabe);
        expect(eingabe).to.eql({ geraet: 'A', individuell: false, stufen: [{ name: 'T' }] });
        expect(v.zeileUmziehen(null).zeile).to.equal(null);
    });

    it('einmalig: Obergrenze 95 -> 100 und Heizkennlinie -10:95 -> -10:100 nur bei exakt der alten Werksvorgabe', async () => {
        const basis = { externClientIdStandard: 'x', externClientId: 'x' };
        const a = instanz({ ...basis, regelObergrenze: 95, regelKennlinieHeizen: HEIZEN_ALT });
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.gespeichert.native.regelObergrenze).to.equal(100);
        expect(a.gespeichert.native.regelKennlinieHeizen).to.eql(HEIZEN_NEU);
        expect(HEIZEN_NEU.map(p => [p.x, p.y])).to.eql(kennlinie.VORGABE_HEIZEN);
        await zweiterStart(a);
        // Text des ganz alten Stands "-10:95, 0:75, ..." wird erst Tabelle, dann gehoben
        const text = instanz({ ...basis, regelObergrenze: '95', regelKennlinieHeizen: '-10:95, 0:75, 7:55, 15:40' });
        await text.konfigUmziehen();
        expect(text.gespeichert.native.regelKennlinieHeizen).to.eql(HEIZEN_NEU);
        expect(text.gespeichert.native.regelObergrenze).to.equal(100);
        // eigene Werte bleiben: andere Obergrenze, ein verschobener Punkt, ein Punkt mehr, -10:95 mit anderem Rest
        for (const [ober, punkte] of [
            [90, [{ x: -10, y: 95 }, { x: 0, y: 70 }, { x: 7, y: 55 }, { x: 15, y: 40 }]],
            [85, [...HEIZEN_ALT, { x: 20, y: 40 }]],
            [100, [{ x: -12, y: 95 }, ...HEIZEN_ALT.slice(1)]],
            [96, HEIZEN_ALT.slice(0, 3)],
        ]) {
            const eigen = instanz({ ...basis, regelObergrenze: ober, regelKennlinieHeizen: punkte });
            await eigen.konfigUmziehen();
            expect(eigen.gespeichert.native.regelObergrenze, String(ober)).to.equal(ober);
            expect(eigen.gespeichert.native.regelKennlinieHeizen, String(ober)).to.eql(punkte);
            expect(eigen.gespeichert.native.regelUmzugStand).to.equal(3);
        }
        // Werte je Geraet sind eigene Werte und bleiben
        const geraet = instanz({ ...basis, regelGeraete: [{ geraet: 'A', obergrenze: 95, kennlinieHeizen: HEIZEN_ALT }] });
        await geraet.konfigUmziehen();
        expect(geraet.gespeichert.native.regelGeraete[0]).to.eql({ ...V, geraet: 'A', obergrenze: 95, kennlinieHeizen: HEIZEN_ALT });
        // nach dem Umzug bewusst wieder auf 95 gestellt: bleibt
        const bewusst = instanz({ ...FERTIG, regelObergrenze: 95, regelKennlinieHeizen: HEIZEN_ALT });
        expect(await bewusst.konfigUmziehen()).to.equal(false);
    });

    it('Probelauf: neue Instanz startet AUS; ein gespeicherter Wert bleibt; ein fehlender (Bestand) wird als AN festgeschrieben', async () => {
        const io = require('../io-package.json');
        // neue Instanz: false aus der io-package, der Start laesst es stehen
        const neu = instanz(io.native);
        await neu.konfigUmziehen();
        expect(neu.gespeichert.native.regelProbelauf).to.equal(false);
        expect(regel.konfigAusInstanz(neu.config).probelaufGlobal).to.equal(false);
        // Bestand mit gespeichertem Wert: nie angefasst (auch nicht beim allerersten Umzug)
        for (const wert of [true, false]) {
            for (const stand of [{}, { regelUmzugStand: 1 }, { regelUmzugStand: 2 }, { regelUmzugStand: 3 }]) {
                const a = instanz({ externClientIdStandard: 'x', externClientId: 'x', ...stand, regelProbelauf: wert, regelGeraete: [{ ...V, geraet: 'A', individuell: true }] });
                expect(await a.konfigUmziehen(), JSON.stringify([wert, stand])).to.equal(stand.regelUmzugStand !== 3);
                expect(a.gespeichert.native.regelProbelauf).to.equal(wert);
                expect(regel.konfigAusInstanz(a.config).probelaufGlobal).to.equal(wert);
            }
        }
        // Bestand ohne den Schluessel (galt bisher als AN): wird einmal ausdruecklich true - mit und ohne Geraete,
        // vor und nach dem Umzug auf 1.0.0; auch null zaehlt als fehlend
        for (const native of [
            { regelUmzugStand: 1, regelGeraete: [{ geraet: 'A', fuehlerWeg: 'sollwert' }] },
            { regelUmzugStand: 3 },
            { regelGeraete: [{ geraet: 'A' }] },
            { regelProbelauf: null, regelUmzugStand: 3 },
            {},
        ]) {
            const a = instanz({ externClientIdStandard: 'x', externClientId: 'x', ...native });
            expect(regel.konfigAusInstanz(a.config).probelaufGlobal, JSON.stringify(native)).to.equal(true);
            expect(await a.konfigUmziehen(), JSON.stringify(native)).to.equal(true);
            expect(a.gespeichert.native.regelProbelauf, JSON.stringify(native)).to.equal(true);
            expect(a.config.regelProbelauf).to.equal(true);
            await zweiterStart(a);
        }
    });

    it('Probelauf-Datenpunkte der Geraete: beim Update EINMAL an die Instanz angeglichen - alle Kombinationen', async () => {
        const DP = id => `${id}.regulation.demand.dryRun`;
        const alt = (a, id, wert) => {
            a.objekte.set(id, { type: 'device', common: { name: id.replace('_', ' ') }, native: {} });
            a.objekte.set(DP(id), { type: 'state', common: { type: 'boolean', role: 'switch', write: true, def: true, name: 'alt' }, native: { regulation: true } });
            if (wert !== undefined) {
                a.werte.set(DP(id), { val: wert, ack: true });
            }
        };
        // Instanz: fehlt (Bestand = AN) / an / aus; Umzugsstand 0 (Vorabstand) / 1 (Stand vor diesem Umzug)
        for (const instanzWert of [undefined, true, false]) {
            for (const stand of [undefined, 1]) {
                const native = { externClientIdStandard: 'x', externClientId: 'x' };
                if (instanzWert !== undefined) {
                    native.regelProbelauf = instanzWert;
                }
                if (stand !== undefined) {
                    native.regelUmzugStand = stand;
                }
                const a = instanz(native);
                alt(a, 'Alt_An', true); // alter Geraeteschalter an (ueblicher Bestand)
                alt(a, 'Alt_Aus', false); // bewusst ausgeschaltet
                alt(a, 'Alt_Leer', undefined); // Objekt ohne Wert
                a.objekte.set('Ohne_Regelung', { type: 'device', common: { name: 'Ohne Regelung' }, native: {} });
                const fall = JSON.stringify([instanzWert, stand]);
                const wirksam = instanzWert !== false; // fehlender Schluessel wird im selben Start als AN festgeschrieben
                expect(await a.konfigUmziehen(), fall).to.equal(true);
                expect(a.gespeichert.native, fall).to.include({ regelProbelauf: wirksam, regelUmzugStand: 3 });
                for (const id of ['Alt_An', 'Alt_Aus', 'Alt_Leer']) {
                    expect(a.wert(DP(id)), `${fall} ${id}`).to.equal(wirksam);
                    expect(a.werte.get(DP(id)).ack).to.equal(true);
                    expect(a.objekte.get(DP(id)).common, `${fall} ${id}`).to.include({ write: false, role: 'indicator', def: false, type: 'boolean' });
                }
                expect(a.objekte.has(DP('Ohne_Regelung'))).to.equal(false);
                // die Geraetezeilen bekommen KEINEN Probelauf-Schalter: nach dem Umzug gilt allein die Instanz
                expect(JSON.stringify(a.gespeichert.native.regelGeraete || [])).to.not.contain('probelauf');
                // Log: nur wo sich fuer das Geraet etwas aendert - "scharf" als Warnung, "bleibt Probelauf" als Info
                const zeilen = stufe => a.zeilen.filter(z => z.stufe === stufe && /per-unit dry-run switch/.test(z.text)).map(z => z.text.split(':')[0]);
                expect(zeilen('warn'), fall).to.eql(wirksam ? [] : ['Alt An']);
                expect(zeilen('info'), fall).to.eql(wirksam ? ['Alt Aus'] : []);
                expect(a.zeilen.filter(z => /now LIVE/.test(z.text)).length, fall).to.equal(wirksam ? 0 : 1);
                await zweiterStart(a);
            }
        }
        // Stand 2 (schon angeglichen): der Start fasst nichts mehr an - das uebernimmt die Regelung je Geraet
        const fertig = instanz({ ...FERTIG, regelProbelauf: false });
        alt(fertig, 'Alt_An', true);
        expect(await fertig.konfigUmziehen()).to.equal(false);
        expect(fertig.wert(DP('Alt_An'))).to.equal(true);
        // ... und zwar bei der ersten Meldung: Anzeige = Instanz (aus), kein eigener Schalter mehr
        fertig.regelung = new regel.Bedarfsregelung(fertig, { jetzt: () => START });
        await fertig.regelung.geraet('Alt_An', 'Alt An');
        expect(fertig.wert(DP('Alt_An'))).to.equal(false);
        expect(fertig.objekte.get(DP('Alt_An')).common.write).to.equal(false);
        // ein Fehler beim Lesen der Geraete haelt den Start nicht auf
        const kaputt = instanz({ externClientIdStandard: 'x', externClientId: 'x', regelProbelauf: true, regelUmzugStand: 1 });
        kaputt.getDevicesAsync = async () => {
            throw new Error('keine Verbindung');
        };
        expect(await kaputt.konfigUmziehen()).to.equal(true);
        expect(kaputt.gespeichert.native.regelUmzugStand).to.equal(3);
    });

    it('Probelauf nur einer Anlage: Feld `probelauf` der Geraetezeile - wirksam = Instanz ODER Zeile', () => {
        for (const [instanzWert, zeile, erwartet] of [
            [false, undefined, false],
            [false, false, false],
            [false, true, true],
            [false, 'true', false], // nur ein echtes true zaehlt (Formular schreibt boolean)
            [true, false, true],
            [true, true, true],
            [undefined, false, true],
        ]) {
            const c = { regelGeraete: [{ geraet: 'A', probelauf: zeile }, { geraet: 'B' }] };
            if (instanzWert !== undefined) {
                c.regelProbelauf = instanzWert;
            }
            const e = regel.konfigAusInstanz(c);
            expect(regel.probelaufWirksam(e, 'A', 'A'), JSON.stringify([instanzWert, zeile])).to.equal(erwartet);
            expect(regel.probelaufWirksam(e, 'B', 'B')).to.equal(instanzWert !== false);
            expect(regel.probelaufWirksam(e, 'Unbekannt', 'Unbekannt')).to.equal(instanzWert !== false);
        }
    });

    it('Neuinstallation (Vorgaben aus io-package): ein Schreibvorgang, danach Ruhe; Vorgaben 40/100 und -10:100', async () => {
        const io = require('../io-package.json');
        expect(io.native).to.include({ regelUntergrenze: 40, regelObergrenze: 100, regelPlanVorlage: '', regelUmzugStand: 0 });
        expect(io.native.regelStufen).to.eql([]);
        expect(io.native.regelKennlinieHeizen).to.eql(HEIZEN_NEU);
        expect(io.native).to.not.have.any.keys('regelSzenen', 'User');
        const a = instanz(io.native);
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.geschrieben).to.equal(1);
        expect(a.gespeichert.native).to.include({ regelObergrenze: 100, regelUmzugStand: 3 });
        await zweiterStart(a);
    });

    it('alles zusammen: der Altbestand einer Vorab-Instanz in einem Start', async () => {
        const stufen = [{ name: 'Tag', soll: 22 }];
        const a = instanz({
            User: 'klima',
            pass: 'X',
            regelObergrenze: 95,
            regelKennlinieHeizen: HEIZEN_ALT,
            regelSzenen: stufen,
            regelGeraete: [{ geraet: 'A', szenen: stufen, kennlinieHeizen: [{ x: -5, y: 80 }, { x: 10, y: 50 }] }],
        });
        expect(await a.konfigUmziehen()).to.equal(true);
        expect(a.geschrieben).to.equal(1);
        const n = a.gespeichert.native;
        expect(n).to.include({ user: 'klima', User: '', pass: 'X', regelObergrenze: 100, regelUmzugStand: 3 });
        expect(n.regelGeraete).to.eql([{ ...V, geraet: 'A', kennlinieHeizen: [{ x: -5, y: 80 }, { x: 10, y: 50 }], stufen }]);
        expect(n.externClientId).to.be.a('string').and.not.equal('');
        await zweiterStart(a);
    });
});

