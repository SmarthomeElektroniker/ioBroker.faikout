'use strict';

/**
 * Klimaregelung - Anbindung an den Adapter. Haelt je Geraet die Eingaenge, ruft die reinen
 * Rechenbausteine (quellen, wochenplan, handeingriff, koordinator mit bedarf und feuchte, sender,
 * schreiber, faehigkeit) und schreibt die Datenpunkte `<Geraet>.regel.*` sowie `info.demandFaehig`.
 *
 * SICHERHEIT: Im Probelauf geht nie ein Befehl hinaus. Gesendet wird nur, wenn
 *   - die Instanz-Einstellung "Probelauf" AUS ist UND
 *   - der Datenpunkt regel.bedarf.probelauf des Geraets false ist.
 * Die Leistungsgrenze braucht zusaetzlich regel.bedarf.aktiv, der Wochenplan regel.plan.aktiv, die
 * Feuchteregelung regel.feuchte.aktiv. publizieren() prueft die Freigabe unmittelbar vor jedem
 * Publish ein zweites Mal. Alle Befehle der Regelung entstehen in dieser Datei (ein Sender je
 * Geraet); im Regelbetrieb wird nie eine Einstellung im Modul gespeichert (kein Flash).
 */

const bedarf = require('./bedarf');
const schreiber = require('./schreiber');
const faehigkeit = require('./faehigkeit');
const zustandSpeicher = require('./zustand');
const quellen = require('./quellen');
const wochenplan = require('./wochenplan');
const handeingriff = require('./handeingriff');
const feuchte = require('./feuchte');
const sender = require('./sender');
const koordinator = require('./koordinator');

const ZWEIG = 'regel.bedarf';
const OFFLINE_MS = 5 * 60000;
const SICHERN_MS = 10 * 60000;

const ZUSTAENDE = {
    ok: 'ok',
    gestört: 'gestört',
    'nicht fähig': 'nicht fähig',
    neutral: 'neutral',
    aus: 'aus',
};

const DATENPUNKTE = {
    aktiv: {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Demand control active', de: 'Bedarfsregelung aktiv' },
    },
    probelauf: {
        type: 'boolean',
        role: 'switch',
        write: true,
        def: true,
        name: { en: 'Dry run (calculate only, never send)', de: 'Probelauf (nur rechnen, nie senden)' },
    },
    sollwert: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Calculated demand', de: 'Berechnete Leistungsgrenze' },
    },
    rohwert: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Raw value before limits', de: 'Rohwert vor Stufung und Grenzen' },
    },
    aussenMittel: {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature (30 min mean)', de: 'Außentemperatur (Mittel 30 min)' },
    },
    grund: { type: 'string', role: 'text', name: { en: 'Reason', de: 'Begründung' } },
    zustand: { type: 'string', role: 'text', states: ZUSTAENDE, name: { en: 'State', de: 'Zustand' } },
    wuerdeSenden: {
        type: 'string',
        role: 'json',
        name: { en: 'Last command (or would-send in dry run)', de: 'Letzter Befehl (im Probelauf: würde senden)' },
    },
    befehleStunde: {
        type: 'number',
        role: 'value',
        name: { en: 'Commands in the last hour', de: 'Befehle in der letzten Stunde' },
    },
    strategie: { type: 'string', role: 'text', name: { en: 'Strategy', de: 'Strategie' } },
    zustandJson: {
        type: 'string',
        role: 'json',
        name: { en: 'Internal state (restart-safe)', de: 'Interner Zustand (neustartfest)' },
    },
};

/** Weitere Datenpunkte unter `<Geraet>.regel` (Pfad relativ zu regel). */
const DATENPUNKTE_REGEL = {
    zustand: {
        type: 'string',
        role: 'text',
        states: { ok: 'ok', hand: 'hand', gestört: 'gestört', offline: 'offline', aus: 'aus' },
        name: { en: 'Control state', de: 'Zustand der Regelung' },
    },
    grund: { type: 'string', role: 'text', name: { en: 'Reason', de: 'Begründung' } },
    betrieb: {
        type: 'string',
        role: 'text',
        states: { adapter: 'adapter', faikout: 'faikout' },
        name: { en: 'Who controls', de: 'Wer regelt' },
    },
    letzterBefehl: {
        type: 'string',
        role: 'json',
        name: { en: 'Last command (or would-send in dry run)', de: 'Letzter Befehl (im Probelauf: würde senden)' },
    },
    verlaufJson: {
        type: 'string',
        role: 'json',
        name: { en: 'Demand limit, last 24 hours', de: 'Leistungsgrenze, letzte 24 Stunden' },
    },
    'plan.aktiv': {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Weekly schedule active', de: 'Wochenplan aktiv' },
    },
    'plan.wocheJson': {
        type: 'string',
        role: 'json',
        write: true,
        name: { en: 'Weekly schedule', de: 'Wochenplan' },
    },
    'plan.abwesenheitJson': {
        type: 'string',
        role: 'json',
        write: true,
        name: { en: 'Absence', de: 'Abwesenheit' },
    },
    'plan.szene': { type: 'string', role: 'text', name: { en: 'Current scene', de: 'Aktuelle Szene' } },
    'plan.naechster': {
        type: 'number',
        role: 'date',
        name: { en: 'Next switching time', de: 'Nächster Schaltpunkt' },
    },
    'plan.naechsteSzene': { type: 'string', role: 'text', name: { en: 'Next scene', de: 'Nächste Szene' } },
    'feuchte.aktiv': {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Humidity control active', de: 'Feuchteregelung aktiv' },
    },
    'feuchte.taupunkt': {
        type: 'number',
        role: 'value.temperature.dewpoint',
        unit: '°C',
        name: { en: 'Dew point', de: 'Taupunkt' },
    },
    'feuchte.abstand': {
        type: 'number',
        role: 'value',
        unit: 'K',
        name: { en: 'Dew point spread', de: 'Abstand zum Taupunkt' },
    },
    'feuchte.eingriff': {
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Humidity intervention running', de: 'Feuchteeingriff läuft' },
    },
    'feuchte.grund': { type: 'string', role: 'text', name: { en: 'Reason', de: 'Begründung' } },
    'hand.gesperrt': {
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Manual override (automation waits)', de: 'Handeingriff (Automatik wartet)' },
    },
    'hand.bis': { type: 'number', role: 'date', name: { en: 'Automation waits until', de: 'Automatik wartet bis' } },
    'hand.aufheben': {
        type: 'boolean',
        role: 'button',
        write: true,
        read: false,
        name: { en: 'Resume automation now', de: 'Automatik jetzt fortsetzen' },
    },
    'fuehler.aussen': {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature used', de: 'Verwendete Außentemperatur' },
    },
    'fuehler.aussenQuelle': {
        type: 'string',
        role: 'text',
        name: { en: 'Outside sensor', de: 'Außenfühler' },
    },
    'fuehler.raum': {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Room temperature used', de: 'Verwendete Raumtemperatur' },
    },
    'fuehler.raumQuelle': { type: 'string', role: 'text', name: { en: 'Room sensor', de: 'Raumfühler' } },
    'fuehler.feuchte': {
        type: 'number',
        role: 'value.humidity',
        unit: '%',
        name: { en: 'Humidity used', de: 'Verwendete Luftfeuchte' },
    },
    'fuehler.feuchteQuelle': {
        type: 'string',
        role: 'text',
        name: { en: 'Humidity sensor', de: 'Feuchtefühler' },
    },
};

