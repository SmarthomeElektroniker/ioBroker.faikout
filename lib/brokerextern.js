'use strict';

/**
 * Externer MQTT-Broker (z. B. Mosquitto oder der MQTT-Adapter von ioBroker): Der Adapter haengt sich
 * als Client an, statt selbst Broker zu sein. Die Klasse hat dieselbe Schnittstelle wie
 * `FaikoutBroker` (start, publish, stop, onMessage, onClient) - alles dahinter (Geraete, Regelung,
 * Modul-Einstellungen, Suche) arbeitet unveraendert.
 *
 * Topic-Praefix: Publizieren die Module unter einem Praefix (`haus/state/<Name>`), wird er beim
 * Empfang abgeschnitten und beim Senden vorangestellt.
 */

const mqtt = require('mqtt');

const ZEITLIMIT_MS = 8000;

/** Nach abgelehnter Anmeldung (falscher Benutzer/falsches Passwort) so lange bis zum naechsten Versuch warten. */
const ANMELDUNG_WIEDERHOLEN_MS = 60000;

/**
 * Praefix normalisieren: ohne fuehrenden, mit genau einem abschliessenden Schraegstrich; leer = keiner.
 *
 * @param {unknown} roh  Eingabe
 * @returns {string} Praefix
 */
function praefixVon(roh) {
    const p = String(roh || '')
        .trim()
        .replace(/^\/+|\/+$/g, '');
    return p && !/[#+]/.test(p) ? `${p}/` : '';
}

/**
 * Verbindungsangaben aus den Einstellungen.
 *
 * @param {object} o  {host, port, tls, user, pass, clientId}
 * @returns {{url: string, optionen: object}} Adresse und Optionen fuer mqtt.connect
 */
function verbindung(o) {
    const host = String(o.host || '').trim();
    const port = Number(o.port) || (o.tls ? 8883 : 1883);
    return {
        url: `${o.tls ? 'mqtts' : 'mqtt'}://${host}:${port}`,
        optionen: {
            clientId: String(o.clientId || '').trim() || `iobroker-faikout-${Math.random().toString(16).slice(2, 8)}`,
            username: o.user ? String(o.user) : undefined,
            password: o.user ? String(o.pass || '') : undefined,
            clean: true,
            connectTimeout: ZEITLIMIT_MS,
            // Selbst signierte Zertifikate im Heimnetz sind ueblich; geprueft wird die Verschluesselung.
            rejectUnauthorized: o.tlsPruefen === true,
        },
    };
}

/**
 * Ordnet einen Verbindungsfehler ein.
 *
 * @param {Error & {code?: number|string}} e  Fehler von mqtt.js
 * @returns {'anmeldung'|'nichtErreichbar'|'zeit'|'fehler'} Art
 */
function fehlerArt(e) {
    const text = `${e && e.message} ${e && e.code}`;
    if (/Bad username|Not authorized|not authorized|code: ?[45]\b/i.test(text) || e.code === 4 || e.code === 5) {
        return 'anmeldung';
    }
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET/.test(text)) {
        return 'nichtErreichbar';
    }
    if (/timeout|ETIMEDOUT/i.test(text)) {
        return 'zeit';
    }
    return 'fehler';
}

/**
 * Einmaliger Verbindungsversuch fuer den Knopf "Verbindung testen".
 *
 * @param {object} o  Einstellungen {host, port, tls, user, pass, clientId}
 * @param {object} [opt]  {mqtt: Ersatz fuer Tests, zeitlimitMs}
 * @returns {Promise<{ok: boolean, art: 'ok'|'anmeldung'|'nichtErreichbar'|'zeit'|'fehler'|'eingabe', fehler?: string}>} Ergebnis
 */
