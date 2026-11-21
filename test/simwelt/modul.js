'use strict';

/*
 * Nachbildung der Faikout-Firmware (RevK, ESP32) fuer EIN Modul samt der Klimaanlage dahinter.
 *
 * Das Modul spricht ueber eine Transportschnittstelle `{publish(topic, payload, {retain})}` und
 * bekommt eingehende Nachrichten ueber empfangen(topic, payload). Es hat keine eigene Uhr und
 * keine Timer: tick() ist ein Durchlauf der Hauptschleife (in der Firmware 1 s, Faikout.c Z. 3613).
 *
 * Belegt aus der Firmware (Zeilen aus ESP/main/Faikout.c, sofern nicht anders genannt):
 *  - Topics: revk_topic() revk.c Z. 1174 -> <art>/<hostname>[/<suffix>]; das Modul hoert auf seinen
 *    Hostnamen, seine ID und "Faikout" (revk.c Z. 1216).
 *  - state/<Name> (retained): Lebenszeichen der Bibliothek (revk.c Z. 2662) + revk_state_extra Z. 3222.
 *  - state/<Name>/status (retained): daikin_status Z. 1784, nur bei livestatus, Statusbericht oder
 *    Aenderung einer Einstellung der Anlage (Z. 4112).
 *  - Faikout/<Name>: Sammelbericht je `reporting` Sekunden mit [min, mittel, max] (Z. 4517).
 *  - command/<Name>[/<suffix>]: mqtt_client_callback Z. 1574, daikin_control Z. 1474.
 *  - command/<Name>/control: Z. 1599 - fehlende Felder bleiben NAN, tcontrol Z. 4418.
 *  - setting/<Name>[/<feld>]: revk.c Z. 1378/1437, gespeichert wird nur ein GEAENDERTER Wert
 *    (settings_lib.c Z. 1701); eine nicht-live Einstellung startet das Modul nach 3 s neu (Z. 1903).
 *  - error/<Name>/failed-set: Z. 4138 - nach mehr als s21.tries Runden mit offener Aenderung.
 *  - Faikout-Auto: Z. 3741 (Band aus autot/autor), Z. 4196-4480 (Regelung).
 *
 * Vereinfacht (bewusst):
 *  - Die Anlage antwortet im selben Durchlauf, in dem das Modul sendet (echt: eine Runde spaeter).
 *  - Kein Frostschutz (frosttemp), kein fanrun, keine BLE-Fernbedienung (nur BLE-Fuehler), kein
 *    autotopic, kein Passwort, kein OTA; b.startup ("Setting cannot be controlled") entfaellt.
 *  - Ein Neustart des Moduls laeuft ueber dieselbe MQTT-Verbindung (up:false, Pause, Neuanmeldung).
 *  - Einstellungen der Bibliothek (hostname, mqtthost ...) kennt das Modul nicht ("Not found").
 */

const FAN = 'A12345Q';
const FAN_NAMEN = ['auto', 'low', 'lowMedium', 'medium', 'mediumHigh', 'high', 'night']; // Z. 149
const MODI = 'FHCA456D';
const MODUS_NAMEN = ['fan_only', 'heat', 'cool', 'heat_cool', '4', '5', '6', 'dry']; // Z. 3284
const VERSION = 'sim00001';
const BUILD = '2026-11-20T00:00:00';
const HARDWARE = '-S3-MINI-N4-R2';

// accontrols.m
const STEUER = {
    power: 'b',
    mode: 'e',
    temp: 't',
    demand: 'i',
    fan: 'e',
    swingh: 'b',
    swingv: 'b',
    econo: 'b',
    powerful: 'b',
    comfort: 'b',
    streamer: 'b',
    sensor: 'b',
    led: 'b',
    quiet: 'b',
    humidify: 'e',
};
const WERTE = { mode: MODI, fan: FAN, humidify: 'XLSHC' };
// acfields.m (ohne die Stellgroessen)
const STATUS = {
    online: 'b',
    control: 'b',
    model: 's',
    home: 't',
    heat: 'b',
    slave: 'b',
    antifreeze: 'b',
    flap: 'b',
    fanrpm: 'i',
    comp: 'i',
    outside: 't',
    inlet: 't',
    liquid: 't',
    anglev: 'i',
    hum: 't',
    Whoutside: 'i',
    Whheating: 'i',
    Whcooling: 'i',
    consumption: 'i',
};
// acextras.m: env, target, acfields, accontrols
const ALLE = { env: 't', target: 'r', ...STATUS, ...STEUER };

// settings.def: Typ, live?, Nachkommastellen. Nur was Adapter anfassen oder die Logik braucht.
const EINSTELLUNGEN = {
    livestatus: ['bit', true],
    fixstatus: ['bit', false],
    s21tries: ['zahl', true, 0],
    reporting: ['zahl', false, 0],
    thermref: ['zahl', true, 0],
    switchtemp: ['zahl', true, 1],
    pushtemp: ['zahl', true, 1],
    coolover: ['zahl', true, 0],
    coolback: ['zahl', true, 0],
    heatover: ['zahl', true, 0],
    heatback: ['zahl', true, 0],
    minoutside: ['zahl', true, 0],
    frosttemp: ['zahl', true, 0],
    temptrack: ['bit', true],
    tempadjust: ['bit', true],
    tempnoflap: ['zahl', true, 0],
    bleenable: ['bit', false],
    autob: ['text', true],
    autoe: ['bit', true],
    auto0: ['hhmm', true],
    auto1: ['hhmm', true],
    autot: ['zahl', true, 1],
    autor: ['zahl', true, 1],
    autop: ['bit', true],
    autofmax: ['zahl', true, 0],
    autoptemp: ['zahl', true, 1],
    thermostat: ['bit', true],
    lockmode: ['bit', false],
    tmin: ['zahl', true, 0],
    tcoolmin: ['zahl', true, 0],
    tmax: ['zahl', true, 0],
    theatmax: ['zahl', true, 0],
    tpredicts: ['zahl', false, 0],
    tpredictt: ['zahl', false, 0],
    tsample: ['zahl', false, 0],
    tcontrol: ['zahl', false, 0],
    nodemand: ['bit', false],
    noauto: ['bit', false],
    noecono: ['bit', false],
    noswingv: ['bit', false],
    noswingh: ['bit', false],
    nocomfort: ['bit', false],
    nostreamer: ['bit', false],
    nopowerful: ['bit', false],
    nosensor: ['bit', false],
    noquiet: ['bit', false],
    noled: ['bit', false],
    nohumidify: ['bit', false],
    nohvacaction: ['bit', false],
    nofanauto: ['bit', false],
    nohomepreset: ['bit', false],
    nofaikoutauto: ['bit', true],
    haenable: ['bit', false],
    haswitches: ['bit', false],
    ha1c: ['bit', false],
    haperiodic: ['bit', false],
    fantype: ['zahl', false, 0],
};
const EINSTELLUNG_VORGABE = {
    livestatus: false,
    fixstatus: false,
    s21tries: 10,
    reporting: 60,
    thermref: 50,
    switchtemp: 0.5,
    pushtemp: 0.1,
    coolover: 6,
    coolback: 6,
    heatover: 6,
    heatback: 6,
    minoutside: -100,
    frosttemp: -100,
    temptrack: false,
    tempadjust: true,
    tempnoflap: 0,
    bleenable: false,
    autob: '',
    autoe: true,
    auto0: 0,
    auto1: 0,
    autot: 0,
    autor: 0,
    autop: false,
    autofmax: 5,
    autoptemp: 0.5,
    thermostat: false,
    lockmode: false,
    tmin: 16,
    tcoolmin: 16,
    tmax: 32,
    theatmax: 32,
    tpredicts: 30,
    tpredictt: 120,
    tsample: 900,
    tcontrol: 600,
    nodemand: false,
    noauto: false,
    noecono: false,
    noswingv: false,
    noswingh: false,
    nocomfort: false,
    nostreamer: false,
    nopowerful: false,
    nosensor: false,
    noquiet: false,
    noled: true,
    nohumidify: true,
    // Ab Werk steht no.hvacaction auf 1 (settings.def); der Simulator meldet `action` trotzdem,
    // weil die Regelmodule und die bestehende Attrappe (test/sim/simulator.js) damit arbeiten.
    nohvacaction: false,
    nofanauto: false,
    nohomepreset: false,
    nofaikoutauto: false,
    haenable: true,
    haswitches: false,
    ha1c: false,
    haperiodic: false,
    fantype: 0,
};

const S21_FELDER = [
    'online',
    'power',
    'mode',
    'temp',
    'fan',
    'swingh',
    'swingv',
    'econo',
    'powerful',
    'comfort',
    'streamer',
    'sensor',
    'quiet',
    'demand',
    'heat',
    'home', // kein inlet: den meldet nur das X50A-Protokoll (Faikout.c Z. 1014)
    'outside',
    'liquid',
    'comp',
    'fanrpm',
    'Whoutside',
    'Whheating',
    'Whcooling',
    'consumption',
    'model',
];
/**
 * Geraetetypen. `felder` = was die Anlage zurueckmeldet (daraus entsteht status_known),
 * `nimmt` = welche Stellgroessen sie uebernimmt.
 */
