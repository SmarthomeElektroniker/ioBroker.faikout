'use strict';

/*
 * Simulator-Dienst fuer das Testnetz: node sim/dienst.js
 *
 * Jedes Modul jeder Welt verbindet sich als eigener MQTT-Client (Client-ID und Testament wie die
 * Firmware) mit dem Broker seiner Welt; dazu die HTTP-Modulseiten (nur lesend), eine Messdatei
 * (JSONL) und eine kleine HTTP-Steuerung NUR fuer das Testnetz.
 *
 * Umgebungsvariablen:
 *   SIM_KONFIG        Pfad einer JSON-Datei {welten: [...], http: {...}, steuerPort, ausgabe, taktMs, bind}
 *   SIM_WELTEN        dasselbe `welten`-Feld als JSON-Text
 *   -- oder eine einzelne Welt: --
 *   SIM_BROKER        mqtt://127.0.0.1:1883
 *   SIM_BENUTZER / SIM_PASSWORT
 *   SIM_PRAEFIX       Vorsatz der Modulnamen (sim-)
 *   SIM_MODULE        Typen, z. B. "s21,nodemand,tcl"
 *   SIM_SZENARIO      Name aus szenarien.js (heizenKalterTag)
 *   SIM_ZEITFAKTOR    Physik-Sekunden je echter Sekunde (1)
 *   SIM_SEED          Zufallsstartwert (1)
 *   -- allgemein: --
 *   SIM_HTTP_PORT     gemeinsamer Port der Modulseiten, Auswahl ueber den Host-Header (8080; "" = keiner)
 *   SIM_HTTP_PORT_AB  zusaetzlich je Modul ein eigener Port ab dieser Nummer
 *   SIM_STEUER_PORT   Steuerung (18900; 0 = aus)
 *   SIM_BIND          Lauschadresse (127.0.0.1; im Container 0.0.0.0)
 *   SIM_AUSGABE       Messdatei (JSONL, wird angehaengt)
 *   SIM_TAKT_MS       echte Millisekunden je Modulsekunde (1000) - nur fuer Tests kleiner
 *
 * Schutz: Broker in 192.168.x.x werden abgelehnt - der Simulator gehoert nie ins Heimnetz.
 */

const fs = require('node:fs');
const http = require('node:http');
const { Welt } = require('./welt');
const { ModulHttp } = require('./http');
const { namen: szenarioNamen } = require('./szenarien');

/**
 * Darf der Dienst diesen Broker ansprechen? Erlaubt: Loopback, Namen ohne Punkt (Container),
 * 10.x und 172.16-31.x (Docker-Netze). Verboten: alles andere, vor allem 192.168.x.x.
 *
 * @param {string} url Broker-URL
 * @returns {boolean} erlaubt
 */
function brokerErlaubt(url) {
    let host;
    try {
        host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
        return false;
    }
    if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
        return true;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        const [a, b] = host.split('.').map(Number);
        return a === 10 || (a === 172 && b >= 16 && b <= 31);
    }
    return /^[a-z0-9][a-z0-9_-]*$/i.test(host);
}

/**
 * Konfiguration aus der Umgebung lesen.
 *
 * @param {Record<string, string|undefined>} [env] Umgebung
 * @returns {object} {welten, http: {port, portAb}, steuerPort, bind, ausgabe, taktMs}
 */
function konfigLesen(env = process.env) {
    let k = {};
    if (env.SIM_KONFIG) {
        k = JSON.parse(fs.readFileSync(env.SIM_KONFIG, 'utf8'));
    }
    if (env.SIM_WELTEN) {
        k.welten = JSON.parse(env.SIM_WELTEN);
    }
    if (!k.welten || !k.welten.length) {
        k.welten = [
            {
                name: 'welt',
                broker: env.SIM_BROKER || 'mqtt://127.0.0.1:1883',
                benutzer: env.SIM_BENUTZER || '',
                passwort: env.SIM_PASSWORT || '',
                praefix: env.SIM_PRAEFIX ?? 'sim-',
                szenario: env.SIM_SZENARIO || 'heizenKalterTag',
                zeitfaktor: Number(env.SIM_ZEITFAKTOR) || 1,
                seed: Number(env.SIM_SEED) || 1,
                module: (env.SIM_MODULE || 's21,nodemand,tcl')
                    .split(',')
                    .map(t => t.trim())
                    .filter(Boolean)
                    .map(typ => ({ typ })),
            },
        ];
    }
    const zahl = (roh, vorgabe) => (roh === undefined ? vorgabe : roh === '' ? null : Number(roh));
    k.http = k.http || {};
    k.http.port = zahl(env.SIM_HTTP_PORT, k.http.port ?? 8080);
    k.http.portAb = zahl(env.SIM_HTTP_PORT_AB, k.http.portAb ?? null);
    k.steuerPort = zahl(env.SIM_STEUER_PORT, k.steuerPort ?? 18900);
    k.bind = env.SIM_BIND || k.bind || '127.0.0.1';
    k.ausgabe = env.SIM_AUSGABE || k.ausgabe || '';
    k.taktMs = Number(env.SIM_TAKT_MS) || k.taktMs || 1000;
    return k;
}