function testen(o, opt = {}) {
    if (!String((o && o.host) || '').trim()) {
        return Promise.resolve({ ok: false, art: 'eingabe' });
    }
    const v = verbindung(o);
    const lib = opt.mqtt || mqtt;
    const limit = opt.zeitlimitMs || ZEITLIMIT_MS;
    return new Promise(resolve => {
        let fertig = false;
        let client;
        const ende = r => {
            if (fertig) {
                return;
            }
            fertig = true;
            clearTimeout(uhr);
            try {
                client && client.end(true);
            } catch {
                // schon geschlossen
            }
            resolve(r);
        };
        const uhr = setTimeout(() => ende({ ok: false, art: 'zeit' }), limit + 500);
        try {
            client = lib.connect(v.url, {
                ...v.optionen,
                clientId: `${v.optionen.clientId}-test`,
                reconnectPeriod: 0,
                connectTimeout: limit,
            });
        } catch (e) {
            return ende({ ok: false, art: 'fehler', fehler: e.message });
        }
        client.once('connect', () => ende({ ok: true, art: 'ok' }));
        client.once('error', e => ende({ ok: false, art: fehlerArt(e), fehler: e.message }));
        client.once('close', () => ende({ ok: false, art: 'nichtErreichbar' }));
    });
}

/**
 * Passwort fuer "Verbindung testen". Das Formular schickt den Inhalt des Passwortfelds; das
 * gespeicherte Passwort gilt nur, wenn die Seite ausdruecklich meldet, dass das Feld unveraendert ist
 * (`passUnveraendert: true`). Meldet sie `false`, zaehlt genau die Eingabe - auch die leere (bis
 * dahin wurde bei leerem Feld IMMER das gespeicherte genommen: ein Test "ohne Passwort" war nicht
 * moeglich). Fehlt das Feld (aeltere Einstellungsseite), bleibt es beim alten Verhalten.
 *
 * @param {string} eingabe  Inhalt des Passwortfelds
 * @param {unknown} unveraendert  Feld `passUnveraendert` der Nachricht (true/false, auch als Text; sonst "fehlt")
 * @param {unknown} gespeichert  gespeichertes Passwort
 * @returns {string} zu verwendendes Passwort
 */
function testPasswort(eingabe, unveraendert, gespeichert) {
    const alt = String(gespeichert || '');
    const neu = String(eingabe || '');
    if (unveraendert === true || unveraendert === 'true') {
        return alt;
    }
    if (unveraendert === false || unveraendert === 'false') {
        return neu;
    }
    return neu || alt;
}

/** Anbindung an einen externen Broker mit der Schnittstelle des eigenen Brokers. */
class ExternerBroker {
    /**
     * @param {object} opts  Einstellungen
     * @param {string} opts.host  Adresse des Brokers
     * @param {number} [opts.port]  Port (1883, mit TLS 8883)
     * @param {boolean} [opts.tls]  verschluesselt
     * @param {string} [opts.user]  Benutzer
     * @param {string} [opts.pass]  Passwort
     * @param {string} [opts.clientId]  Client-ID
     * @param {string} [opts.praefix]  Topic-Praefix der Module
     * @param {object} opts.log  Logger des Adapters
     * @param {(topic: string, payload: Buffer) => void} opts.onMessage  je eingehender Nachricht (ohne Praefix)
     * @param {(clientId: string, verbunden: boolean) => void} [opts.onClient]  hier: Verbindung zum Broker
     * @param {object} [opts.mqtt]  Ersatz fuer Tests
     * @param {number} [opts.anmeldungWiederholenMs]  Abstand der Versuche nach abgelehnter Anmeldung (Tests)
     */
    constructor(opts) {
        this.opts = opts;
        this.log = opts.log;
        this.onMessage = opts.onMessage;
        this.onClient = opts.onClient || (() => {});
        this.praefix = praefixVon(opts.praefix);
        this.lib = opts.mqtt || mqtt;
        this.client = null;
        this.verbunden = false;
        this.gemeldet = '';
        this.beendet = false;
        this.neuTimer = null;
        this.wiederholenMs =
            Number(opts.anmeldungWiederholenMs) > 0 ? Number(opts.anmeldungWiederholenMs) : ANMELDUNG_WIEDERHOLEN_MS;
    }