const TYPEN = {
    // (a) Daikin am S21-Bus, uebernimmt demand und meldet es zurueck.
    s21: { protokoll: 'S21', felder: S21_FELDER, nimmt: S21_FELDER, nimmtDemand: 'immer', model: 'FTXM35R' },
    // (b) Daikin, die demand quittiert, aber nie uebernimmt (Anlage 1OG, gemessen 05.11.2026).
    nodemand: { protokoll: 'S21', felder: S21_FELDER, nimmt: S21_FELDER, nimmtDemand: 'nie', model: 'FTXA25B' },
    // (c) TCL an der IR-Bruecke: Einweg, keine Fuehler, kein demand, kein outside. Das Modul
    // "liest" nur zurueck, was es selbst gesendet hat (ANNAHME - die Laborfirmware liegt nicht vor).
    tcl: {
        protokoll: 'IR',
        felder: ['online', 'power', 'mode', 'temp', 'fan', 'swingv'],
        nimmt: ['power', 'mode', 'temp', 'fan', 'swingv'],
        nimmtDemand: 'nie',
        einweg: true,
        model: '',
    },
};

const HVAC = {
    off: 'off',
    heizen: 'heating',
    kuehlen: 'cooling',
    trocknen: 'drying',
    luefter: 'fan',
    ruhe: 'idle',
    abtauen: 'defrosting',
};

/** JSON-Schreiber wie jo.c: Literale behalten ihre Schreibweise ("21.50"), nan wird null (jo.c Z. 647). */
class Jo {
    /** @param {Record<string, unknown>} [ersatz] Felder, deren Wert verfaelscht wird (Szenario) */
    constructor(ersatz) {
        this.teile = [];
        this.ersatz = ersatz || {};
    }
    /**
     * Literal anhaengen.
     *
     * @param {string} k Name
     * @param {string} s Literal in JSON-Schreibweise
     * @returns {Jo} this
     */
    lit(k, s) {
        let w = s;
        if (k in this.ersatz) {
            w = JSON.stringify(this.ersatz[k]);
        } else if (!w || /^-?(nan|inf|NaN|Infinity)$/.test(w)) {
            w = 'null';
        }
        this.teile.push(`${JSON.stringify(k)}:${w}`);
        return this;
    }
    /**
     * Zahl mit fester Stellenzahl (printf %.Nf).
     *
     * @param {string} k Name
     * @param {number} x Wert
     * @param {number} stellen Nachkommastellen
     * @returns {Jo} this
     */
    zahl(k, x, stellen) {
        return this.lit(k, Number.isFinite(x) ? x.toFixed(stellen) : 'nan');
    }
    /**
     * Ganzzahl.
     *
     * @param {string} k Name
     * @param {number} x Wert
     * @returns {Jo} this
     */
    ganz(k, x) {
        return this.lit(k, Number.isFinite(x) ? String(Math.trunc(x)) : 'nan');
    }
    /**
     * Wahrheitswert.
     *
     * @param {string} k Name
     * @param {unknown} b Wert
     * @returns {Jo} this
     */
    bool(k, b) {
        return this.lit(k, b ? 'true' : 'false');
    }
    /**
     * Zeichenkette.
     *
     * @param {string} k Name
     * @param {unknown} s Wert
     * @returns {Jo} this
     */
    text(k, s) {
        return this.lit(k, JSON.stringify(String(s)));
    }
    /**
     * Fertiges Objekt.
     *
     * @returns {string} JSON-Text
     */
    ende() {
        return `{${this.teile.join(',')}}`;
    }
}

const zeitstempel = ms => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const hhmmText = n => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
const ortszeit = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/** Ein Faikout-Modul mit Anlage. */
class Modul {
    /**
     * @param {object} opt Aufbau
     * @param {string} opt.name Hostname des Moduls (= Name in den Topics; fuer faikout-ac ohne Leerzeichen)
     * @param {string} [opt.id] 12 Hex-Zeichen (revk_id)
     * @param {'s21'|'nodemand'|'tcl'} [opt.typ] Geraetetyp
     * @param {import('./physik').Physik} opt.physik Raum und Anlage
     * @param {{publish: (topic: string, payload: string, opt: {retain: boolean}) => void}} opt.transport Ausgang
     * @param {() => number} [opt.uhr] Wanduhr des Moduls (ms)
     * @param {object} [opt.einstellungen] Abweichungen von den Werkseinstellungen (settings.def)
     * @param {object} [opt.anlage] Startzustand der Anlage (power, mode, temp ...)
     * @param {'immer'|'nie'|'nurEin'} [opt.nimmtDemand] ueberschreibt den Typ
     * @param {boolean} [opt.abtauMeldung] Anlage meldet `antifreeze` -> action "defrosting" (S21 tut das nicht, Z. 1043)
     * @param {boolean} [opt.feuchteFuehler] Anlage meldet `hum`
     * @param {boolean} [opt.austrittSensor] zusaetzliches Feld `simoutlet`: simulierter Sensor am Luftaustritt
     * @param {number} [opt.bootSek] Dauer eines Neustarts
     */
    constructor(opt) {
        this.name = opt.name;
        this.id = (opt.id || '0A0B0C000001').toUpperCase();
        this.typ = opt.typ || 's21';
        this.art = TYPEN[this.typ];
        if (!this.art) {
            throw new Error(`unknown device type "${this.typ}"`);
        }
        this.physik = opt.physik;
        this.transport = opt.transport;
        this.uhr = opt.uhr || (() => Date.now());
        this.e = { ...EINSTELLUNG_VORGABE, ...(opt.einstellungen || {}) };
        this.nimmtDemand = opt.nimmtDemand || this.art.nimmtDemand;
        this.abtauMeldung = !!opt.abtauMeldung;
        this.feuchteFuehler = !!opt.feuchteFuehler;
        this.austrittSensor = !!opt.austrittSensor;
        this.bootSek = opt.bootSek ?? 6;
        // Die Anlage selbst (was die Fernbedienung zeigen wuerde)
        this.ac = {
            power: false,
            mode: 'H',
            temp: 21,
            demand: 100,
            fan: 'A',
            swingh: false,
            swingv: false,
            econo: false,
            powerful: false,
            comfort: false,
            streamer: false,
            sensor: false,
            quiet: false,
            ...(opt.anlage || {}),
        };
        this.zaehler = {
            befehle: {},
            flash: 0,
            flashNach: {},
            failedSet: 0,
            failedSetNach: {},
            fehler: 0,
            neustarts: 0,
            gesendet: 0,
            klartext: 0,
            nativ: 0,
            verbindungsabrisse: 0,
        };
        this.ble = { verbunden: false, bat: 87, versatz: 0 };
        this.verbunden = false;
        this.stumm = false; // verbunden, sendet aber nichts (Szenario "Meldungen bleiben aus")
        this.unsinn = {}; // Feld -> verfaelschter Rohwert in den Statusmeldungen
        this.neustartIn = 0;
        this.neustartGrund = '';
        this.bootRest = 0;
        this.anlageAbgleichen();
        this.hochfahren();
    }

    /** Zustand der Firmware nach dem Einschalten (struct daikin, Z. 300 ff.). */
    hochfahren() {
        this.uptime = 0;
        this.d = { env: NaN, home: NaN, inlet: NaN, outside: NaN, liquid: NaN, hum: NaN, temp: NaN, model: '' };
        this.bekannt = new Set();
        this.geaendert = new Set(); // control_changed
        this.versuche = 0; // control_count
        this.statusGeaendert = false;
        this.statusBericht = false;
        this.modusGeaendert = false;
        this.haSenden = false;
        this.upNext = 0;
        this.ersteMeldung = true;
        this.mintarget = NaN;
        this.maxtarget = NaN;
        this.controlvalid = 0;
        this.remote = false;
        this.action = HVAC.off;
        this.hysteresis = 0;
        this.fansaved = 0;
        this.sample = 0;
        this.z = { an: 0, anAlt: 0, jen: 0, jenAlt: 0, ges: 0, gesAlt: 0 }; // countApproaching/Beyond/Total
        this.lastheat = null;
        this.envPrev = 0;
        this.envDelta = 0;
        this.envDeltaPrev = 0;
        this.predictLast = 0;
        this.autoLast = 0;
        this.flap = 0;
        this.lastaction = '';
        this.lastset = 0;
        this.berichtLast = Math.floor(this.uhr() / 1000 / Math.max(1, this.e.reporting));
        this.stat = {};
        this.statAnzahl = 0;
        this.gesendetIr = { online: true, ...this.ac }; // Einweg-Geraet: letzter gesendeter Stand
    }

    // ------------------------------------------------------------------ Verbindung

