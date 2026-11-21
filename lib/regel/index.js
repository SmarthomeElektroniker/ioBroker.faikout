'use strict';

/**
 * Klimaregelung - Anbindung an den Adapter. Haelt je Geraet die Eingaenge, ruft die reinen
 * Rechenbausteine (quellen, wochenplan, handeingriff, koordinator mit bedarf und feuchte, sender,
 * schreiber, faehigkeit) und schreibt die Datenpunkte `<Geraet>.regulation.*` sowie `info.demandCapable`.
 *
 * SICHERHEIT: Im Probelauf geht nie ein Befehl hinaus. Gesendet wird nur, wenn
 *   - die Instanz-Einstellung "Probelauf" (regelProbelauf) AUS ist UND
 *   - in der Geraetezeile der Einstellungen (regelGeraete[].probelauf) der Probelauf nicht gesetzt ist.
 * Der Datenpunkt regulation.demand.dryRun ist nur noch die ANZEIGE des wirksamen Zustands (nicht
 * schreibbar, Nutzerentscheid 21.11.2026): ein zweiter, versteckter Schalter je Geraet entfaellt.
 * Die Leistungsgrenze braucht zusaetzlich regulation.demand.active, der Wochenplan regulation.schedule.active, die
 * Feuchteregelung regulation.humidity.active. publizieren() prueft die Freigabe unmittelbar vor jedem
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
const texte = require('./texte');
const vorlage = require('./vorlage');
const nutzlast = require('./nutzlast');

/** Wurzel aller Datenpunkte der Regelung unter dem Geraet (bis zum Vorabstand von 1.0.0: `regel`). */
const WURZEL = 'regulation';
const ZWEIG = `${WURZEL}.demand`;
const OFFLINE_MS = 5 * 60000;
const SICHERN_MS = 10 * 60000;

const ZUSTAENDE = {
    ok: 'ok',
    fault: 'fault',
    notCapable: 'notCapable',
    neutral: 'neutral',
    off: 'off',
};

const DATENPUNKTE = {
    active: {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Demand control active', de: 'Bedarfsregelung aktiv' },
    },
    dryRun: {
        type: 'boolean',
        role: 'indicator',
        // Nur Anzeige des wirksamen Probelaufs (Instanz-Einstellung ODER Schalter der Geraetezeile in den
        // Einstellungen). Geschaltet wird in den Einstellungen; siehe probelaufAnzeigen().
        def: false,
        name: {
            en: 'Dry run in effect (calculate only, never send) - set in the instance settings',
            de: 'Probelauf wirksam (nur rechnen, nie senden) - Schalter in den Instanzeinstellungen',
        },
    },
    setpoint: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Calculated demand', de: 'Berechnete Leistungsgrenze' },
    },
    rawValue: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Raw value before limits', de: 'Rohwert vor Stufung und Grenzen' },
    },
    outsideMean: {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature (30 min mean)', de: 'Außentemperatur (Mittel 30 min)' },
    },
    reason: { type: 'string', role: 'text', name: { en: 'Demand limit: reason', de: 'Leistungsgrenze: Begründung' } },
    state: {
        type: 'string',
        role: 'text',
        states: ZUSTAENDE,
        name: { en: 'Demand limit: state', de: 'Leistungsgrenze: Zustand' },
    },
    wouldSend: {
        type: 'string',
        role: 'json',
        name: { en: 'Last command (or would-send in dry run)', de: 'Letzter Befehl (im Probelauf: würde senden)' },
    },
    commandsPerHour: {
        type: 'number',
        role: 'value',
        name: { en: 'Commands in the last hour', de: 'Befehle in der letzten Stunde' },
    },
    strategy: {
        type: 'string',
        role: 'text',
        states: { curve: 'curve', previousDay: 'previousDay' },
        name: { en: 'Strategy', de: 'Strategie' },
    },
    stateJson: {
        type: 'string',
        role: 'json',
        name: { en: 'Internal state (restart-safe)', de: 'Interner Zustand (neustartfest)' },
    },
};