    /**
     * Verbindet und abonniert alles unter dem Praefix. Kehrt zurueck, sobald der Verbindungsaufbau
     * laeuft - ein nicht erreichbarer Broker haelt den Adapter nicht auf.
     *
     * Wer verbindet neu?
     *  - Broker nicht erreichbar oder Verbindung abgerissen: mqtt.js selbst (reconnectPeriod, 10 s).
     *  - Anmeldung abgelehnt (CONNACK mit Fehlercode): mqtt.js meldet nur `error` und tut sonst
     *    NICHTS (lib/handlers/connack.js; `reconnectOnConnackError` ist ab Werk aus). Neu verbunden
     *    wird dann nur, wenn der BROKER die Verbindung schliesst. Laesst er sie offen, haengt der
     *    Client fuer immer (Test Strang E, 21.11.2026). Deshalb beendet der Adapter den Client hier
     *    selbst und versucht es alle ANMELDUNG_WIEDERHOLEN_MS erneut - ein inzwischen am Broker
     *    berichtigtes Passwort wirkt so ohne Neustart der Instanz, und der Broker wird nicht im
     *    10-s-Takt mit abgelehnten Anmeldungen belegt.
     *
     * @returns {Promise<void>} gestartet
     */
    async start() {
        if (!String(this.opts.host || '').trim()) {
            throw new Error('external broker: no host configured');
        }
        this.beendet = false;
        this.verbinden();
    }

    /** Baut einen neuen Client auf (Start und jeder neue Versuch nach abgelehnter Anmeldung). */
    verbinden() {
        const v = verbindung(this.opts);
        const client = this.lib.connect(v.url, { ...v.optionen, reconnectPeriod: 10000 });
        this.client = client;
        client.on('connect', () => {
            this.verbunden = true;
            this.verbundenSeit = Date.now();
            this.gemeldet = '';
            this.log.info(
                `Connected to external MQTT broker ${v.url}${this.praefix ? ` (prefix "${this.praefix}")` : ''}`,
            );
            client.subscribe(`${this.praefix}#`, { qos: 0 }, err => {
                if (err) {
                    this.log.warn(`External MQTT broker: subscribe failed - ${err.message}`);
                }
            });
            this.onClient('extern', true);
        });
        client.on('message', (topic, payload) => {
            if (this.praefix) {
                if (!topic.startsWith(this.praefix)) {
                    return;
                }
                topic = topic.slice(this.praefix.length);
            }
            this.onMessage(topic, payload);
        });
        client.on('close', () => {
            if (this.verbunden) {
                this.verbunden = false;
                // Bricht die Verbindung mehrmals gleich nach dem Aufbau ab, haengt meist ein zweiter
                // Client mit DERSELBEN Client-ID am Broker - der Broker wirft dann abwechselnd einen
                // von beiden hinaus (Brokertest 21.11.2026: ein anderer Adapter nutzte dieselbe ID).
                const kurz = Date.now() - (this.verbundenSeit || 0) < 5000;
                this.kurzAbbrueche = kurz ? (this.kurzAbbrueche || 0) + 1 : 0;
                if (this.kurzAbbrueche === 3) {
                    this.log.error(
                        `External MQTT broker keeps closing the connection right after connecting. Most likely another client uses the same client ID "${v.optionen.clientId}" - set a different client ID in the MQTT broker tab.`,
                    );
                }
                this.log.warn(`Connection to external MQTT broker ${v.url} lost - reconnecting`);
                this.onClient('extern', false);
            }
        });
        client.on('error', e => {
            if (client !== this.client) {
                return; // Nachzuegler eines schon ersetzten Clients
            }
            // Dieselbe Ursache nur einmal melden, nicht bei jedem Versuch.
            const art = fehlerArt(e);
            if (this.gemeldet !== art) {
                this.gemeldet = art;
                const text =
                    art === 'anmeldung'
                        ? `user name or password not accepted - check them in the MQTT broker tab; trying again every ${Math.round(this.wiederholenMs / 1000)} s`
                        : art === 'nichtErreichbar'
                          ? 'not reachable - trying again every 10 s'
                          : e.message;
                this.log.error(`External MQTT broker ${v.url}: ${text}`);
            }
            if (art === 'anmeldung') {
                this.spaeterNeuVerbinden(client);
            }
        });
    }