    /** @returns {{topic: string, payload: string, retain: boolean}} Testament wie revk.c Z. 1537 */
    lwt() {
        return { topic: `state/${this.name}`, payload: '{"up":false,"reason":"LWT"}', retain: true };
    }

    /** @returns {string} MQTT-Client-ID wie revk.c Z. 1549 */
    clientId() {
        return this.name === this.id ? `Faikout:${this.name}` : `Faikout:${this.name}_${this.id.slice(6)}`;
    }

    /** @returns {string[]} Abos wie revk.c Z. 1216 */
    abos() {
        const ziele = [...new Set([this.id, 'Faikout', this.name])];
        return ['command', 'setting'].flatMap(art => ziele.map(z => `${art}/${z}/#`));
    }

    /** MQTT steht (revk.c Z. 1484): Statusbericht und Discovery anfordern (Z. 1581). */
    verbinden() {
        this.verbunden = true;
        this.statusBericht = true;
        this.haSenden = true;
        this.upNext = 0;
        this.ersteMeldung = true;
    }

    /** Verbindung reisst ab - das Modul merkt es, sendet aber nichts mehr (das Testament schickt der Broker). */
    abriss() {
        if (this.verbunden) {
            this.zaehler.verbindungsabrisse++;
        }
        this.verbunden = false;
    }

    /**
     * Veroeffentlichen - nur wenn verbunden und nicht stumm.
     *
     * @param {string} topic Topic
     * @param {string} payload Nutzlast
     * @param {boolean} [retain] retained
     */
    sende(topic, payload, retain = false) {
        if (!this.verbunden || this.stumm) {
            return;
        }
        this.zaehler.gesendet++;
        this.transport.publish(topic, payload, { retain });
    }

    /**
     * Neustart einplanen (revk_restart).
     *
     * @param {number} sek Verzoegerung
     * @param {string} grund Text fuer "reason"
     */
    neustart(sek, grund) {
        if (!this.neustartIn) {
            this.neustartIn = sek;
            this.neustartGrund = grund;
            this.upNext = 0; // restart_time laesst das Lebenszeichen sofort neu senden (revk.c Z. 2658)
        }
    }

    // ------------------------------------------------------------------ Anlage

    /** Stellgroessen der Anlage an die Physik durchreichen. */
    anlageAbgleichen() {
        const a = this.ac;
        Object.assign(this.physik.stell, {
            power: a.power,
            mode: a.mode,
            temp: a.temp,
            demand: a.demand,
            fan: a.fan,
            econo: a.econo,
            powerful: a.powerful,
            quiet: a.quiet,
        });
    }

    /**
     * Jemand bedient die Anlage direkt (Fernbedienung) - Status aendert sich ohne Befehl.
     *
     * @param {object} setze z. B. {temp: 23} oder {power: false}
     */
    handeingriff(setze) {
        Object.assign(this.ac, setze);
        this.anlageAbgleichen();
    }

    /**
     * Modul sendet offene Aenderungen an die Anlage; die uebernimmt - oder eben nicht.
     */
    anlageSchreiben() {
        for (const feld of this.geaendert) {
            const wert = this.d[feld];
            if (!this.art.nimmt.includes(feld)) {
                continue;
            }
            if (feld === 'demand') {
                // ANNAHME: uebernommen werden ganze Prozent von 30 bis 100.
                const ok = this.nimmtDemand === 'immer' || (this.nimmtDemand === 'nurEin' && this.ac.power);
                if (!ok || !(wert >= 30 && wert <= 100)) {
                    continue;
                }
            }
            if (feld === 'temp' && !(wert >= 10 && wert <= 32)) {
                continue;
            }
            this.ac[feld] = wert;
            if (feld === 'powerful' && wert) {
                this.ac.econo = false; // die Anlage kennt nur eines von beiden
            }
            if (feld === 'econo' && wert) {
                this.ac.powerful = false;
            }
            if (this.art.einweg) {
                this.gesendetIr[feld] = wert;
            }
        }
        this.anlageAbgleichen();
    }

    /** @returns {Record<string, unknown>} was die Anlage auf Anfrage liefert */
    anlageLesen() {
        if (this.art.einweg) {
            const r = {};
            for (const f of this.art.felder) {
                r[f] = this.gesendetIr[f];
            }
            return r;
        }
        const m = this.physik.messwerte();
        const a = this.ac;
        const alles = { online: true, heat: a.mode === 'H', model: this.art.model, ...a, ...m }; // heat: Z. 613
        const r = {};
        for (const f of this.art.felder) {
            r[f] = alles[f];
        }
        if (this.feuchteFuehler) {
            r.hum = m.hum;
        }
        if (this.abtauMeldung) {
            r.antifreeze = m.antifreeze;
        }
        return r;
    }

    // ------------------------------------------------------------------ set_* / daikin_set_*

    /**
     * Wert von der Anlage (set_uint8/set_int/set_float, Z. 448-524).
     *
     * @param {string} feld Name
     * @param {unknown} val Wert
     */
    melde(feld, val) {
        const art = ALLE[feld];
        if (!this.bekannt.has(feld)) {
            this.bekannt.add(feld);
            this.statusGeaendert = true;
            this.haSenden = true;
        }
        const alt = this.d[feld];
        const gleich =
            art === 't'
                ? (Number.isNaN(alt) && Number.isNaN(val)) || Math.round(alt * 10) === Math.round(val * 10)
                : alt === val;
        if (gleich) {
            if (this.geaendert.has(feld)) {
                this.geaendert.delete(feld);
                this.statusGeaendert = true;
            }
        } else if (!this.geaendert.has(feld)) {
            this.d[feld] = val;
            if (art === 'i') {
                if (Math.trunc((alt || 0) / 10) !== Math.trunc(val / 10)) {
                    this.statusGeaendert = true;
                }
            } else {
                this.statusGeaendert = true;
                if (art !== 't' || feld === 'temp') {
                    this.modusGeaendert = true;
                }
            }
        }
    }

    /**
     * Stellwert setzen (daikin_set_value/int/enum/temp, Z. 374-446).
     *
     * @param {string} feld Name
     * @param {unknown} wert Wert
     * @returns {string|null} Fehlertext
     */
    setze(feld, wert) {
        const art = STEUER[feld];
        let w = wert;
        if (art === 'e') {
            if (!w) {
                return 'No value';
            }
            if (String(w).length > 1) {
                return 'Value is meant to be one character';
            }
            if (!WERTE[feld].includes(w)) {
                return 'Value is not a valid value';
            }
        }
        if (this.d[feld] === w) {
            return null;
        }
        if (art === 't' && this.art.protokoll === 'S21') {
            w = Math.round(w * 2) / 2; // S21 kennt nur halbe Grad (Z. 434)
        }
        this.d[feld] = w;
        this.geaendert.add(feld);
        this.modusGeaendert = true;
        return null;
    }

    /**
     * Luefterstufe ueber ihre Nummer setzen (0 = auto ... 6 = night).
     *
     * @param {number} n Stufe
     * @returns {string|null} Fehlertext
     */
    setzeLuefter(n) {
        return this.setze('fan', FAN[n]);
    }

    // ------------------------------------------------------------------ Eingang

    /**
     * Eingehende MQTT-Nachricht (mqtt_rx, revk.c Z. 1245-1482).
     *
     * @param {string} topic Topic
     * @param {Buffer|string} payload Nutzlast
     */
    empfangen(topic, payload) {
        if (!this.verbunden || this.bootRest > 0) {
            return;
        }
        const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
        const teile = String(topic).split('/');
        const prefix = teile[0];
        if ((prefix !== 'command' && prefix !== 'setting') || ![this.name, this.id, 'Faikout'].includes(teile[1])) {
            return;
        }
        let suffix = teile.length > 2 ? teile.slice(2).join('/') : null;
        const schluessel = suffix ? `${prefix}/${suffix}` : prefix;
        this.zaehler.befehle[schluessel] = (this.zaehler.befehle[schluessel] || 0) + 1;

        let j;
        let hat = false;
        let err = null;
        if (text.length) {
            hat = true;
            if (!'"{['.includes(text[0])) {
                if (prefix === 'setting' && suffix) {
                    j = { [suffix]: text }; // revk.c Z. 1380: der Suffix ist die Einstellung
                    suffix = null;
                } else if (text === 'true' || text === 'false') {
                    j = text === 'true';
                } else if (/^-?\d+(\.\d+)?$/.test(text)) {
                    j = Number(text);
                } else {
                    j = text;
                }
            } else {
                try {
                    j = JSON.parse(text);
                } catch {
                    err = 'Bad JSON';
                }
            }
        }
        let ort = null;
        if (!err) {
            if (prefix === 'command') {
                // revk_command (revk.c Z. 5786)
                if (suffix === 'status') {
                    this.upNext = 0;
                    err = '';
                } else if (suffix === 'restart') {
                    this.neustart(3, 'Restart command');
                    err = '';
                }
                const e2 = this.befehl(suffix, j, hat);
                if (e2 !== null && (e2 !== '' || err === null)) {
                    err = e2;
                }
            } else {
                err = '';
                if ((!suffix && !hat) || suffix === '*' || suffix === '**' || suffix === '-') {
                    // Ausgabe aller Einstellungen - bildet der Simulator nicht nach.
                } else {
                    const r = this.speichern(j);
                    err = r.fehler || '';
                    ort = r.ort || null;
                }
            }
        }
        if (err === null) {
            err = 'Unknown'; // revk.c Z. 1459
        }
        if (err) {
            const e = new Jo().text('ts', zeitstempel(this.uhr())).text('description', err).text('prefix', prefix);
            if (suffix) {
                e.text('suffix', suffix);
            }
            if (ort) {
                e.text('location', ort);
            } else if (hat) {
                e.text('payload', text);
            }
            this.zaehler.fehler++;
            this.sende(`error/${this.name}/${suffix || prefix}`, e.ende());
        }
    }