/** Weitere Datenpunkte unter `<Geraet>.regulation` (Pfad relativ dazu). */
const DATENPUNKTE_REGEL = {
    state: {
        type: 'string',
        role: 'text',
        // 'setup' = es fehlt noch etwas (kein Wochenplan, Faikout-Auto im Modul aus) - keine Stoerung
        states: {
            ok: 'ok',
            manual: 'manual',
            setup: 'setup',
            fault: 'fault',
            offline: 'offline',
            off: 'off',
        },
        name: { en: 'Control: state (overall)', de: 'Regelung: Zustand (gesamt)' },
    },
    reason: {
        type: 'string',
        role: 'text',
        name: { en: 'Control: reason (overall)', de: 'Regelung: Begründung (gesamt)' },
    },
    'schedule.missing': {
        type: 'boolean',
        role: 'indicator',
        name: {
            en: 'Weekly schedule switched on, but none stored yet',
            de: 'Wochenplan eingeschaltet, aber noch keiner hinterlegt',
        },
    },
    'sensors.note': {
        type: 'string',
        role: 'text',
        name: { en: 'Sensors: note on a missing data point', de: 'Sensoren: Hinweis auf einen fehlenden Datenpunkt' },
    },
    mode: {
        type: 'string',
        role: 'text',
        states: { adapter: 'adapter', faikout: 'faikout' },
        name: { en: 'Who controls', de: 'Wer regelt' },
    },
    lastCommand: {
        type: 'string',
        role: 'json',
        name: { en: 'Last command (or would-send in dry run)', de: 'Letzter Befehl (im Probelauf: würde senden)' },
    },
    historyJson: {
        type: 'string',
        role: 'json',
        name: { en: 'Demand limit, last 24 hours', de: 'Leistungsgrenze, letzte 24 Stunden' },
    },
    'schedule.active': {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Weekly schedule active', de: 'Wochenplan aktiv' },
    },
    'schedule.weekJson': {
        type: 'string',
        role: 'json',
        write: true,
        name: { en: 'Weekly schedule', de: 'Wochenplan' },
    },
    'schedule.absenceJson': {
        type: 'string',
        role: 'json',
        write: true,
        name: { en: 'Absence', de: 'Abwesenheit' },
    },
    'schedule.level': {
        type: 'string',
        role: 'text',
        name: { en: 'Current temperature level', de: 'Aktuelle Temperaturstufe' },
    },
    'schedule.next': {
        type: 'number',
        role: 'date',
        name: { en: 'Next switching time', de: 'Nächster Schaltpunkt' },
    },
    'schedule.nextLevel': {
        type: 'string',
        role: 'text',
        name: { en: 'Next temperature level', de: 'Nächste Temperaturstufe' },
    },
    'humidity.active': {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Humidity control active', de: 'Feuchteregelung aktiv' },
    },
    'humidity.dewPoint': {
        type: 'number',
        role: 'value.temperature.dewpoint',
        unit: '°C',
        name: { en: 'Dew point', de: 'Taupunkt' },
    },
    'humidity.margin': {
        type: 'number',
        role: 'value',
        unit: 'K',
        name: { en: 'Dew point spread', de: 'Abstand zum Taupunkt' },
    },
    'humidity.intervention': {
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Humidity intervention running', de: 'Feuchteeingriff läuft' },
    },
    'humidity.reason': { type: 'string', role: 'text', name: { en: 'Reason', de: 'Begründung' } },
    'manual.locked': {
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Manual override (automation waits)', de: 'Handeingriff (Automatik wartet)' },
    },
    'manual.until': {
        type: 'number',
        role: 'date',
        name: { en: 'Automation waits until', de: 'Automatik wartet bis' },
    },
    'manual.resume': {
        type: 'boolean',
        role: 'button',
        write: true,
        read: false,
        name: { en: 'Resume automation now', de: 'Automatik jetzt fortsetzen' },
    },
    'target.up': {
        type: 'boolean',
        role: 'button',
        write: true,
        read: false,
        name: { en: 'Target temperature one step warmer', de: 'Solltemperatur einen Schritt wärmer' },
    },
    'target.down': {
        type: 'boolean',
        role: 'button',
        write: true,
        read: false,
        name: { en: 'Target temperature one step cooler', de: 'Solltemperatur einen Schritt kühler' },
    },
    'sensors.outside': {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature used', de: 'Verwendete Außentemperatur' },
    },
    'sensors.outsideStatus': {
        type: 'string',
        role: 'text',
        states: { ok: 'ok', fallback: 'fallback', missing: 'missing' },
        name: { en: 'Outside sensor state', de: 'Zustand Außensensor' },
    },
    'sensors.roomStatus': {
        type: 'string',
        role: 'text',
        states: { ok: 'ok', fallback: 'fallback', missing: 'missing' },
        name: { en: 'Room sensor state', de: 'Zustand Raumsensor' },
    },
    'sensors.humidityStatus': {
        type: 'string',
        role: 'text',
        states: { ok: 'ok', fallback: 'fallback', missing: 'missing' },
        name: { en: 'Humidity sensor state', de: 'Zustand Feuchtesensor' },
    },
    'sensors.outsideKind': {
        type: 'string',
        role: 'text',
        states: { ble: 'ble', dp: 'dp', internal: 'internal' },
        name: { en: 'Outside sensor: kind of source', de: 'Außensensor: Art der Quelle' },
    },
    'sensors.roomKind': {
        type: 'string',
        role: 'text',
        states: { ble: 'ble', dp: 'dp', internal: 'internal' },
        name: { en: 'Room sensor: kind of source', de: 'Raumsensor: Art der Quelle' },
    },
    'sensors.humidityKind': {
        type: 'string',
        role: 'text',
        states: { ble: 'ble', dp: 'dp', internal: 'internal' },
        name: { en: 'Humidity sensor: kind of source', de: 'Feuchtesensor: Art der Quelle' },
    },
    'demand.curveJson': {
        type: 'string',
        role: 'json',
        name: { en: 'Curve and limits of this device', de: 'Kennlinie und Grenzen dieses Geräts' },
    },
    'sensors.correction': {
        type: 'number',
        role: 'value',
        unit: 'K',
        name: { en: 'Sensor correction of the unit setpoint', de: 'Sensorkorrektur am Sollwert der Anlage' },
    },
    'sensors.target': {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Target at the room sensor', de: 'Ziel am Raumsensor' },
    },
    'demand.capableReason': {
        type: 'string',
        role: 'text',
        name: { en: 'Demand capability: reason', de: 'Leistungsgrenze möglich: Begründung' },
    },
    'sensors.outsideSource': {
        type: 'string',
        role: 'text',
        name: { en: 'Outside sensor', de: 'Außensensor' },
    },
    'sensors.room': {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Room temperature used', de: 'Verwendete Raumtemperatur' },
    },
    'sensors.roomSource': { type: 'string', role: 'text', name: { en: 'Room sensor', de: 'Raumsensor' } },
    'sensors.humidity': {
        type: 'number',
        role: 'value.humidity',
        unit: '%',
        name: { en: 'Humidity used', de: 'Verwendete Luftfeuchte' },
    },
    'sensors.humiditySource': {
        type: 'string',
        role: 'text',
        name: { en: 'Humidity sensor', de: 'Feuchtesensor' },
    },
};

const KANAELE = {
    regulation: { en: 'Control', de: 'Regelung' },
    'regulation.demand': { en: 'Demand control', de: 'Bedarfsregelung' },
    'regulation.schedule': { en: 'Weekly schedule', de: 'Wochenplan' },
    'regulation.humidity': { en: 'Humidity control', de: 'Feuchteregelung' },
    'regulation.manual': { en: 'Manual override', de: 'Handeingriff' },
    'regulation.target': { en: 'Target temperature', de: 'Solltemperatur' },
    'regulation.sensors': { en: 'Sensors', de: 'Sensoren' },
};

/** Schreibbare Schalter: Pfad unter regulation -> Art */
/** Fuehlerart (intern) -> Namensstamm der Datenpunkte unter regulation.sensors */
const FUEHLER_DP = { aussen: 'outside', raum: 'room', feuchte: 'humidity' };
/** Strategie der Einstellungen -> Wert des Datenpunkts regulation.demand.strategy */
const STRATEGIE_WERT = { kennlinie: 'curve', vortag: 'previousDay' };

/** Kanal des Schalters -> Name in r.schalter */
const SCHALTER_ZWEIG = { schedule: 'plan', humidity: 'feuchte' };

const SCHALTER = {
    'demand.active': 'bool',
    'schedule.active': 'bool',
    'humidity.active': 'bool',
    'schedule.weekJson': 'plan',
    'schedule.absenceJson': 'abwesenheit',
    'manual.resume': 'knopf',
    'target.up': 'zielSchritt',
    'target.down': 'zielSchritt',
};

/**
 * Abwesenheit als Text des Datenpunkts schedule.absenceJson (englische Schluessel).
 *
 * @param {{von: number, bis: number, szene: string}|null} abw  Abwesenheit
 * @returns {string} JSON-Text oder ''
 */
function abwesenheitText(abw) {
    return abw ? JSON.stringify(nutzlast.schreiben('abwesenheit', abw)) : '';
}

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

/** Felder einer Geraetezeile, die einen Wert der Vorlage ersetzen (siehe lib/regel/vorlage.js). */
const { VORLAGEN_FELDER } = vorlage;

const zahl = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const text = v => String(v === undefined || v === null ? '' : v).trim();

