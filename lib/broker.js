'use strict';

/*
 * Eigener MQTT-Broker fuer die faikout-Module.
 *
 * Bewusst ein eigener Broker auf eigenem Port statt Mitbenutzung eines vorhandenen
 * (z. B. mqtt.0): Die Klimaanlagen sollen von allem anderen getrennt bleiben, und der
 * Adapter kennt so jede Nachricht seiner Geraete, ohne fremden Verkehr mitzulesen.
 */

const net = require('node:net');
// aedes 1.x exportiert die Klasse benannt; der Aufruf als Funktion (aedes(...)) faellt weg.
const { Aedes } = require('aedes');

/** Abgelehnte Anmeldung desselben Clients hoechstens so oft als Warnung melden. */
const ABLEHNUNG_MELDEN_MS = 60 * 60 * 1000;

/** So viele Client-IDs merkt sich die Drosselung hoechstens. */
const ABLEHNUNG_MERKEN_MAX = 200;

/**
 * Der MQTT-Broker, mit dem sich die faikout-Module verbinden.
 */
class FaikoutBroker {
    /**
     * @param {object} opts              Einstellungen des Brokers
     * @param {number} opts.port          Port, auf dem gelauscht wird
     * @param {string} [opts.user]        Optionaler Benutzername; leer = keine Anmeldung noetig
     * @param {string} [opts.pass]        Passwort dazu
     * @param {object} opts.log           Logger des Adapters
     * @param {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} opts.timer  Zeitgeber des Adapters
     *        (adapter.setTimeout statt des nackten setTimeout - der Adapter raeumt sie beim Beenden selbst ab)
     * @param {(topic:string, payload:Buffer)=>void} opts.onMessage  je eingehender Nachricht
     * @param {(clientId:string, verbunden:boolean)=>void} [opts.onClient]  bei An- und Abmeldung eines Moduls
     * @param {() => number} [opts.jetzt]  Uhr (Tests)
     */
    constructor(opts) {
        this.port = opts.port;
        this.user = opts.user || '';
        this.pass = opts.pass || '';
        this.log = opts.log;
        this.timer = opts.timer;
        this.onMessage = opts.onMessage;
        this.onClient = opts.onClient || (() => {});
        this.broker = null;
        this.server = null;
        /** Abgelehnte Anmeldungen je Client-ID: {zeit der letzten Warnung, seitdem unterdrueckte Versuche}. */
        this.abgelehnt = new Map();
        this.jetzt = opts.jetzt || (() => Date.now());
    }

    /**
     * Meldet eine abgelehnte Anmeldung: je Client beim ersten Mal und danach hoechstens stuendlich
     * als Warnung mit Handlungshinweis, dazwischen nur auf Debug. Ein Modul mit falschen Zugangsdaten
     * versucht es alle paar Sekunden erneut - ohne Drosselung fuellte das das Log (Test Strang E).
     *
     * @param {string} clientId  Client-ID des abgelehnten Clients
     * @param {string} benutzer  gesendeter Benutzername
     */
    ablehnungMelden(clientId, benutzer) {
        const jetzt = this.jetzt();
        const e = this.abgelehnt.get(clientId);
        if (e && jetzt - e.zeit < ABLEHNUNG_MELDEN_MS) {
            e.unterdrueckt++;
            this.log.debug(`MQTT login rejected for "${clientId}" (user "${benutzer}")`);
            return;
        }
        // Obergrenze: wechselnde Client-IDs (Scanner) duerfen den Merker nicht wachsen lassen.
        if (!e && this.abgelehnt.size >= ABLEHNUNG_MERKEN_MAX) {
            this.abgelehnt.delete(this.abgelehnt.keys().next().value);
        }
        const mehr = e && e.unterdrueckt ? ` ${e.unterdrueckt} more attempt(s) since the last report.` : '';
        this.abgelehnt.set(clientId, { zeit: jetzt, unterdrueckt: 0 });
        this.log.warn(
            `MQTT login rejected for "${clientId}" (user "${benutzer}").${mehr} Set "mqttuser" and "mqttpass" on the module to the values of the MQTT broker tab, or use "Connect" in the tab "Find modules". Further rejections of this client are reported at most once per hour.`,
        );
    }

