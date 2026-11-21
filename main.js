'use strict';

/*
 * ioBroker.faikout
 * Bindet Daikin-Klimaanlagen mit faikout-Modul rein ueber MQTT an - mit eigenem Broker.
 */

const utils = require('@iobroker/adapter-core');
const { FaikoutBroker } = require('./lib/broker');
const brokerextern = require('./lib/brokerextern');
const felder = require('./lib/fields');
const namen = require('./lib/namen');
const verbrauch = require('./lib/verbrauch');
const { FaikoutDeviceManagement } = require('./lib/devicemanager');
const discovery = require('./lib/discovery');
const suche = require('./lib/suche');
const anbinden = require('./lib/anbinden');
const { Bedarfsregelung } = require('./lib/regel');
const regelUmzug = require('./lib/regel/umzug');

/** Topics, die der Adapter auswertet. Alles andere wird still verworfen. */
const BEKANNTE_ARTEN = new Set(['state', 'info', 'error', 'event']);

/** Kanaele der Felder unter jedem Geraet. */
const KANAELE = ['control', 'status', 'info'];

/** Kanal der Verbrauchswerte unter jedem Geraet. */
const CONSUMPTION = 'consumption';

/**
 * Die drei Lebensdauer-Zaehler und ihr Zweig im Objektbaum. Die Gesamtzaehler bleiben
 * erhalten (status.*), zusaetzlich entstehen daraus die Verbrauchswerte (consumption.*).
 * `alt` ist der Zweig bis 0.0.13 - siehe verbrauchUmziehen().
 */
const ZAEHLER = [
    { feld: 'energy', zweig: 'total', alt: 'gesamt', name: { en: 'Total', de: 'Gesamt' } },
    { feld: 'energyheat', zweig: 'heating', alt: 'heizen', name: { en: 'Heating', de: 'Heizen' } },
    { feld: 'energycool', zweig: 'cooling', alt: 'kuehlen', name: { en: 'Cooling', de: 'Kühlen' } },
];

/** Datenpunkte je Zaehlerzweig. `alt` ist die ID bis 0.0.13. */
const VERBRAUCH_FELDER = [
    { id: 'currentHour', alt: 'stunde', name: { en: 'Current hour', de: 'Laufende Stunde' } },
    { id: 'lastHour', alt: 'letzteStunde', name: { en: 'Last full hour', de: 'Letzte volle Stunde' } },
    { id: 'today', alt: 'heute', name: { en: 'Today', de: 'Heute' } },
    { id: 'yesterday', alt: 'gestern', name: { en: 'Yesterday', de: 'Gestern' } },
    { id: 'thisMonth', alt: 'dieserMonat', name: { en: 'This month', de: 'Dieser Monat' } },
    { id: 'lastMonth', alt: 'letzterMonat', name: { en: 'Last month', de: 'Letzter Monat' } },
];

/**
 * Verlaufsreihen als JSON. Sie tragen die Diagramme im VIS-Baustein und werden hier gefuehrt,
 * damit der Adapter ohne Fremdskript auskommt - andernfalls blieben Monats- und Jahresansicht
 * bei jedem leer, der nichts weiter einrichtet.
 */
const VERBRAUCH_REIHEN = [
    {
        id: 'hoursJson',
        alt: 'stundenJson',
        quelle: 'hours',
        name: { en: 'Last 48 hours (JSON)', de: 'Letzte 48 Stunden (JSON)' },
    },
    {
        id: 'daysJson',
        alt: 'tageJson',
        quelle: 'days',
        name: { en: 'Last 62 days (JSON)', de: 'Letzte 62 Tage (JSON)' },
    },
    {
        id: 'monthsJson',
        alt: 'monateJson',
        quelle: 'months',
        name: { en: 'Last 24 months (JSON)', de: 'Letzte 24 Monate (JSON)' },
    },
];

/**
 * Ein unveraenderter Wert wird nicht bei jeder Nachricht neu geschrieben, aber spaetestens nach
 * dieser Zeit wieder - damit der Zeitstempel (ts) eines Datenpunkts nicht stehen bleibt und
 * Ueberwachungen wie device-watcher ein lebendes Geraet nicht fuer tot halten.
 */
const AUFFRISCHEN_MS = 5 * 60 * 1000;

/**
 * Zaehlerstaende (native.zaehler) werden ausser bei Stundenwechsel, Hinweisen und Beenden
 * hoechstens so oft gesichert. Was nach einem Absturz dazwischen fehlt, faengt verbrauch.js ab:
 * gerechnet wird immer Rohwert minus Basis, der Verbrauch landet also nur spaeter, nicht doppelt
 * und nicht verloren.
 */
const SICHERN_MS = 10 * 60 * 1000;

/** Laufwerte: hoechstens ein Schreibvorgang je Minute (siehe wertSchreiben). */
const LAUFWERTE = /\.info\.(ts|uptime|mqttUp)$/;
const LAUFWERT_MS = 60 * 1000;