const KANAELE = {
    regel: { en: 'Control', de: 'Regelung' },
    'regel.bedarf': { en: 'Demand control', de: 'Bedarfsregelung' },
    'regel.plan': { en: 'Weekly schedule', de: 'Wochenplan' },
    'regel.feuchte': { en: 'Humidity control', de: 'Feuchteregelung' },
    'regel.hand': { en: 'Manual override', de: 'Handeingriff' },
    'regel.fuehler': { en: 'Sensors', de: 'Fühler' },
};

/** Schreibbare Schalter: Pfad unter regel -> Art */
const SCHALTER = {
    'bedarf.aktiv': 'bool',
    'bedarf.probelauf': 'bool',
    'plan.aktiv': 'bool',
    'feuchte.aktiv': 'bool',
    'plan.wocheJson': 'plan',
    'plan.abwesenheitJson': 'abwesenheit',
    'hand.aufheben': 'knopf',
};

/**
 * Datum "YYYY-MM-DD" in Ortszeit.
 *
 * @param {Date} d  Datum
 * @returns {string} Tag
 */
function tagVon(d) {
    const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

const zahl = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const text = v => String(v === undefined || v === null ? '' : v).trim();

/**
 * Regelkonfiguration eines Geraets: Instanzvorgaben, ueberschrieben durch die Geraetezeile.
 *
 * @param {object} c  adapter.config
 * @param {object} [g]  Zeile aus regelGeraete
 * @param {{aussen: string, raum: string}} [alt]  Quellen aus der alten Tabelle regelQuellen
 * @returns {{konfig: object, fehler: string|null}} Konfiguration des Geraets
 */
function geraeteKonfig(c = {}, g = {}, alt = { aussen: '', raum: '' }) {
    const v = bedarf.VORGABEN;
    const eigen = g.eigeneKennlinie === true;
    const wahl = (feld, instanz, vorgabe) => (eigen && text(g[feld]) ? g[feld] : text(instanz) ? instanz : vorgabe);
    const b = bedarf.konfigPruefen({
        strategie: wahl('strategie', c.regelStrategie, v.strategie),
        heizen: wahl('kennlinieHeizen', c.regelKennlinieHeizen, v.heizen),
        kuehlen: wahl('kennlinieKuehlen', c.regelKennlinieKuehlen, v.kuehlen),
        untergrenze: zahl(eigen ? g.untergrenze : undefined, zahl(c.regelUntergrenze, v.untergrenze)),
        obergrenze: zahl(eigen ? g.obergrenze : undefined, zahl(c.regelObergrenze, v.obergrenze)),
        totband: zahl(c.regelTotband, v.totband),
        prozentProK: zahl(c.regelProzentProK, v.prozentProK),
        vortag: {
            bezug: text(c.regelVortagBezug) || v.vortag.bezug,
            zuschlag: zahl(c.regelVortagZuschlag, v.vortag.zuschlag),
            referenzW: zahl(eigen ? g.vortagReferenzW : undefined, zahl(c.regelVortagReferenzW, v.vortag.referenzW)),
            min: zahl(c.regelVortagMin, v.vortag.min),
            max: zahl(c.regelVortagMax, v.vortag.max),
        },
    });
    const f = feuchte.konfigPruefen({
        dtpEin: c.regelFeuchteDtpEin,
        dtpAus: c.regelFeuchteDtpAus,
        rhEin: c.regelFeuchteRhEin,
        rhAus: c.regelFeuchteRhAus,
        massnahme: text(g.feuchteMassnahme) || c.regelFeuchteMassnahme,
        minLaufMin: c.regelFeuchteMinLauf,
        pauseMin: c.regelFeuchtePause,
    });
    const quelle = (wahlFeld, dpFeld, altDp) => {
        const dp = text(g[dpFeld]) || text(altDp);
        let w = text(g[wahlFeld]) || 'auto';
        if (w === 'dp' && !dp) {
            w = 'auto';
        }
        return { wahl: w, dp };
    };
    const konfig = {
        betrieb: g.betrieb === 'faikout' ? 'faikout' : 'adapter',
        bedarf: b.konfig,
        feuchte: f.konfig,
        hand: handeingriff.konfigPruefen({ modus: c.regelHandModus, stunden: c.regelHandStunden }),
        quellen: {
            aussen: quelle('aussenQuelle', 'aussenDp', alt.aussen),
            raum: quelle('raumQuelle', 'raumDp', alt.raum),
            feuchte: quelle('feuchteQuelle', 'feuchteDp', ''),
        },
        frostAb: Math.max(0, zahl(g.frostAb, 0)),
        frostZiel: koordinator.VORGABEN.frostZiel,
        band: Math.min(2, Math.max(0.1, zahl(c.regelBand, koordinator.VORGABEN.band))),
    };
    return { konfig, fehler: b.fehler || f.fehler };
}

/**
 * Liest die Einstellungen der Instanz in die Regelkonfiguration um.
 *
 * @param {object} c  adapter.config
 * @returns {object} Regelkonfiguration: Vorgabe, je Geraet, Szenen, Feiertage, Schalter
 */
function konfigAusInstanz(c = {}) {
    const vorgabe = geraeteKonfig(c);
    const altQuellen = new Map();
    for (const q of Array.isArray(c.regelQuellen) ? c.regelQuellen : []) {
        if (q && q.geraet) {
            altQuellen.set(text(q.geraet), { aussen: text(q.aussen), raum: text(q.raum) });
        }
    }
    const zeilen = new Map();
    for (const g of Array.isArray(c.regelGeraete) ? c.regelGeraete : []) {
        if (g && text(g.geraet)) {
            zeilen.set(text(g.geraet), g);
        }
    }
    const sz = wochenplan.szenenLesen(c.regelSzenen);
    return {
        konfig: vorgabe.konfig.bedarf, // Instanzvorgabe der Bedarfsregelung (wie 0.5.0)
        fehler: vorgabe.fehler || sz.fehler,
        // Vorgabe: Probelauf AN. Nur ein ausdrueckliches false schaltet ihn ab.
        probelaufGlobal: c.regelProbelauf !== false,
        aktivVorgabe: c.regelAktiv === true,
        szenen: sz.szenen,
        feiertage: {
            feiertagSonntag: c.regelFeiertagSonntag === true,
            deutschland: c.regelFeiertageDE !== false,
            eigene: wochenplan.feiertageLesen(c.regelFeiertage),
        },
        /**
         * @param {string} id    Geraete-ID
         * @param {string} name  Geraetename
         * @returns {{konfig: object, fehler: string|null}} Konfiguration dieses Geraets
         */
        fuer(id, name) {
            const g = zeilen.get(id) || zeilen.get(name) || {};
            const alt = altQuellen.get(id) || altQuellen.get(name) || { aussen: '', raum: '' };
            const k = geraeteKonfig(c, g, alt);
            return { konfig: k.konfig, fehler: k.fehler || sz.fehler };
        },
    };
}

/** Klimaregelung aller Geraete einer Instanz. */
class Bedarfsregelung {
    /**
     * @param {object} adapter  Adapter (setObjectNotExistsAsync, getStateAsync, getForeignStateAsync, wertSchreiben, log, broker)
     * @param {object} [opt]    {jetzt: () => number} fuer Tests/Simulator
     */
    constructor(adapter, opt = {}) {
        this.adapter = adapter;
        this.jetzt = opt.jetzt || (() => Date.now());
        this.einstellung = konfigAusInstanz(adapter.config);
        /** je Geraete-ID: {name, eingang, zustand, schalter, plan, ...} */
        this.geraete = new Map();
        if (this.einstellung.fehler) {
            adapter.log.warn(`Climate control: configuration error - ${this.einstellung.fehler}`);
        }
    }

    /**
     * Legt die Datenpunkte an und liest Schalter und Zustand. Einmal je Geraet.
     *
     * @param {string} id    Geraete-ID
     * @param {string} name  echter Geraetename
     * @returns {Promise<object>} Geraeteeintrag
     */
    async geraet(id, name) {
        let r = this.geraete.get(id);
        if (r) {
            r.name = name;
            // Zweite Meldung waehrend des Anlegens: erst weiter, wenn die Objekte stehen.
            await r.bereit;
            return r;
        }
        const k = this.einstellung.fuer(id, name);
        r = {
            name,
            konfig: k.konfig,
            fehler: k.fehler,
            eingang: {},
            zustand: zustandSpeicher.leer(),
            aktiv: false,
            probelauf: true,
            schalter: { plan: false, feuchte: false },
            plan: null,
            planFehler: null,
            abwesenheit: null,
            laeuft: false,
            vortag: null,
            letzteMeldung: 0,
            ersteMeldung: true,
            virtuell: {},
            gesichert: 0,
            gesichertText: '',
        };
        this.geraete.set(id, r);
        let fertig;
        r.bereit = new Promise(res => (fertig = res));
        try {
            await this.anlegen(id, r);
        } finally {
            fertig();
        }
        return r;
    }

    /**
     * Legt Kanaele, Datenpunkte und info.demandFaehig an und liest Schalter und Zustand.
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     */
    async anlegen(id, r) {
        const a = this.adapter;
        for (const [kanal, name] of Object.entries(KANAELE)) {
            await a.setObjectNotExistsAsync(`${id}.${kanal}`, { type: 'channel', common: { name }, native: {} });
        }
        const anlegen = async (pfad, feld, d) => {
            const common = {
                name: d.name,
                type: d.type,
                role: d.role,
                read: d.read !== false,
                write: !!d.write,
            };
            if (d.unit) {
                common.unit = d.unit;
            }
            if (d.states) {
                common.states = d.states;
            }
            if (d.def !== undefined) {
                common.def = feld === 'aktiv' && pfad === ZWEIG ? this.einstellung.aktivVorgabe : d.def;
            }
            await a.setObjectNotExistsAsync(`${id}.${pfad}.${feld}`, {
                type: 'state',
                common,
                native: { regel: true },
            });
        };
        for (const [feld, d] of Object.entries(DATENPUNKTE)) {
            await anlegen(ZWEIG, feld, d);
        }
        for (const [feld, d] of Object.entries(DATENPUNKTE_REGEL)) {
            await anlegen('regel', feld, d);
        }
        await a.setObjectNotExistsAsync(`${id}.info.demandFaehig`, {
            type: 'state',
            common: {
                name: { en: 'Demand control supported', de: 'Leistungsgrenze möglich' },
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                states: { unbekannt: 'unbekannt', ja: 'ja', nein: 'nein' },
            },
            native: {},
        });
        const lies = async feld => {
            const s = await a.getStateAsync(`${id}.regel.${feld}`);
            return s ? s.val : null;
        };
        const aktiv = await lies('bedarf.aktiv');
        const probe = await lies('bedarf.probelauf');
        r.aktiv = aktiv === null ? this.einstellung.aktivVorgabe : aktiv === true;
        r.probelauf = probe !== false; // alles ausser ausdruecklich false = Probelauf
        r.zustand = zustandSpeicher.lesen(await lies('bedarf.zustandJson'));
        if (aktiv === null) {
            await a.setStateAsync(`${id}.${ZWEIG}.aktiv`, { val: r.aktiv, ack: true });
        }
        if (probe === null) {
            await a.setStateAsync(`${id}.${ZWEIG}.probelauf`, { val: true, ack: true });
        }
        for (const s of ['plan', 'feuchte']) {
            const w = await lies(`${s}.aktiv`);
            r.schalter[s] = w === true;
            if (w === null) {
                await a.setStateAsync(`${id}.regel.${s}.aktiv`, { val: false, ack: true });
            }
        }
        this.planUebernehmen(r, await lies('plan.wocheJson'));
        r.abwesenheit = wochenplan.abwesenheitLesen(await lies('plan.abwesenheitJson'), this.einstellung.szenen);
    }

    /**
     * Uebernimmt einen Wochenplan (JSON-Text) in den Geraeteeintrag.
     *
     * @param {object} r     Geraeteeintrag
     * @param {unknown} roh  JSON-Text oder Plan
     * @returns {string|null} Fehlertext oder null
     */
    planUebernehmen(r, roh) {
        if (roh === null || roh === undefined || roh === '') {
            r.plan = null;
            r.planFehler = 'kein Wochenplan hinterlegt';
            return r.planFehler;
        }
        const p = wochenplan.planLesen(roh, this.einstellung.szenen);
        r.plan = p.plan;
        r.planFehler = p.fehler;
        return p.fehler;
    }

    /**
     * Statusmeldung state/<Name> eines Geraets.
     *
     * @param {string} id     Geraete-ID
     * @param {string} name   echter Name
     * @param {object} daten  gemeldete Felder (Klartextformat)
     */
    async meldung(id, name, daten) {
        if (this.adapter.stopping) {
            return;
        }
        const r = await this.geraet(id, name);
        const jetzt = this.jetzt();
        const e = r.eingang;
        if (daten.up === false) {
            r.letzteMeldung = 0; // Modul hat sich abgemeldet (LWT)
            await this.schritt(id);
            return;
        }
        const vollstaendig = typeof daten.power === 'boolean';
        const kopieren = ['power', 'mode', 'heat', 'target', 'fan', 'econo', 'action', 'antifreeze', 'demand', 'autoe'];
        for (const f of kopieren) {
            if (daten[f] !== undefined && daten[f] !== null) {
                e[f] = daten[f];
            } else if (vollstaendig && f === 'demand') {
                delete e.demand;
            }
        }
        // Fuehlerwerte mit Zeitstempel; ein nicht mehr gemeldeter Wert altert und faellt dann heraus.
        const messen = (feld, ziel) => {
            if (daten[feld] !== undefined && daten[feld] !== null) {
                e[ziel] = { wert: daten[feld], zeit: jetzt };
            }
        };
        messen('outside', 'outside');
        messen('temp', 'temp');
        messen('achome', 'achome');
        messen('hum', 'hum');
        if (vollstaendig) {
            // BLE gilt nur, solange das Modul den Fuehler meldet (gekoppelt und in Reichweite).
            e.ble = daten.bletemp !== undefined && daten.bletemp !== null;
            if (e.ble) {
                e.bletemp = { wert: daten.bletemp, zeit: jetzt };
                if (daten.blehum !== undefined && daten.blehum !== null) {
                    e.blehum = { wert: daten.blehum, zeit: jetzt };
                }
            } else {
                delete e.bletemp;
                delete e.blehum;
            }
            r.letzteMeldung = jetzt;
        }
        // Faehigkeit aus der Meldung: vollstaendig ist eine Meldung mit power.
        r.zustand.faehig = faehigkeit.bewerten(r.zustand.faehig, {
            art: 'status',
            vollstaendig,
            demand: typeof daten.demand === 'number' ? daten.demand : undefined,
        });
        const g = r.zustand.schreiber.letzter;
        if (g && typeof daten.demand === 'number' && daten.demand === g.wert && g.wert < 100 && !this.probe(r)) {
            r.zustand.faehig = faehigkeit.bewerten(r.zustand.faehig, { art: 'angenommen', wert: g.wert });
        }
        await this.schritt(id, vollstaendig);
    }

    /**
     * failed-set vom Modul.
     *
     * @param {string} id        Geraete-ID
     * @param {object} settings  abgelehnte Felder {demand: 80, ...}
     */
    async abgelehnt(id, settings) {
        const r = this.geraete.get(id);
        if (!r || !settings) {
            return;
        }
        const felder = Object.keys(settings).map(f => (f === 'temp' ? 'target' : f));
        r.zustand.sender = sender.ablehnen(r.zustand.sender, felder, this.jetzt());
        if (settings.demand === undefined) {
            return;
        }
        r.zustand.faehig = faehigkeit.bewerten(r.zustand.faehig, {
            art: 'abgelehnt',
            power: r.eingang.power === true,
            wert: settings.demand,
        });
        await this.adapter.wertSchreiben(`${id}.info.demandFaehig`, r.zustand.faehig.wert);
    }

    /**
     * Schreibbarer Datenpunkt unter regel.* vom Nutzer (ack=false).
     *
     * @param {string} id    Geraete-ID
     * @param {string} feld  Pfad unter regel ('bedarf.aktiv', 'plan.wocheJson', ...) - oder kurz 'aktiv'/'probelauf'
     * @param {unknown} val  neuer Wert
     * @returns {Promise<boolean>} true, wenn uebernommen
     */
    async schalter(id, feld, val) {
        const r = this.geraete.get(id);
        const pfad = feld === 'aktiv' || feld === 'probelauf' ? `bedarf.${feld}` : feld;
        const art = SCHALTER[pfad];
        if (!r || !art) {
            return false;
        }
        const a = this.adapter;
        const dp = `${id}.regel.${pfad}`;
        if (art === 'bool') {
            const b = val === true || val === 'true' || val === 1;
            if (pfad === 'bedarf.aktiv') {
                r.aktiv = b;
            } else if (pfad === 'bedarf.probelauf') {
                r.probelauf = b;
                r.virtuell = {};
            } else {
                r.schalter[pfad.split('.')[0]] = b;
                if (pfad === 'plan.aktiv' && b) {
                    // Plan bewusst eingeschaltet: sofort anwenden, alte Sperre faellt weg
                    r.zustand.hand = handeingriff.aufheben(r.zustand.hand);
                }
            }
            await a.setStateAsync(dp, { val: b, ack: true });
            a.log.info(`${r.name}: control ${pfad} = ${b}`);
        } else if (art === 'plan') {
            const fehler = this.planUebernehmen(r, val);
            if (fehler && val) {
                a.log.warn(`${r.name}: weekly schedule rejected - ${fehler}`);
                return false; // ohne ack: der Datenpunkt zeigt, dass nichts uebernommen wurde
            }
            await a.setStateAsync(dp, { val: r.plan ? JSON.stringify(r.plan) : '', ack: true });
            a.log.info(`${r.name}: weekly schedule updated`);
        } else if (art === 'abwesenheit') {
            r.abwesenheit = wochenplan.abwesenheitLesen(val, this.einstellung.szenen);
            if (!r.abwesenheit && val && String(val).trim() && String(val).trim() !== '{}') {
                a.log.warn(`${r.name}: absence rejected (needs von, bis, szene)`);
                return false;
            }
            await a.setStateAsync(dp, { val: r.abwesenheit ? JSON.stringify(r.abwesenheit) : '', ack: true });
        } else if (art === 'knopf') {
            r.zustand.hand = handeingriff.aufheben(r.zustand.hand);
            a.log.info(`${r.name}: manual override cleared`);
        }
        r.sichernNoetig = true;
        await this.schritt(id);
        return true;
    }

    /**
     * Zeittakt des Adapters: rechnet alle Geraete neu (Schaltpunkte, Ablauf von Sperren, Fuehleralter).
     */
    async takt() {
        for (const id of this.geraete.keys()) {
            await this.schritt(id);
        }
    }

    /**
     * Schreibt die Zustaende aller Geraete (beim Beenden).
     */
    async sichernAlle() {
        for (const [id, r] of this.geraete) {
            await this.sichern(id, r, true).catch(() => {});
        }
    }

    /**
     * Probelauf fuer dieses Geraet? (alles ausser ausdruecklich freigegeben)
     *
     * @param {object} r  Geraeteeintrag
     * @returns {boolean} true = es darf nichts hinaus
     */
    probe(r) {
        return !(r.probelauf === false && this.einstellung.probelaufGlobal === false);
    }

    /**
     * Ist fuer dieses Geraet das Senden der Leistungsgrenze erlaubt? (zweite, unabhaengige Pruefung)
     *
     * @param {object} r  Geraeteeintrag
     * @returns {boolean} true nur ausserhalb jedes Probelaufs
     */
    sendenErlaubt(r) {
        return r.aktiv === true && !this.probe(r);
    }

    /**
     * Liest einen Fuehler aus einem fremden Datenpunkt.
     *
     * @param {string} quelle  Datenpunkt-ID
     * @returns {Promise<{wert: (number|string|null), zeit: number}|null>} Messung
     */
    async fremdFuehler(quelle) {
        try {
            const s = await this.adapter.getForeignStateAsync(quelle);
            return s ? { wert: s.val, zeit: s.ts } : null;
        } catch {
            return null;
        }
    }

    /**
     * Vortagswerte aus der eigenen Stundenreihe (einmal je Tag und Zweig gelesen).
     *
     * @param {string} id      Geraete-ID
     * @param {object} r       Geraeteeintrag
     * @param {string} zweig   'heating' | 'cooling'
     * @returns {Promise<object|null>} Vortagswerte
     */
    async vortag(id, r, zweig) {
        const gestern = new Date(this.jetzt());
        gestern.setDate(gestern.getDate() - 1);
        const tag = tagVon(gestern);
        if (r.vortag && r.vortag.tag === tag && r.vortag.zweig === zweig) {
            return r.vortag.werte;
        }
        let werte = null;
        try {
            const s = await this.adapter.getStateAsync(`${id}.consumption.${zweig}.hoursJson`);
            werte = s && typeof s.val === 'string' ? bedarf.vortagAusStunden(JSON.parse(s.val), tag) : null;
        } catch {
            werte = null;
        }
        r.vortag = { tag, zweig, werte };
        return werte;
    }

    /**
     * Ein Regelschritt fuer ein Geraet.
     *
     * @param {string} id  Geraete-ID
     * @param {boolean} [meldung]  true: ausgeloest durch eine vollstaendige Statusmeldung
     */
    async schritt(id, meldung = false) {
        const r = this.geraete.get(id);
        if (!r || this.adapter.stopping) {
            return; // beim Beenden keine Lese-/Schreibzugriffe mehr ("Connection is closed")
        }
        if (r.laeuft) {
            r.nochmal = r.nochmal || meldung;
            return;
        }
        await r.bereit;
        r.laeuft = true;
        try {
            await this.schrittIntern(id, r, meldung);
            if (r.nochmal && !this.adapter.stopping) {
                r.nochmal = false;
                await this.schrittIntern(id, r, true);
            }
        } finally {
            r.laeuft = false;
        }
    }

    /**
     * Sammelt die Fuehlerwerte aller Quellen und waehlt je Messgroesse.
     *
     * @param {object} r      Geraeteeintrag
     * @param {number} jetzt  Uhr
     * @returns {Promise<{aussen: object, raum: object, feuchte: object}>} Auswahl je Messgroesse
     */
    async fuehlerWaehlen(r, jetzt) {
        const e = r.eingang;
        const q = r.konfig.quellen;
        const dp = async eintrag => (eintrag.dp ? (await this.fremdFuehler(eintrag.dp)) || null : undefined);
        // Interner Raumfuehler: achome, sonst temp. `temp` spiegelt einen gelieferten Fremdwert und
        // taugt als "intern" nur, solange die Regelung keinen liefert.
        const liefertEnv = !!(r.zustand.control && jetzt - r.zustand.control.zeit < 15 * 60000);
        const internRaum = e.achome || (liefertEnv || e.ble ? undefined : e.temp);
        return {
            aussen: quellen.waehlen('aussen', q.aussen.wahl, { dp: await dp(q.aussen), intern: e.outside }, jetzt),
            raum: quellen.waehlen(
                'raum',
                q.raum.wahl,
                { ble: e.ble ? e.bletemp : undefined, dp: await dp(q.raum), intern: internRaum },
                jetzt,
            ),
            feuchte: quellen.waehlen(
                'feuchte',
                q.feuchte.wahl,
                { ble: e.ble ? e.blehum : undefined, dp: await dp(q.feuchte), intern: e.hum },
                jetzt,
            ),
        };
    }

    /**
     * Rechnet, entscheidet und schreibt die Datenpunkte (ohne Sperre - siehe schritt()).
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     * @param {boolean} meldung  ausgeloest durch eine vollstaendige Statusmeldung
     */
    async schrittIntern(id, r, meldung) {
        const a = this.adapter;
        const jetzt = this.jetzt();
        const p = `${id}.${ZWEIG}`;
        const e = r.eingang;
        const k = r.konfig;
        const probelauf = this.probe(r);
        const schreibe = (feld, wert) => a.wertSchreiben(`${id}.regel.${feld}`, wert);
        await a.wertSchreiben(`${p}.strategie`, k.bedarf.strategie);
        await schreibe('betrieb', k.betrieb);
        await a.wertSchreiben(`${id}.info.demandFaehig`, (r.zustand.faehig && r.zustand.faehig.wert) || 'unbekannt');

        const fehler = r.fehler || this.einstellung.fehler;
        if (fehler) {
            await a.wertSchreiben(`${p}.zustand`, 'gestört');
            await a.wertSchreiben(`${p}.grund`, `Konfigurationsfehler: ${fehler}`);
            await schreibe('zustand', 'gestört');
            await schreibe('grund', `Konfigurationsfehler: ${fehler}`);
            return;
        }
        const online = r.letzteMeldung > 0 && jetzt - r.letzteMeldung <= OFFLINE_MS;

        // Fuehler
        const fu = await this.fuehlerWaehlen(r, jetzt);
        for (const art of ['aussen', 'raum', 'feuchte']) {
            await schreibe(`fuehler.${art}`, fu[art].messung ? fu[art].messung.wert : null);
            await schreibe(`fuehler.${art}Quelle`, fu[art].text);
        }

        // Wochenplan
        const planOpt = { ...this.einstellung.feiertage, abwesenheit: r.abwesenheit };
        const ps = r.plan ? wochenplan.stand(r.plan, jetzt, planOpt) : null;
        const szene = ps && ps.szene ? this.einstellung.szenen.get(ps.szene) || null : null;
        await schreibe('plan.szene', szene ? szene.name : '');
        await schreibe('plan.naechster', ps && ps.naechster ? ps.naechster.zeit : null);
        const naechste = ps && ps.naechster ? this.einstellung.szenen.get(ps.naechster.szene) : null;
        await schreibe('plan.naechsteSzene', naechste ? naechste.name : '');

        // Status, im Probelauf ueberlagert von den Werten, die gesendet worden waeren
        const status = {
            power: typeof e.power === 'boolean' ? e.power : undefined,
            mode: e.mode, // bei ausgeschalteter Anlage meldet das Modul "off"
            heat: e.heat,
            target: Number.isFinite(Number(e.target)) ? Number(e.target) : undefined,
            fan: e.fan,
            demand: e.demand,
            econo: e.econo === true,
            abtauen: e.action === 'defrosting' || e.antifreeze === true,
            autoe: e.autoe,
            autor: e.autoe === true ? 1 : 0,
            ble: e.ble === true,
        };
        const sicht = probelauf ? { ...status, ...r.virtuell } : status;

        // Handeingriff - nur aus echten Meldungen; im Zielband-Betrieb fuehrt das Modul den Sollwert
        // der Anlage selbst nach, in Faikout-Auto waehlt es die Betriebsart.
        const ignoriere = [];
        if (r.zustand.control && r.zustand.control.text.includes('target')) {
            ignoriere.push('target');
        }
        if (k.betrieb === 'faikout') {
            ignoriere.push('mode');
        }
        if (meldung && online) {
            const erwartet =
                r.schalter.plan && szene
                    ? szene.power
                        ? { power: true, mode: szene.mode, target: szene.soll, fan: szene.fan }
                        : { power: false }
                    : null;
            const h = handeingriff.auswerten(
                {
                    power: status.power,
                    mode: status.power ? status.mode : undefined,
                    target: status.power ? status.target : undefined,
                    fan: status.power ? status.fan : undefined,
                },
                r.zustand.hand,
                k.hand,
                jetzt,
                {
                    naechsterSchaltpunkt: ps && ps.naechster ? ps.naechster.zeit : null,
                    ignoriere,
                    ersteMeldung: r.ersteMeldung && Object.keys(r.zustand.hand.bekannt || {}).length === 0,
                    erwartet,
                },
            );
            r.ersteMeldung = false;
            // Eine Sperre gibt es nur, wenn ueberhaupt etwas automatisch verstellt wuerde.
            const automatik = r.schalter.plan || r.schalter.feuchte;
            if (h.neu.length && automatik && k.hand.modus !== 'nie') {
                a.log.info(
                    `${r.name}: manual change detected (${h.neu.join(', ')}) - automation waits until ${new Date(h.zustand.bis).toISOString()}`,
                );
                r.sichernNoetig = true;
                r.zustand.hand = h.zustand;
            } else {
                r.zustand.hand = { ...h.zustand, bis: h.neu.length ? r.zustand.hand.bis || 0 : h.zustand.bis };
            }
        }
        const gesperrt = jetzt < (r.zustand.hand.bis || 0) && (r.schalter.plan || r.schalter.feuchte);
        await schreibe('hand.gesperrt', gesperrt);
        await schreibe('hand.bis', gesperrt ? r.zustand.hand.bis : null);

        // Koordinator
        const richtung = bedarf.richtung({ power: sicht.power === true, mode: sicht.mode, heat: sicht.heat });
        const vortag =
            k.bedarf.strategie === 'vortag' && richtung
                ? await this.vortag(id, r, richtung === 'kuehlen' ? 'cooling' : 'heating')
                : null;
        const faehig = (r.zustand.faehig && r.zustand.faehig.wert) || 'unbekannt';
        const erg = koordinator.koordinieren(
            {
                status: sicht,
                fuehler: fu,
                schalter: { plan: r.schalter.plan, feuchte: r.schalter.feuchte, bedarf: r.aktiv },
                szene,
                gesperrt,
                faehig,
                vortag,
            },
            k,
            r.zustand,
            jetzt,
        );
        const feuchteVorher = r.zustand.feuchte.seit;
        r.zustand.koordinator = erg.zustand.koordinator;
        r.zustand.bedarf = erg.zustand.bedarf;
        r.zustand.feuchte = erg.zustand.feuchte;
        if (feuchteVorher !== r.zustand.feuchte.seit) {
            r.sichernNoetig = true;
        }
        const gruende = [...erg.gruende];
        let zustandText = erg.zustandText;
        if (r.schalter.plan && r.planFehler) {
            gruende.unshift(`Wochenplan: ${r.planFehler}`);
            zustandText = 'gestört';
        }

        // Feuchte-Anzeige
        await schreibe('feuchte.taupunkt', erg.feuchte.taupunkt);
        await schreibe('feuchte.abstand', erg.feuchte.abstand);
        await schreibe('feuchte.eingriff', erg.feuchte.bedarf && erg.feuchte.massnahme !== 'melden');
        await schreibe('feuchte.grund', erg.feuchte.grund);

        // Senden: Szenenfelder
        if (!online) {
            zustandText = 'offline';
            gruende.unshift('Modul meldet sich nicht – es wird nichts gesendet');
        } else if (Object.keys(erg.wunsch).length) {
            const plan = sender.planen({ wunsch: erg.wunsch, status: sicht, zustand: r.zustand.sender, jetzt });
            r.zustand.sender = plan.zustand;
            if (Object.keys(plan.befehle).length) {
                await this.felderSenden(id, r, plan.befehle, probelauf, jetzt);
            }
            if (plan.grund) {
                gruende.push(`Senden: ${plan.grund}${probelauf ? ' [Probelauf]' : ''}`);
            }
            if (plan.abgelehnt.length && zustandText === 'ok') {
                zustandText = 'gestört';
            }
        }

        // Senden: Leistungsgrenze
        const b = erg.bedarf;
        let bedarfZustand = b.zustand;
        let bedarfGrund = b.grund + (b.konflikt ? ` | ${b.konflikt}` : '');
        if (!r.aktiv) {
            bedarfZustand = 'aus';
            bedarfGrund = `Regelung aus | ${bedarfGrund}`;
        } else if (online) {
            const ent = schreiber.entscheiden({
                sollwert: erg.demand,
                istwert: e.demand,
                probelauf: probelauf,
                faehig,
                jetzt,
                zustand: r.zustand.schreiber,
            });
            r.zustand.schreiber = ent.zustand;
            await a.wertSchreiben(`${p}.befehleStunde`, ent.befehleStunde);
            if (ent.aktion === 'wuerde' || ent.aktion === 'senden') {
                const eintrag = {
                    wert: ent.wert,
                    zeit: new Date(jetzt).toISOString(),
                    aktion: ent.aktion,
                    ist: e.demand ?? null,
                };
                await a.wertSchreiben(`${p}.wuerdeSenden`, JSON.stringify(eintrag));
                r.zustand.verlauf = zustandSpeicher.verlaufAnhaengen(r.zustand.verlauf, ent.wert, jetzt);
                await schreibe('verlaufJson', JSON.stringify(r.zustand.verlauf));
                r.sichernNoetig = true;
                if (ent.aktion === 'senden') {
                    await this.senden(id, r, ent.wert);
                } else {
                    a.log.info(
                        `${r.name}: demand control (dry run) would send demand ${ent.wert} % (currently ${e.demand ?? '?'} %).`,
                    );
                }
            }
            if (erg.demand !== null && erg.demand !== b.sollwert) {
                bedarfGrund = `${bedarfGrund} | Szene begrenzt auf ${erg.demand} %`;
            }
            bedarfGrund = `${bedarfGrund} | ${ent.grund}${probelauf ? ' [Probelauf]' : ''}`;
        }
        await a.wertSchreiben(`${p}.sollwert`, r.aktiv && erg.demand !== null ? erg.demand : b.sollwert);
        await a.wertSchreiben(`${p}.rohwert`, b.rohwert);
        await a.wertSchreiben(`${p}.aussenMittel`, b.aussenMittel);
        await a.wertSchreiben(`${p}.zustand`, bedarfZustand);
        await a.wertSchreiben(`${p}.grund`, bedarfGrund.slice(0, 500));

        // Senden: control (Fuehlerwert / Zielband)
        if (online && erg.control && koordinator.controlFaellig(erg.control, r.zustand.control, jetzt)) {
            const nachricht = JSON.stringify(erg.control);
            const gesendet = await this.publizieren(r, `command/${r.name}/control`, nachricht, probelauf);
            if (gesendet || probelauf) {
                r.zustand.control = { text: nachricht, zeit: jetzt };
            }
        } else if (!erg.control && r.zustand.control) {
            r.zustand.control = null; // laeuft im Modul nach tcontrol (600 s) von selbst ab
            r.sichernNoetig = true;
        }

        const aus = !r.aktiv && !r.schalter.plan && !r.schalter.feuchte;
        await schreibe('zustand', aus ? 'aus' : zustandText);
        await schreibe('grund', (aus ? 'Regelung aus' : gruende.join(' · ')).slice(0, 800));
        await this.sichern(id, r, false);
    }

    /**
     * Schreibt den neustartfesten Zustand - bei wichtigen Aenderungen sofort, sonst alle 10 Minuten.
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     * @param {boolean} erzwingen  true: immer schreiben (Beenden)
     */
    async sichern(id, r, erzwingen) {
        const jetzt = this.jetzt();
        if (!erzwingen && !r.sichernNoetig && jetzt - r.gesichert < SICHERN_MS) {
            return;
        }
        r.sichernNoetig = false;
        r.gesichert = jetzt;
        const textNeu = zustandSpeicher.schreiben(r.zustand);
        if (textNeu !== r.gesichertText) {
            r.gesichertText = textNeu;
            await this.adapter.setStateAsync(`${id}.${ZWEIG}.zustandJson`, { val: textNeu, ack: true });
        }
    }

    /**
     * Veroeffentlicht einen Befehl - oder protokolliert ihn im Probelauf. Einzige Sendestelle.
     *
     * @param {object} r         Geraeteeintrag
     * @param {string} topic     Topic
     * @param {string} nutzlast  Nutzlast
     * @param {boolean} probelauf  true: nicht senden
     * @returns {Promise<boolean>} true, wenn wirklich gesendet
     */
    async publizieren(r, topic, nutzlast, probelauf) {
        if (probelauf || this.probe(r)) {
            this.adapter.log.debug(`${r.name}: (dry run) would publish ${topic} = ${nutzlast}`);
            return false;
        }
        const ok = this.adapter.broker ? await this.adapter.broker.publish(topic, nutzlast) : false;
        this.adapter.log.debug(`${r.name}: -> ${topic} = ${nutzlast}${ok ? '' : ' (publish failed)'}`);
        return ok;
    }

    /**
     * Sendet Szenenfelder (power, mode, target, fan) als einzelne Befehle in fester Reihenfolge.
     *
     * @param {string} id       Geraete-ID
     * @param {object} r        Geraeteeintrag
     * @param {object} befehle  {feld: wert}
     * @param {boolean} probelauf  Probelauf
     * @param {number} jetzt    Uhr
     */
    async felderSenden(id, r, befehle, probelauf, jetzt) {
        const a = this.adapter;
        const topicFeld = { power: 'power', mode: 'mode', target: 'temp', fan: 'fan' };
        for (const [feld, wert] of Object.entries(befehle)) {
            const nutzlast = typeof wert === 'boolean' ? (wert ? 'true' : 'false') : String(wert);
            await this.publizieren(r, `command/${r.name}/${topicFeld[feld]}`, nutzlast, probelauf);
        }
        if (probelauf) {
            r.virtuell = { ...r.virtuell, ...befehle };
            if (befehle.mode !== undefined) {
                r.virtuell.power = true;
            }
        } else {
            r.zustand.hand = handeingriff.befehlMerken(r.zustand.hand, befehle, jetzt);
        }
        const eintrag = {
            felder: befehle,
            zeit: new Date(jetzt).toISOString(),
            aktion: probelauf ? 'wuerde' : 'senden',
        };
        await a.wertSchreiben(`${id}.regel.letzterBefehl`, JSON.stringify(eintrag));
        const liste = Object.entries(befehle)
            .map(([f, w]) => `${f}=${w}`)
            .join(', ');
        a.log.info(`${r.name}: control ${probelauf ? '(dry run) would send' : 'sends'} ${liste}.`);
        r.sichernNoetig = true;
    }

    /**
     * Sendet demand an das Modul - nur ausserhalb des Probelaufs (zweite Pruefung hier).
     *
     * @param {string} id    Geraete-ID
     * @param {object} r     Geraeteeintrag
     * @param {number} wert  Geraetestufe
     */
    async senden(id, r, wert) {
        if (!this.sendenErlaubt(r)) {
            this.adapter.log.error(`${r.name}: demand control tried to send outside of live mode - blocked.`);
            return;
        }
        const stufe = schreiber.geraeteStufe(wert);
        const ok = this.adapter.broker
            ? await this.adapter.broker.publish(`command/${r.name}/demand`, String(stufe))
            : false;
        this.adapter.log.info(`${r.name}: demand control sends demand ${stufe} %${ok ? '' : ' (publish failed)'}.`);
    }
}

module.exports = {
    Bedarfsregelung,
    Regelung: Bedarfsregelung,
    konfigAusInstanz,
    geraeteKonfig,
    DATENPUNKTE,
    DATENPUNKTE_REGEL,
    SCHALTER,
    ZWEIG,
    tagVon,
};