    /**
     * mqtt_client_callback (Z. 1574-1780).
     *
     * @param {string|null} suffix Unterpfad hinter command/<Name>/
     * @param {unknown} j Nutzlast (schon als JSON gelesen)
     * @param {boolean} hat Nutzlast vorhanden
     * @returns {string|null} null = nicht zustaendig, '' = erledigt, sonst Fehlertext
     */
    befehl(suffix, j, hat) {
        if (!suffix) {
            return this.steuern(j);
        }
        if (suffix === 'reconnect') {
            return '';
        }
        if (suffix === 'control') {
            return this.kontrolle(j);
        }
        const s = {};
        if (!hat) {
            const grob = {
                on: ['power', true],
                off: ['power', false],
                auto: ['mode', 'A'],
                heat: ['mode', 'H'],
                cool: ['mode', 'C'],
                dry: ['mode', 'D'],
                fan: ['mode', 'F'],
                low: ['fan', '1'],
                medium: ['fan', '3'],
                high: ['fan', '5'],
            }[suffix];
            if (grob) {
                s[grob[0]] = grob[1];
            }
        } else {
            const value = typeof j === 'object' && j !== null ? '' : String(j).slice(0, 19);
            const ja = /^(on|true)$/i.test(value) || value === '1'; // checkbool, Z. 1699
            const e = this.e;
            if (suffix === 'temp') {
                if (e.autoe && e.autor) {
                    // Das Modul regelt selbst: die Solltemperatur ist dann autot - ein Flash-Schreiben (Z. 1691).
                    this.speichern({ autot: (parseFloat(value) || 0).toFixed(1) });
                } else if (Number.isFinite(Number(value)) && value !== '') {
                    s.temp = Number(value);
                }
            }
            if (suffix === 'mode') {
                s.power = value !== 'off';
                if (value === 'heat_cool') {
                    s.mode = 'A';
                } else if (value[0] !== 'o') {
                    s.mode = (value[0] || '').toUpperCase();
                }
            }
            if (suffix === 'fan') {
                const i = FAN_NAMEN.indexOf(value);
                s.fan = i >= 0 ? FAN[i] : value[0] || ''; // lookup_fan_mode, Z. 253
            }
            if (suffix === 'swing') {
                if (value === 'C' || value === 'H+C') {
                    s.comfort = true;
                    if (!e.noswingh) {
                        s.swingh = value === 'H+C';
                    }
                } else {
                    if (!e.nocomfort && this.bekannt.has('comfort')) {
                        s.comfort = false;
                    }
                    if (!e.noswingh) {
                        s.swingh = ['H', 'H+V', 'on'].includes(value);
                    }
                    if (!e.noswingv) {
                        s.swingv = ['V', 'H+V', 'on'].includes(value);
                    }
                }
            }
            if (suffix === 'preset') {
                s.econo = value[0] === 'e';
                s.powerful = value[0] === 'b';
            }
            if (suffix === 'demand') {
                s.demand = parseInt(value, 10) || 0; // atoi
            }
            if (
                ['sensor', 'econo', 'powerful', 'quiet', 'comfort', 'power', 'streamer', 'autoe', 'led'].includes(
                    suffix,
                )
            ) {
                s[suffix] = ja;
            }
        }
        return Object.keys(s).length ? this.steuern(s) : null;
    }

    /**
     * daikin_control (Z. 1474-1548): JSON mit Stellgroessen und gespeicherten Auto-Einstellungen.
     *
     * @param {unknown} j Objekt
     * @returns {string} '' oder Fehlertext
     */
    steuern(j) {
        if (!j || typeof j !== 'object' || Array.isArray(j)) {
            return '';
        }
        const ablage = {};
        for (const [tag, v] of Object.entries(j)) {
            let err = null;
            const art = STEUER[tag];
            const val = typeof v === 'object' ? '' : String(v);
            if (art === 'b' && typeof v === 'boolean') {
                err = this.setze(tag, v);
            } else if (art === 't' && typeof v === 'number') {
                err = this.setze(tag, v);
            } else if (art === 'i' && typeof v === 'number') {
                err = this.setze(tag, Math.trunc(v));
            } else if (art === 'e' && typeof v === 'string') {
                err = this.setze(tag, v);
            }
            if ((tag === 'auto0' || tag === 'auto1') && val.length >= 5) {
                ablage[tag] = parseInt(val, 10) * 100 + parseInt(val.slice(3), 10);
            }
            if (tag === 'autob') {
                ablage[tag] = val;
            }
            if (tag === 'autop') {
                ablage[tag] = val[0] === 't';
            }
            if (tag === 'autoe') {
                ablage[tag] = val[0] === 't';
                this.statusGeaendert = true;
            }
            if (tag === 'autot' || tag === 'autor') {
                ablage[tag] = val.replace(/(\.\d)\d+$/, '$1'); // eine Nachkommastelle (Z. 1526)
                this.statusGeaendert = true;
            }
            if (err) {
                this.zaehler.fehler++;
                this.sende(
                    `error/${this.name}/control`,
                    new Jo().text('ts', zeitstempel(this.uhr())).text('field', tag).text('error', err).ende(),
                );
                return err;
            }
        }
        if (Object.keys(ablage).length) {
            this.speichern(ablage);
        }
        return '';
    }

    /**
     * command/<Name>/control (Z. 1599-1668): Raumwert und Zielband von aussen.
     *
     * @param {unknown} j {env, target: Zahl | [min, max], margin, dazu Stellgroessen}
     * @returns {string} '' oder Fehlertext
     */
    kontrolle(j) {
        let env = NaN;
        let min = NaN;
        let max = NaN;
        let margin = NaN;
        let ret = null;
        const zahl = v => (typeof v === 'object' ? 0 : parseFloat(String(v)) || 0); // strtof
        for (const [tag, v] of Object.entries(j && typeof j === 'object' && !Array.isArray(j) ? j : {})) {
            if (tag === 'env') {
                env = zahl(v);
            } else if (tag === 'margin') {
                margin = zahl(v);
            } else if (tag === 'target') {
                if (Array.isArray(v)) {
                    if (typeof v[0] === 'number') {
                        min = v[0];
                        if (typeof v[1] === 'number') {
                            max = v[1];
                        }
                    }
                    if ((!this.e.autoe || !this.e.autor) && !this.bleAn()) {
                        this.remote = true; // blendet die eigenen Auto-Einstellungen aus (Z. 1641)
                    }
                } else {
                    min = max = zahl(v);
                }
            } else if (tag in STEUER) {
                const art = STEUER[tag];
                const passt = { b: 'boolean', t: 'number', i: 'number', e: 'string' }[art];
                if (typeof v !== passt) {
                    ret = `Expecting ${passt}`;
                } else {
                    ret = this.setze(tag, art === 'i' ? Math.trunc(v) : v);
                }
            }
        }
        if (!Number.isNaN(margin)) {
            min -= margin / 2;
            max += margin / 2;
        }
        this.controlvalid = this.uptime + this.e.tcontrol;
        if (!this.e.autor || !this.e.autoe) {
            this.mintarget = min;
            this.maxtarget = max;
        }
        if (!this.bleVerbunden()) {
            if (!Object.is(this.d.env, env)) {
                this.statusGeaendert = true;
            }
            this.d.env = env; // fehlt env, steht hier NAN - und "temp" wird null (Z. 1660)
            this.bekannt.add('env');
        }
        return ret || '';
    }

