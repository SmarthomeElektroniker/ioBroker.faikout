'use strict';

/*
 * ioBroker.faikout
 * Bindet Daikin-Klimaanlagen mit faikout-Modul rein ueber MQTT an - mit eigenem Broker.
 */

const utils = require('@iobroker/adapter-core');
const { FaikoutBroker } = require('./lib/broker');
const felder = require('./lib/fields');
const verbrauch = require('./lib/verbrauch');

/** Topics, die der Adapter auswertet. Alles andere wird still verworfen. */
const BEKANNTE_ARTEN = new Set(['state', 'info', 'error', 'event']);

/**
 * Die drei Lebensdauer-Zaehler und ihr Zweig im Objektbaum. Die Gesamtzaehler bleiben
 * erhalten (status.*), zusaetzlich entstehen daraus die Verbrauchswerte (verbrauch.*).
 */
const ZAEHLER = [
    { feld: 'energy', zweig: 'gesamt', name: { en: 'Total', de: 'Gesamt' } },
    { feld: 'energyheat', zweig: 'heizen', name: { en: 'Heating', de: 'Heizen' } },
    { feld: 'energycool', zweig: 'kuehlen', name: { en: 'Cooling', de: 'Kühlen' } },
];

/** Datenpunkte je Zaehlerzweig. */
const VERBRAUCH_FELDER = [
    { id: 'stunde', name: { en: 'Current hour', de: 'Laufende Stunde' } },
    { id: 'letzteStunde', name: { en: 'Last full hour', de: 'Letzte volle Stunde' } },
    { id: 'heute', name: { en: 'Today', de: 'Heute' } },
    { id: 'gestern', name: { en: 'Yesterday', de: 'Gestern' } },
    { id: 'dieserMonat', name: { en: 'This month', de: 'Dieser Monat' } },
    { id: 'letzterMonat', name: { en: 'Last month', de: 'Letzter Monat' } },
];

/**
 * Verlaufsreihen als JSON. Sie tragen die Diagramme im VIS-Baustein und werden hier gefuehrt,
 * damit der Adapter ohne Fremdskript auskommt - andernfalls blieben Monats- und Jahresansicht
 * bei jedem leer, der nichts weiter einrichtet.
 */