/**
 * Regelkonfiguration eines Geraets. Zwei Ebenen: die globale Vorlage der Instanz und eigene Werte
 * des Geraets. Je Teil (Kennlinie Heizen, Kennlinie Kuehlen, Grenzen, Temperaturstufen, Strategie,
 * Feuchte-Massnahme) gilt seit Runde 2 (21.11.2026): hat die Geraetezeile dafuer einen eigenen Wert,
 * gilt er - ein leeres Feld faellt auf die Vorlage zurueck und von dort auf die Werksvorgabe. Den
 * frueheren Haken `individuell` gibt es nicht mehr (Umzug: main.js regelKonfigUmziehen, Stand 3);
 * steht er noch in einer Zeile, wird er nicht beachtet.
 * Immer geraetebezogen sind Betrieb, Fuehler und Frostschutz.
 *
 * @param {object} c  adapter.config
 * @param {object} [zeile]  Zeile aus regelGeraete
 * @param {{aussen: string, raum: string}} [alt]  Quellen aus der alten Tabelle regelQuellen
 * @returns {{konfig: object, fehler: string|null}} Konfiguration des Geraets
 */
function geraeteKonfig(c = {}, zeile = {}, alt = { aussen: '', raum: '' }) {
    const v = bedarf.VORGABEN;
    const g = zeile;
    const wahl = (feld, instanz, vorgabe) => {
        const eigen = g[feld];
        if (Array.isArray(eigen) ? eigen.length : text(eigen)) {
            return eigen;
        }
        return (Array.isArray(instanz) ? instanz.length : text(instanz)) ? instanz : vorgabe;
    };
    const b = bedarf.konfigPruefen({
        strategie: wahl('strategie', c.regelStrategie, v.strategie),
        heizen: wahl('kennlinieHeizen', c.regelKennlinieHeizen, v.heizen),
        kuehlen: wahl('kennlinieKuehlen', c.regelKennlinieKuehlen, v.kuehlen),
        untergrenze: zahl(g.untergrenze, zahl(c.regelUntergrenze, v.untergrenze)),
        obergrenze: zahl(g.obergrenze, zahl(c.regelObergrenze, v.obergrenze)),
        totband: zahl(c.regelTotband, v.totband),
        prozentProK: zahl(c.regelProzentProK, v.prozentProK),
        ueberAbK: Math.max(0, zahl(c.regelUeberAbK, v.ueberAbK)),
        vortag: {
            bezug: text(g.vortagBezug) || text(c.regelVortagBezug) || v.vortag.bezug,
            zuschlag: zahl(g.vortagZuschlag, zahl(c.regelVortagZuschlag, v.vortag.zuschlag)),
            referenzW: zahl(g.vortagReferenzW, zahl(c.regelVortagReferenzW, v.vortag.referenzW)),
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
        // eigene Teile dieser Anlage (leer = alles aus der Vorlage), siehe vorlage.TEILE
        eigen: vorlage.eigeneTeile(g),
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
        // Fremder Raumfuehler: 'sollwert' = Anlage regelt selbst, Adapter korrigiert ihren Sollwert
        // (Vorgabe, auch fuer traege Fuehler); 'modul' = Fuehlerwert und Ziel ans Modul (control).
        fuehlerWeg: g.fuehlerWeg === 'modul' ? 'modul' : 'sollwert',
        korrAbstandMs: Math.min(180, Math.max(10, zahl(g.korrAbstandMin, 30))) * 60000,
        korrMittelMs: koordinator.VORGABEN.korrMittelMs,
        korrTotK: koordinator.VORGABEN.korrTotK,
        korrMaxK: koordinator.VORGABEN.korrMaxK,
        // Traeger Fremdfuehler (Minuten Zeitkonstante, 0 = aus): siehe quellen.mischen
        raumTraegeMin: Math.min(240, Math.max(0, zahl(g.raumTraegeMin, 0))),
        frostZiel: koordinator.VORGABEN.frostZiel,
        band: Math.min(2, Math.max(0.1, zahl(c.regelBand, koordinator.VORGABEN.band))),
    };
    const eigeneStufen = Array.isArray(g.stufen) && g.stufen.length > 0;
    const stufenListe = eigeneStufen ? g.stufen : c.regelStufen;
    const sz = wochenplan.szenenLesen(stufenListe);
    konfig.szenen = sz.szenen;
    // Ersatz fuer entfernte Stufen (steht an der Ersatzstufe; nach "Auf die Vorlage zuruecksetzen" in der
    // Geraetezeile unter stufenErsatz): siehe stufenErsatzAnwenden
    konfig.stufenErsatz = wochenplan.ersatzLesen(stufenListe, eigeneStufen ? null : g.stufenErsatz);
    return { konfig, fehler: b.fehler || f.fehler || sz.fehler };
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
    return {
        konfig: vorgabe.konfig.bedarf, // Instanzvorgabe der Bedarfsregelung (wie 0.5.0)
        fehler: vorgabe.fehler, // Instanzvorgabe; massgeblich ist der Fehler je Geraet (fuer())
        // Nur ein ausdrueckliches false schaltet den Probelauf ab. Neue Instanzen bringen false aus der
        // io-package mit; fehlt der Schluessel (Bestand), gilt weiter AN - main.js schreibt das beim Start fest.
        probelaufGlobal: c.regelProbelauf !== false,
        aktivVorgabe: c.regelAktiv === true,
        szenen: vorgabe.konfig.szenen, // Instanzvorgabe; massgeblich sind die Szenen je Geraet
        feiertage: {
            feiertagSonntag: c.regelFeiertagSonntag === true,
            deutschland: c.regelFeiertageDE !== false,
            eigene: wochenplan.feiertageLesen(c.regelFeiertage),
        },
        /**
         * @param {string} id    Geraete-ID
         * @param {string} name  Geraetename
         * @returns {{konfig: object, fehler: string|null, probelauf: boolean}} Konfiguration dieses Geraets
         */
        fuer(id, name) {
            const g = zeilen.get(id) || zeilen.get(name) || {};
            const alt = altQuellen.get(id) || altQuellen.get(name) || { aussen: '', raum: '' };
            const k = geraeteKonfig(c, g, alt);
            // Probelauf nur dieser Anlage: Feld der Geraetezeile ("Fuer Fortgeschrittene" in der Karte)
            return { konfig: k.konfig, fehler: k.fehler, probelauf: g.probelauf === true };
        },
    };
}

/**
 * Gilt fuer dieses Geraet der Probelauf? Die EINE Regel: Instanz-Einstellung ODER Schalter der Geraetezeile.
 *
 * @param {object} einstellung  Ergebnis von konfigAusInstanz
 * @param {string} id    Geraete-ID
 * @param {string} name  Geraetename
 * @returns {boolean} true = es darf nichts hinaus
 */
function probelaufWirksam(einstellung, id, name) {
    return einstellung.probelaufGlobal !== false || einstellung.fuer(id, name).probelauf !== false;
}

/**
 * Stellt den Datenpunkt `<Geraet>.regulation.demand.dryRun` auf "nur Anzeige" und auf den wirksamen Wert.
 * Bis 1.0.0-Vorabstand war er ein zweiter Schalter je Geraet (schreibbar, Bestand oft `true`): solche
 * Objekte werden einmal umgestellt (write false, Rolle indicator) und der Wert folgt ab dann der Einstellung.
 *
 * @param {object} a        Adapter (getObjectAsync, extendObject, getStateAsync, setStateAsync, log)
 * @param {string} id       Geraete-ID
 * @param {boolean} wirksam wirksamer Probelauf (probelaufWirksam)
 * @param {string} [name]   Geraetename fuer das Log
 * @returns {Promise<{umgestellt: boolean, vorher: unknown}|null>} null, wenn es den Datenpunkt nicht gibt
 */
async function probelaufAnzeigen(a, id, wirksam, name) {
    const dp = `${id}.${ZWEIG}.dryRun`;
    const objekt = typeof a.getObjectAsync === 'function' ? await a.getObjectAsync(dp).catch(() => null) : null;
    if (!objekt) {
        return null;
    }
    const stand = await a.getStateAsync(dp);
    const vorher = stand ? stand.val : null;
    const umgestellt =
        !objekt.common || objekt.common.write !== false || objekt.common.role !== DATENPUNKTE.dryRun.role;
    if (umgestellt && typeof a.extendObject === 'function') {
        await a.extendObject(dp, {
            common: { write: false, role: DATENPUNKTE.dryRun.role, def: false, name: DATENPUNKTE.dryRun.name },
        });
        if (vorher !== null && vorher !== wirksam) {
            // Der alte Geraeteschalter stand anders als die Einstellung - das soll niemand suchen muessen.
            const text =
                `${name || id}: the per-unit dry-run switch (regulation.demand.dryRun = ${vorher}) is no longer a switch - ` +
                `it now shows the effective state (${wirksam}). Dry run is set in the instance settings ` +
                '(tab "Control"; a single unit: its card, "Advanced").';
            if (wirksam) {
                a.log.info(text);
            } else {
                a.log.warn(`${text} This unit is now LIVE: commands are sent.`);
            }
        }
    }
    if (vorher !== wirksam) {
        await a.setStateAsync(dp, { val: wirksam, ack: true });
    }
    return { umgestellt, vorher };
}

/**
 * Legt Kanaele und Datenpunkte `<Geraet>.regulation.*` sowie `info.demandCapable` an (nur, was fehlt).
 * Auch der Umzug alter Datenpunkte (umzug.js) legt die neuen Objekte hierueber an.
 *
 * @param {object} a   Adapter (setObjectNotExistsAsync)
 * @param {string} id  Geraete-ID
 * @param {boolean} aktivVorgabe  Vorgabe fuer regulation.demand.active
 */
async function objekteAnlegen(a, id, aktivVorgabe) {
    // Bestand: Objekte, die ein aelterer Stand mit "Fuehler" im deutschen Namen angelegt hat, bekommen den
    // heutigen Namen ("Sensor", Nutzerentscheid 21.11.2026) - nur diese, eigene Umbenennungen bleiben.
    const umbenennen = async (objektId, name) => {
        if (!/ensor/.test(name.de) || typeof a.getObjectAsync !== 'function' || typeof a.extendObject !== 'function') {
            return;
        }
        const alt = await a.getObjectAsync(objektId);
        const altName = alt && alt.common && alt.common.name;
        if (altName && typeof altName === 'object' && /f(ü|ue)hler/i.test(String(altName.de || ''))) {
            await a.extendObject(objektId, { common: { name } });
        }
    };
    for (const [kanal, name] of Object.entries(KANAELE)) {
        await a.setObjectNotExistsAsync(`${id}.${kanal}`, { type: 'channel', common: { name }, native: {} });
        await umbenennen(`${id}.${kanal}`, name);
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
            common.def = feld === 'active' && pfad === ZWEIG ? aktivVorgabe : d.def;
        }
        await a.setObjectNotExistsAsync(`${id}.${pfad}.${feld}`, {
            type: 'state',
            common,
            native: { regulation: true },
        });
        await umbenennen(`${id}.${pfad}.${feld}`, d.name);
    };
    for (const [feld, d] of Object.entries(DATENPUNKTE)) {
        await anlegen(ZWEIG, feld, d);
    }
    for (const [feld, d] of Object.entries(DATENPUNKTE_REGEL)) {
        await anlegen(WURZEL, feld, d);
    }
    await a.setObjectNotExistsAsync(`${id}.info.demandCapable`, {
        type: 'state',
        common: {
            name: { en: 'Demand control supported', de: 'Leistungsgrenze möglich' },
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            states: { unknown: 'unknown', yes: 'yes', no: 'no' },
        },
        native: {},
    });
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
        /** Erfuellt, sobald die Sprache der Texte feststeht (lehnt nie ab). */
        this.sprachBereit = this.spracheSetzen();
    }

    /**
     * Holt die Systemsprache und stellt die Texte der Regelung darauf ein - sie gilt fuer die ganze
     * Instanz. Ohne Zugriff auf system.config (Tests, Attrappen) bleibt es bei Deutsch.
     *
     * @returns {Promise<string>} geltende Sprache
     */
    async spracheSetzen() {
        const a = this.adapter;
        const vorher = texte.sprache();
        let code = 'de';
        try {
            // Bewusst nicht ueber adapter.sprache(): die Methode meldet bei einem Fehler 'en' - hier
            // soll ein Fehler die Vorgabe Deutsch lassen.
            if (typeof a.getForeignObjectAsync === 'function') {
                const cfg = await a.getForeignObjectAsync('system.config');
                code = (cfg && cfg.common && cfg.common.language) || 'de';
            }
        } catch {
            code = 'de';
        }
        const neu = texte.setzeSprache(code);
        if (neu !== vorher) {
            // Vorgabe-Szenen und Fehlertexte der Instanzvorgabe tragen die Sprache in sich.
            this.einstellung = konfigAusInstanz(a.config);
        }
        return neu;
    }

    /**
     * Die Systemsprache wurde im laufenden Betrieb umgestellt (system.config): Texte neu einstellen
     * und je Geraet Konfiguration (Namen der Vorgabe-Szenen, Fehlertexte) und Begruendungen neu
     * schreiben. Plaene haengen an den Szenen-IDs und bleiben, wie sie sind.
     *
     * @returns {Promise<boolean>} true, wenn sich die Sprache geaendert hat
     */
    async sprachWechsel() {
        const vorher = await this.sprachBereit;
        this.sprachBereit = this.spracheSetzen();
        const neu = await this.sprachBereit;
        if (neu === vorher) {
            return false;
        }
        this.adapter.log.info(`System language changed to "${neu}" - texts of the control follow`);
        for (const [id, r] of this.geraete) {
            await r.bereit;
            const k = this.einstellung.fuer(id, r.name);
            r.konfig = k.konfig;
            r.fehler = k.fehler;
            // ein hinterlegter, aber unlesbarer Plan behaelt seinen Grund (z. B. "Stufe gibt es nicht") - in der neuen Sprache
            this.planUebernehmen(r, r.plan || r.planRoh || '');
            await this.schritt(id);
        }
        return true;
    }

    /**
     * Legt die Datenpunkte an und liest Schalter und Zustand. Einmal je Geraet.
     *
     * @param {string} id    Geraete-ID
     * @param {string} name  echter Geraetename
     * @returns {Promise<object>} Geraeteeintrag
     */
    async geraet(id, name) {
        // Erst wenn die Sprache feststeht: Konfigurationsfehler und Szenennamen entstehen hier.
        await this.sprachBereit;
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
            // Probelauf nur dieser Anlage (Geraetezeile der Einstellungen); wirksam: siehe probe()
            probelauf: k.probelauf !== false,
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
     * Legt Kanaele, Datenpunkte und info.demandCapable an und liest Schalter und Zustand.
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     */
    async anlegen(id, r) {
        const a = this.adapter;
        await objekteAnlegen(a, id, this.einstellung.aktivVorgabe);
        const lies = async feld => {
            const s = await a.getStateAsync(`${id}.${WURZEL}.${feld}`);
            return s ? s.val : null;
        };
        const aktiv = await lies('demand.active');
        r.aktiv = aktiv === null ? this.einstellung.aktivVorgabe : aktiv === true;
        // Der Datenpunkt dryRun zeigt nur den wirksamen Probelauf (Instanz ODER Geraetezeile); ein Wert aus
        // aelteren Versionen (dort ein eigener Schalter) wird hier an die Einstellung angeglichen.
        await probelaufAnzeigen(a, id, this.probe(r), r.name);
        r.zustand = zustandSpeicher.lesen(await lies('demand.stateJson'));
        if (aktiv === null) {
            await a.setStateAsync(`${id}.${ZWEIG}.active`, { val: r.aktiv, ack: true });
        }
        for (const [zweig, s] of Object.entries(SCHALTER_ZWEIG)) {
            const w = await lies(`${zweig}.active`);
            r.schalter[s] = w === true;
            if (w === null) {
                await a.setStateAsync(`${id}.${WURZEL}.${zweig}.active`, { val: false, ack: true });
            }
        }
        this.planUebernehmen(r, await this.stufenErsatzAnwenden(id, r, lies));
        if (!r.planFehlt && r.planFehler && r.schalter.plan) {
            // Plan hinterlegt und eingeschaltet, aber unlesbar - typisch: das Geraet folgt jetzt der Vorlage,
            // der Plan nennt noch seine frueheren eigenen Temperaturstufen. Ohne diese Zeile schaltet er still nicht.
            a.log.warn(
                `${r.name}: the stored weekly schedule cannot be used (${r.planFehler}) - it does not switch. ` +
                    'Edit it in the tab "Schedules" or apply the template there.',
            );
        }
        r.abwesenheit = wochenplan.abwesenheitLesen(await lies('schedule.absenceJson'), r.konfig.szenen);
        // JSON-Nutzlasten des Vorabstands (deutsche Schluessel, `scene`) einmal auf das heutige Format umschreiben
        for (const pfad of Object.keys(nutzlast.DATENPUNKTE)) {
            const neu = nutzlast.umschreiben(pfad, await lies(pfad));
            if (neu !== null) {
                await a.setStateAsync(`${id}.${WURZEL}.${pfad}`, { val: neu, ack: true });
                a.log.info(`${r.name}: JSON keys of ${WURZEL}.${pfad} rewritten to the current format`);
            }
        }
    }

    /**
     * Entfernte Temperaturstufen im gespeicherten Wochenplan (und in der Abwesenheit) durch die in den
     * Einstellungen gewaehlte Ersatzstufe ersetzen. Laeuft beim Anlegen des Geraets, also nach jedem
     * "Speichern" der Instanz (der Adapter startet neu): Erst dann ist die Stufe wirklich weg - der Plan
     * ist ein Datenpunkt und wirkt sofort, die Stufenliste gilt erst mit dem Speichern. Ersetzt wird nur,
     * was es nicht mehr gibt; ohne Ersatzwahl bleibt der Plan unveraendert (und meldet sich als unlesbar).
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     * @param {(feld: string) => Promise<unknown>} lies  liest einen Datenpunkt unter regulation
     * @returns {Promise<unknown>} der Wochenplan, wie er jetzt im Datenpunkt steht
     */
    async stufenErsatzAnwenden(id, r, lies) {
        const a = this.adapter;
        const { szenen, stufenErsatz: ersatz } = r.konfig;
        let roh = await lies('schedule.weekJson');
        if (!(ersatz instanceof Map) || !ersatz.size) {
            return roh;
        }
        const name = n => (szenen.get(n) ? szenen.get(n).name : n);
        const p = wochenplan.planErsetzen(roh, ersatz, szenen);
        if (p && p.ersetzt.length) {
            roh = JSON.stringify(p.plan);
            await a.setStateAsync(`${id}.${WURZEL}.schedule.weekJson`, { val: roh, ack: true });
            a.log.info(
                `${r.name}: weekly schedule adapted to the temperature levels - ${p.ersetzt
                    .map(e => `removed level "${e.von}" replaced by "${name(e.nach)}"`)
                    .join(', ')}`,
            );
        }
        const abw = nutzlast.lesen('abwesenheit', await lies('schedule.absenceJson'));
        if (abw && !szenen.has(String(abw.szene))) {
            const nach = wochenplan.ersatzZiel(abw.szene, ersatz, szenen);
            if (nach) {
                await a.setStateAsync(`${id}.${WURZEL}.schedule.absenceJson`, {
                    val: JSON.stringify(nutzlast.schreiben('abwesenheit', { ...abw, szene: nach })),
                    ack: true,
                });
                a.log.info(
                    `${r.name}: absence adapted to the temperature levels - removed level "${abw.szene}" replaced by "${name(nach)}"`,
                );
            }
        }
        return roh;
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
            r.planRoh = null;
            r.planFehlt = true;
            r.planFehler = texte.t('plan.keiner');
            return r.planFehler;
        }
        const p = wochenplan.planLesen(roh, r.konfig.szenen);
        r.planFehlt = false;
        r.plan = p.plan;
        r.planFehler = p.fehler;
        // unlesbar: den Text behalten, damit ein Sprachwechsel den Grund neu formulieren kann
        r.planRoh = p.plan ? null : roh;
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
     * Native Meldung state/<Name>/status: nur sie nennt autoe/autor/autot zuverlaessig (im Klartext
     * steht autoe nur mit der Moduleinstellung ha.switches).
     *
     * @param {string} id     Geraete-ID
     * @param {object} daten  native Felder
     */
    nativ(id, daten) {
        const r = this.geraete.get(id);
        if (!r || !daten) {
            return;
        }
        if (typeof daten.autoe === 'boolean') {
            r.eingang.autoe = daten.autoe;
        }
        for (const f of ['autor', 'autot']) {
            if (Number.isFinite(Number(daten[f])) && daten[f] !== null && daten[f] !== '') {
                r.eingang[f] = Number(daten[f]);
            }
        }
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
        await this.adapter.wertSchreiben(`${id}.info.demandCapable`, r.zustand.faehig.wert);
    }

    /**
     * Schreibbarer Datenpunkt unter regulation.* vom Nutzer (ack=false).
     *
     * @param {string} id    Geraete-ID
     * @param {string} feld  Pfad unter regulation ('demand.active', 'schedule.weekJson', ...) - oder kurz 'active'
     * @param {unknown} val  neuer Wert
     * @returns {Promise<boolean>} true, wenn uebernommen
     */
    async schalter(id, feld, val) {
        const r = this.geraete.get(id);
        const pfad = feld === 'active' || feld === 'dryRun' ? `demand.${feld}` : feld;
        const art = SCHALTER[pfad];
        const a = this.adapter;
        if (r && pfad === 'demand.dryRun') {
            // Kein Schalter mehr: der Datenpunkt zeigt den wirksamen Probelauf. Ein Schreibversuch (altes
            // Skript, alte Visualisierung) wird abgelehnt und der Wert zurueckgestellt - mit Fundstelle im Log.
            const wirksam = this.probe(r);
            await a.setStateAsync(`${id}.${WURZEL}.${pfad}`, { val: wirksam, ack: true });
            a.log.warn(
                `${r.name}: regulation.demand.dryRun is read-only (written value ${JSON.stringify(val)} ignored, effective dry run stays ${wirksam}). ` +
                    'Set dry run in the instance settings: tab "Control" > "Advanced" (all units) or the card of the unit > "Advanced" (this unit only).',
            );
            return false;
        }
        if (!r || !art) {
            return false;
        }
        const dp = `${id}.${WURZEL}.${pfad}`;
        if (art === 'bool') {
            const b = val === true || val === 'true' || val === 1;
            if (pfad === 'demand.active') {
                r.aktiv = b;
            } else {
                r.schalter[SCHALTER_ZWEIG[pfad.split('.')[0]]] = b;
                if (pfad === 'schedule.active' && b) {
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
            r.abwesenheit = wochenplan.abwesenheitLesen(val, r.konfig.szenen);
            if (!r.abwesenheit && val && String(val).trim() && String(val).trim() !== '{}') {
                a.log.warn(`${r.name}: absence rejected (needs from, to, level)`);
                return false;
            }
            await a.setStateAsync(dp, { val: abwesenheitText(r.abwesenheit), ack: true });
        } else if (art === 'zielSchritt') {
            // +/- auf der Geraetekarte: einen Schritt der Anlage (meist 0,5 K) vom jetzigen Sollwert aus.
            // Geschrieben wird control.target OHNE ack - der Befehl geht den gewohnten Weg ueber main.js.
            const feldId = `${id}.control.target`;
            const st = await a.getStateAsync(feldId);
            const jetzt = st && Number.isFinite(Number(st.val)) ? Number(st.val) : null;
            if (jetzt === null) {
                return false;
            }
            const g = ((a.geraete && a.geraete.get(id)) || {}).grenzen || {};
            const schritt = Number(g.step) > 0 ? Number(g.step) : 0.5;
            const min = Number.isFinite(Number(g.min)) ? Number(g.min) : 10;
            const max = Number.isFinite(Number(g.max)) ? Number(g.max) : 32;
            const roh = jetzt + (pfad === 'target.up' ? schritt : -schritt);
            const neu = Math.min(max, Math.max(min, Math.round(roh / schritt) * schritt));
            if (neu !== jetzt) {
                await a.setStateAsync(feldId, { val: Math.round(neu * 10) / 10, ack: false });
            }
            return true;
        } else if (art === 'knopf') {
            r.zustand.hand = handeingriff.aufheben(r.zustand.hand);
            a.log.info(`${r.name}: manual override cleared`);
        }
        r.sichernNoetig = true;
        await this.schritt(id);
        return true;
    }

    /**
     * Der Nutzer hat ueber den Datenpunkt control.target ein neues Ziel gesetzt. Solange das Modul
     * den Sollwert der Anlage selbst nachfuehrt (Zielband), ist das die einzige Stelle, an der die
     * Regelung das neue Ziel erfaehrt.
     *
     * @param {string} id   Geraete-ID
     * @param {unknown} val neues Ziel
     */
    zielGesetzt(id, val) {
        const r = this.geraete.get(id);
        const ziel = Number(val);
        if (r && Number.isFinite(ziel)) {
            if (r.zustand.koordinator.bandAktiv) {
                r.zustand.koordinator.bandZiel = ziel;
            }
            if (Number.isFinite(r.zustand.koordinator.basisZiel)) {
                r.zustand.koordinator.basisZiel = ziel; // Fuehlerkorrektur: das ist das neue Ziel im Raum
                r.zustand.koordinator.korrGemeldet = ziel;
            }
            r.sichernNoetig = true;
        }
    }

    /**
     * Szenen eines Geraets (fuer Karten und Dialoge).
     *
     * @param {string} id  Geraete-ID
     * @returns {Map<string, object>} Szenen nach ID
     */
    szenenVon(id) {
        const r = this.geraete.get(id);
        return r ? r.konfig.szenen : this.einstellung.fuer(id, id).konfig.szenen;
    }

    /**
     * Regelt das Modul dieses Geraets gerade selbst (Faikout-Auto eingeschaltet)?
     *
     * @param {string} id  Geraete-ID
     * @returns {boolean} true bei gemeldetem autoe
     */
    autoAn(id) {
        const r = this.geraete.get(id);
        return !!r && r.eingang.autoe === true && r.eingang.autor !== 0;
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
     * Probelauf fuer dieses Geraet? Instanz-Einstellung ODER Schalter der Geraetezeile (alles ausser
     * ausdruecklich freigegeben).
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
        const raum = quellen.waehlen(
            'raum',
            q.raum.wahl,
            { ble: e.ble ? e.bletemp : undefined, dp: await dp(q.raum), intern: internRaum },
            jetzt,
        );
        // Traeger Fremdfuehler: schnelle Aenderungen vom Fuehler der Anlage dazumischen.
        if (raum.quelle === 'dp' && raum.messung && r.konfig.raumTraegeMin > 0) {
            const intern = e.achome && jetzt - e.achome.zeit < 10 * 60000 ? Number(e.achome.wert) : null;
            const m = quellen.mischen(raum.messung.wert, intern, r.mischer, jetzt, r.konfig.raumTraegeMin * 60000);
            r.mischer = m.zustand;
            raum.fremd = raum.messung.wert;
            raum.messung = { wert: m.wert, zeit: raum.messung.zeit };
        } else {
            r.mischer = null;
        }
        const erg = {
            aussen: quellen.waehlen('aussen', q.aussen.wahl, { dp: await dp(q.aussen), intern: e.outside }, jetzt),
            raum,
            feuchte: quellen.waehlen(
                'feuchte',
                q.feuchte.wahl,
                { ble: e.ble ? e.blehum : undefined, dp: await dp(q.feuchte), intern: e.hum },
                jetzt,
            ),
        };
        // Ein gewaehlter Datenpunkt, der nicht fuehrt, wird MIT NAMEN genannt (UX-Fund 21.11.2026):
        // "Raumsensor 0_userdata.0.x existiert nicht - es gilt: Sensor der Anlage".
        erg.hinweise = [];
        for (const art of ['aussen', 'raum', 'feuchte']) {
            const eintrag = q[art];
            if (!eintrag || !eintrag.dp || erg[art].quelle === 'dp') {
                continue;
            }
            const artText =
                art === 'aussen'
                    ? texte.t('index.fuehlerArt.aussen')
                    : art === 'raum'
                      ? texte.t('index.fuehlerArt.raum')
                      : texte.t('index.fuehlerArt.feuchte');
            const ersatz = erg[art].quelle ? quellen.name(erg[art].quelle) : texte.t('quellen.keiner');
            const text = (await this.fremdObjektGibtEs(eintrag.dp))
                ? `${artText} ${eintrag.dp}: ${erg[art].text}`
                : texte.t('index.fuehlerFehlt', { art: artText, id: eintrag.dp, ersatz });
            erg.hinweise.push(text);
            erg[art].text = text;
        }
        return erg;
    }

    /**
     * Gibt es das Objekt eines fremden Fuehler-Datenpunkts? (je ID hoechstens einmal je Minute gefragt)
     *
     * @param {string} id  volle ID
     * @returns {Promise<boolean>} true, wenn das Objekt existiert
     */
    async fremdObjektGibtEs(id) {
        this.fremdObjekte = this.fremdObjekte || new Map();
        const jetzt = this.jetzt();
        const alt = this.fremdObjekte.get(id);
        if (alt && jetzt - alt.zeit < 60000) {
            return alt.da;
        }
        // Unbekannt (Abfrage scheitert) zaehlt als vorhanden: "existiert nicht" wird nur behauptet,
        // wenn die Datenbank das Objekt wirklich nicht kennt.
        let da = true;
        try {
            if (typeof this.adapter.getForeignObjectAsync === 'function') {
                da = !!(await this.adapter.getForeignObjectAsync(id)) || !!(await this.fremdFuehler(id));
            }
        } catch {
            da = true;
        }
        this.fremdObjekte.set(id, { da, zeit: jetzt });
        return da;
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
        const schreibe = (feld, wert) => a.wertSchreiben(`${id}.${WURZEL}.${feld}`, wert);
        await a.wertSchreiben(`${p}.strategy`, STRATEGIE_WERT[k.bedarf.strategie] || k.bedarf.strategie);
        await schreibe('mode', k.betrieb);
        await schreibe(
            'demand.curveJson',
            JSON.stringify(
                nutzlast.schreiben('kennlinie', {
                    heizen: k.bedarf.heizen,
                    kuehlen: k.bedarf.kuehlen,
                    untergrenze: k.bedarf.untergrenze,
                    obergrenze: k.bedarf.obergrenze,
                }),
            ),
        );
        await a.wertSchreiben(`${id}.info.demandCapable`, (r.zustand.faehig && r.zustand.faehig.wert) || 'unknown');
        await schreibe('demand.capableReason', ((r.zustand.faehig && r.zustand.faehig.grund) || '').slice(0, 500));

        const fehler = r.fehler;
        if (fehler) {
            await a.wertSchreiben(`${p}.state`, 'fault');
            await a.wertSchreiben(`${p}.reason`, texte.t('index.konfigFehler', { fehler }));
            await schreibe('state', 'fault');
            await schreibe('reason', texte.t('index.konfigFehler', { fehler }));
            return;
        }
        const online = r.letzteMeldung > 0 && jetzt - r.letzteMeldung <= OFFLINE_MS;

        // Fuehler
        const fu = await this.fuehlerWaehlen(r, jetzt);
        for (const [art, dp] of Object.entries(FUEHLER_DP)) {
            await schreibe(`sensors.${dp}`, fu[art].messung ? fu[art].messung.wert : null);
            await schreibe(`sensors.${dp}Source`, fu[art].text);
            await schreibe(`sensors.${dp}Status`, fu[art].stand);
            await schreibe(`sensors.${dp}Kind`, fu[art].quelle === 'intern' ? 'internal' : fu[art].quelle || '');
        }
        await schreibe('sensors.note', (fu.hinweise || []).join(' · ').slice(0, 500));

        // Wochenplan
        const planOpt = { ...this.einstellung.feiertage, abwesenheit: r.abwesenheit };
        const ps = r.plan ? wochenplan.stand(r.plan, jetzt, planOpt) : null;
        const szene = ps && ps.szene ? k.szenen.get(ps.szene) || null : null;
        await schreibe('schedule.level', szene ? szene.name : '');
        await schreibe('schedule.next', ps && ps.naechster ? ps.naechster.zeit : null);
        const naechste = ps && ps.naechster ? k.szenen.get(ps.naechster.szene) : null;
        await schreibe('schedule.nextLevel', naechste ? naechste.name : '');

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
            autor: Number.isFinite(e.autor) ? e.autor : e.autoe === true ? 1 : 0,
            ble: e.ble === true,
            schritt: (((this.adapter.geraete && this.adapter.geraete.get(id)) || {}).grenzen || {}).step,
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
        // Kann ein Handeingriff ueberhaupt etwas anhalten? Nur ein eingeschalteter, hinterlegter Plan.
        const planWartet = r.schalter.plan === true && !!r.plan;
        if (meldung && online) {
            const erwartet =
                r.schalter.plan && szene
                    ? szene.power
                        ? {
                              power: true,
                              mode: szene.mode,
                              target: Number.isFinite(r.zustand.koordinator.korrSoll)
                                  ? r.zustand.koordinator.korrSoll
                                  : szene.soll,
                              fan: szene.fan,
                          }
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
            // Eine Sperre gibt es nur, wenn wirklich etwas wartet: Der Handeingriff haelt allein Plan und
            // Szenen an (Feuchte, Schutz und Leistungsgrenze laufen weiter) - ohne eingeschalteten UND
            // hinterlegten Wochenplan gibt es nichts anzuhalten und auch keinen Hinweis auf der Karte.
            const automatik = planWartet;
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
        const gesperrt = jetzt < (r.zustand.hand.bis || 0) && planWartet;
        await schreibe('manual.locked', gesperrt);
        await schreibe('manual.until', gesperrt ? r.zustand.hand.bis : null);

        // Koordinator
        const richtung = bedarf.richtung({ power: sicht.power === true, mode: sicht.mode, heat: sicht.heat });
        const vortag =
            k.bedarf.strategie === 'vortag' && richtung
                ? await this.vortag(id, r, richtung === 'kuehlen' ? 'cooling' : 'heating')
                : null;
        const faehig = (r.zustand.faehig && r.zustand.faehig.wert) || 'unknown';
        const erg = koordinator.koordinieren(
            {
                status: sicht,
                internRaum: e.achome && jetzt - e.achome.zeit < 10 * 60000 ? Number(e.achome.wert) : null,
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
            gruende.unshift(texte.t('index.wochenplan', { fehler: r.planFehler }));
            // Noch kein Plan angelegt ist der Normalfall nach dem Einschalten - "setup", keine
            // Stoerung. Ein vorhandener, aber fehlerhafter Plan bleibt "fault".
            if (!r.planFehlt) {
                zustandText = 'fault';
            } else if (zustandText === 'ok') {
                zustandText = 'setup';
            }
        }
        await schreibe('schedule.missing', !!(r.schalter.plan && r.planFehlt));

        await schreibe('sensors.correction', erg.korrektur ? erg.korrektur.korr : 0);
        await schreibe('sensors.target', erg.korrektur ? erg.korrektur.ziel : null);

        // Feuchte-Anzeige
        await schreibe('humidity.dewPoint', erg.feuchte.taupunkt);
        await schreibe('humidity.margin', erg.feuchte.abstand);
        await schreibe('humidity.intervention', erg.feuchte.bedarf && erg.feuchte.massnahme !== 'melden');
        await schreibe('humidity.reason', erg.feuchte.grund);

        // Senden: Szenenfelder
        if (!online) {
            zustandText = 'offline';
            gruende.unshift(texte.t('index.offline'));
        } else if (Object.keys(erg.wunsch).length) {
            // Mit Zielband fuehrt das MODUL den Sollwert der Anlage (er pendelt dann absichtlich weit um
            // das Ziel). Ein eigener temp-Befehl wuerde dagegen arbeiten - das Ziel steckt im Band.
            const wunsch = { ...erg.wunsch };
            const bandAktiv =
                (erg.control && erg.control.target) ||
                (r.zustand.control &&
                    r.zustand.control.text.includes('target') &&
                    jetzt - r.zustand.control.zeit < 660000);
            if (bandAktiv) {
                delete wunsch.target;
            }
            const plan = sender.planen({ wunsch, status: sicht, zustand: r.zustand.sender, jetzt });
            r.zustand.sender = plan.zustand;
            if (Object.keys(plan.befehle).length) {
                await this.felderSenden(id, r, plan.befehle, probelauf, jetzt);
            }
            if (plan.grund) {
                gruende.push(
                    texte.t('index.senden', {
                        grund: `${plan.grund}${probelauf ? ` ${texte.t('index.probelauf')}` : ''}`,
                    }),
                );
            }
            if (plan.abgelehnt.length && zustandText === 'ok') {
                zustandText = 'fault';
            }
        }

        // Senden: Leistungsgrenze
        const b = erg.bedarf;
        let sendungWartet = null;
        let bedarfZustand = b.zustand;
        let bedarfGrund = b.grund + (b.konflikt ? ` | ${b.konflikt}` : '');
        if (erg.bedarfRuht) {
            bedarfZustand = 'neutral';
            bedarfGrund = texte.t('index.ruhtAuto');
        } else if (faehig === 'no') {
            bedarfZustand = 'notCapable';
            bedarfGrund = texte.t('index.nichtFaehig');
        } else if (!r.aktiv) {
            bedarfZustand = 'off';
            bedarfGrund = `${texte.t('index.regelungAus')} | ${bedarfGrund}`;
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
            await a.wertSchreiben(`${p}.commandsPerHour`, ent.befehleStunde);
            // noch nicht gesendet: die Einstellungsseite sagt das neben dem Rechenweg (sonst stuende dort
            // ein Wert, den die Anlage noch gar nicht hat - Volltest 21.11.2026)
            sendungWartet = ent.wartet ? ent.grund : null;
            if (ent.aktion === 'wuerde' || ent.aktion === 'senden') {
                const eintrag = {
                    wert: ent.wert,
                    zeit: new Date(jetzt).toISOString(),
                    aktion: ent.aktion,
                    ist: e.demand ?? null,
                };
                await a.wertSchreiben(`${p}.wouldSend`, JSON.stringify(nutzlast.schreiben('befehl', eintrag)));
                r.zustand.verlauf = zustandSpeicher.verlaufAnhaengen(r.zustand.verlauf, ent.wert, jetzt);
                await schreibe('historyJson', JSON.stringify(r.zustand.verlauf));
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
                bedarfGrund = `${bedarfGrund} | ${texte.t('index.szeneBegrenzt', { wert: erg.demand })}`;
            }
            bedarfGrund = `${bedarfGrund} | ${ent.grund}${probelauf ? ` ${texte.t('index.probelauf')}` : ''}`;
        }
        // Rechenweg fuer die Einstellungsseite (regelArbeitspunkt): nur im Speicher, je Durchlauf neu
        r.weg = {
            ...(faehig === 'no' ? { art: 'nichtFaehig' } : erg.weg || { art: 'neutral' }),
            aus: !r.aktiv,
            probelauf: probelauf === true,
            ...(sendungWartet ? { wartet: sendungWartet } : {}),
            zeit: jetzt,
        };
        await a.wertSchreiben(`${p}.setpoint`, r.aktiv && erg.demand !== null ? erg.demand : b.sollwert);
        await a.wertSchreiben(`${p}.rawValue`, b.rohwert);
        await a.wertSchreiben(`${p}.outsideMean`, b.aussenMittel);
        await a.wertSchreiben(`${p}.state`, bedarfZustand);
        await a.wertSchreiben(`${p}.reason`, bedarfGrund.slice(0, 500));

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
        await schreibe('state', aus ? 'off' : zustandText);
        await schreibe('reason', (aus ? texte.t('index.regelungAus') : gruende.join(' · ')).slice(0, 800));
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
            await this.adapter.setStateAsync(`${id}.${ZWEIG}.stateJson`, { val: textNeu, ack: true });
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
        await a.wertSchreiben(`${id}.${WURZEL}.lastCommand`, JSON.stringify(nutzlast.schreiben('befehl', eintrag)));
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
    VORLAGEN_FELDER,
    DATENPUNKTE,
    DATENPUNKTE_REGEL,
    KANAELE,
    SCHALTER,
    ZWEIG,
    WURZEL,
    objekteAnlegen,
    probelaufWirksam,
    probelaufAnzeigen,
    tagVon,
};