    /**
     * Nach abgelehnter Anmeldung: den Client beenden (mqtt.js versucht es dann nicht mehr selbst) und
     * nach der Wartezeit einen neuen aufbauen.
     *
     * @param {object} client  der abgelehnte Client
     */
    spaeterNeuVerbinden(client) {
        if (this.beendet || this.neuTimer) {
            return;
        }
        if (this.verbunden) {
            // kommt nicht vor (CONNACK-Fehler gibt es nur beim Aufbau) - der Zustand bleibt trotzdem stimmig
            this.verbunden = false;
            this.onClient('extern', false);
        }
        client.removeAllListeners('close');
        this.client = null;
        try {
            client.end(true);
        } catch {
            // schon geschlossen
        }
        // Bewusst der Zeitgeber von Node (wie lib/broker.js): stop() raeumt ihn ab; unref, damit er
        // einen Prozess ohne Adapter (Tests) nicht am Leben haelt.
        this.neuTimer = setTimeout(() => {
            this.neuTimer = null;
            if (!this.beendet) {
                this.verbinden();
            }
        }, this.wiederholenMs);
        if (typeof this.neuTimer.unref === 'function') {
            this.neuTimer.unref();
        }
    }

    /**
     * Veroeffentlicht ein Kommando an ein Geraet.
     *
     * @param {string} topic   Zieltopic des Moduls (ohne Praefix)
     * @param {string|Buffer} payload  Nutzlast
     * @returns {Promise<boolean>} true, wenn der Broker die Nachricht angenommen hat
     */
    publish(topic, payload) {
        return new Promise(resolve => {
            if (!this.client || !this.verbunden) {
                this.log.warn(`Sending to "${topic}" failed: external MQTT broker not connected`);
                return resolve(false);
            }
            this.client.publish(`${this.praefix}${topic}`, String(payload), { qos: 0, retain: false }, err => {
                if (err) {
                    this.log.warn(`Sending to "${topic}" failed: ${err.message}`);
                }
                resolve(!err);
            });
        });
    }

    /**
     * Verbindung beenden.
     *
     * @returns {Promise<void>} beendet
     */
    stop() {
        return new Promise(resolve => {
            const c = this.client;
            this.client = null;
            this.verbunden = false;
            this.beendet = true;
            if (this.neuTimer) {
                clearTimeout(this.neuTimer);
                this.neuTimer = null;
            }
            if (!c) {
                return resolve();
            }
            c.removeAllListeners('close');
            c.end(true, {}, () => resolve());
        });
    }
}

/**
 * Client-ID, wenn der Nutzer keine eingetragen hat: eindeutig je Installation und Instanz.
 * Bewusst NICHT "iobroker-faikout-<Instanz>": diese ID nutzt auch ein anderer Adapter fuer dieselben
 * Module - am selben Broker warfen sich beide im Sekundentakt gegenseitig hinaus.
 *
 * @param {number|string} instanz  Instanznummer
 * @param {string} [rechner]  Rechnername (Vorgabe: os.hostname())
 * @returns {string} Client-ID
 */
function standardClientId(instanz, rechner = require('node:os').hostname()) {
    const kurz = require('node:crypto').createHash('sha1').update(String(rechner)).digest('hex').slice(0, 6);
    return `iobroker-faikout-adapter-${instanz ?? 0}-${kurz}`;
}

/**
 * Neue Standard-Client-ID fuer eine Instanz: einmal erzeugt, in der Instanz gespeichert und im Feld
 * "Client-ID" sichtbar vorbelegt. Ein fester Zufallsteil statt einer neuen ID je Start - wechselnde
 * IDs stoeren Sitzungen und Zugriffslisten des Brokers.
 *
 * @param {number|string} instanz  Instanznummer
 * @returns {string} Client-ID
 */
function neueClientId(instanz) {
    return `iobroker-faikout-${instanz ?? 0}-${require('node:crypto').randomBytes(3).toString('hex')}`;
}

module.exports = {
    ANMELDUNG_WIEDERHOLEN_MS,
    neueClientId,
    standardClientId,
    ExternerBroker,
    testen,
    testPasswort,
    praefixVon,
    verbindung,
    fehlerArt,
};