    /**
     * revk_settings_store (settings_lib.c Z. 1480): nur geaenderte Werte landen im Flash.
     *
     * @param {unknown} j Objekt Einstellung -> Wert
     * @returns {{fehler?: string, ort?: string, geaendert: string[]}} Ergebnis
     */
    speichern(j) {
        const geaendert = [];
        if (!j || typeof j !== 'object' || Array.isArray(j)) {
            return { fehler: 'Not an object - top level', geaendert };
        }
        let neustart = '';
        for (const [name, v] of Object.entries(j)) {
            const def = EINSTELLUNGEN[name];
            if (!def) {
                return { fehler: 'Not found', ort: name, geaendert };
            }
            const [art, live, stellen] = def;
            let w;
            if (art === 'bit') {
                w =
                    v === true ||
                    (typeof v === 'number' && v !== 0) ||
                    (typeof v === 'string' && /^([1tTyY]|on)/.test(v));
            } else if (art === 'text') {
                w = String(v ?? '');
            } else {
                const roh = art === 'hhmm' ? String(v).replace(':', '') : v;
                const n = Number(roh);
                if (roh === '' || roh === null || !Number.isFinite(n)) {
                    return { fehler: 'Not numeric', ort: name, geaendert };
                }
                const f = Math.pow(10, stellen || 0);
                w = Math.round(n * f) / f;
            }
            if (this.e[name] === w) {
                continue; // unveraendert: kein Schreibvorgang (settings_lib.c Z. 1701)
            }
            this.e[name] = w;
            geaendert.push(name);
            this.zaehler.flash++;
            this.zaehler.flashNach[name] = (this.zaehler.flashNach[name] || 0) + 1;
            if (!live && !neustart) {
                neustart = `Change ${name}`;
            }
            if (name === 'autob' || name === 'bleenable') {
                this.haSenden = true;
            }
        }
        if (neustart) {
            this.neustart(3, `Settings changed\n(${neustart})`);
        }
        return { geaendert };
    }

    // ------------------------------------------------------------------ BLE

    /** @returns {boolean} ble_sensor_enabled (Z. 297) */
    bleAn() {
        return !!(this.e.bleenable && this.e.autob);
    }

    /** @returns {boolean} ble_sensor_connected (Z. 290) */
    bleVerbunden() {
        return this.bleAn() && this.ble.verbunden;
    }

    /**
     * BLE-Fuehler koppeln oder entfernen (Szenario; entspricht dem Einstellen von autob am Modul).
     *
     * @param {boolean} an gekoppelt
     * @param {{versatz?: number, bat?: number}} [opt] Abweichung des Fuehlers vom Raum, Batterie
     */
    bleSetzen(an, opt = {}) {
        this.e.bleenable = an;
        this.e.autob = an ? 'SimBLE' : '';
        this.ble.verbunden = an;
        Object.assign(this.ble, opt);
        this.haSenden = true;
    }

    /**
     * Messwerte des BLE-Fuehlers.
     *
     * @returns {{temp: number, hum: number, bat: number}} Werte
     */
    bleWerte() {
        return {
            temp: Math.round((this.physik.luft + this.ble.versatz) * 100) / 100,
            hum: Math.round(this.physik.feuchte() * 100) / 100,
            bat: this.ble.bat,
        };
    }

    // ------------------------------------------------------------------ Hauptschleife

    /** Ein Durchlauf der Hauptschleife = 1 s Modulzeit. */
    tick() {
        if (this.bootRest > 0) {
            if (--this.bootRest === 0) {
                this.hochfahren();
                this.verbinden();
            }
            return;
        }
        const e = this.e;
        this.uptime++;
        const now = this.uptime;

        // BLE-Fuehler liefert den Raumwert (Z. 3636-3646)
        if (this.bleAn()) {
            if (this.ble.verbunden) {
                const env = this.bleWerte().temp;
                if (this.d.env !== env) {
                    this.statusGeaendert = true;
                    this.d.env = env;
                }
                this.bekannt.add('env');
            } else {
                this.bekannt.delete('env');
            }
        }
        // Eigenes Zielband aus autot/autor (Z. 3741-3747)
        if (!this.remote && e.autoe && e.autor && e.autot) {
            if ((!this.bleAn() || this.bleVerbunden()) && this.controlvalid < now + 10) {
                this.controlvalid = now + 10;
            }
            this.mintarget = e.autot - e.autor;
            this.maxtarget = e.autot + e.autor;
        }

        // Mit der Anlage reden: offene Aenderungen senden, dann zuruecklesen.
        if (this.geaendert.size) {
            this.anlageSchreiben();
        }
        for (const [feld, wert] of Object.entries(this.anlageLesen())) {
            if (feld === 'model') {
                if (wert && !this.bekannt.has('model')) {
                    this.bekannt.add('model');
                    this.d.model = wert;
                }
            } else if (wert !== undefined) {
                this.melde(feld, wert);
            }
        }
        // Zu kalt draussen (Z. 4108)
        if (this.d.power && this.bekannt.has('outside') && this.d.outside < e.minoutside) {
            this.setze('power', false);
        }
        // Statusaenderungen melden - nicht, solange eine eigene Aenderung offen ist (Z. 4112-4126)
        if (!this.geaendert.size && (this.statusGeaendert || this.statusBericht || this.modusGeaendert)) {
            const senden = e.livestatus || this.statusBericht || this.modusGeaendert;
            this.statusGeaendert = false;
            this.modusGeaendert = false;
            this.statusBericht = false;
            if (senden) {
                this.zaehler.nativ++;
                this.sende(`state/${this.name}/status`, this.statusNativ(), true);
            }
            this.haStatus();
        }
        this.statSammeln();
        // Abgelehnte Einstellungen (Z. 4138-4152)
        if (!this.geaendert.size) {
            this.versuche = 0;
        } else if (this.versuche++ > e.s21tries) {
            const j = new Jo();
            for (const feld of Object.keys(STEUER)) {
                if (this.geaendert.has(feld)) {
                    this.feldSchreiben(j, feld, 1);
                    this.zaehler.failedSetNach[feld] = (this.zaehler.failedSetNach[feld] || 0) + 1;
                }
            }
            this.zaehler.failedSet++;
            this.sende(`error/${this.name}/failed-set`, j.ende());
            this.geaendert.clear();
            this.versuche = 0;
        }

        this.regeln(now);

        // Sammelbericht (Z. 4517-4547)
        if (e.reporting) {
            const takt = Math.floor(this.uhr() / 1000 / e.reporting);
            if (takt !== this.berichtLast) {
                this.berichtLast = takt;
                if (this.statAnzahl) {
                    this.sende(`Faikout/${this.name}`, this.statMelden());
                    this.haStatus();
                }
            }
        }
        if (this.haSenden && this.verbunden && now > 1) {
            this.haSenden = false;
            this.discovery();
            this.haStatus();
        }
        // Lebenszeichen der Bibliothek (revk.c Z. 2656): sofort nach "status", sonst stuendlich.
        if (this.neustartIn > 0 && --this.neustartIn === 0) {
            const j = new Jo(this.unsinn)
                .text('ts', zeitstempel(this.uhr()))
                .bool('up', false)
                .text('reason', this.neustartGrund);
            this.statusExtra(j);
            this.sende(`state/${this.name}`, j.ende(), true); // revk_mqtt_close, revk.c Z. 5953
            this.zaehler.neustarts++;
            this.bootRest = this.bootSek;
            return;
        }
        if (now > this.upNext || this.neustartIn > 0) {
            this.zaehler.klartext++;
            this.sende(`state/${this.name}`, this.statusKlartext(), true);
            this.ersteMeldung = false;
            this.upNext = now + 3600;
        }
    }

    /** ha_status (Z. 3213): revk_command("status") -> Lebenszeichen sofort. */
    haStatus() {
        if (this.e.haenable) {
            this.upNext = 0;
        }
    }