/** Der Dienst: Welten, MQTT-Clients, HTTP, Messdatei, Steuerung. */
class Dienst {
    /**
     * @param {object} konfig aus konfigLesen()
     * @param {{log?: (text: string) => void, mqtt?: object}} [opt] Logausgabe, MQTT-Bibliothek (Tests)
     */
    constructor(konfig, opt = {}) {
        this.k = konfig;
        this.log = opt.log || (text => console.log(`${new Date().toISOString()} ${text}`));
        this.mqtt = opt.mqtt || require('mqtt');
        this.welten = [];
        this.clients = new Map(); // "<welt>/<modul>" -> MQTT-Client
        this.http = new ModulHttp({ bind: konfig.bind });
        this.steuerung = null;
        this.steuerPort = null;
        this.httpPorts = [];
        this.datei = null;
        this.takt = null;
        this.laeuft = false;
    }

    /** @returns {Promise<void>} alles gestartet */
    async start() {
        const k = this.k;
        for (const w of k.welten) {
            if (!brokerErlaubt(w.broker)) {
                throw new Error(
                    `broker "${w.broker}" refused: the simulator only talks to loopback or container networks`,
                );
            }
        }
        if (k.ausgabe) {
            this.datei = fs.createWriteStream(k.ausgabe, { flags: 'a' });
        }
        this.laeuft = true;
        let nr = 0;
        for (const w of k.welten) {
            const welt = new Welt({
                name: w.name,
                szenario: w.szenario,
                seed: w.seed,
                praefix: w.praefix,
                module: w.module,
                zeitfaktor: w.zeitfaktor,
                uhr: () => Date.now(),
                senden: (modul, topic, payload, o) => {
                    const c = this.clients.get(`${welt.name}/${modul}`);
                    if (c && c.connected) {
                        c.publish(topic, payload, { retain: !!(o && o.retain), qos: 0 });
                    }
                },
                messung: zeile => this.datei && this.datei.write(`${JSON.stringify(zeile)}\n`),
                abriss: m => this.trennen(welt, m),
                wiederkehr: m => this.verbindeModul(welt, w, m),
                beiMarke: marke => this.log(`world ${welt.name}: mark "${marke.name}" at ${marke.zeit}`),
            });
            this.welten.push(welt);
            for (const m of welt.module) {
                const eigen = (w.module || []).find(x => (x.name || `${welt.praefix}${x.typ}`) === m.name) || {};
                const eigenerPort = eigen.httpPort ?? (k.http.portAb ? k.http.portAb + nr : undefined);
                // Das Modul meldet seine Adresse wie ein echtes ("ipv4" in state/<Name>); mit eigenem
                // Port als "Adresse:Port", damit der Adapter die Einstellungsseite ohne Handarbeit findet.
                if (eigenerPort) {
                    const host = k.bind && k.bind !== '0.0.0.0' ? k.bind : '127.0.0.1';
                    m.httpAdresse = eigenerPort === 80 ? host : `${host}:${eigenerPort}`;
                }
                this.http.anmelden(m, {
                    hosts: eigen.hosts,
                    port: eigenerPort,
                    mqtthost: new URL(w.broker).host,
                    mqttuser: w.benutzer,
                });
                nr++;
                this.verbindeModul(welt, w, m);
            }
        }
        this.httpPorts = await this.http.start(k.http.port);
        if (k.steuerPort !== null && k.steuerPort !== undefined && (k.steuerPort || k.steuerPortZufall)) {
            await this.steuerungStarten(k.steuerPortZufall ? 0 : k.steuerPort);
        }
        this.takt = setInterval(() => {
            for (const welt of this.welten) {
                try {
                    welt.sekunde();
                } catch (e) {
                    this.log(`world ${welt.name}: ${e.stack || e.message}`);
                }
            }
        }, k.taktMs);
        this.log(
            `simulator up: ${this.welten.length} world(s), http ${this.httpPorts.join(',') || '-'}, control ${this.steuerPort ?? '-'}`,
        );
    }

    /**
     * Modul als eigenen MQTT-Client verbinden (Client-ID, Testament, Abos wie die Firmware).
     *
     * @param {Welt} welt Welt
     * @param {object} w Konfiguration der Welt (Broker, Zugang)
     * @param {import('./modul').Modul} m Modul
     */
    verbindeModul(welt, w, m) {
        const schluessel = `${welt.name}/${m.name}`;
        if (!this.laeuft || this.clients.has(schluessel)) {
            return;
        }
        const t = m.lwt();
        const c = this.mqtt.connect(w.broker, {
            clientId: m.clientId(),
            username: w.benutzer || undefined,
            password: w.passwort || undefined,
            clean: true,
            keepalive: 30, // revk.c Z. 1543
            reconnectPeriod: Math.max(200, this.k.taktMs * 2),
            will: { topic: t.topic, payload: t.payload, retain: t.retain, qos: 0 },
        });
        this.clients.set(schluessel, c);
        c.on('connect', () => {
            c.subscribe(m.abos(), { qos: 0 });
            m.verbinden();
        });
        c.on('message', (topic, payload) => m.empfangen(topic, payload));
        c.on('close', () => m.abriss());
        c.on('error', e => this.log(`${schluessel}: mqtt ${e.message}`));
    }