class Faikout extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'faikout' });

        /**
         * Geraete, die sich gemeldet haben.
         * Schluessel ist die ioBroker-taugliche ID, Wert enthaelt den ECHTEN Geraetenamen -
         * der enthaelt bei diesen Modulen ein Leerzeichen ("Wohnzimmer AC"), waehrend die
         * Objekt-ID einen Unterstrich braucht. Kommandos muessen den echten Namen treffen,
         * sonst hoert das Geraet nicht zu.
         *
         */
        this.geraete = new Map();

        /**
         * Einheiten von comp/fanfreq je Geraet aus der HA-Discovery (Hz oder rpm). Getrennt von
         * `geraete`, weil die Discovery vor der ersten Statusmeldung eintreffen kann.
         */
        this.einheiten = new Map();

        /** Geraete, fuer die schon vor ausgeschaltetem ha.enable gewarnt wurde (einmal je Lauf). */
        this.haWarnung = new Set();

        /** Letzte Warnung "Einstellung abgelehnt" je Geraet: {text, zeit} - gegen Wiederholungen im Log. */
        this.abgelehntWarnung = new Map();

        /**
         * Schreib-Zwischenspeicher: stateId -> {val, zeit} des zuletzt geschriebenen Werts.
         * Bis 0.0.18 schrieb der Adapter bei jeder Statusmeldung alle Datenpunkte samt drei
         * JSON-Reihen und dem Zaehlerstand ins Objekt - bei vier Geraeten 27 % CPU (Issue #5).
         * Beim Start leer, der erste Durchlauf schreibt also alles.
         */
        this.geschrieben = new Map();

        /** Stunde, fuer die die Stundenreihe (hoursJson) zuletzt geschrieben wurde, je stateId. */
        this.reihenStunde = new Map();

        /** Client-IDs der Module, die gerade am Broker haengen ("Faikout:<Hostname>[_<ID-Ende>]"). */
        this.mqttClients = new Set();
        /** Absenderadresse je MQTT-Client des eigenen Brokers (Client-Name -> IP) */
        this.clientAdressen = new Map();

        /** Laeuft gerade eine Suche (Reiter "Module suchen")? Nur eine zur Zeit. */
        this.sucheLaeuft = false;

        /** Letzte Meldung je Modul-Hostname (Topic) - Erfolgskontrolle beim Anbinden. */
        this.gesehen = new Map();

        /** Module der letzten Suche (ohne Formularwerte) fuer die Auswahl "Modul anbinden". */
        this.letzteSuche = [];
        /** Ergebniszeilen der Tabelle (ohne Formularwerte) - Einzelpruefungen sammeln sich hier. */
        this.letzteZeilen = [];

        /**
         * Anbinden: Plan aus "Pruefen" und Rueckweg je IP. Nur im Speicher - enthaelt den alten
         * mqtthost/mqttuser des Moduls, der nie geloggt oder gespeichert wird.
         */
        this.anbindenPlaene = new Map();
        this.rueckwege = new Map();

        /** Laeuft gerade ein Anbinden/Zurueckstellen? Nur eins zur Zeit. */
        this.anbindenLaeuft = false;

        /** Bedarfsregelung (Leistungsgrenze demand), entsteht in onReady mit der Konfiguration. */
        this.regelung = null;

        this.broker = null;
        this.stopping = false;
        this.stundenTimer = null;

        /**
         * Karten im Device-Manager des Admins: laufender Betrieb und Alltagsbedienung, bewusst
         * ohne Konfigurationsaktionen (siehe lib/devicemanager.js).
         */
        this.deviceManagement = new FaikoutDeviceManagement(this);

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        // dm:* beantwortet der Device-Manager selbst; hier nur die Befehle der Einstellungsseite.
        this.on('message', this.onMessage.bind(this));
    }

    // ---------------------------------------------------------------- Start

    async onReady() {
        // Startzeit: die Einrichtungsseite wartet kurz nach dem Start auf das erste Modul (oberflaeche.einrichtungStandHtml)
        this.startZeit = Date.now();
        await this.setState('info.connection', { val: false, ack: true });
        if (await this.konfigUmziehen()) {
            return; // die Instanz startet mit der umgezogenen Konfiguration neu
        }
        await this.verbrauchUmziehen();
        // Vorabstand von 1.0.0: Datenpunkte der Regelung von regel.* nach regulation.* (lib/regel/umzug.js)
        await regelUmzug.umziehen(this);
        await this.objekteAbgleichen();
        // Geloeschte Objekte mitbekommen (Issue #6): sonst schreibt der Adapter weiter in einen
        // Zweig, den er fuer angelegt haelt - "State ... has no existing object".
        await this.subscribeObjectsAsync('*');
        this.regelung = new Bedarfsregelung(this);
        // Systemsprache im Betrieb umgestellt: Begruendungen und Szenennamen folgen ohne Neustart
        if (typeof this.subscribeForeignObjectsAsync === 'function') {
            await this.subscribeForeignObjectsAsync('system.config');
        }

        const ziel = this.brokerZiel();
        const onMessage = (topic, payload) => this.onMqtt(topic, payload);
        if (ziel.extern) {
            // Externer Broker: der Adapter ist Client, der eigene Broker wird NICHT gestartet.
            this.broker = new brokerextern.ExternerBroker({
                host: this.config.externHost,
                port: this.config.externPort,
                tls: this.config.externTls === true,
                user: this.config.externUser,
                pass: this.config.externPass,
                clientId: this.config.externClientId || brokerextern.standardClientId(this.instance),
                praefix: this.config.externPraefix,
                log: this.log,
                onMessage,
                // Verbindung zum Broker da/weg -> info.connection nachfuehren
                onClient: () => this.verbindungPruefen(),
            });
        } else {
            this.broker = new FaikoutBroker({
                port: ziel.port,
                user: this.config.user,
                pass: this.config.pass,
                log: this.log,
                timer: this,
                onMessage,
                onClient: (clientId, verbunden, adresse) => {
                    if (verbunden) {
                        this.mqttClients.add(String(clientId));
                        if (adresse) {
                            this.clientAdressen.set(String(clientId), String(adresse));
                        }
                    } else {
                        this.mqttClients.delete(String(clientId));
                    }
                    this.verbindungPruefen();
                },
            });
        }

        try {
            await this.broker.start();
        } catch (e) {
            this.log.error(`MQTT broker could not start: ${e.message}`);
            return;
        }

        if (ziel.extern) {
            this.log.info(
                `Ready. The faikout modules must point to the external broker ${ziel.adresse}:${ziel.port} (module setting "mqtthost").`,
            );
        } else {
            const adresse = ziel.adresse || '<ioBroker IP>';
            this.log.info(`Ready. Configure the faikout modules with MQTT host ${adresse}:${ziel.port}.`);
        }
        this.subscribeStates('*.control.*');
        // `autoe` liegt im Kanal status, ist aber beschreibbar (Review 11.10.2026: Schreibbefehle
        // darauf gingen bisher ins Leere, weil nur control.* abonniert war).
        this.subscribeStates('*.status.autoe');
        // Schalter der Bedarfsregelung - laufen NICHT ueber den Befehlsweg ans Modul.
        this.subscribeStates('*.regulation.*');
        // Zeittakt der Regelung: Schaltpunkte des Wochenplans, Ablauf von Sperren, Fuehleralter.
        this.regelTakt = this.setInterval(() => {
            if (this.regelung) {
                this.regelung.takt().catch(e => this.log.warn(`Climate control: ${e.message}`));
            }
        }, 30000);
        this.stundenTaktStarten();
    }

    /**
     * Weckt die Verbrauchsrechnung zur vollen Stunde.
     *
     * Noetig, weil die Module nur zyklisch senden (Einstellung "reporting", ab Werk 60 s):
     * ohne eigenen Takt wuerde ein Stundenwechsel erst mit der naechsten Nachricht bemerkt
     * und die Stunde bekaeme Verbrauch aus der falschen Periode zugerechnet.
     */
    stundenTaktStarten() {
        const jetzt = new Date();
        const naechste = new Date(jetzt);
        naechste.setHours(jetzt.getHours() + 1, 0, 5, 0); // 5 s nach der vollen Stunde
        this.stundenTimer = this.setTimeout(() => {
            this.stundenwechsel().catch(e => this.log.warn(`Hour change: ${e.message}`));
            this.stundenTaktStarten();
        }, naechste - jetzt);
    }

    async stundenwechsel() {
        // Kopie: geraetVergessen() nimmt waehrend der Schleife Eintraege heraus.
        for (const [id, g] of [...this.geraete]) {
            // Issue #6: Ein umbenanntes Modul blieb bis zum Neustart als Geist in this.geraete, und
            // jede volle Stunde gingen setState-Aufrufe auf die vom Nutzer geloeschten Objekte.
            if (!(await this.geraetNochDa(id, g))) {
                continue;
            }
            for (const z of ZAEHLER) {
                if (this.geraete.get(id) !== g) {
                    break; // inzwischen geloescht oder umbenannt
                }
                const ergebnis = verbrauch.pruefen(g.zaehler[z.feld], new Date());
                if (!ergebnis.werte) {
                    continue;
                }
                g.zaehler[z.feld] = ergebnis.stand;
                ergebnis.hinweise.forEach(h => this.log.info(`${g.name} ${z.name.en.toLowerCase()}: ${h}`));
                await this.verbrauchSchreiben(id, g, z, ergebnis.werte);
            }
            await this.zaehlerstandSichern(id, g);
        }
    }

    verbindungPruefen() {
        if (this.stopping) {
            return; // beim Beenden nichts mehr schreiben (die Verbindung zur Datenbank schliesst gerade)
        }
        // Verbunden heisst hier: mindestens ein faikout-Modul haengt am Broker.
        // Am externen Broker zaehlt zusaetzlich die Verbindung zum Broker selbst: faellt er weg, kommt
        // keine Meldung mehr an - "verbunden" waere dann falsch (Brokertest 21.11.2026).
        const brokerDa = (this.config || {}).brokerModus !== 'extern' || !!(this.broker && this.broker.verbunden);
        this.setState('info.connection', { val: this.geraete.size > 0 && brokerDa, ack: true });
    }

    // ---------------------------------------------------------------- MQTT hinein

    /**
     * Zerlegt ein Topic in Art, Geraet und Unterpfad.
     * `state/Wohnzimmer AC` -> {art:'state', geraet:'Wohnzimmer AC', unter:''}
     * `info/Wohnzimmer AC/upgrade` -> {art:'info', geraet:'Wohnzimmer AC', unter:'upgrade'}
     *
     * @param {string} topic   Topic der Modulnachricht
     * @returns {{art: string, geraet: string, unter: string}} zerlegtes Topic
     */
    topicZerlegen(topic) {
        const teile = topic.split('/');
        if (teile.length < 2) {
            return null;
        }
        const [art, geraet, ...rest] = teile;
        if (!BEKANNTE_ARTEN.has(art)) {
            return null;
        }
        return { art, geraet, unter: rest.join('/') };
    }

    onMqtt(topic, payload) {
        const text = payload ? payload.toString('utf8') : '';
        if (!text) {
            return;
        }

        // Die Module veroeffentlichen ihre Faehigkeiten selbst als Home-Assistant-Discovery.
        // Daraus kommen Bereich und Schrittweite der Solltemperatur - die unterscheiden sich
        // je Anlage (eine nimmt halbe Grad, die andere nur ganze, Einstellung "ha1c").
        if (topic.startsWith('homeassistant/climate/') && topic.endsWith('/config')) {
            this.klimaConfig(text).catch(e => this.log.debug(`HA config: ${e.message}`));
            return;
        }
        // Aus den Sensor-Discoveries kommt die Einheit von comp/fanfreq (Hz ab Werk, rpm mit
        // ha.comprpm/ha.fanrpm) - der Statuswert selbst traegt keine Einheit.
        const sensor = felder.haSensorAuswerten(topic, text);
        if (sensor) {
            this.einheitSetzen(
                this.geraetId(sensor.geraet),
                sensor.geraet,
                sensor.feld,
                sensor.einheit,
                'discovery',
            ).catch(e => this.log.debug(`HA config: ${e.message}`));
            return;
        }

        const t = this.topicZerlegen(topic);
        if (!t) {
            return;
        } // command/…, Faikout/… - nicht ausgewertet
        this.gesehen.set(t.geraet, Date.now());

        if (t.art === 'error') {
            const abgelehnt = felder.abgelehntAuswerten(t.unter, text);
            if (abgelehnt) {
                this.einstellungAbgelehnt(t.geraet, abgelehnt).catch(e => this.log.warn(`${t.geraet}: ${e.message}`));
            } else if (
                t.unter === 'temp' &&
                /"description"\s*:\s*"Unknown"/.test(text) &&
                this.regelung &&
                this.regelung.autoAn(this.geraetId(t.geraet))
            ) {
                // Firmware-Eigenheit: Bei eingeschaltetem Faikout-Auto legt `command/<Name>/temp` das
                // Ziel als autot ab und meldet trotzdem "Unknown" - der Befehl hat gewirkt.
                this.log.debug(`${t.geraet}: temp stored as auto target (module reports "Unknown" - harmless)`);
            } else {
                // Der Unterpfad sagt, WAS schiefging (comms, unsupported, ...) - bis 0.0.18 fehlte er.
                this.log.warn(`${t.geraet}: ${t.unter ? `${t.unter}: ` : ''}${text}`);
            }
            return;
        }

        let daten;
        try {
            daten = JSON.parse(text);
        } catch {
            this.log.debug(`No JSON on "${topic}": ${text.slice(0, 80)}`);
            return;
        }
        if (!daten || typeof daten !== 'object') {
            return;
        }

        // state/<Name> ist die Hauptmeldung im Klartext. state/<Name>/status liefert dasselbe
        // im nativen Format (mode "C" statt "cool") - das waere doppelt und wird uebergangen,
        // bis auf die Betriebsart bei ausgeschalteter Anlage (selectedMode).
        if (t.art === 'state' && !t.unter) {
            if (felder.ohneHaEnable(daten) && !this.haWarnung.has(t.geraet)) {
                this.haWarnung.add(t.geraet);
                this.log.warn(
                    `${t.geraet}: the module sends diagnostics only - enable the setting "ha.enable" ("Home Assistant") in the module, otherwise no temperatures, mode or energy values arrive.`,
                );
            }
            // Die gewaehlte Betriebsart (ohne "off") laeuft als eigenes Feld mit.
            const gewaehlt = felder.gewaehlteBetriebsart(daten, false);
            // Dazu die Zahl-Zwillinge (modeNum, fanNum ...) fuer Lovelace und Co.
            const werte = felder.zahlZwillingeErgaenzen(gewaehlt ? { ...daten, selectedMode: gewaehlt } : daten);
            this.werteUebernehmen(t.geraet, werte)
                .then(() => this.regelung && this.regelung.meldung(this.geraetId(t.geraet), t.geraet, daten))
                .catch(e => this.log.warn(`${t.geraet}: ${e.message}`));
        } else if (t.art === 'state' && t.unter === 'status') {
            // Aus der nativen Meldung nur die Betriebsart einer AUSGESCHALTETEN Anlage - der Rest
            // steht schon in state/<Name>.
            if (this.regelung) {
                this.regelung.nativ(this.geraetId(t.geraet), daten);
            }
            const gewaehlt = felder.gewaehlteBetriebsart(daten, true);
            if (gewaehlt) {
                this.werteUebernehmen(t.geraet, { selectedMode: gewaehlt }).catch(e =>
                    this.log.warn(`${t.geraet}: ${e.message}`),
                );
            }
        } else if (t.art === 'info' && t.unter === 'upgrade') {
            this.werteUebernehmen(t.geraet, { version: daten.version, build: daten.build }).catch(() => {});
        }
    }

    /**
     * Die Klimaanlage hat eine Einstellung nicht uebernommen (Meldung error/<Name>/failed-set).
     *
     * Bis 0.0.18 stand dafuer nur die nackte Nutzlast im Log (`Daikin 1OG: {"demand":90}`) - nicht
     * zu erkennen, dass die ANLAGE abgelehnt hat und nicht der Adapter oder ein Skript den Wert
     * zurueckgestellt hat. Jetzt: Klartext-Warnung und der Datenpunkt `info.failedSet` mit Feld,
     * verlangtem Wert und Zeit. Den wirklichen Wert der Anlage liefert das Modul mit seiner
     * naechsten Statusmeldung selbst; `control.*` wird hier deshalb nicht angefasst.
     *
     * Dieselbe Ablehnung kommt bei einem zyklisch schreibenden Skript immer wieder. Als Warnung
     * erscheint sie hoechstens einmal je Stunde, dazwischen auf Debug-Stufe; der Datenpunkt wird
     * jedes Mal aktualisiert.
     *
     * @param {string} geraetName  Name des Moduls
     * @param {{settings: object, text: string, details?: object}} abgelehnt  Ergebnis von felder.abgelehntAuswerten()
     */
    async einstellungAbgelehnt(geraetName, abgelehnt) {
        const jetzt = Date.now();
        const letzte = this.abgelehntWarnung.get(geraetName);
        const wiederholt = letzte && letzte.text === abgelehnt.text && jetzt - letzte.zeit < 3600000;
        const stateId = `${this.geraetId(geraetName)}.info.${felder.objektId('failed-set')}`;
        const meldung = `${geraetName}: the air conditioner did not accept ${abgelehnt.text}. The module gave up after several attempts and reports the value of the unit again (data point ${this.namespace}.${stateId}).`;
        if (wiederholt) {
            this.log.debug(meldung);
        } else {
            this.abgelehntWarnung.set(geraetName, { text: abgelehnt.text, zeit: jetzt });
            this.log.warn(meldung);
        }
        const inhalt = { time: new Date(jetzt).toISOString(), settings: abgelehnt.settings };
        if (abgelehnt.details) {
            inhalt.details = abgelehnt.details;
        }
        await this.werteUebernehmen(geraetName, { 'failed-set': JSON.stringify(inhalt) });
        if (this.regelung) {
            await this.regelung.abgelehnt(this.geraetId(geraetName), abgelehnt.settings);
        }
    }

    /**
     * Wertet die HA-Discovery einer Klimaeinheit aus und uebernimmt Bereich und Schrittweite
     * der Solltemperatur ins Objekt `control.target`.
     *
     * @param {string} text   JSON der HA-Discovery-Nachricht
     */
    async klimaConfig(text) {
        const c = JSON.parse(text);
        // Der Geraetename steckt im Verfuegbarkeits-Topic: "state/Wohnzimmer AC".
        const geraetName = String(c.avty_t || '').replace(/^state\//, '');
        if (!geraetName) {
            return;
        }

        const id = this.geraetId(geraetName);
        const grenzen = {
            min: Number(c.min_temp),
            max: Number(c.max_temp),
            step: Number(c.temp_step),
        };
        if (!isFinite(grenzen.min) || !isFinite(grenzen.max) || !isFinite(grenzen.step)) {
            return;
        }

        const g = this.geraete.get(id);
        if (
            g &&
            g.grenzen &&
            g.grenzen.step === grenzen.step &&
            g.grenzen.min === grenzen.min &&
            g.grenzen.max === grenzen.max
        ) {
            return; // unveraendert - die Discovery wird regelmaessig wiederholt
        }
        if (g) {
            g.grenzen = grenzen;
        }

        const stateId = `${id}.control.target`;
        const vorhanden = await this.getObjectAsync(stateId);
        if (vorhanden) {
            await this.extendObject(stateId, { common: grenzen });
            this.log.info(
                `${geraetName}: target range ${grenzen.min}–${grenzen.max} °C in steps of ${grenzen.step} applied.`,
            );
        }
    }

    /**
     * Uebernimmt die Einheit eines Feldes mit wechselnder Einheit (comp/fanfreq) und zieht ein
     * vorhandenes Objekt nach. Die Einheit wird am Geraeteobjekt gemerkt, damit sie nach einem
     * Neustart schon beim Anlegen stimmt.
     *
     * @param {string} id          Objekt-ID des Geraets
     * @param {string} geraetName  Name des Moduls
     * @param {string} feld        Feldname (comp oder fanfreq)
     * @param {string} einheit     'Hz' oder 'rpm'
     * @param {string} quelle      Herkunft fuer das Log
     */
    async einheitSetzen(id, geraetName, feld, einheit, quelle) {
        const bekannt = this.einheiten.get(id) || {};
        if (bekannt[feld] === einheit) {
            return;
        }
        bekannt[feld] = einheit;
        this.einheiten.set(id, bekannt);

        if (await this.getObjectAsync(id)) {
            await this.extendObject(id, { native: { einheiten: { [feld]: einheit } } });
        }
        const def = felder.FELDER[feld];
        const stateId = `${id}.${def.kanal}.${felder.objektId(feld)}`;
        const obj = await this.getObjectAsync(stateId);
        if (obj && obj.common && obj.common.unit !== einheit) {
            await this.extendObject(stateId, { common: { unit: einheit } });
            this.log.info(`${geraetName}: unit of "${feld}" set to ${einheit} (from ${quelle}).`);
        }
    }

    /**
     * Einheit eines Feldes fuer dieses Geraet: aus der Discovery bzw. gemerkt; fehlt beides, die
     * Einheit eines schon vorhandenen Objekts (sie stammt aus einem frueheren Lauf und wird nicht
     * blind auf den Werksstand zurueckgesetzt), sonst der Werksstand aus der Feldkunde.
     *
     * @param {string} id       Objekt-ID des Geraets
     * @param {string} feld     Feldname
     * @param {object} def      Feldbeschreibung
     * @param {string} stateId  Objekt-ID des Datenpunkts
     * @returns {Promise<string|undefined>} Einheit
     */
    async einheitFuer(id, feld, def, stateId) {
        if (!def.einheiten) {
            return def.unit;
        }
        const e = this.einheiten.get(id);
        if (e && e[feld]) {
            return e[feld];
        }
        const vorhanden = await this.getObjectAsync(stateId);
        const alt = vorhanden && vorhanden.common && vorhanden.common.unit;
        return def.einheiten.includes(alt) ? alt : def.unit;
    }

    /**
     * Legt fehlende Objekte an und schreibt die Werte.
     *
     * @param {string} geraetName   Name des Moduls, wie es sich meldet
     * @param {object} daten        gemeldete Felder
     */
    async werteUebernehmen(geraetName, daten) {
        const id = this.geraetId(geraetName);
        let g = this.geraete.get(id);
        if (!g) {
            // Frueheren Stand uebernehmen, falls es das Geraet aus einem vorherigen Lauf gibt -
            // vor allem den Merker, ob die Luftfeuchte echt ist.
            const alt = await this.getObjectAsync(id);
            g = {
                name: geraetName,
                // Geraeteobjekt gab es vor diesem Lauf nicht - Kandidat fuer die Uebernahme der
                // Zaehler eines umbenannten Moduls (siehe modulIdPruefen()).
                neu: !alt,
                // Hardware-ID des Moduls (Feld `id`, die MAC ohne Doppelpunkte). Erst gesetzt, wenn
                // sie in diesem Lauf gemeldet und gegen die anderen Geraete geprueft wurde.
                modulId: null,
                angelegt: new Set(),
                feuchteEcht: !!(alt && alt.native && alt.native.feuchteEcht),
                // Die Zaehlerstaende muessen den Adapter-Neustart ueberleben, sonst faengt
                // jede Zaehlung wieder bei null an.
                zaehler: (alt && alt.native && alt.native.zaehler) || {},
                grenzen: (alt && alt.native && alt.native.grenzen) || null,
                // Zeitpunkt der letzten Sicherung von native.zaehler und ob seitdem etwas dazukam.
                gesichert: Date.now(),
                zaehlerGeaendert: false,
                // WLAN-Stufe fuer die Geraetekarte (native.wlan), dazu die letzten Rohwerte
                // (ohne native.wlanAus stammt das Objekt aus einem aelteren Stand: einmal neu schreiben)
                wlan: (alt && alt.native && typeof alt.native.wlanAus === 'boolean' && alt.native.wlan) || null,
                rssi: undefined,
                up: undefined,
            };
            // Gemerkte Einheiten aus einem frueheren Lauf; was die Discovery in diesem Lauf
            // schon geliefert hat, hat Vorrang.
            const gemerkt = (alt && alt.native && alt.native.einheiten) || {};
            this.einheiten.set(id, { ...gemerkt, ...(this.einheiten.get(id) || {}) });
            this.geraete.set(id, g);
            await this.extendObject(id, {
                type: 'device',
                common: { name: geraetName },
                native: { faikoutName: geraetName, einheiten: this.einheiten.get(id) },
            });
            this.log.info(`Device detected: "${geraetName}" -> ${this.namespace}.${id}`);
            this.verbindungPruefen();
        }
        // Der Name kann sich aendern, wenn der Hostname im Modul umgestellt wird.
        g.name = geraetName;

        // Hardware-ID: erkennt ein umbenanntes Modul, bevor die Zaehler verarbeitet werden.
        if (typeof daten.id === 'string' && daten.id && g.modulId !== daten.id) {
            await this.modulIdPruefen(id, g, daten.id);
        }

        for (const [feld, wert] of Object.entries(daten)) {
            if (wert === null || wert === undefined) {
                continue;
            }
            if (felder.UEBERSPRINGEN.has(feld)) {
                continue;
            }
            if (typeof wert === 'object') {
                continue;
            } // verschachteltes (ble) - eigener Zweig, spaeter

            // Anlagen ohne Feuchtesensor melden dauerhaft 50 - das ist ein Platzhalter, kein
            // Messwert. Erst wenn einmal etwas anderes kam, gibt es wirklich einen Sensor.
            if (feld === 'hum') {
                const urteil = felder.feuchteBewerten(wert, g.feuchteEcht);
                if (urteil.echtAbJetzt && !g.feuchteEcht) {
                    g.feuchteEcht = true;
                    await this.extendObject(id, { native: { feuchteEcht: true } });
                    this.log.info(
                        `${geraetName}: humidity sensor detected (${wert} %) - state is maintained from now on.`,
                    );
                }
                if (!urteil.nehmen) {
                    continue;
                }
            }

            const def = felder.beschreibe(feld, wert);
            const stateId = `${id}.${def.kanal}.${felder.objektId(feld)}`;

            // Ein gebrochener Luefterwert ist sicher Hz - auch ohne Discovery.
            const ausWert = felder.einheitAusWert(feld, wert);
            if (ausWert && g.angelegt.has(stateId)) {
                await this.einheitSetzen(id, geraetName, feld, ausWert, 'value');
            }

            if (!g.angelegt.has(stateId)) {
                const einheit = ausWert || (await this.einheitFuer(id, feld, def, stateId));
                await this.objektAnlegen(id, def, feld, stateId, einheit);
                g.angelegt.add(stateId);
                if (ausWert) {
                    await this.einheitSetzen(id, geraetName, feld, ausWert, 'value');
                }
            }
            await this.wertSchreiben(stateId, felder.umrechnen(def, wert));
        }

        await this.zaehlerVerarbeiten(id, g, daten);
        await this.wlanStufeAktualisieren(id, g, daten);
    }

    /**
     * Haelt die WLAN-Stufe der Geraetekarte im Geraeteobjekt aktuell (native.wlan: s1..s4/off, dazu
     * native.wlanAn: s1..s4 oder leer und native.wlanAus: true/false).
     * Die Karte zeigt damit EIN WLAN-Symbol, das Signalstaerke und Verbindung zusammenfasst - dafuer
     * braucht sie rssi und up zugleich, eine Kartenanzeige haengt aber nur an einem Wert. Geschrieben
     * wird nur, wenn sich die Stufe aendert (selten), nicht bei jedem dBm.
     *
     * @param {string} id     Objekt-ID des Geraets
     * @param {object} g      gemerkter Zustand des Geraets
     * @param {object} daten  gemeldete Felder
     */
    async wlanStufeAktualisieren(id, g, daten) {
        if (typeof daten.rssi === 'number') {
            g.rssi = daten.rssi;
        }
        if (typeof daten.up === 'boolean') {
            g.up = daten.up;
        }
        if (!('rssi' in daten) && !('up' in daten)) {
            return;
        }
        const stufe = felder.wlanStufe(g.rssi, g.up);
        if (stufe && stufe !== g.wlan) {
            g.wlan = stufe;
            // wlanAn/wlanAus: die Karte zeigt verbunden (Stufe mit "… dBm") und getrennt (ohne Einheit)
            // als zwei Anzeigen, von denen immer nur eine einen Wert hat
            const aus = stufe === 'off';
            await this.extendObject(id, { native: { wlan: stufe, wlanAn: aus ? '' : stufe, wlanAus: aus } });
        }
    }

    /**
     * Schreibt einen Wert mit ack, aber nur, wenn er sich gegenueber dem zuletzt geschriebenen
     * geaendert hat oder dieser aelter als AUFFRISCHEN_MS ist. Bewusst kein setStateChanged -
     * das liest den Wert vorher aus der Datenbank und spart damit nichts.
     *
     * @param {string} stateId  Objekt-ID ohne Namensraum
     * @param {string|number|boolean|null} val         Wert
     */
    async wertSchreiben(stateId, val) {
        const jetzt = Date.now();
        const letzt = this.geschrieben.get(stateId);
        if (letzt && letzt.val === val && jetzt - letzt.zeit < AUFFRISCHEN_MS) {
            return;
        }
        // Laufwerte (Zeitstempel, Laufzeit) aendern sich mit JEDER Meldung. Ein Modul, das bei jeder
        // Leistungsaenderung meldet, erzeugte so mehrere Schreibvorgaenge je Minute ohne neuen
        // Inhalt - sie werden hoechstens einmal je Minute geschrieben.
        if (letzt && jetzt - letzt.zeit < LAUFWERT_MS && LAUFWERTE.test(stateId)) {
            return;
        }
        await this.setState(stateId, { val, ack: true });
        this.geschrieben.set(stateId, { val, zeit: jetzt });
    }

    /**
     * Bildet aus den Lebensdauer-Zaehlern die Stunden- und Tagesverbraeuche.
     *
     * @param {string} id      Objekt-ID des Geraets
     * @param {object} g       gemerkter Zustand des Geraets
     * @param {object} daten   gemeldete Felder mit den Lebensdauer-Zaehlern
     */
    async zaehlerVerarbeiten(id, g, daten) {
        const jetzt = new Date();
        let sofortSichern = false;
        for (const z of ZAEHLER) {
            const roh = daten[z.feld];
            if (typeof roh !== 'number') {
                continue;
            }
            const bisher = g.zaehler[z.feld] || null;
            // Frueh abbrechen: gleicher Rohwert in derselben Stunde - es kaeme dasselbe heraus.
            // Erst nachdem der Zweig in diesem Lauf einmal angelegt und geschrieben wurde.
            if (g.angelegt.has(`${id}.${CONSUMPTION}.${z.zweig}`) && verbrauch.unveraendert(bisher, roh, jetzt)) {
                continue;
            }
            const ergebnis = verbrauch.verarbeiten(bisher, roh, jetzt);
            g.zaehler[z.feld] = ergebnis.stand;
            g.zaehlerGeaendert = true;
            // Sofort sichern bei erstem Wert, Stundenwechsel (schliesst Tag und Monat ein) und
            // allem, was einen Hinweis erzeugt (neu basieren, Luecke).
            if (
                !bisher ||
                bisher.letzterWert === null ||
                bisher.stunde !== ergebnis.stand.stunde ||
                ergebnis.hinweise.length
            ) {
                sofortSichern = true;
            }
            ergebnis.hinweise.forEach(h => this.log.info(`${g.name} ${z.name.en.toLowerCase()}: ${h}`));
            await this.verbrauchSchreiben(id, g, z, ergebnis.werte);
        }
        if (sofortSichern || (g.zaehlerGeaendert && Date.now() - g.gesichert >= SICHERN_MS)) {
            await this.zaehlerstandSichern(id, g);
        }
    }

    async verbrauchSchreiben(id, g, z, werte) {
        const basis = `${id}.${CONSUMPTION}.${z.zweig}`;
        if (!g.angelegt.has(basis)) {
            await this.verbrauchAnlegen(id, z);
            g.angelegt.add(basis);
        }

        for (const f of VERBRAUCH_FELDER) {
            const wert = werte[f.id];
            if (wert === null || wert === undefined) {
                continue;
            }
            await this.wertSchreiben(`${basis}.${f.id}`, wert);
        }
        // Die Stundenreihe aendert sich nur beim Stundenwechsel; Tages- und Monatsreihe tragen den
        // laufenden Tag/Monat und werden ueber den Textvergleich in wertSchreiben() gefiltert.
        const stunde = g.zaehler[z.feld] && g.zaehler[z.feld].stunde;
        for (const r of VERBRAUCH_REIHEN) {
            const stateId = `${basis}.${r.id}`;
            if (r.quelle === 'hours' && stunde && this.reihenStunde.get(stateId) === stunde) {
                continue;
            }
            await this.wertSchreiben(stateId, JSON.stringify(werte[r.quelle] || []));
            if (r.quelle === 'hours') {
                this.reihenStunde.set(stateId, stunde);
            }
        }
    }

    /**
     * Legt Kanal und Datenpunkte eines Zaehlerzweigs an.
     *
     * @param {string} id   Objekt-ID des Geraets
     * @param {object} z    Eintrag aus ZAEHLER
     */
    async verbrauchAnlegen(id, z) {
        const basis = `${id}.${CONSUMPTION}.${z.zweig}`;
        await this.extendObject(`${id}.${CONSUMPTION}`, {
            type: 'channel',
            common: { name: namen.vollerName({ en: 'Consumption', de: 'Verbrauch' }) },
            native: {},
        });
        await this.extendObject(basis, {
            type: 'channel',
            common: { name: namen.vollerName(z.name) },
            native: {},
        });
        for (const f of VERBRAUCH_FELDER) {
            await this.zaehlerObjekt(`${basis}.${f.id}`, f.name, 'kWh', 'value.energy.consumed');
        }
        for (const r of VERBRAUCH_REIHEN) {
            await this.extendObject(`${basis}.${r.id}`, {
                type: 'state',
                common: {
                    name: namen.vollerName(r.name),
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
    }

    /**
     * Zieht den Verbrauchszweig von den deutschen IDs bis 0.0.13 (`verbrauch.gesamt.heute` ...)
     * auf die englischen (`consumption.total.today` ...) um.
     *
     * Review vom 11.10.2026: Objekt-IDs muessen englisch sein. Damit beim Update nichts verloren
     * geht, werden die letzten Werte uebernommen und erst danach die alten Objekte geloescht.
     * Die JSON-Reihen bekommen dabei ihre englischen Schluessel (hour/day/month). Was der
     * History-Adapter unter den alten IDs aufgezeichnet hat, bleibt dort stehen - die neuen
     * Datenpunkte werden wieder angemeldet und zeichnen ab jetzt auf.
     */
    async verbrauchUmziehen() {
        let geraete;
        try {
            geraete = await this.getDevicesAsync();
        } catch (e) {
            this.log.debug(`Consumption migration skipped: ${e.message}`);
            return;
        }
        const umbenennen = { stunde: 'hour', tag: 'day', monat: 'month' };
        for (const geraet of geraete) {
            const id = geraet._id.slice(this.namespace.length + 1);
            if (!(await this.getObjectAsync(`${id}.verbrauch`))) {
                continue;
            }
            for (const z of ZAEHLER) {
                const altBasis = `${id}.verbrauch.${z.alt}`;
                if (!(await this.getObjectAsync(altBasis))) {
                    continue;
                }
                await this.verbrauchAnlegen(id, z);
                const neuBasis = `${id}.${CONSUMPTION}.${z.zweig}`;
                for (const f of VERBRAUCH_FELDER) {
                    const alt = await this.getStateAsync(`${altBasis}.${f.alt}`);
                    if (alt && alt.val !== null && alt.val !== undefined) {
                        await this.setState(`${neuBasis}.${f.id}`, { val: alt.val, ack: true });
                    }
                }
                for (const r of VERBRAUCH_REIHEN) {
                    const alt = await this.getStateAsync(`${altBasis}.${r.alt}`);
                    if (!alt || typeof alt.val !== 'string') {
                        continue;
                    }
                    try {
                        const reihe = JSON.parse(alt.val).map(e => {
                            const neu = {};
                            for (const [k, v] of Object.entries(e)) {
                                neu[umbenennen[k] || k] = v;
                            }
                            return neu;
                        });
                        await this.setState(`${neuBasis}.${r.id}`, { val: JSON.stringify(reihe), ack: true });
                    } catch {
                        // unbrauchbare Reihe - sie entsteht mit der naechsten Meldung neu
                    }
                }
            }
            await this.delObjectAsync(`${id}.verbrauch`, { recursive: true });
            this.log.info(
                `${geraet.common && geraet.common.name}: consumption states moved from "verbrauch.*" to "${CONSUMPTION}.*".`,
            );
        }
    }

    /**
     * Legt einen Verbrauchs-Datenpunkt an und meldet ihn - wenn gewuenscht - gleich beim
     * History-Adapter zur Aufzeichnung an. Das erspart es, jeden Punkt von Hand im Admin
     * einzuschalten.
     *
     * @param {string} stateId   vollstaendige Objekt-ID
     * @param {string} name      Anzeigename
     * @param {string} unit      Einheit
     * @param {string} role      ioBroker-Rolle
     */
    async zaehlerObjekt(stateId, name, unit, role) {
        const common = {
            name: namen.vollerName(name),
            type: 'number',
            role,
            unit,
            read: true,
            write: false,
        };
        // historyInstanz/historyAnmelden sind die Schluessel bis 0.0.13 - eine bestehende
        // Konfiguration gilt weiter, bis sie im Admin neu gespeichert wird.
        const instanz = String(this.config.historyInstance ?? this.config.historyInstanz ?? '').trim();
        const anmelden = this.config.historyRegister ?? this.config.historyAnmelden;
        if (anmelden && instanz) {
            common.custom = {
                [instanz]: { enabled: true, changesOnly: false, debounce: 0, retention: 0 },
            };
        }
        await this.extendObject(stateId, { type: 'state', common, native: {} });
    }

    /**
     * Namen und Rollen vorhandener Datenpunkte an die aktuelle Feldkunde angleichen.
     *
     * Objekte entstehen erst, wenn ein Wert kommt. Felder, die selten kommen (etwa `reason` aus
     * dem MQTT-Last-Will beim Trennen), behielten sonst nach einem Update ihre alte Beschreibung -
     * ein unbekannt angelegtes Feld blieb dann bei Namen nur in en/de (Objektpruefung E6001).
     * Geraetabhaengige Werte (min/max/step) bleiben unangetastet.
     */
    async objekteAbgleichen() {
        try {
            const sicht = await this.getObjectViewAsync('system', 'state', {
                startkey: `${this.namespace}.`,
                endkey: `${this.namespace}.\u9999`,
            });
            let angepasst = 0;
            for (const zeile of sicht.rows) {
                const o = zeile.value;
                const feld = o && o.native && o.native.feld;
                const def = feld && felder.FELDER[feld];
                if (!def) {
                    // Unbekanntes Feld: Name in allen elf Sprachen nachtragen (bis 0.0.13 nur en/de).
                    const n = o && o.common && o.common.name;
                    if (feld && n && typeof n === 'object' && felder.SPRACHEN.some(l => !n[l])) {
                        await this.extendObject(o._id, {
                            common: { name: Object.fromEntries(felder.SPRACHEN.map(l => [l, n[l] || n.en || feld])) },
                        });
                        angepasst++;
                    }
                    continue;
                }
                // Falscher Kanal: bis 0.0.16 unbekannte Felder (dma, restart) lagen unter status.*,
                // gehoeren aber nach info.*. Umziehen mit dem letzten Wert.
                const teile = o._id.slice(this.namespace.length + 1).split('.');
                if (teile.length === 3 && teile[1] !== def.kanal && KANAELE.includes(teile[1])) {
                    await this.objektUmziehen(o, teile[0], def, feld);
                    angepasst++;
                    continue;
                }
                const name = namen.vollerName(def.name);
                if (JSON.stringify(o.common.name) !== JSON.stringify(name) || o.common.role !== def.role) {
                    await this.extendObject(o._id, { common: { name, role: def.role } });
                    angepasst++;
                }
            }
            if (angepasst) {
                this.log.info(`${angepasst} existing state(s) updated to the current field description.`);
            }
        } catch (e) {
            this.log.debug(`Object update skipped: ${e.message}`);
        }
    }

    /**
     * Legt einen Datenpunkt im richtigen Kanal neu an, uebernimmt den letzten Wert und loescht
     * den alten.
     *
     * @param {object} alt       bisheriges Objekt
     * @param {string} geraetId  Objekt-ID des Geraets
     * @param {object} def       Feldbeschreibung
     * @param {string} feld      Feldname
     */
    async objektUmziehen(alt, geraetId, def, feld) {
        const neuId = `${geraetId}.${def.kanal}.${felder.objektId(feld)}`;
        await this.objektAnlegen(geraetId, def, feld, neuId, await this.einheitFuer(geraetId, feld, def, neuId));
        const wert = await this.getForeignStateAsync(alt._id);
        if (wert && wert.val !== null && wert.val !== undefined) {
            await this.setState(neuId, { val: wert.val, ack: true });
        }
        await this.delForeignObjectAsync(alt._id);
        this.log.info(`State ${alt._id} moved to ${this.namespace}.${neuId}.`);
    }

    async zaehlerstandSichern(id, g) {
        // Nie ein geloeschtes Geraeteobjekt per extendObject als Rumpf wiederbeleben (Issue #6).
        if (!(await this.geraetNochDa(id, g))) {
            return;
        }
        g.gesichert = Date.now();
        g.zaehlerGeaendert = false;
        await this.extendObject(id, { native: { zaehler: g.zaehler } });
    }

    // ---------------------------------------------------------------- Umbenennen und Loeschen (Issue #6)

    /**
     * Ist das Geraet noch im Speicher UND sein Geraeteobjekt noch vorhanden? Fehlt das Objekt (vom
     * Nutzer geloescht), wird das Geraet vergessen. Meldet sich das Modul weiter, entsteht es mit
     * der naechsten Nachricht vollstaendig neu.
     *
     * @param {string} id  Objekt-ID des Geraets
     * @param {object} g   gemerkter Zustand des Geraets
     * @returns {Promise<boolean>} true, wenn weitergeschrieben werden darf
     */
    async geraetNochDa(id, g) {
        if (this.geraete.get(id) !== g) {
            return false;
        }
        if (await this.getObjectAsync(id)) {
            return true;
        }
        this.geraetVergessen(id, 'its objects were deleted');
        return false;
    }

    /**
     * Nimmt ein Geraet aus allen Speichern des laufenden Adapters, die am Geraet bzw. seinem Namen
     * haengen. Die Einheiten (this.einheiten) bleiben: sie stammen aus der Discovery, die nicht
     * wiederholt wird, und schaden ohne Geraet nicht.
     *
     * @param {string} id     Objekt-ID des Geraets
     * @param {string} grund  Grund fuers Log
     */
    geraetVergessen(id, grund) {
        const g = this.geraete.get(id);
        if (!g) {
            return;
        }
        this.geraete.delete(id);
        if (this.regelung) {
            this.regelung.geraete.delete(id);
        }
        const praefix = `${id}.`;
        for (const speicher of [this.geschrieben, this.reihenStunde]) {
            for (const schluessel of [...speicher.keys()]) {
                if (schluessel.startsWith(praefix)) {
                    speicher.delete(schluessel);
                }
            }
        }
        this.haWarnung.delete(g.name);
        this.abgelehntWarnung.delete(g.name);
        this.log.info(`"${g.name}" (${this.namespace}.${id}) is no longer updated: ${grund}.`);
        this.verbindungPruefen();
    }

    /**
     * Ein Objekt im eigenen Namensraum wurde geloescht. Alles, was der Adapter darueber im Speicher
     * hat, muss weg - sonst haelt er den Datenpunkt fuer angelegt und schreibt per setState auf ein
     * Objekt, das es nicht mehr gibt. Ist es das Geraeteobjekt selbst, wird das Geraet vergessen.
     *
     * @param {string} volleId  Objekt-ID mit Namensraum
     * @param {ioBroker.Object | null | undefined} obj  neues Objekt, null/undefined beim Loeschen
     */
    onObjectChange(volleId, obj) {
        if (volleId === 'system.config') {
            if (obj && this.regelung && !this.stopping) {
                this.regelung.sprachWechsel().catch(e => this.log.warn(`Language change: ${e.message}`));
            }
            return;
        }
        if (obj || !volleId.startsWith(`${this.namespace}.`)) {
            return;
        }
        const id = volleId.slice(this.namespace.length + 1);
        const geraetId = id.split('.')[0];
        const g = this.geraete.get(geraetId);
        if (!g) {
            return;
        }
        if (id === geraetId) {
            this.geraetVergessen(geraetId, 'its objects were deleted');
            return;
        }
        this.geschrieben.delete(id);
        this.reihenStunde.delete(id);
        // Den Eintrag selbst, alles darunter und die Zweige darueber (consumption.total steht fuer
        // den ganzen Zweig) - fehlt einer seiner Datenpunkte, wird der Zweig neu angelegt.
        for (const a of [...g.angelegt]) {
            if (a === id || a.startsWith(`${id}.`) || id.startsWith(`${a}.`)) {
                g.angelegt.delete(a);
            }
        }
    }

    /**
     * Prueft die Hardware-ID eines Moduls gegen die anderen Geraete. Der Objektbaum haengt am
     * Hostnamen; wird der im Modul umgestellt, meldet sich dasselbe Modul unter neuem Namen.
     * Bis 0.2.0 lief das alte Geraet dann im Speicher weiter (Issue #6).
     *
     * Ein anderes Geraet mit derselben ID ist der fruehere Name dieses Moduls. Es wird vergessen und
     * im Objekt als umbenannt markiert (native.renamedTo), damit es nicht bei jedem Start erneut
     * auffaellt; seine Objekte und Verlaufsdaten bleiben unangetastet - loeschen kann sie der Nutzer.
     * Die Zaehlerstaende (Basis fuer heute, Monat und die JSON-Reihen) werden uebernommen, wenn das
     * Geraet unter dem neuen Namen noch keine eigene Geschichte hat: Geraeteobjekt in diesem Lauf
     * neu angelegt, noch kein Zaehlerstand, oder selbst frueher als umbenannt markiert (Modul hat
     * seinen alten Namen zurueck). Sonst bleiben die eigenen Zaehler - nichts wird ueberschrieben.
     *
     * @param {string} id       Objekt-ID des Geraets
     * @param {object} g        gemerkter Zustand des Geraets
     * @param {string} modulId  gemeldete Hardware-ID
     */
    async modulIdPruefen(id, g, modulId) {
        g.modulId = modulId;
        const eigen = await this.getObjectAsync(id);
        const eigenNative = (eigen && eigen.native) || {};
        const ohneGeschichte = g.neu || !Object.keys(g.zaehler).length || !!eigenNative.renamedTo;

        // aid -> {name, zaehler, objekt}
        const frueher = new Map();
        // Im Speicher: das Modul lief in diesem Lauf schon unter dem alten Namen.
        for (const [aid, ag] of this.geraete) {
            if (aid !== id && ag.modulId === modulId) {
                frueher.set(aid, { name: ag.name, zaehler: ag.zaehler, objekt: false });
            }
        }
        // Im Objektbaum: alter Name aus einem frueheren Lauf. native.modulId gibt es erst nach 0.2.0, davor
        // steht die ID nur im Datenpunkt info.id.
        try {
            for (const geraet of await this.getDevicesAsync()) {
                const aid = geraet._id.slice(this.namespace.length + 1);
                const n = geraet.native || {};
                if (aid === id || n.renamedTo) {
                    continue;
                }
                let gleich = n.modulId === modulId;
                if (!gleich && !n.modulId) {
                    const st = await this.getStateAsync(`${aid}.info.id`);
                    gleich = !!st && st.val === modulId;
                }
                if (!gleich) {
                    continue;
                }
                const bekannt = frueher.get(aid);
                frueher.set(aid, {
                    name: bekannt ? bekannt.name : n.faikoutName || aid,
                    // Speicherstand ist aktueller als der zuletzt gesicherte im Objekt.
                    zaehler: bekannt ? bekannt.zaehler : n.zaehler || null,
                    objekt: true,
                });
            }
        } catch (e) {
            this.log.debug(`Device lookup for module ${modulId} skipped: ${e.message}`);
        }

        let uebernommen = null;
        for (const [aid, alt] of frueher) {
            this.geraetVergessen(aid, `module ${modulId} now reports as "${g.name}"`);
            if (alt.objekt) {
                await this.extendObject(aid, { native: { modulId, renamedTo: id } });
            }
            const hatZaehler = alt.zaehler && Object.keys(alt.zaehler).length;
            if (ohneGeschichte && hatZaehler && !uebernommen) {
                g.zaehler = JSON.parse(JSON.stringify(alt.zaehler));
                uebernommen = alt.name;
            }
            const zusatz = uebernommen === alt.name ? 'Consumption counters taken over. ' : '';
            this.log.info(
                `"${g.name}": module ${modulId} was known as "${alt.name}" (${this.namespace}.${aid}). ${zusatz}The old objects are no longer updated and can be deleted.`,
            );
        }

        const native = { modulId };
        if (eigenNative.renamedTo) {
            native.renamedTo = null;
        }
        if (uebernommen) {
            native.zaehler = g.zaehler;
            g.gesichert = Date.now();
            g.zaehlerGeaendert = false;
        }
        if (eigen && (eigenNative.modulId !== modulId || eigenNative.renamedTo || uebernommen)) {
            await this.extendObject(id, { native });
        }
    }

    async objektAnlegen(geraetId, def, feld, stateId, einheit = def.unit) {
        await this.extendObject(`${geraetId}.${def.kanal}`, {
            type: 'channel',
            common: { name: namen.vollerName(this.kanalName(def.kanal)) },
            native: {},
        });
        const common = {
            name: namen.vollerName(def.name),
            type: def.type,
            role: def.role,
            read: true,
            write: !!def.w,
        };
        if (einheit) {
            common.unit = einheit;
        }
        if (def.states) {
            common.states = def.states;
        }
        if (def.min !== undefined) {
            common.min = def.min;
        }
        if (def.max !== undefined) {
            common.max = def.max;
        }
        if (def.step !== undefined) {
            common.step = def.step;
        }

        await this.extendObject(stateId, { type: 'state', common, native: { feld } });
        if (def.unbekannt) {
            this.log.info(
                `Unknown field "${feld}" created (${def.type}) - please report it so it can be described properly.`,
            );
        }
    }

    kanalName(kanal) {
        return (
            {
                control: { en: 'Control', de: 'Steuerung' },
                status: { en: 'Readings', de: 'Messwerte' },
                info: { en: 'Device info', de: 'Geräteinfo' },
            }[kanal] || kanal
        );
    }

    /**
     * Objekttaugliche ID aus dem Geraetenamen - Leerzeichen und Sonderzeichen raus.
     *
     * @param {string} name   Geraetename aus dem Topic
     * @returns {string} ID-taugliche Schreibweise
     */
    geraetId(name) {
        return name.replace(/[\s.\][*,;'"`<>\\?]+/g, '_');
    }

    // ---------------------------------------------------------------- MQTT hinaus

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        } // nur eigene Befehle, nicht die eigenen Rueckmeldungen

        // Schalter der Bedarfsregelung: nie ein Befehl ans Modul.
        const teileR = id.split('.');
        if (teileR[3] === 'regulation') {
            if (this.regelung) {
                await this.regelung.schalter(teileR[2], teileR.slice(4).join('.'), state.val);
            }
            return;
        }

        const obj = await this.getObjectAsync(id);
        if (!obj || !obj.common || !obj.common.write) {
            return;
        }
        // Der Befehl hat den Datenpunkt ueberschrieben. Die naechste Rueckmeldung des Moduls muss
        // ihn wieder mit ack setzen - auch wenn sie den alten Wert bringt (Anlage lehnt ab).
        this.geschrieben.delete(id.slice(this.namespace.length + 1));

        // faikout.0.<GeraetId>.control.<feld>
        const teile = id.split('.');
        const geraetId = teile[2];
        const feld = (obj.native && obj.native.feld) || teile[teile.length - 1];
        const g = this.geraete.get(geraetId);
        if (!g) {
            this.log.warn(`Command for unknown device ${geraetId} discarded.`);
            return;
        }

        // Manche Felder heissen beim Schreiben anders als beim Lesen: Der Sollwert kommt als
        // `target` herein, das Kommandotopic dafuer heisst aber `temp`.
        const def = felder.FELDER[feld];
        const suffix = (def && def.cmd) || feld;

        // Der ECHTE Geraetename gehoert ins Topic, nicht die bereinigte Objekt-ID.
        const topic = `command/${g.name}/${suffix}`;
        let nutzlast;
        if (def && def.zahlZu) {
            // Zahl-Zwilling (modeNum ...): das Modul versteht nur Text. Der Text-Datenpunkt
            // bleibt unberuehrt - beide ziehen mit der Bestaetigung des Moduls nach. Ihn hier
            // mitzuschreiben (ack=false) loeste einen zweiten Befehl aus.
            nutzlast = felder.zahlZuText(feld, state.val);
            if (nutzlast === null) {
                this.log.warn(
                    `${g.name}: value ${JSON.stringify(state.val)} for ${feld} is not valid (allowed: ${JSON.stringify(def.states)}) - command discarded.`,
                );
                return;
            }
        } else {
            nutzlast = this.nutzlast(feld, state.val);
        }
        if (suffix === 'temp' && this.regelung) {
            this.regelung.zielGesetzt(geraetId, state.val);
        }
        const ok = await this.broker.publish(topic, nutzlast);
        if (ok) {
            this.log.debug(`-> ${topic} = ${nutzlast}`);
            // Das Modul meldet seinen Zustand zyklisch (Einstellung "reporting", ab Werk 60 s)
            // und nicht sofort nach dem Befehl. Der Wert wird deshalb erst mit der naechsten
            // Statusmeldung bestaetigt - hier bewusst kein vorschnelles ack.
        }
    }

    /**
     * Wandelt einen ioBroker-Wert in die Nutzlast, die das Modul erwartet.
     *
     * @param {string} feld   Feldname des Moduls
     * @param {string|number|boolean} wert  Wert aus ioBroker
     * @returns {string} Nutzlast fuer die MQTT-Nachricht
     */
    nutzlast(feld, wert) {
        if (typeof wert === 'boolean') {
            return wert ? 'true' : 'false';
        }
        return String(wert);
    }

    // ---------------------------------------------------------------- Module suchen

    /**
     * Befehle aus den Instanzeinstellungen (Reiter "Module suchen").
     *
     * Nur lesend: Gesucht wird einmalig je Klick, nie im Hintergrund. Formularwerte der Module
     * (Broker, Benutzer) werden nicht geloggt und nicht gespeichert.
     *
     * @param {ioBroker.Message} obj Nachricht
     */
    async onMessage(obj) {
        if (!obj || !obj.command || obj.command.startsWith('dm:')) {
            return;
        }
        if (await require('./lib/oberflaeche').nachricht(this, obj)) {
            return;
        } // Oberflaeche der Regelung
        const antworten = antwort => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, antwort, obj.callback);
            }
        };
        const msg = obj.message && typeof obj.message === 'object' ? obj.message : {};
        try {
            switch (obj.command) {
                case 'adresseVorschlag': {
                    // defaultSendTo: Rohwert = Vorbelegung des Felds "Adresse fuer Module"
                    const vorhanden = feldWert(msg.value) || String(this.config.moduleAddress || '').trim();
                    return antworten(vorhanden || discovery.adressenErmitteln().vorschlag || null);
                }
                case 'adresseHinweis': {
                    const sprache = await this.sprache();
                    const a = discovery.adressenErmitteln();
                    const liste = a.adressen.join(', ') || '-';
                    return antworten(
                        a.nurDocker
                            ? suche.text(suche.ERGEBNIS_TEXTE.dockerHinweis, sprache, { a: liste })
                            : suche.text(suche.ERGEBNIS_TEXTE.adressenErkannt, sprache, { a: liste }),
                    );
                }
                case 'brokerTesten': {
                    // Knopf "Verbindung testen": Werte aus dem (ungespeicherten) Formular; ein leeres
                    // Passwortfeld heisst "das gespeicherte nehmen".
                    const r = await brokerextern.testen({
                        host: feldWert(msg.host),
                        port: Number(feldWert(msg.port)) || undefined,
                        tls: msg.tls === true || msg.tls === 'true',
                        user: feldWert(msg.user),
                        pass: feldWert(msg.pass) || String(this.config.externPass || ''),
                        clientId: feldWert(msg.clientId) || brokerextern.standardClientId(this.instance),
                    });
                    return antworten(r);
                }
                case 'mqtthostWert': {
                    // Ohne Adresse nur ein Strich: das Feld ist schmal und laesst sich kopieren - der Weg
                    // zur fehlenden Adresse steht im Text daneben bzw. in der Anleitung darunter.
                    const z = this.zielAusFormular(msg);
                    return antworten(z.adresse ? `${z.adresse}:${z.port}` : '–');
                }
                case 'anleitung': {
                    const sprache = await this.sprache();
                    const z = this.zielAusFormular(msg);
                    if (!z.adresse) {
                        const o = require('./lib/oberflaeche');
                        return antworten(htmlZeilen(o.t(z.extern ? 'mqttWertFehltExtern' : 'mqttWertFehlt', sprache)));
                    }
                    return antworten(
                        htmlZeilen(
                            discovery.anleitung({
                                adresse: z.adresse,
                                port: z.port,
                                user: z.user,
                                sprache: sprache === 'de' ? 'de' : 'en',
                            }),
                        ),
                    );
                }
                case 'suchen':
                case 'adressePruefen': {
                    const sprache = await this.sprache();
                    const ziel = obj.command === 'adressePruefen' ? feldWert(msg.ziel) : '';
                    if (obj.command === 'adressePruefen' && !ziel) {
                        return antworten({ error: suche.text(suche.ERGEBNIS_TEXTE.adresseFehlt, sprache) });
                    }
                    if (this.sucheLaeuft) {
                        return antworten({ error: require('./lib/oberflaeche').t('sucheLaeuft', sprache) });
                    }
                    this.sucheLaeuft = true;
                    try {
                        const r = await suche.suchen({
                            ziel,
                            adressen: this.eigeneAdressen(feldWert(msg.adresse)),
                            port: this.brokerZiel().port,
                            geraete: this.geraeteFuerSuche(),
                            sprache,
                            timer: this,
                        });
                        // Im Log nur die Anzahl - keine Adressen von Brokern, keine Formularwerte.
                        this.log.info(
                            ziel
                                ? `Module check: ${r.fingerprints.length ? 'faikout module answered' : 'no faikout module'}`
                                : `Module search: ${r.fingerprints.length} faikout module(s) among ${r.kandidaten} mDNS candidate(s)`,
                        );
                        if (!ziel) {
                            this.letzteSuche = r.fingerprints.map(f => ({
                                ip: f.adresse,
                                name: f.titel || f.hostname || f.adresse,
                                status: f.status,
                            }));
                        } else {
                            for (const f of r.fingerprints) {
                                this.letzteSuche = this.letzteSuche.filter(x => x.ip !== f.adresse);
                                this.letzteSuche.push({
                                    ip: f.adresse,
                                    name: f.titel || f.hostname || f.adresse,
                                    status: f.status,
                                });
                            }
                        }
                        // Einzeladressen sammeln sich in der Tabelle (im Docker-Bridge-Netz der normale
                        // Weg, ein Modul nach dem anderen); eine neue mDNS-Suche beginnt von vorn.
                        const neu = r.zeilen.map(({ code: _c, ...z }) => z);
                        if (!ziel) {
                            this.letzteZeilen = neu;
                        } else {
                            const ips = new Set(neu.map(z => z.ip));
                            this.letzteZeilen = [...(this.letzteZeilen || []).filter(z => !ips.has(z.ip)), ...neu];
                        }
                        const uhrzeit = new Date().toLocaleTimeString(sprache, {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                        });
                        // Ohne Treffer und bei leerer Tabelle: ein neutraler Hinweis als Statuszeile (wie bei
                        // "Adresse pruefen"), kein roter Fehlerdialog - nichts gefunden ist kein Fehler
                        // (Nutzerentscheid 21.11.2026). Die Tabelle bleibt unberuehrt. Bekannte Grenze: jeder
                        // Formularwert macht "Speichern" aktiv, auch dieser nicht gespeicherte Hinweis.
                        if (!ziel && !r.fingerprints.length && msg.leer === true && !this.letzteZeilen.length) {
                            return antworten({ native: { _foundText: '', _foundLeer: `${r.text} (${uhrzeit})` } });
                        }
                        return antworten({
                            native: {
                                _found: this.letzteZeilen,
                                _foundText: `${r.text} (${uhrzeit})`,
                                _foundLeer: '',
                            },
                        });
                    } finally {
                        this.sucheLaeuft = false;
                    }
                }
                case 'anbindenPruefen':
                    return antworten(await this.anbindenPruefen(msg));
                case 'anbinden':
                case 'zurueckstellen': {
                    if (this.anbindenLaeuft) {
                        return antworten({
                            error: require('./lib/oberflaeche').t('anbindenLaeuft', await this.sprache()),
                        });
                    }
                    this.anbindenLaeuft = true;
                    try {
                        return antworten(
                            obj.command === 'anbinden'
                                ? await this.anbindenAusfuehren(msg)
                                : await this.zurueckstellen(msg),
                        );
                    } finally {
                        this.anbindenLaeuft = false;
                    }
                }
                default:
                    // Unbekanntes bleibt unbeantwortet (wie bisher), damit fremde Absender nicht haengen
                    // bleiben, sondern in ihr eigenes Zeitlimit laufen.
                    this.log.debug(`Unknown message "${obj.command}" ignored`);
                    return;
            }
        } catch (e) {
            this.log.warn(`${obj.command}: ${e.message}`);
            antworten({ error: e.message });
        }
    }

    /**
     * Vermutete Adresse eines Moduls aus seiner Verbindung zum eigenen Broker. Nur ein Kandidat: hinter
     * Docker-NAT ist es die Adresse des Gateways, und ein Simulator lauscht auf einem anderen Port -
     * die Einstellungsseite prueft sie deshalb, bevor sie sie verwendet.
     *
     * @param {string} name Name des Moduls (so meldet es sich am Broker)
     * @returns {string} IP oder ''
     */
    modulClientAdresse(name) {
        for (const [client, adresse] of this.clientAdressen) {
            const kurz = client.slice(client.indexOf(':') + 1);
            if (this.mqttClients.has(client) && (kurz === name || kurz.startsWith(`${name}_`))) {
                return adresse;
            }
        }
        return '';
    }

    /**
     * Ziel der Module aus dem (UNGESPEICHERTEN) Formular der Einstellungsseite: Die Seite schickt
     * Betriebsart, Adresse, Port und Benutzer mit, damit "Wert fuer MQTT host" und die Anleitung
     * sofort zu dem passen, was der Nutzer gerade eingestellt hat - auch beim Wechsel auf den
     * externen Broker vor dem Speichern. Fehlt die Betriebsart in der Nachricht, gilt die gespeicherte.
     *
     * @param {Record<string, unknown>} msg Formularwerte (modus, adresse, port, user, externHost, externPort, externTls, externUser)
     * @returns {{extern: boolean, adresse: string, port: number, user: string}} Ziel
     */
    zielAusFormular(msg) {
        const gespeichert = this.brokerZiel(feldWert(msg.adresse));
        const modus = feldWert(msg.modus);
        const extern = modus ? modus === 'extern' : gespeichert.extern;
        if (extern) {
            const tls = msg.externTls === undefined ? this.config.externTls === true : msg.externTls === true;
            return {
                extern: true,
                adresse:
                    msg.externHost === undefined
                        ? String(this.config.externHost || '').trim()
                        : feldWert(msg.externHost),
                port: Number(feldWert(msg.externPort)) || Number(this.config.externPort) || (tls ? 8883 : 1883),
                user: msg.externUser === undefined ? String(this.config.externUser || '') : feldWert(msg.externUser),
            };
        }
        return {
            extern: false,
            adresse: feldWert(msg.adresse) || String(this.config.moduleAddress || '').trim(),
            port: Number(feldWert(msg.port)) || Number(this.config.port) || 1888,
            user: msg.user === undefined ? String(this.config.user || '') : feldWert(msg.user),
        };
    }

    /**
     * Zieht Einstellungen aus aelteren Staenden um. Bisher: die Vorgabe-Kennlinien standen als Text
     * "-10:95, 0:75" in der Konfiguration; die Einstellungsseite fuehrt sie jetzt als Tabelle wie
     * beim Geraet. Ein alter Text wird einmal in die Tabelle uebertragen - sonst zeigte die Seite eine
     * leere Tabelle und das naechste Speichern verwuerfe die Kennlinie des Nutzers.
     *
     * @returns {Promise<boolean>} true, wenn die Konfiguration geschrieben wurde (Neustart folgt)
     */
    async konfigUmziehen() {
        const kennlinie = require('./lib/regel/kennlinie');
        const neu = {};
        for (const feld of ['regelKennlinieHeizen', 'regelKennlinieKuehlen']) {
            const wert = this.config[feld];
            if (typeof wert !== 'string') {
                continue;
            }
            const punkte = (kennlinie.lesen(wert).punkte || []).filter(
                p => Number.isFinite(p[0]) && Number.isFinite(p[1]),
            );
            neu[feld] = punkte.map(([x, y]) => ({ x, y }));
            this.config[feld] = neu[feld];
        }
        // Client-ID fuer den externen Broker: der Standardwert wird EINMAL erzeugt, gespeichert und im
        // Feld vorbelegt (Nutzervorgabe 21.11.2026) - frei ueberschreibbar, "Standard wiederherstellen"
        // setzt ihn zurueck.
        if (!String(this.config.externClientIdStandard || '').trim()) {
            neu.externClientIdStandard = brokerextern.neueClientId(this.instance);
            this.config.externClientIdStandard = neu.externClientIdStandard;
        }
        if (!String(this.config.externClientId || '').trim()) {
            neu.externClientId = this.config.externClientIdStandard;
            this.config.externClientId = neu.externClientId;
        }
        Object.assign(neu, this.regelKonfigUmziehen());
        if (!Object.keys(neu).length || typeof this.extendForeignObjectAsync !== 'function') {
            return false;
        }
        this.log.info(`Settings completed (${Object.keys(neu).join(', ')}). The instance restarts once.`);
        const objektId = `system.adapter.${this.namespace}`;
        // Ganz schreiben statt erweitern: extendObject fuehrt Listen elementweise zusammen - ein aus einer
        // Geraetezeile entferntes Feld (szenen) bliebe stehen und der Umzug liefe bei jedem Start erneut.
        // Gelesen wird das gespeicherte Objekt (Passwoerter bleiben verschluesselt, wie sie sind).
        const objekt =
            typeof this.getForeignObjectAsync === 'function' && typeof this.setForeignObjectAsync === 'function'
                ? await this.getForeignObjectAsync(objektId)
                : null;
        if (objekt && objekt.native) {
            for (const [feld, wert] of Object.entries(neu)) {
                if (wert === null) {
                    delete objekt.native[feld];
                } else {
                    objekt.native[feld] = wert;
                }
            }
            await this.setForeignObjectAsync(objektId, objekt);
        } else {
            await this.extendForeignObjectAsync(objektId, { native: neu });
        }
        return true;
    }

    /**
     * Umzug der Einstellungen auf den Stand von 1.0.0 (Teil von konfigUmziehen; aendert this.config und
     * nennt, was in die Instanzkonfiguration zu schreiben ist):
     *   - `User` -> `user`: der Vorabstand 0.5.0-alpha fuehrte den Benutzernamen des eigenen Brokers als
     *     `User`. 1.0.0 liest nur `user` - ohne Umzug verloeren die Module ihre Anmeldung.
     *   - `regelSzenen` -> `regelStufen`, je Geraet `szenen` -> `stufen` ("Szenen" heissen Temperaturstufen).
     *   - einmalig (Merker `regelUmzugStand`): vorhandene Geraeteeintraege bekommen `individuell: true`
     *     (ihr Verhalten bleibt gleich); die Obergrenze 95 und die Heizkennlinie der alten Werksvorgabe
     *     werden auf die neue Werksvorgabe (100 bzw. -10 °C: 100 %) gehoben - nur bei exakter
     *     Uebereinstimmung, eigene Werte bleiben. Der Merker verhindert, dass ein spaeter ohne Haken
     *     angelegter Eintrag oder eine bewusst wieder auf 95 gestellte Obergrenze erneut angefasst wird.
     *
     * @returns {Record<string, unknown>} geaenderte Felder der Instanzkonfiguration (leer = nichts zu tun)
     */
    regelKonfigUmziehen() {
        const kennlinie = require('./lib/regel/kennlinie');
        const c = this.config;
        const neu = {};
        const leer = v => v === undefined || v === null || String(v).trim() === '';
        if (leer(c.user) && !leer(c.User)) {
            neu.user = String(c.User);
            neu.User = '';
            c.user = neu.user;
            c.User = '';
        }
        const gefuellt = v => Array.isArray(v) && v.length > 0;
        if (gefuellt(c.regelSzenen)) {
            if (!gefuellt(c.regelStufen)) {
                neu.regelStufen = c.regelSzenen;
                c.regelStufen = neu.regelStufen;
            }
            // null: konfigUmziehen entfernt das alte Feld aus der Instanzkonfiguration
            neu.regelSzenen = null;
            delete c.regelSzenen;
        }
        const erster = !(Number(c.regelUmzugStand) >= 1);
        let geraeteNeu = false;
        const geraete = (Array.isArray(c.regelGeraete) ? c.regelGeraete : []).map(g => {
            if (!g || typeof g !== 'object') {
                return g;
            }
            const z = { ...g };
            if (gefuellt(z.szenen)) {
                if (!gefuellt(z.stufen)) {
                    z.stufen = z.szenen;
                }
                delete z.szenen;
                geraeteNeu = true;
            }
            if (erster && typeof z.individuell !== 'boolean') {
                z.individuell = true;
                geraeteNeu = true;
            }
            return z;
        });
        if (geraeteNeu) {
            neu.regelGeraete = geraete;
            c.regelGeraete = geraete;
        }
        if (erster) {
            if (Number(c.regelObergrenze) === 95) {
                neu.regelObergrenze = 100;
                c.regelObergrenze = 100;
            }
            const punkte = Array.isArray(c.regelKennlinieHeizen) ? c.regelKennlinieHeizen : [];
            const alt = kennlinie.VORGABE_HEIZEN_ALT;
            if (
                punkte.length === alt.length &&
                punkte.every((p, i) => p && Number(p.x) === alt[i][0] && Number(p.y) === alt[i][1])
            ) {
                neu.regelKennlinieHeizen = kennlinie.VORGABE_HEIZEN.map(([x, y]) => ({ x, y }));
                c.regelKennlinieHeizen = neu.regelKennlinieHeizen;
            }
            neu.regelUmzugStand = 1;
            c.regelUmzugStand = 1;
        }
        return neu;
    }

    /**
     * "Pruefen": frischer Fingerprint der gewaehlten IP und Vorschau. Schreibt nichts (bei
     * Passwortschutz meldet ein POST nur mit `password` an - das speichert nichts).
     *
     * @param {Record<string, unknown>} msg Formularwerte (ip, adresse, pass)
     * @returns {Promise<object>} Antwort fuer den Admin
     */
    async anbindenPruefen(msg) {
        const sprache = await this.sprache();
        const ip = feldWert(msg.ip);
        if (!ip) {
            return { error: anbinden.t('keinPlan', sprache) };
        }
        const adresse = this.brokerZiel(feldWert(msg.adresse)).adresse;
        if (!adresse) {
            return { error: anbinden.t('keineAdresse', sprache) };
        }
        const gelesen = await anbinden.lesen(ip, feldWert(msg.pass), { timeoutMs: 3000, timer: this });
        const fehler = this.anbindenLesefehler(gelesen, ip, sprache);
        if (fehler) {
            this.anbindenPlaene.delete(ip);
            return { error: fehler, native: { _bindPlan: '', _bindPreview: '', _bindOther: false } };
        }
        const plan = anbinden.planen(gelesen, this.anbindenZiel(adresse));
        if (plan.schonHier) {
            this.anbindenPlaene.delete(ip);
            const text = anbinden.t('schonHier', sprache, { name: plan.titel });
            return { result: text, native: { _bindPlan: '', _bindPreview: text, _bindOther: false } };
        }
        this.anbindenPlaene.set(ip, plan);
        this.log.info(`Connect: module "${plan.titel}" (${ip}) checked, waiting for confirmation`);
        const text = anbinden.vorschau(plan, sprache);
        return { native: { _bindPlan: ip, _bindPreview: text, _bindOther: plan.anderer, _bindOtherOk: false } };
    }

    /**
     * "Anbinden": frischer Fingerprint, Vergleich mit dem Plan, EIN POST, Erfolgskontrolle.
     *
     * @param {Record<string, unknown>} msg Formularwerte (ip, pass, andererOk)
     * @returns {Promise<object>} Antwort fuer den Admin
     */
    async anbindenAusfuehren(msg) {
        const sprache = await this.sprache();
        const ip = feldWert(msg.ip);
        const plan = this.anbindenPlaene.get(ip);
        if (!plan || Date.now() - plan.zeit > anbinden.PLAN_MS) {
            this.anbindenPlaene.delete(ip);
            return { error: anbinden.t('keinPlan', sprache) };
        }
        if (plan.anderer && !(msg.andererOk === true || msg.andererOk === 'true')) {
            return { error: anbinden.t('andererNichtBestaetigt', sprache) };
        }
        const passwort = feldWert(msg.pass);
        // Unmittelbar vorher: dieselbe IP frisch lesen und mit dem Plan vergleichen.
        const gelesen = await anbinden.lesen(ip, passwort, { timeoutMs: 3000, timer: this });
        const fehler = this.anbindenLesefehler(gelesen, ip, sprache);
        if (fehler) {
            return { error: fehler };
        }
        const frisch = anbinden.planen(gelesen, {
            ...this.anbindenZiel(plan.neu.mqtthost.slice(0, plan.neu.mqtthost.lastIndexOf(':'))),
        });
        const anders = anbinden.abweichung(plan, frisch);
        if (anders) {
            this.anbindenPlaene.delete(ip);
            return { error: anbinden.t('geaendert', sprache, { was: anders }), native: { _bindPlan: '' } };
        }
        this.anbindenPlaene.delete(ip);
        const benutzer = plan.neu.mqttuser !== undefined;
        const daten = anbinden.koerper({
            passwort: plan.geschuetzt ? passwort : undefined,
            mqtthost: plan.neu.mqtthost,
            mqttuser: benutzer ? plan.neu.mqttuser : undefined,
            mqttpass: benutzer ? this.brokerZiel().pass : undefined,
        });
        const start = Date.now();
        this.log.info(`Connect: setting MQTT host of module "${plan.titel}" (${ip}) to this adapter, module restarts`);
        const r = await anbinden.posten(ip, daten, { timer: this });
        if (!r.ok) {
            this.log.warn(`Connect: module "${plan.titel}" (${ip}) rejected the change: ${r.fehler}`);
            return { error: anbinden.t('modulFehler', sprache, { fehler: r.fehler }), native: { _bindPlan: '' } };
        }
        // Rueckweg: alte Werte, nur im Speicher.
        this.rueckwege.set(ip, {
            titel: plan.titel,
            hostname: plan.hostname,
            revkId: plan.revkId,
            geschuetzt: plan.geschuetzt,
            mqtthost: plan.alt.mqtthost,
            mqttuser: benutzer ? plan.alt.mqttuser : undefined,
        });
        const ok = await anbinden.warten(() => this.modulGemeldetSeit(plan.hostname, start), {
            // wartenMs nur kuerzer als die Vorgabe (Tests/Werkzeuge), nie laenger
            maxMs: Math.min(Number(msg.wartenMs) > 0 ? Number(msg.wartenMs) : anbinden.ERFOLG_MS, anbinden.ERFOLG_MS),
            timer: this,
            abbruch: () => this.stopping,
        });
        const s = Math.round((Date.now() - start) / 1000);
        if (ok) {
            this.log.info(`Connect: module "${plan.titel}" (${ip}) connected after ${s} s`);
            const text = anbinden.t('erfolg', sprache, { name: plan.titel, s });
            return { result: text, native: { _bindPlan: '', _bindPreview: text } };
        }
        this.log.warn(`Connect: module "${plan.titel}" (${ip}) did not connect within ${s} s`);
        const text = anbinden.t('zeitueberschreitung', sprache, { name: plan.titel, s });
        return { error: text, native: { _bindPlan: '', _bindPreview: text } };
    }

    /**
     * "Zurueckstellen": vorher gelesenen alten mqtthost (ggf. mqttuser) zurueckschreiben.
     *
     * @param {Record<string, unknown>} msg Formularwerte (ip, pass)
     * @returns {Promise<object>} Antwort fuer den Admin
     */
    async zurueckstellen(msg) {
        const sprache = await this.sprache();
        const ip = feldWert(msg.ip);
        const weg = this.rueckwege.get(ip);
        if (!weg) {
            return { error: anbinden.t('keinRueckweg', sprache, { ip: ip || '-' }) };
        }
        const passwort = feldWert(msg.pass);
        // Auch hier: frisch lesen - es muss noch dasselbe Modul sein.
        const gelesen = await anbinden.lesen(ip, passwort, { timeoutMs: 3000, timer: this });
        const fehler = this.anbindenLesefehler(gelesen, ip, sprache);
        if (fehler) {
            return { error: fehler };
        }
        if ((weg.revkId && gelesen.fp.revkId !== weg.revkId) || gelesen.fp.hostname !== weg.hostname) {
            return { error: anbinden.t('geaendert', sprache, { was: 'revkId/hostname' }) };
        }
        const benutzer = weg.mqttuser !== undefined;
        const daten = anbinden.koerper({
            passwort: weg.geschuetzt || gelesen.fp.geschuetzt ? passwort : undefined,
            mqtthost: weg.mqtthost,
            mqttuser: benutzer ? weg.mqttuser : undefined,
            // das alte Passwort ist nicht rueckholbar - mqttpass bleibt, wie es ist (Warnung unten)
        });
        this.log.info(`Restore: writing the previous MQTT host back to module "${weg.titel}" (${ip}), module restarts`);
        const r = await anbinden.posten(ip, daten, { timer: this });
        if (!r.ok) {
            this.log.warn(`Restore: module "${weg.titel}" (${ip}) rejected the change: ${r.fehler}`);
            return { error: anbinden.t('modulFehler', sprache, { fehler: r.fehler }) };
        }
        this.rueckwege.delete(ip);
        let text = anbinden.t('zurueck', sprache, {
            name: weg.titel,
            alt: weg.mqtthost || anbinden.t('leer', sprache),
        });
        if (benutzer) {
            text += anbinden.t('passwortWarnung', sprache);
        }
        return { result: text, native: { _bindPlan: '', _bindPreview: text } };
    }

    /**
     * Fehlertext, wenn das gelesene Modul nicht angebunden werden kann.
     *
     * @param {{fp: object, fehler?: string}} gelesen Ergebnis von anbinden.lesen()
     * @param {string} ip Adresse
     * @param {string} sprache Sprachkuerzel
     * @returns {string} '' = alles in Ordnung
     */
    anbindenLesefehler(gelesen, ip, sprache) {
        if (gelesen.fehler) {
            return anbinden.t('modulFehler', sprache, { fehler: gelesen.fehler });
        }
        if (gelesen.fp.art === 'weblogin') {
            return anbinden.t('weblogin', sprache);
        }
        if (!gelesen.fp.faikout) {
            return anbinden.t('keinModul', sprache, { ip });
        }
        if (gelesen.fp.art === 'passwort') {
            return anbinden.t('passwortNoetig', sprache);
        }
        return '';
    }

    /**
     * Der Broker, an dem die Module haengen sollen: der eigene (Vorgabe) oder der externe.
     * EINE Quelle fuer Suche, Anbinden, Anleitung und Logzeile - beide Betriebsarten laufen sonst gleich.
     *
     * @param {string} [adresse] ungespeicherte "Adresse fuer Module" aus dem Formular (nur eigener Broker)
     * @returns {{extern: boolean, adresse: string, port: number, user: string, pass: string}} Ziel
     */
    brokerZiel(adresse) {
        if (this.config.brokerModus === 'extern') {
            return {
                extern: true,
                adresse: String(this.config.externHost || '').trim(),
                port: Number(this.config.externPort) || (this.config.externTls === true ? 8883 : 1883),
                user: String(this.config.externUser || ''),
                pass: String(this.config.externPass || ''),
            };
        }
        return {
            extern: false,
            adresse: String(adresse || this.config.moduleAddress || '').trim(),
            port: Number(this.config.port) || 1888,
            user: String(this.config.user || ''),
            pass: String(this.config.pass || ''),
        };
    }

    /**
     * Namen der Module, die gerade am Broker haengen. Eigener Broker: aus den Client-IDs
     * ("<App>:<Hostname>[_<Ende der ID>]"). Externer Broker: dort sind die Clients nicht sichtbar -
     * es zaehlt, wer in den letzten fuenf Minuten gemeldet hat.
     *
     * @returns {string[]} Namen bzw. Client-Namen
     */
    modulClients() {
        if (this.config.brokerModus === 'extern') {
            const jetzt = Date.now();
            return [...this.gesehen].filter(([, zeit]) => jetzt - zeit < 5 * 60000).map(([name]) => name);
        }
        return [...this.mqttClients].map(c => c.slice(c.indexOf(':') + 1));
    }

    /**
     * Zielwerte fuer anbinden.planen().
     *
     * @param {string} adresse Adresse fuer Module
     * @returns {{adresse: string, port: number, user: string, eigeneAdressen: string[]}} Ziel
     */
    anbindenZiel(adresse) {
        const z = this.brokerZiel(adresse);
        return {
            adresse: z.adresse,
            port: z.port,
            user: z.user,
            eigeneAdressen: this.eigeneAdressen(adresse),
        };
    }

    /**
     * Hat sich das Modul seit `seit` am Broker gemeldet (verbunden UND eine Nachricht geschickt)?
     *
     * @param {string} hostname Hostname = Topic des Moduls
     * @param {number} seit Zeitpunkt (ms)
     * @returns {boolean} gemeldet
     */
    modulGemeldetSeit(hostname, seit) {
        const zuletzt = this.gesehen.get(hostname) || 0;
        const clients = this.modulClients();
        return zuletzt > seit && clients.some(c => c === hostname || c.startsWith(`${hostname}_`));
    }

    /**
     * Sprache der ioBroker-Installation (system.config), Rueckfall Englisch.
     *
     * @returns {Promise<string>} Sprachkuerzel
     */
    async sprache() {
        try {
            const cfg = await this.getForeignObjectAsync('system.config');
            return (cfg && cfg.common && cfg.common.language) || 'en';
        } catch {
            return 'en';
        }
    }

    /**
     * Adressen, unter denen die Module diesen Broker erreichen koennen: eingetragene "Adresse fuer
     * Module" (auch der ungespeicherte Wert aus dem Formular) und alle eigenen IPv4-Adressen.
     *
     * @param {string} [formular] ungespeicherter Wert aus dem Formular
     * @returns {string[]} Adressen
     */
    eigeneAdressen(formular) {
        // Externer Broker: "dieser Adapter" ist fuer die Module die Adresse des externen Brokers.
        const liste = (
            this.config.brokerModus === 'extern'
                ? [this.config.externHost]
                : [formular, this.config.moduleAddress, ...discovery.adressenErmitteln().adressen]
        )
            .map(a =>
                String(a || '')
                    .trim()
                    .toLowerCase(),
            )
            .filter(Boolean);
        return [...new Set(liste)];
    }

    /**
     * Geraete dieses Adapters fuer den Abgleich der Suchergebnisse.
     *
     * @returns {Array<{name: string, modulId: string|null, verbunden: boolean}>} Geraete
     */
    geraeteFuerSuche() {
        const clients = this.modulClients();
        return [...this.geraete.values()].map(g => ({
            name: g.name,
            modulId: g.modulId,
            // Client-ID der Module: "<App>:<Hostname>" oder "<App>:<Hostname>_<Ende der ID>"
            verbunden: clients.some(c => c === g.name || c.startsWith(`${g.name}_`)),
        }));
    }

    // ---------------------------------------------------------------- Ende

    async onUnload(callback) {
        this.stopping = true;
        try {
            if (this.stundenTimer) {
                this.clearTimeout(this.stundenTimer);
            }
            if (this.regelTakt) {
                this.clearInterval(this.regelTakt);
            }
            // Zustand der Regelung sichern (Sperren, Haltezeiten, laufender Feuchteeingriff).
            if (this.regelung) {
                await this.regelung.sichernAlle();
            }
            // Zaehlerstaende sichern, damit nach dem Neustart weitergezaehlt wird.
            for (const [id, g] of this.geraete) {
                await this.zaehlerstandSichern(id, g);
            }
            await this.setState('info.connection', { val: false, ack: true });
            if (this.broker) {
                await this.broker.stop();
            }
        } catch {
            // beim Herunterfahren nicht weiter stoeren
        }
        callback();
    }
}

/**
 * Mehrzeiligen Text sicher als HTML ausgeben (Werte stammen aus dem Formular).
 *
 * @param {string} text Text mit Zeilenumbruechen
 * @returns {string} HTML
 */
function htmlZeilen(text) {
    const maskiert = String(text).replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
    return maskiert.split('\n').join('<br>');
}

/**
 * Wert aus jsonData des Admins: unaufgeloeste Platzhalter ("${data.x}") zaehlen als leer.
 *
 * @param {unknown} v Wert
 * @returns {string} bereinigter Text
 */
function feldWert(v) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s.includes('${') || s === 'undefined' || s === 'null' ? '' : s;
}

if (require.main !== module) {
    module.exports = options => new Faikout(options);
} else {
    new Faikout();
}