    /**
     * Temperaturverfolgung, Automatik und eigene Regelung (Z. 4159-4515).
     *
     * @param {number} now uptime in s
     */
    regeln(now) {
        const e = this.e;
        const d = this.d;
        let hot = !!d.heat;
        let min = this.mintarget;
        let max = this.maxtarget;
        let ist = d.env;
        if (Number.isNaN(ist)) {
            ist = d.home;
        }
        // Vorhersage aus den letzten beiden Aenderungen (Z. 4180-4195)
        if (e.tpredicts && !Number.isNaN(ist)) {
            if (Math.floor(now / e.tpredicts) !== Math.floor(this.predictLast / e.tpredicts)) {
                this.predictLast = now;
                this.envDeltaPrev = this.envDelta;
                this.envDelta = ist - this.envPrev;
                this.envPrev = ist;
            }
            if ((this.envDelta <= 0 && this.envDeltaPrev <= 0) || (this.envDelta >= 0 && this.envDeltaPrev >= 0)) {
                ist += ((this.envDelta + this.envDeltaPrev) * e.tpredictt) / (e.tpredicts * 2);
            }
        }
        const gueltig = !Number.isNaN(min) && !Number.isNaN(max);
        // Band verschieben (Z. 4197-4208)
        if (!e.thermostat && d.control && d.power && gueltig) {
            if (hot) {
                max += e.switchtemp;
                min += e.pushtemp;
            } else {
                min -= e.switchtemp;
                max -= e.pushtemp;
            }
        }
        const probenStart = () => {
            this.sample = 0;
        };
        const regelStart = () => {
            if (d.control) {
                return;
            }
            this.hysteresis = 0;
            this.melde('control', true);
            probenStart();
            if (!e.lockmode) {
                if (hot && ist > max) {
                    hot = false;
                    this.setze('mode', 'C');
                } else if (!hot && ist < min) {
                    hot = true;
                    this.setze('mode', 'H');
                }
            }
            const fan = FAN.indexOf(d.fan);
            if (
                !e.nofanauto &&
                fan > 0 &&
                ((hot && ist < min - 2 * e.switchtemp) || (!hot && ist > max + 2 * e.switchtemp))
            ) {
                this.fansaved = fan;
                this.setzeLuefter(e.autofmax);
            }
        };
        const regelStopp = () => {
            if (!d.control) {
                return;
            }
            this.melde('control', false);
            if (this.fansaved) {
                this.setzeLuefter(this.fansaved);
                this.fansaved = 0;
            }
            if (!Number.isNaN(this.mintarget) && !Number.isNaN(this.maxtarget)) {
                this.setze('temp', d.heat ? this.maxtarget : this.mintarget);
            }
            this.mintarget = NaN;
            this.maxtarget = NaN;
        };

        // Ein-/Ausschalten nach Uhrzeit (Z. 4276-4293)
        if (!this.remote && e.autoe && (e.auto0 || e.auto1) && e.auto0 !== e.auto1) {
            const hhmm = Number(ortszeit.format(new Date(this.uhr())).replace(':', ''));
            if (e.auto0 && this.autoLast < e.auto0 && hhmm >= e.auto0) {
                this.setze('power', false);
            }
            if (e.auto1 && this.autoLast < e.auto1 && hhmm >= e.auto1) {
                this.setze('power', true);
                if (
                    !e.lockmode &&
                    d.mode !== 'A' &&
                    !Number.isNaN(ist) &&
                    gueltig &&
                    ((hot && ist > max) || (!hot && ist < min))
                ) {
                    this.setze('mode', hot ? 'C' : 'H');
                }
            }
            this.autoLast = hhmm;
        }
        // Proben und Automatik (Z. 4295-4416)
        if (!Number.isNaN(ist) && gueltig && e.tsample) {
            const z = this.z;
            if (d.power && this.lastheat !== hot) {
                this.lastheat = hot;
                probenStart();
            }
            if (!this.sample) {
                z.an = z.anAlt = z.jen = z.jenAlt = z.ges = z.gesAlt = 0;
            } else {
                z.ges++;
                if ((hot && ist < min) || (!hot && ist > max)) {
                    z.an++;
                } else if ((hot && ist > max) || (!hot && ist < min)) {
                    z.jen++;
                }
            }
            if (this.sample <= now) {
                const an2 = z.an + z.anAlt;
                const jen2 = z.jen + z.jenAlt;
                const ges2 = z.ges + z.gesAlt;
                const j = new Jo().text('ts', zeitstempel(this.uhr())).bool('hot', hot);
                if (ges2) {
                    j.ganz('approaching', an2)
                        .ganz('beyond', jen2)
                        .ganz(z.gesAlt ? 'samples' : 'initial-samples', ges2);
                }
                j.ganz('period', e.tsample).zahl('temp', ist, 2).zahl('min', min, 2).zahl('max', max, 2);
                const autoP = (e.autoe && e.autop) || (this.remote && e.autoptemp);
                if (z.gesAlt) {
                    const fan = FAN.indexOf(d.fan);
                    if (d.power) {
                        if (jen2 * 2 > ges2 && !an2) {
                            if (!e.lockmode) {
                                j.text('set-mode', hot ? 'C' : 'H');
                                this.setze('mode', hot ? 'C' : 'H');
                                if (!e.nofanauto && fan > 1 && fan <= 5) {
                                    j.ganz('set-fan', 1);
                                    this.setzeLuefter(1);
                                }
                            }
                        } else if (!e.nofanauto && an2 * 10 < ges2 * 7 && fan > 1 && fan <= 5) {
                            j.ganz('set-fan', fan - 1);
                            this.setzeLuefter(fan - 1);
                        } else if (!e.nofanauto && an2 * 10 > ges2 * 9 && fan >= 1 && fan < e.autofmax) {
                            j.ganz('set-fan', fan + 1);
                            this.setzeLuefter(fan + 1);
                        } else if (autoP && !an2 && !jen2) {
                            j.bool('set-power', false);
                            this.setze('power', false);
                        }
                    } else if (
                        autoP &&
                        (z.an === z.ges || z.jen === z.ges) &&
                        (ist >= max + e.autoptemp || ist <= min - e.autoptemp) &&
                        (!e.lockmode || jen2 !== ges2)
                    ) {
                        j.bool('set-power', true);
                        this.setze('power', true);
                        if (jen2 === ges2) {
                            j.text('set-mode', hot ? 'C' : 'H');
                            this.setze('mode', hot ? 'C' : 'H');
                        }
                    }
                }
                if (ges2) {
                    this.sende(`info/${this.name}/automation`, j.ende());
                }
                z.anAlt = z.an;
                z.jenAlt = z.jen;
                z.gesAlt = z.ges;
                z.an = z.jen = z.ges = 0;
                this.sample = now + e.tsample;
            }
        }
        // Ablauf der Fremdsteuerung (Z. 4418-4427)
        if (this.controlvalid && now > this.controlvalid) {
            this.controlvalid = 0;
            this.bekannt.delete('env');
            this.statusGeaendert = true;
            d.env = NaN;
            this.remote = false;
            regelStopp();
        }
        if (!gueltig) {
            regelStopp();
        }
        // Eigene Regelung ueber die Solltemperatur der Anlage (Z. 4431-4502)
        if (d.power && this.controlvalid) {
            regelStart();
            let bezug = NaN;
            if (this.bekannt.has('home') && this.bekannt.has('inlet')) {
                bezug = (d.home * e.thermref + d.inlet * (100 - e.thermref)) / 100;
            } else if (this.bekannt.has('home')) {
                bezug = d.home;
            } else if (this.bekannt.has('inlet')) {
                bezug = d.inlet;
            }
            if (d.mode === 'A') {
                this.setze('mode', hot ? 'H' : 'C');
            }
            let set = (min + max) / 2;
            if (e.thermostat) {
                set = (hot && this.hysteresis) || (!hot && !this.hysteresis) ? max : min;
            }
            if (e.temptrack) {
                set = bezug;
            } else if (e.tempadjust) {
                set += bezug - ist;
            }
            if ((hot && ist < (this.hysteresis ? max : min)) || (!hot && ist > (this.hysteresis ? min : max))) {
                if (e.thermostat) {
                    this.hysteresis = 1;
                }
                set += hot ? e.heatover : -e.coolover;
                this.action = hot ? HVAC.heizen : HVAC.kuehlen;
            } else {
                this.action = HVAC.ruhe;
                this.hysteresis = 0;
                if (this.fansaved) {
                    this.setzeLuefter(this.fansaved);
                    this.fansaved = 0;
                    probenStart();
                }
                set += hot ? -e.heatback : e.coolback;
            }
            if (this.art.protokoll === 'S21') {
                set = Math.round(set * 2) / 2;
            }
            if (set < (hot ? e.tmin : e.tcoolmin)) {
                set = hot ? e.tmin : e.tcoolmin;
            }
            if (set > (hot ? e.theatmax : e.tmax)) {
                set = hot ? e.theatmax : e.tmax;
            }
            if (!Number.isNaN(set) && (this.action !== this.lastaction || (set !== this.lastset && now > this.flap))) {
                this.flap = now + e.tempnoflap;
                this.lastaction = this.action;
                this.lastset = set;
                this.setze('temp', set);
            }
        } else {
            regelStopp();
            // nur aus der Betriebsart (Z. 4506-4513)
            this.action = !d.power
                ? HVAC.off
                : d.antifreeze
                  ? HVAC.abtauen
                  : this.bekannt.has('comp') && !d.comp
                    ? HVAC.ruhe
                    : { H: HVAC.heizen, C: HVAC.kuehlen, A: HVAC.ruhe, D: HVAC.trocknen, F: HVAC.luefter }[d.mode] ||
                      HVAC.ruhe;
        }
    }

    // ------------------------------------------------------------------ Meldungen

    /**
     * Ein Feld im nativen Format schreiben (Makros Z. 1789-1793 bzw. 4143-4146).
     *
     * @param {Jo} j Ziel
     * @param {string} feld Name
     * @param {number} [stellen] Nachkommastellen fuer Temperaturen
     */
    feldSchreiben(j, feld, stellen = 1) {
        const art = ALLE[feld];
        const w = this.d[feld];
        if (art === 'b') {
            j.bool(feld, w);
        } else if (art === 't') {
            j.zahl(feld, w >= 100 ? NaN : w, stellen);
        } else if (art === 'i') {
            j.ganz(feld, w || 0);
        } else if (art === 'e') {
            j.text(feld, w);
        } else if (art === 's' && w) {
            j.text(feld, w);
        }
    }