    /**
     * Verbindung hart kappen - ohne DISCONNECT, damit der Broker das Testament verschickt.
     *
     * @param {Welt} welt Welt
     * @param {import('./modul').Modul} m Modul
     */
    trennen(welt, m) {
        const schluessel = `${welt.name}/${m.name}`;
        const c = this.clients.get(schluessel);
        if (c) {
            this.clients.delete(schluessel);
            c.removeAllListeners('close');
            c.on('error', () => {});
            c.end(true);
        }
    }

    /** @returns {object} Stand aller Welten und Zaehler */
    stand() {
        return {
            zeit: new Date().toISOString(),
            http: { ports: this.httpPorts, ...this.http.zaehler },
            welten: this.welten.map(w => w.stand()),
        };
    }

    /**
     * Steuerung auswerten (auch direkt aus Tests aufrufbar).
     *
     * @param {string} methode GET/POST
     * @param {string} pfad Pfad
     * @param {object} [daten] JSON-Koerper
     * @returns {{status: number, daten: object}} Antwort
     */
    steuern(methode, pfad, daten = {}) {
        const welt =
            this.welten.find(w => w.name === daten.welt) ||
            (this.welten.length === 1 || !daten.welt ? this.welten[0] : null);
        if (methode === 'GET' && pfad === '/stand') {
            return { status: 200, daten: this.stand() };
        }
        if (methode === 'GET' && pfad === '/szenarien') {
            return { status: 200, daten: { szenarien: szenarioNamen() } };
        }
        if (methode === 'POST' && (pfad === '/szenario' || pfad === '/ereignis')) {
            if (!welt || (daten.welt && welt.name !== daten.welt)) {
                return { status: 404, daten: { fehler: `unknown world "${daten.welt}"` } };
            }
            try {
                if (pfad === '/szenario') {
                    welt.szenarioSetzen(daten.name);
                } else {
                    if (daten.modul && !welt.modul(daten.modul)) {
                        return { status: 404, daten: { fehler: `unknown module "${daten.modul}"` } };
                    }
                    welt.ereignis(daten);
                }
            } catch (e) {
                return { status: 400, daten: { fehler: e.message } };
            }
            return { status: 200, daten: { ok: true, welt: welt.name, szenario: welt.szenario.name } };
        }
        return { status: 404, daten: { fehler: 'not found' } };
    }

    /**
     * Steuerung auf dem Port starten.
     *
     * @param {number} port Port (0 = frei waehlen)
     * @returns {Promise<void>} lauscht
     */
    steuerungStarten(port) {
        this.steuerung = http.createServer((req, res) => {
            const teile = [];
            let laenge = 0;
            req.on('data', t => {
                laenge += t.length;
                if (laenge <= 65536) {
                    teile.push(t);
                }
            });
            req.on('end', () => {
                let daten = {};
                let r;
                try {
                    const text = Buffer.concat(teile).toString('utf8');
                    daten = text ? JSON.parse(text) : {};
                    r = this.steuern(req.method, new URL(req.url, 'http://x').pathname, daten);
                } catch (e) {
                    r = { status: 400, daten: { fehler: e.message } };
                }
                res.writeHead(r.status, { 'Content-Type': 'application/json', Connection: 'close' });
                res.end(`${JSON.stringify(r.daten)}\n`);
            });
        });
        return new Promise((resolve, reject) => {
            this.steuerung.once('error', reject);
            this.steuerung.listen(port, this.k.bind, () => {
                this.steuerPort = this.steuerung.address().port;
                resolve();
            });
        });
    }

    /** @returns {Promise<void>} alles beendet */
    async stop() {
        this.laeuft = false;
        clearInterval(this.takt);
        const enden = [];
        for (const c of this.clients.values()) {
            c.removeAllListeners('close');
            enden.push(new Promise(r => c.end(true, {}, () => r())));
        }
        this.clients.clear();
        await Promise.all(enden);
        await this.http.stop();
        if (this.steuerung) {
            await new Promise(r => this.steuerung.close(() => r()));
        }
        if (this.datei) {
            await new Promise(r => this.datei.end(() => r()));
        }
    }
}

if (require.main === module) {
    const dienst = new Dienst(konfigLesen());
    dienst.start().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
    const ende = () => dienst.stop().then(() => process.exit(0));
    process.on('SIGINT', ende);
    process.on('SIGTERM', ende);
}

module.exports = { Dienst, konfigLesen, brokerErlaubt };