    /**
     * Den Broker starten und auf dem eingestellten Port lauschen.
     *
     * @returns {Promise<void>} erfuellt, sobald der Port angenommen wird
     */
    async start() {
        // aedes 1.x wird ueber eine asynchrone Fabrik erzeugt. Ein blosses `new Aedes()`
        // liefert zwar eine Instanz, deren `handle` aber nie antwortet - der Client laeuft
        // dann in "connack timeout".
        this.broker = await Aedes.createBroker({
            id: 'iobroker-faikout',
            // Anmeldung nur pruefen, wenn in den Instanzeinstellungen etwas hinterlegt ist.
            // Ohne Benutzer bleibt der Broker offen - im eigenen LAN der uebliche Fall, und
            // die faikout-Module koennen ohne Anmeldung senden.
            authenticate: (client, username, password, done) => {
                if (!this.user) {
                    return done(null, true);
                }
                const u = username ? String(username) : '';
                const p = password ? password.toString() : '';
                if (u !== this.user || p !== this.pass) {
                    this.ablehnungMelden(String((client && client.id) || ''), u);
                    const err = new Error('Login rejected');
                    err.returnCode = 4; // bad user name or password
                    return done(err, false);
                }
                done(null, true);
            },
        });

        return new Promise((resolve, reject) => {
            this.broker.on('client', client => {
                this.log.info(`MQTT client connected: ${client.id}`);
                // Anmeldung gelungen: eine spaetere Ablehnung desselben Clients ist wieder neu und wird sofort gemeldet
                this.abgelehnt.delete(String(client.id));
                // Absenderadresse der Verbindung: daraus kennt der Adapter die Adresse des Moduls, auch wenn
                // die Statusmeldung keine IP nennt (IPv4 in IPv6-Schreibweise wird bereinigt)
                const roh = String((client.conn && client.conn.remoteAddress) || '');
                this.onClient(client.id, true, roh.replace(/^::ffff:/, ''));
            });
            this.broker.on('clientDisconnect', client => {
                this.log.info(`MQTT client disconnected: ${client.id}`);
                this.onClient(client.id, false);
            });
            this.broker.on('clientError', (client, err) => {
                this.log.debug(`MQTT client error ${client && client.id}: ${err.message}`);
            });
            this.broker.on('publish', (packet, client) => {
                // Ohne client sind es die internen $SYS-Nachrichten des Brokers.
                if (!client || !packet || !packet.topic) {
                    return;
                }
                try {
                    this.onMessage(packet.topic, packet.payload);
                } catch (e) {
                    this.log.warn(`Error processing "${packet.topic}": ${e.message}`);
                }
            });

            // Offene Verbindungen merken: server.close() wartet sonst, bis jedes Modul von sich aus
            // trennt - die faikout-Module halten ihre Verbindung aber dauerhaft. Ohne das hing das
            // Beenden, und der js-controller brach den Prozess nach der Wartezeit hart ab (SIGKILL).
            this.sockets = new Set();
            this.server = net.createServer(stream => {
                this.sockets.add(stream);
                stream.on('close', () => this.sockets.delete(stream));
                this.broker.handle(stream);
            });
            this.server.on('error', err => {
                if (err.code === 'EADDRINUSE') {
                    this.log.error(`Port ${this.port} is in use - choose another port in the instance settings.`);
                }
                reject(err);
            });
            this.server.listen(this.port, () => {
                // Mit oder ohne Anmeldung: steht bei jedem Start im Log (Test Strang E: ein offen laufender
                // Broker war nirgends zu erkennen).
                if (this.user) {
                    this.log.info(
                        `MQTT broker listening on port ${this.port} WITH login (user "${this.user}") - modules need "mqttuser" and "mqttpass".`,
                    );
                } else {
                    this.log.info(
                        `MQTT broker listening on port ${this.port} WITHOUT login - every device in the network can connect.`,
                    );
                    if (this.pass) {
                        this.log.warn(
                            'A password is stored for the MQTT broker but no user name - the password is ignored and the broker runs WITHOUT login. Enter a user name in the MQTT broker tab to require a login.',
                        );
                    }
                }
                resolve();
            });
        });
    }

    /**
     * Veroeffentlicht ein Kommando an ein Geraet.
     *
     * @param {string} topic   Zieltopic des Moduls
     * @param {string|Buffer} payload  Nutzlast
     * @returns {Promise<void>} erfuellt, sobald der Broker die Nachricht angenommen hat
     */
    publish(topic, payload) {
        return new Promise(resolve => {
            if (!this.broker) {
                return resolve(false);
            }
            this.broker.publish(
                { topic, payload: Buffer.from(String(payload)), qos: 0, retain: false, cmd: 'publish' },
                err => {
                    if (err) {
                        this.log.warn(`Sending to "${topic}" failed: ${err.message}`);
                    }
                    resolve(!err);
                },
            );
        });
    }

    /**
     * Den Broker beenden und alle Verbindungen schliessen.
     *
     * @returns {Promise<void>} erfuellt, wenn der Port wieder frei ist
     */
    stop() {
        return new Promise(resolve => {
            let erledigt = false;
            const ende = () => {
                if (!erledigt) {
                    erledigt = true;
                    clearTimeout(notbremse);
                    resolve();
                }
            };
            // Obergrenze: Das Beenden darf den Adapter nie blockieren (Unload-Zeitlimit).
            // Bewusst der Zeitgeber von Node: der des Adapters verweigert waehrend des Beendens
            // ("setTimeout called, but adapter is shutting down") - die Notbremse liefe dann nie.
            const notbremse = setTimeout(ende, 1500);
            const server = this.server;
            const broker = this.broker;
            this.server = null;
            this.broker = null;
            if (server) {
                server.close(() => (broker ? broker.close(ende) : ende()));
            }
            // Die dauerhaft offenen Modul-Verbindungen aktiv trennen, damit server.close() fertig wird.
            for (const s of this.sockets || []) {
                s.destroy();
            }
            if (this.sockets) {
                this.sockets.clear();
            }
            if (!server) {
                if (broker) {
                    broker.close(ende);
                } else {
                    ende();
                }
            }
        });
    }
}

module.exports = { FaikoutBroker, ABLEHNUNG_MELDEN_MS };