    /** @returns {string} state/<Name>/status (daikin_status, Z. 1784-1830) */
    statusNativ() {
        const e = this.e;
        const j = new Jo(this.unsinn).text('protocol', this.art.protokoll);
        for (const feld of Object.keys(ALLE)) {
            if (this.bekannt.has(feld) && ALLE[feld] !== 'r') {
                this.feldSchreiben(j, feld, 1);
            }
        }
        if (this.bleVerbunden()) {
            const b = this.bleWerte();
            j.lit('ble', `{"temp":${b.temp.toFixed(2)},"hum":${b.hum.toFixed(2)},"bat":${b.bat}}`);
        }
        if (this.bleAn()) {
            j.text('autob', e.autob);
        }
        if (this.remote) {
            j.bool('remote', true);
        } else {
            j.zahl('autor', e.autor, 1).zahl('autot', e.autot, 1);
            j.text('auto0', hhmmText(e.auto0))
                .text('auto1', hhmmText(e.auto1))
                .bool('autop', e.autop)
                .bool('autoe', e.autoe);
        }
        return j.ende();
    }

    /**
     * revk_state_extra (Z. 3222-3313).
     *
     * @param {Jo} j Ziel
     */
    statusExtra(j) {
        const e = this.e;
        const d = this.d;
        const k = f => this.bekannt.has(f);
        if (!e.haenable) {
            return;
        }
        if (k('online')) {
            j.bool('online', d.online);
        }
        if (k('power')) {
            j.bool('power', d.power);
        }
        j.zahl('target', e.autoe && e.autor ? e.autot : d.temp, 2);
        if (k('temp')) {
            j.zahl('actarget', d.temp, 2);
        }
        if (k('env')) {
            j.zahl('temp', d.env, 2);
        } else if (k('home')) {
            j.zahl('temp', d.home, 2);
        } else if (k('inlet')) {
            j.zahl('temp', d.inlet, 2);
        }
        if (k('hum')) {
            j.zahl('hum', d.hum, 2);
        }
        if (k('home')) {
            j.zahl('achome', d.home, 2);
        }
        if (k('home') && k('inlet')) {
            j.zahl('inlet', d.inlet, 2);
        }
        if (k('outside')) {
            j.zahl('outside', d.outside, 2);
        }
        if (k('liquid')) {
            j.zahl('liquid', d.liquid, 2);
        }
        if (k('demand')) {
            j.ganz('demand', d.demand);
        }
        if (k('Whoutside')) {
            j.ganz('energy', d.Whoutside);
        }
        if (k('Whheating')) {
            j.ganz('energyheat', d.Whheating);
        }
        if (k('Whcooling')) {
            j.ganz('energycool', d.Whcooling);
        }
        if (k('consumption')) {
            j.ganz('consumption', d.consumption);
        }
        if (k('fanrpm')) {
            j.zahl('fanfreq', d.fanrpm / 60, 1);
        }
        if (k('comp')) {
            j.ganz('comp', d.comp);
        }
        if (this.austrittSensor) {
            // KEIN Feld der Firmware: simulierter Sensor am Luftaustritt, damit der Kalibrierassistent des
            // Adapters im Testnetz einen Datenpunkt hat (der Adapter legt unbekannte Felder unter status.* an)
            j.zahl('simoutlet', this.physik.messwerte().austritt, 1);
        }
        if (this.bleVerbunden()) {
            const b = this.bleWerte();
            j.zahl('bletemp', b.temp, 2).zahl('blehum', b.hum, 2).ganz('blebat', b.bat);
        }
        if (k('mode')) {
            const auto = e.autoe && e.autor && !e.lockmode && !e.noauto;
            j.text('mode', d.power ? (auto ? 'heat_cool' : MODUS_NAMEN[MODI.indexOf(d.mode)]) : 'off');
        }
        if (!e.nohvacaction) {
            j.text('action', this.action);
        }
        if (k('fan')) {
            j.text('fan', FAN_NAMEN[FAN.indexOf(d.fan)]);
        }
        for (const f of ['streamer', 'quiet', 'econo', 'comfort', 'powerful', 'sensor', 'led']) {
            if (k(f)) {
                j.bool(f, d[f]);
            }
        }
        if (k('swingh') || k('swingv') || k('comfort')) {
            const beide = k('swingh') && k('swingv');
            j.text(
                'swing',
                d.comfort
                    ? k('swingh') && d.swingh
                        ? 'H+C'
                        : 'C'
                    : beide && d.swingh && d.swingv
                      ? 'H+V'
                      : d.swingh
                        ? k('swingv')
                            ? 'H'
                            : 'on'
                        : d.swingv
                          ? k('swingh')
                              ? 'V'
                              : 'on'
                          : 'off',
            );
        }
        if (k('econo') || k('powerful')) {
            j.text('preset', d.econo ? 'eco' : d.powerful ? 'boost' : e.nohomepreset ? 'none' : 'home');
        }
        if (e.haswitches) {
            j.bool('autoe', e.autoe);
        }
    }

    /** @returns {string} state/<Name> (revk.c Z. 2662-2732) */
    statusKlartext() {
        const j = new Jo(this.unsinn)
            .text('ts', zeitstempel(this.uhr()))
            .text('id', this.id)
            .bool('up', true)
            .ganz('uptime', this.uptime)
            .ganz('mqtt-up', 1);
        if (this.neustartIn > 0) {
            j.ganz('restart', this.neustartIn).text('reason', this.neustartGrund);
        }
        // "some unchanging stuff": immer wenn up_next 0 war - also bei jeder angeforderten Meldung.
        j.text('app', 'Faikout').text('version', VERSION).text('build-suffix', HARDWARE).text('build', BUILD);
        j.ganz('flash', 4194304).ganz('rst', 1).ganz('mem', 150000);
        j.text('ssid', 'SimNetz').text('bssid', '020000000001').ganz('rssi', -55).ganz('chan', 6);
        // Ein echtes Modul nennt seine IP (revk.c: "ipv4"). Der Simulator nennt die Adresse, unter der
        // seine Einstellungsseite erreichbar ist - mit Port, wenn es nicht 80 ist (Dienst: httpAdresse).
        if (this.httpAdresse) {
            j.text('ipv4', this.httpAdresse);
        }
        this.statusExtra(j);
        return j.ende();
    }

    /** Werte fuer den Sammelbericht aufnehmen (Z. 4128-4137). */
    statSammeln() {
        for (const [feld, art] of Object.entries(ALLE)) {
            const w = this.d[feld];
            const s = (this.stat[feld] ||= { min: NaN, max: NaN, summe: 0, n: 0 });
            if (art === 'b') {
                s.summe += w ? 1 : 0;
            } else if (art === 't') {
                if (!Number.isNaN(w) && w !== undefined) {
                    s.min = s.n ? Math.min(s.min, w) : w;
                    s.max = s.n ? Math.max(s.max, w) : w;
                    s.summe += w;
                    s.n++;
                }
            } else if (art === 'i') {
                const v = w || 0;
                s.min = this.statAnzahl ? Math.min(s.min, v) : v;
                s.max = this.statAnzahl ? Math.max(s.max, v) : v;
                s.summe += v;
            }
        }
        this.statAnzahl++;
    }

    /** @returns {string} Faikout/<Name> (Z. 4524-4541) */
    statMelden() {
        const fest = this.e.fixstatus;
        const n = this.statAnzahl;
        const j = new Jo(this.unsinn).text('protocol', this.art.protokoll).text('ts', zeitstempel(this.uhr()));
        for (const [feld, art] of Object.entries(ALLE)) {
            const s = this.stat[feld];
            const k = this.bekannt.has(feld);
            if (art === 'b' && k) {
                if (!s.summe) {
                    j.bool(feld, false);
                } else if (fest || s.summe === n) {
                    j.bool(feld, true);
                } else {
                    j.zahl(feld, s.summe / n, 2);
                }
            } else if (art === 't' && s.n) {
                if (fest || s.min === s.max) {
                    j.zahl(feld, s.min, 2);
                } else {
                    j.lit(feld, `[${s.min.toFixed(2)},${(s.summe / s.n).toFixed(2)},${s.max.toFixed(2)}]`);
                }
            } else if (art === 'r' && !Number.isNaN(this.mintarget) && !Number.isNaN(this.maxtarget)) {
                if (fest || this.mintarget === this.maxtarget) {
                    j.zahl(feld, this.mintarget, 2);
                } else {
                    j.lit(feld, `[${this.mintarget.toFixed(2)},${this.maxtarget.toFixed(2)}]`);
                }
            } else if (art === 'i' && k) {
                if (fest || s.min === s.max) {
                    j.ganz(feld, s.summe / n);
                } else {
                    j.lit(feld, `[${s.min},${Math.trunc(s.summe / n)},${s.max}]`);
                }
            } else if (art === 'e' && k) {
                j.text(feld, this.d[feld]);
            }
        }
        this.stat = {};
        this.statAnzahl = 0;
        return j.ende();
    }

