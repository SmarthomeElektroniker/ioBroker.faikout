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
     * @param {(topic:string, payload:Buffer)=>void} opts.onMessage  je eingehender Nachricht
     * @param {(clientId:string, verbunden:boolean)=>void} [opts.onClient]  bei An- und Abmeldung eines Moduls
     */
    constructor(opts) {
        this.port = opts.port;
        this.user = opts.user || '';
        this.pass = opts.pass || '';
        this.log = opts.log;
        this.onMessage = opts.onMessage;
        this.onClient = opts.onClient || (() => {});
        this.broker = null;
        this.server = null;
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
                    this.log.warn(`MQTT-Anmeldung abgelehnt für "${client && client.id}" (Benutzer "${u}")`);
                    const err = new Error('Anmeldung abgelehnt');
                    err.returnCode = 4; // bad user name or password
                    return done(err, false);
                }
                done(null, true);
            },
        });

        return new Promise((resolve, reject) => {
            this.broker.on('client', client => {
                this.log.info(`MQTT-Client verbunden: ${client.id}`);
                this.onClient(client.id, true);
            });
            this.broker.on('clientDisconnect', client => {
                this.log.info(`MQTT-Client getrennt: ${client.id}`);
                this.onClient(client.id, false);
            });
            this.broker.on('clientError', (client, err) => {
                this.log.debug(`MQTT-Clientfehler ${client && client.id}: ${err.message}`);
            });
            this.broker.on('publish', (packet, client) => {
                // Ohne client sind es die internen $SYS-Nachrichten des Brokers.
                if (!client || !packet || !packet.topic) {
                    return;
                }
                try {
                    this.onMessage(packet.topic, packet.payload);
                } catch (e) {
                    this.log.warn(`Fehler beim Verarbeiten von "${packet.topic}": ${e.message}`);
                }
            });

            this.server = net.createServer(stream => this.broker.handle(stream));
            this.server.on('error', err => {
                if (err.code === 'EADDRINUSE') {
                    this.log.error(`Port ${this.port} ist belegt - anderen Port in den Instanzeinstellungen wählen.`);
                }
                reject(err);
            });
            this.server.listen(this.port, () => {
                this.log.info(`MQTT-Broker lauscht auf Port ${this.port}`);
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
                        this.log.warn(`Senden an "${topic}" fehlgeschlagen: ${err.message}`);
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
            const fertig = () => {
                if (this.broker) {
                    this.broker.close(() => resolve());
                    this.broker = null;
                } else {
                    resolve();
                }
            };
            if (this.server) {
                this.server.close(fertig);
                this.server = null;
            } else {
                fertig();
            }
        });
    }
}

module.exports = { FaikoutBroker };