const VERBRAUCH_REIHEN = [
    { id: 'stundenJson', quelle: 'ring',
      name: { en: 'Last 48 hours (JSON)', de: 'Letzte 48 Stunden (JSON)' } },
    { id: 'tageJson', quelle: 'ringTage',
      name: { en: 'Last 62 days (JSON)', de: 'Letzte 62 Tage (JSON)' } },
    { id: 'monateJson', quelle: 'ringMonate',
      name: { en: 'Last 24 months (JSON)', de: 'Letzte 24 Monate (JSON)' } },
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
         * @type {Map<string, {name:string, angelegt:Set<string>}>}
         */
        this.geraete = new Map();

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

        const port = Number(this.config.port) || 1888;
        this.broker = new FaikoutBroker({
            port,
            user: this.config.user,
            pass: this.config.pass,
            log: this.log,
            onMessage: (topic, payload) => this.onMqtt(topic, payload),
            onClient: () => this.verbindungPruefen(),
        });

        try {
            await this.broker.start();
        } catch (e) {
            this.log.error(`MQTT-Broker konnte nicht starten: ${e.message}`);
            return;
        }

        this.log.info(
            `Bereit. Die faikout-Module müssen als MQTT-Host <IP des ioBroker>:${port} eingetragen sein.`,
        );
        this.subscribeStates('*.control.*');
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
            this.stundenwechsel().catch(e => this.log.warn(`Stundenwechsel: ${e.message}`));
            this.stundenTaktStarten();
        }, naechste - jetzt);
    }

    async stundenwechsel() {
        for (const [id, g] of this.geraete) {
            for (const z of ZAEHLER) {
                const ergebnis = verbrauch.pruefen(g.zaehler[z.feld], new Date());
                if (!ergebnis.werte) continue;
                g.zaehler[z.feld] = ergebnis.stand;
                ergebnis.hinweise.forEach(h => this.log.info(`${g.name} ${z.zweig}: ${h}`));
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
     */
    topicZerlegen(topic) {
        const teile = topic.split('/');
        if (teile.length < 2) return null;
        const [art, geraet, ...rest] = teile;
        if (!BEKANNTE_ARTEN.has(art)) return null;
        return { art, geraet, unter: rest.join('/') };
    }

    onMqtt(topic, payload) {
        const text = payload ? payload.toString('utf8') : '';
        if (!text) return;

        // Die Module veroeffentlichen ihre Faehigkeiten selbst als Home-Assistant-Discovery.
        // Daraus kommen Bereich und Schrittweite der Solltemperatur - die unterscheiden sich
        // je Anlage (eine nimmt halbe Grad, die andere nur ganze, Einstellung "ha1c").
        if (topic.startsWith('homeassistant/climate/') && topic.endsWith('/config')) {
            this.klimaConfig(text).catch(e => this.log.debug(`HA-Config: ${e.message}`));
            return;
        }

        const t = this.topicZerlegen(topic);
        if (!t) return; // command/…, Faikout/… - nicht ausgewertet

        if (t.art === 'error') {
            this.log.warn(`${t.geraet}: ${text}`);
            return;
        }

        let daten;
        try {
            daten = JSON.parse(text);
        } catch {
            this.log.debug(`Kein JSON auf "${topic}": ${text.slice(0, 80)}`);
            return;
        }
        if (!daten || typeof daten !== 'object') return;

        // state/<Name> ist die Hauptmeldung im Klartext. state/<Name>/status liefert dasselbe
        // im nativen Format (mode "C" statt "cool") - das waere doppelt und wird uebergangen.
        if (t.art === 'state' && !t.unter) {
            this.werteUebernehmen(t.geraet, daten).catch(e => this.log.warn(`${t.geraet}: ${e.message}`));
        } else if (t.art === 'info' && t.unter === 'upgrade') {
            this.werteUebernehmen(t.geraet, { version: daten.version, build: daten.build }).catch(() => {});
        }
    }

    /**
     * Wertet die HA-Discovery einer Klimaeinheit aus und uebernimmt Bereich und Schrittweite
     * der Solltemperatur ins Objekt `control.target`.
     */
    async klimaConfig(text) {
        const c = JSON.parse(text);
        // Der Geraetename steckt im Verfuegbarkeits-Topic: "state/Wohnzimmer AC".
        const geraetName = String(c.avty_t || '').replace(/^state\//, '');
        if (!geraetName) return;

        const id = this.geraetId(geraetName);
        const grenzen = {
            min: Number(c.min_temp),
            max: Number(c.max_temp),
            step: Number(c.temp_step),
        };
        if (!isFinite(grenzen.min) || !isFinite(grenzen.max) || !isFinite(grenzen.step)) return;

        const g = this.geraete.get(id);
        if (g && g.grenzen && g.grenzen.step === grenzen.step &&
            g.grenzen.min === grenzen.min && g.grenzen.max === grenzen.max) {
            return; // unveraendert - die Discovery wird regelmaessig wiederholt
        }
        if (g) g.grenzen = grenzen;

        const stateId = `${id}.control.target`;
        const vorhanden = await this.getObjectAsync(stateId);
        if (vorhanden) {
            await this.extendObject(stateId, { common: grenzen });
            this.log.info(`${geraetName}: Sollwertbereich ${grenzen.min}–${grenzen.max} °C in ${grenzen.step}er-Schritten übernommen.`);
        }
    }

    /** Legt fehlende Objekte an und schreibt die Werte. */
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
            this.geraete.set(id, g);
            await this.extendObject(id, {
                type: 'device',
                common: { name: geraetName },
                native: { faikoutName: geraetName },
            });
            this.log.info(`Gerät erkannt: "${geraetName}" -> ${this.namespace}.${id}`);
            this.verbindungPruefen();
        }
        // Der Name kann sich aendern, wenn der Hostname im Modul umgestellt wird.
        g.name = geraetName;

        for (const [feld, wert] of Object.entries(daten)) {
            if (wert === null || wert === undefined) continue;
            if (felder.UEBERSPRINGEN.has(feld)) continue;
            if (typeof wert === 'object') continue; // verschachteltes (ble) - eigener Zweig, spaeter

            // Anlagen ohne Feuchtesensor melden dauerhaft 50 - das ist ein Platzhalter, kein
            // Messwert. Erst wenn einmal etwas anderes kam, gibt es wirklich einen Sensor.
            if (feld === 'hum') {
                const urteil = felder.feuchteBewerten(wert, g.feuchteEcht);
                if (urteil.echtAbJetzt && !g.feuchteEcht) {
                    g.feuchteEcht = true;
                    await this.extendObject(id, { native: { feuchteEcht: true } });
                    this.log.info(`${geraetName}: Luftfeuchte-Sensor erkannt (${wert} %) - Datenpunkt wird ab jetzt geführt.`);
                }
                if (!urteil.nehmen) continue;
            }

            const def = felder.beschreibe(feld, wert);
            const stateId = `${id}.${def.kanal}.${felder.objektId(feld)}`;

            if (!g.angelegt.has(stateId)) {
                await this.objektAnlegen(id, def, feld, stateId);
                g.angelegt.add(stateId);
            }
            await this.setState(stateId, { val: felder.umrechnen(def, wert), ack: true });
        }

        await this.zaehlerVerarbeiten(id, g, daten);
    }

    /** Bildet aus den Lebensdauer-Zaehlern die Stunden- und Tagesverbraeuche. */
    async zaehlerVerarbeiten(id, g, daten) {
        let veraendert = false;
        for (const z of ZAEHLER) {
            const roh = daten[z.feld];
            if (typeof roh !== 'number') continue;
            const ergebnis = verbrauch.verarbeiten(g.zaehler[z.feld] || null, roh, new Date());
            g.zaehler[z.feld] = ergebnis.stand;
            veraendert = true;
            ergebnis.hinweise.forEach(h => this.log.info(`${g.name} ${z.zweig}: ${h}`));
            await this.verbrauchSchreiben(id, g, z, ergebnis.werte);
        }
        if (veraendert) await this.zaehlerstandSichern(id, g);
    }

    async verbrauchSchreiben(id, g, z, werte) {
        const basis = `${id}.verbrauch.${z.zweig}`;
        if (!g.angelegt.has(basis)) {
            await this.extendObject(`${id}.verbrauch`, {
                type: 'channel',
                common: { name: { en: 'Consumption', de: 'Verbrauch' } },
                native: {},
            });
            await this.extendObject(basis, { type: 'channel', common: { name: z.name }, native: {} });
            for (const f of VERBRAUCH_FELDER) {
                await this.zaehlerObjekt(`${basis}.${f.id}`, f.name, 'kWh', 'value.energy.consumed');
            }
            for (const r of VERBRAUCH_REIHEN) {
                await this.extendObject(`${basis}.${r.id}`, {
                    type: 'state',
                    common: { name: r.name, type: 'string', role: 'json', read: true, write: false },
                    native: {},
                });
            }
            g.angelegt.add(basis);
        }

        for (const f of VERBRAUCH_FELDER) {
            const wert = werte[f.id];
            if (wert === null || wert === undefined) continue;
            await this.setState(`${basis}.${f.id}`, { val: wert, ack: true });
        }
        for (const r of VERBRAUCH_REIHEN) {
            await this.setState(`${basis}.${r.id}`, {
                val: JSON.stringify(werte[r.quelle] || []), ack: true,
            });
        }
    }

    /**
     * Legt einen Verbrauchs-Datenpunkt an und meldet ihn - wenn gewuenscht - gleich beim
     * History-Adapter zur Aufzeichnung an. Das erspart es, jeden Punkt von Hand im Admin
     * einzuschalten.
     */
    async zaehlerObjekt(stateId, name, unit, role) {
        const common = { name, type: 'number', role, unit, read: true, write: false };
        const instanz = (this.config.historyInstanz || '').trim();
        if (this.config.historyAnmelden && instanz) {
            common.custom = {
                [instanz]: { enabled: true, changesOnly: false, debounce: 0, retention: 0 },
            };
        }
        await this.extendObject(stateId, { type: 'state', common, native: {} });
    }

    async zaehlerstandSichern(id, g) {
        await this.extendObject(id, { native: { zaehler: g.zaehler } });
    }

    async objektAnlegen(geraetId, def, feld, stateId) {
        await this.extendObject(`${geraetId}.${def.kanal}`, {
            type: 'channel',
            common: { name: this.kanalName(def.kanal) },
            native: {},
        });
        const common = {
            name: def.name,
            type: def.type,
            role: def.role,
            read: true,
            write: !!def.w,
        };
        if (def.unit) common.unit = def.unit;
        if (def.states) common.states = def.states;
        if (def.min !== undefined) common.min = def.min;
        if (def.max !== undefined) common.max = def.max;
        if (def.step !== undefined) common.step = def.step;

        await this.extendObject(stateId, { type: 'state', common, native: { feld } });
        if (def.unbekannt) {
            this.log.info(`Unbekanntes Feld "${feld}" angelegt (${def.type}) - bitte melden, damit es sauber beschrieben wird.`);
        }
    }

    kanalName(kanal) {
        return {
            control: { en: 'Control', de: 'Steuerung' },
            status: { en: 'Readings', de: 'Messwerte' },
            info: { en: 'Device info', de: 'Geräteinfo' },
        }[kanal] || kanal;
    }

    /** Objekttaugliche ID aus dem Geraetenamen - Leerzeichen und Sonderzeichen raus. */
    geraetId(name) {
        return name.replace(/[\s.\][*,;'"`<>\\?]+/g, '_');
    }

    // ---------------------------------------------------------------- MQTT hinaus

    async onStateChange(id, state) {
        if (!state || state.ack) return; // nur eigene Befehle, nicht die eigenen Rueckmeldungen

        const obj = await this.getObjectAsync(id);
        if (!obj || !obj.common || !obj.common.write) return;

        // faikout.0.<GeraetId>.control.<feld>
        const teile = id.split('.');
        const geraetId = teile[2];
        const feld = (obj.native && obj.native.feld) || teile[teile.length - 1];
        const g = this.geraete.get(geraetId);
        if (!g) {
            this.log.warn(`Befehl für unbekanntes Gerät ${geraetId} verworfen.`);
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

    /** Wandelt einen ioBroker-Wert in die Nutzlast, die das Modul erwartet. */
    nutzlast(feld, wert) {
        if (typeof wert === 'boolean') return wert ? 'true' : 'false';
        return String(wert);
    }

    // ---------------------------------------------------------------- Ende

    async onUnload(callback) {
        this.stopping = true;
        try {
            if (this.stundenTimer) this.clearTimeout(this.stundenTimer);
            // Zaehlerstaende sichern, damit nach dem Neustart weitergezaehlt wird.
            for (const [id, g] of this.geraete) await this.zaehlerstandSichern(id, g);
            if (this.broker) await this.broker.stop();
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