    /** Home-Assistant-Discovery (send_ha_config, Z. 2840-3200) - retained, leer = Eintrag loeschen. */
    discovery() {
        const e = this.e;
        const k = f => this.bekannt.has(f);
        const zustand = `state/${this.name}`;
        const cmd = `command/${this.name}`;
        const basis = (tag, icon) => {
            const o = {
                unique_id: `${this.id}${tag}`,
                dev: { ids: [this.id], name: this.name, sw: VERSION, mf: 'RevK', cu: `http://${this.name}.local/` },
            };
            if (this.d.model) {
                o.dev = { ids: [this.id], name: this.name, mdl: this.d.model, sw: VERSION, mf: 'RevK', cu: o.dev.cu };
            }
            if (icon) {
                o.icon = icon;
            }
            return Object.assign(o, {
                avty_t: zustand,
                avty_tpl: '{{value_json.up}}',
                pl_avail: true,
                pl_not_avail: false,
            });
        };
        const raus = (art, tag, ok, bau) =>
            this.sende(`homeassistant/${art}/${this.id}${tag}/config`, ok ? JSON.stringify(bau()) : '', true);
        const fuehler = (ok, tag, name, mehr, icon) =>
            raus('sensor', tag, ok, () => ({
                ...basis(tag, icon),
                name,
                ...mehr,
                stat_t: zustand,
                val_tpl: `{{value_json.${tag}}}`,
            }));
        const temp = (ok, tag, name) =>
            fuehler(
                ok,
                tag,
                name,
                { dev_cla: 'temperature', state_class: 'measurement', unit_of_meas: '°C' },
                'mdi:thermometer',
            );

        const klima = { ...basis('', 'mdi:thermostat'), '~': cmd, min_temp: e.tmin, max_temp: e.tmax, temp_unit: 'C' };
        klima.temp_step = e.ha1c ? 1 : this.art.protokoll === 'S21' ? 0.5 : 0.1;
        Object.assign(klima, { temp_cmd_t: '~/temp', temp_stat_t: zustand, temp_stat_tpl: '{{value_json.target}}' });
        if (k('inlet') || k('home')) {
            Object.assign(klima, { curr_temp_t: zustand, curr_temp_tpl: '{{value_json.temp}}' });
        }
        if (k('hum') || this.bleVerbunden()) {
            klima.curr_hum_t = zustand;
            klima.curr_hum_tpl = this.bleVerbunden() ? '{{value_json.blehum}}' : '{{value_json.hum}}';
        }
        if (k('mode')) {
            Object.assign(klima, { mode_cmd_t: '~/mode', mode_stat_t: zustand, mode_stat_tpl: '{{value_json.mode}}' });
            if (!e.nohvacaction) {
                Object.assign(klima, { action_topic: zustand, action_template: '{{value_json.action}}' });
            }
            Object.assign(klima, { payload_on: '1', payload_off: '0', power_command_topic: '~/power' });
            klima.modes = [...(e.noauto ? [] : ['heat_cool']), 'off', 'cool', 'heat', 'dry', 'fan_only'];
        }
        if (k('fan')) {
            Object.assign(klima, {
                fan_mode_cmd_t: '~/fan',
                fan_mode_stat_t: zustand,
                fan_mode_stat_tpl: '{{value_json.fan}}',
            });
            klima.fan_modes = FAN_NAMEN;
        }
        if (k('swingh') || k('swingv') || k('comfort')) {
            Object.assign(klima, {
                swing_mode_cmd_t: '~/swing',
                swing_mode_stat_t: zustand,
                swing_mode_stat_tpl: '{{value_json.swing}}',
            });
            klima.swing_modes = ['off'];
            if (k('swingh') && k('swingv')) {
                klima.swing_modes.push('H', 'V', 'H+V');
            } else {
                klima.swing_modes.push('on');
            }
            if (k('comfort')) {
                klima.swing_modes.push('C', ...(k('swingh') ? ['H+C'] : []));
            }
        }
        if (k('econo') || k('powerful')) {
            Object.assign(klima, {
                pr_mode_cmd_t: '~/preset',
                pr_mode_stat_t: zustand,
                pr_mode_val_tpl: '{{value_json.preset}}',
            });
            klima.pr_modes = [
                ...(k('econo') ? ['eco'] : []),
                ...(k('powerful') ? ['boost'] : []),
                ...(e.nohomepreset ? [] : ['home']),
            ];
        }
        this.sende(`homeassistant/climate/${this.id}/config`, JSON.stringify(klima), true);

        temp(k('home') && k('inlet'), 'inlet', 'Inlet');
        temp(k('temp'), 'actarget', 'AC-Target');
        temp(k('home'), 'achome', 'AC-Home');
        temp(k('outside'), 'outside', 'Outside');
        temp(k('liquid'), 'liquid', 'Liquid');
        const mess = { state_class: 'measurement' };
        fuehler(k('hum'), 'hum', 'Humidity', { dev_cla: 'humidity', ...mess, unit_of_meas: '%' }, 'mdi:water-percent');
        fuehler(k('comp'), 'comp', 'comp', { dev_cla: 'frequency', ...mess, unit_of_meas: 'Hz' }, 'mdi:sine-wave');
        fuehler(k('fanrpm'), 'fanfreq', 'fanfreq', { dev_cla: 'frequency', ...mess, unit_of_meas: 'Hz' }, 'mdi:fan');
        for (const [tag, feld] of [
            ['power', 'power'],
            ['streamer', 'streamer'],
            ['sensor', 'sensor'],
            ['powerful', 'powerful'],
            ['comfort', 'comfort'],
            ['quiet', 'quiet'],
            ['econo', 'econo'],
            ['led', 'led'],
        ]) {
            raus('switch', tag, e.haswitches && k(feld) && !e[`no${feld}`], () => ({
                ...basis(tag),
                name: tag,
                stat_t: zustand,
                cmd_t: `${cmd}/${tag}`,
                val_tpl: `{{value_json.${tag}}}`,
                pl_on: true,
                pl_off: false,
            }));
        }
        temp(this.bleVerbunden(), 'bletemp', 'BLE Temp');
        fuehler(
            this.bleVerbunden(),
            'blehum',
            'BLE Humidity',
            { dev_cla: 'humidity', ...mess, unit_of_meas: '%' },
            'mdi:water-percent',
        );
        fuehler(this.bleVerbunden(), 'blebat', 'BLE Battery', { dev_cla: 'battery', ...mess, unit_of_meas: '%' });
        raus('select', 'demand', k('demand'), () => ({
            ...basis('demand'),
            name: 'Demand control',
            cmd_t: `${cmd}/demand`,
            stat_t: zustand,
            val_tpl: '{{value_json.demand}}',
            options: Array.from({ length: 15 }, (_, i) => String(30 + 5 * i)),
        }));
        for (const [feld, tag, name] of [
            ['Whoutside', 'energy', 'Lifetime outside energy'],
            ['Whheating', 'energyheat', 'Lifetime heating energy'],
            ['Whcooling', 'energycool', 'Lifetime cooling energy'],
        ]) {
            raus('sensor', tag, k(feld), () => ({
                ...basis(tag),
                name,
                dev_cla: 'energy',
                stat_t: zustand,
                unit_of_meas: 'kWh',
                state_class: 'total_increasing',
                val_tpl: `{{(value_json.${tag}|float)/1000}}`,
            }));
        }
        raus('sensor', 'consumption', k('consumption'), () => ({
            ...basis('consumption'),
            name: 'Power consumption',
            dev_cla: 'power',
            stat_t: zustand,
            unit_of_meas: 'W',
            state_class: 'measurement',
            val_tpl: '{{(value_json.consumption)}}',
        }));
        raus('button', 'restart', true, () => ({
            ...basis('restart'),
            name: 'Restart',
            dev_cla: 'restart',
            cmd_t: `${cmd}/restart`,
        }));
    }

    // ------------------------------------------------------------------ Auskunft

    /** @returns {number} Ziel, auf das gerade geregelt wird (fuer die Messdatei) */
    zielwert() {
        const e = this.e;
        if (e.autoe && e.autor && e.autot) {
            return e.autot;
        }
        if (this.controlvalid && !Number.isNaN(this.mintarget) && !Number.isNaN(this.maxtarget)) {
            return (this.mintarget + this.maxtarget) / 2;
        }
        return this.ac.temp;
    }

    /** @returns {object} Stand fuer GET /stand und die Messdatei */
    stand() {
        return {
            name: this.name,
            id: this.id,
            typ: this.typ,
            verbunden: this.verbunden,
            uptime: this.uptime,
            anlage: { ...this.ac },
            ziel: this.zielwert(),
            action: this.action,
            control: !!this.d.control,
            env: Number.isNaN(this.d.env) ? null : this.d.env,
            ble: this.bleVerbunden(),
            einstellungen: { ...this.e },
            zaehler: JSON.parse(JSON.stringify(this.zaehler)),
        };
    }
}

module.exports = {
    Modul,
    Jo,
    TYPEN,
    EINSTELLUNGEN,
    EINSTELLUNG_VORGABE,
    STEUER,
    FAN,
    FAN_NAMEN,
    MODI,
    MODUS_NAMEN,
    VERSION,
    BUILD,
    HARDWARE,
};
