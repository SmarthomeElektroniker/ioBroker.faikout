'use strict';

/*
 * ioBroker.faikout
 * Bindet Daikin-Klimaanlagen mit faikout-Modul rein ueber MQTT an - mit eigenem Broker.
 */

const utils = require('@iobroker/adapter-core');
const { FaikoutBroker } = require('./lib/broker');
const felder = require('./lib/fields');
const namen = require('./lib/namen');
const verbrauch = require('./lib/verbrauch');

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

        this.broker = null;
        this.stopping = false;
        this.stundenTimer = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------------------------------------------------------- Start

    async onReady() {
        await this.setState('info.connection', { val: false, ack: true });
        await this.verbrauchUmziehen();
        await this.objekteAbgleichen();

        const port = Number(this.config.port) || 1888;
        this.broker = new FaikoutBroker({
            port,
            user: this.config.user,
            pass: this.config.pass,
            log: this.log,
            timer: this,
            onMessage: (topic, payload) => this.onMqtt(topic, payload),
            onClient: () => this.verbindungPruefen(),
        });

        try {
            await this.broker.start();
        } catch (e) {
            this.log.error(`MQTT broker could not start: ${e.message}`);
            return;
        }

        this.log.info(`Ready. Configure the faikout modules with MQTT host <ioBroker IP>:${port}.`);
        this.subscribeStates('*.control.*');
        // `autoe` liegt im Kanal status, ist aber beschreibbar (Review 11.10.2026: Schreibbefehle
        // darauf gingen bisher ins Leere, weil nur control.* abonniert war).
        this.subscribeStates('*.status.autoe');
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
        for (const [id, g] of this.geraete) {
            for (const z of ZAEHLER) {
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
        // Verbunden heisst hier: mindestens ein faikout-Modul haengt am Broker.
        this.setState('info.connection', { val: this.geraete.size > 0, ack: true });
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

        if (t.art === 'error') {
            this.log.warn(`${t.geraet}: ${text}`);
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
        // im nativen Format (mode "C" statt "cool") - das waere doppelt und wird uebergangen.
        if (t.art === 'state' && !t.unter) {
            if (felder.ohneHaEnable(daten) && !this.haWarnung.has(t.geraet)) {
                this.haWarnung.add(t.geraet);
                this.log.warn(
                    `${t.geraet}: the module sends diagnostics only - enable the setting "ha.enable" ("Home Assistant") in the module, otherwise no temperatures, mode or energy values arrive.`,
                );
            }
            this.werteUebernehmen(t.geraet, daten).catch(e => this.log.warn(`${t.geraet}: ${e.message}`));
        } else if (t.art === 'info' && t.unter === 'upgrade') {
            this.werteUebernehmen(t.geraet, { version: daten.version, build: daten.build }).catch(() => {});
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
                angelegt: new Set(),
                feuchteEcht: !!(alt && alt.native && alt.native.feuchteEcht),
                // Die Zaehlerstaende muessen den Adapter-Neustart ueberleben, sonst faengt
                // jede Zaehlung wieder bei null an.
                zaehler: (alt && alt.native && alt.native.zaehler) || {},
                grenzen: (alt && alt.native && alt.native.grenzen) || null,
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
            await this.setState(stateId, { val: felder.umrechnen(def, wert), ack: true });
        }

        await this.zaehlerVerarbeiten(id, g, daten);
    }

    /**
     * Bildet aus den Lebensdauer-Zaehlern die Stunden- und Tagesverbraeuche.
     *
     * @param {string} id      Objekt-ID des Geraets
     * @param {object} g       gemerkter Zustand des Geraets
     * @param {object} daten   gemeldete Felder mit den Lebensdauer-Zaehlern
     */
    async zaehlerVerarbeiten(id, g, daten) {
        let veraendert = false;
        for (const z of ZAEHLER) {
            const roh = daten[z.feld];
            if (typeof roh !== 'number') {
                continue;
            }
            const ergebnis = verbrauch.verarbeiten(g.zaehler[z.feld] || null, roh, new Date());
            g.zaehler[z.feld] = ergebnis.stand;
            veraendert = true;
            ergebnis.hinweise.forEach(h => this.log.info(`${g.name} ${z.name.en.toLowerCase()}: ${h}`));
            await this.verbrauchSchreiben(id, g, z, ergebnis.werte);
        }
        if (veraendert) {
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
            await this.setState(`${basis}.${f.id}`, { val: wert, ack: true });
        }
        for (const r of VERBRAUCH_REIHEN) {
            await this.setState(`${basis}.${r.id}`, {
                val: JSON.stringify(werte[r.quelle] || []),
                ack: true,
            });
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
        await this.extendObject(id, { native: { zaehler: g.zaehler } });
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

        const obj = await this.getObjectAsync(id);
        if (!obj || !obj.common || !obj.common.write) {
            return;
        }

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
        const nutzlast = this.nutzlast(feld, state.val);
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

    // ---------------------------------------------------------------- Ende

    async onUnload(callback) {
        this.stopping = true;
        try {
            if (this.stundenTimer) {
                this.clearTimeout(this.stundenTimer);
            }
            // Zaehlerstaende sichern, damit nach dem Neustart weitergezaehlt wird.
            for (const [id, g] of this.geraete) {
                await this.zaehlerstandSichern(id, g);
            }
            if (this.broker) {
                await this.broker.stop();
            }
            await this.setState('info.connection', { val: false, ack: true });
        } catch {
            // beim Herunterfahren nicht weiter stoeren
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new Faikout(options);
} else {
    new Faikout();
}
