'use strict';

/*
 * HTTP-Nachbildung der Modulseiten - NUR LESEN. Jede andere Methode als GET/HEAD wird mit 405
 * abgewiesen und gezaehlt ("verbotener POST"): ein Adapter, der hier schreibt, wuerde am echten
 * Modul Einstellungen speichern.
 *
 * Wer liest was:
 *  - unser Adapter (lib/discovery.js): GET /revk-settings, wertet <address>-Fusszeile, <h1> und die
 *    Eingabefelder hostname (Platzhalter = ID), mqtthost, mqttuser aus.
 *  - faikout-ac (lib/deviceDiscovery.ts): GET / (sucht `o.<feld>` im Skript), /revk-settings?_page=-2
 *    (`id="no<feld>" ... checked`, Auswahl `_fantype`), ?_page=0 (`<h1>Name` und `Home</a> App<small>`),
 *    ?_page=1 (xgpio - gibt es hier nicht), ?_page=-3 (topiccommand/-setting/-state, prefixapp/-host).
 *
 * Seitenaufbau nach revk.c (revk_web_settings Z. 4440 ff., revk_web_foot Z. 4122) und Faikout.c
 * (web_control Z. 1900-2193). Ein Server bedient mehrere Module: Auswahl ueber den Host-Header
 * (Modulname, Aliasname oder ID) oder ueber einen eigenen Port je Modul.
 */

const http = require('node:http');
const { VERSION, BUILD, HARDWARE } = require('./modul');

const maske = s =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const kopf = (titel, modul) =>
    `<!DOCTYPE html><meta name='viewport' content='width=device-width, initial-scale=.75'><title>${titel}</title>` +
    `<style>body{font-family:sans-serif;}</style><html><body>` +
    `<h1>${maske(modul.name)} <b id=_msg class=status>${modul.verbunden ? 'MQTT connected' : 'MQTT not connected'}</b></h1>`;

const fuss = (heim, extra) =>
    `<hr><address>${heim ? '<a href=/>Home</a> ' : '<a href=/revk-settings?_page=0>Settings</a> '}` +
    `Faikout<small>${HARDWARE}</small>: ${VERSION} ${BUILD}${extra ? ` <b>${maske(extra)}</b>` : ''}</address></body></html>`;

const eingabe = (feld, wert, platzhalter = '') =>
    `<tr><td>${feld}</td><td nowrap><input id="${feld}" name="_${feld}" onchange="this.name='${feld}';" value="${maske(wert)}" ` +
    `autocapitalize='off' autocomplete='off' spellcheck='false' size=40 autocorrect='off' placeholder="${maske(platzhalter)}"></td><td></td></tr>`;

const schalter = (feld, an) =>
    `<tr><td>${feld}</td><td nowrap><label class=switch><input type=checkbox id="${feld}" name="_${feld}" ` +
    `onchange="this.name='${feld}';settings.__${feld}.name='${feld}';"${an ? ' checked' : ''}><span class=slider></span></label></td>` +
    `<td><input type=hidden name="__${feld}"><label for="${feld}"></label></td></tr>`;

const reiter = seite =>
    `<tr id=_set><td valign=top><input name=_save type=submit value='Save'></td><td colspan=2 nowrap>${[
        [-1, 'Basic'],
        [0, 'Faikout'],
        [-2, 'Extra'],
        [-3, 'Library'],
    ]
        .map(
            ([nr, name]) =>
                `<label class=box style="width:${name.length}em"><input type=radio name='_page' value='${nr}' ` +
                `onchange="document.settings.submit();"${nr === seite ? ' checked' : ''}><span class=button>${name}</span></label>`,
        )
        .join('')}</td></tr>`;

/**
 * Einstellungsseite /revk-settings?_page=N.
 *
 * @param {import('./modul').Modul} modul Modul
 * @param {number} seite -1 Basic, 0 Faikout, -2 Extra, -3 Library, sonst leer
 * @param {{mqtthost?: string, mqttuser?: string}} [netz] Anzeige der Broker-Angaben
 * @returns {string} HTML
 */
function einstellungsSeite(modul, seite, netz = {}) {
    const e = modul.e;
    let zeilen = '';
    if (seite === -1) {
        zeilen =
            eingabe('wifissid', 'SimNetz') +
            eingabe('wifipass', '') +
            eingabe('hostname', modul.name === modul.id ? '' : modul.name, modul.id) +
            eingabe('instance', '') +
            eingabe('mqtthost', netz.mqtthost || '', 'hostname') +
            eingabe('mqttuser', netz.mqttuser || '', 'username') +
            eingabe('mqttpass', '', 'password') + // Passwoerter zeigt der Simulator nie
            eingabe('cookie', '') +
            eingabe('password', '');
    } else if (seite === 0) {
        for (const f of ['reporting', 'thermref', 'autot', 'autor', 'auto0', 'auto1', 'switchtemp', 'pushtemp']) {
            zeilen += eingabe(f, e[f]);
        }
        for (const f of [
            'coolover',
            'coolback',
            'heatover',
            'heatback',
            'tmin',
            'tmax',
            'tcoolmin',
            'theatmax',
            'tcontrol',
            'tsample',
        ]) {
            zeilen += eingabe(f, e[f]);
        }
        for (const f of ['autoe', 'autop', 'livestatus', 'lockmode', 'thermostat', 'haenable', 'haswitches']) {
            zeilen += schalter(f, e[f]);
        }
    } else if (seite === -2) {
        for (const f of Object.keys(e).filter(k => k.startsWith('no'))) {
            zeilen += schalter(f, e[f]);
        }
        zeilen += `<tr><td>fantype</td><td nowrap><select name="_fantype" onchange="this.name='fantype';settings.__fantype.name='fantype';">${[
            'Default',
            '5 level+auto',
            '3 level',
            '3 level+auto',
        ]
            .map((n, i) => `<option value="${i}"${i === e.fantype ? ' selected' : ''}>${n}</option>`)
            .join('')}</select></td><td></td></tr>`;
    } else if (seite === -3) {
        zeilen =
            eingabe('topiccommand', 'command') +
            eingabe('topicsetting', 'setting') +
            eingabe('topicstate', 'state') +
            eingabe('topicevent', 'event') +
            eingabe('topicinfo', 'info') +
            eingabe('topicerror', 'error') +
            eingabe('topicha', 'homeassistant') +
            schalter('prefixapp', false) +
            schalter('prefixhost', false);
    }
    return (
        `${kopf('Settings', modul)}<form action='/revk-settings' name='settings' method='post'><table>${reiter(seite)}` +
        `${zeilen}</table></form>${fuss(true)}`
    );
}

/**
 * Startseite / - die Bedienseite. Ihr Skript nennt alle Statusfelder als `o.<feld>` (Faikout.c
 * Z. 2142-2188), unabhaengig davon, was die Anlage kann.
 *
 * @param {import('./modul').Modul} modul Modul
 * @returns {string} HTML
 */
function startSeite(modul) {
    const b = ['power', 'swingh', 'swingv', 'econo', 'powerful', 'comfort', 'sensor', 'led', 'quiet', 'streamer'];
    const skript =
        `function decode(o){` +
        `cl=(!o.online&&o.protocol!='loopback'?'':'xoffline ')+(o.control?'':'xcontrol ')+(o.slave?'':'xslave ')+` +
        `(o.remote?'isremote ':'')+(o.antifreeze?'':'xantifreeze ')+(o.autor>0?'':'xautor ')+(o.autoe?'':'xautoe ');` +
        `${b.map(f => `b('${f}',o.${f});`).join('')}e('mode',o.mode);` +
        `t('Inlet',o.inlet);t('Home',o.home);t('Env',o.env);t('Outside',o.outside);t('Liquid',o.liquid);s('Humidity',o.hum+'%');` +
        `if(o.ble){t('Temp',o.ble.temp);s('Hum',o.ble.hum?o.ble.hum+'%':'---');s('Bat',o.ble.bat?o.ble.bat+'%':o.ble.volt?o.ble.volt+'V':'---');}` +
        `n('demand',o.demand);s('Tdemand',(o.demand!=undefined?o.demand+'%':'---'));n('temp',o.temp);` +
        `b('autop',o.autop);b('autoe',o.autoe);e('autor',o.autor);n('autob',o.autob);n('auto0',o.auto0);n('auto1',o.auto1);n('autot',o.autot);` +
        `s('Fan',(o.fanrpm?' '+o.fanrpm+'RPM':'')+(o.consumption?' '+o.consumption+'W':''));e('fan',o.fan);` +
        `if(o.shutdown){reboot=true;}}`;
    return (
        `<!DOCTYPE html><meta name='viewport' content='width=device-width, initial-scale=.75'><title>${maske(modul.name)}</title>` +
        `<style>body{font-family:sans-serif;}</style><html><body><h1>${maske(modul.name)}</h1>` +
        `<form name=F><table id=live></table></form><script>${skript}</script>${fuss(false, modul.art.protokoll)}`
    );
}

/** HTTP-Dienst fuer die Modulseiten. */
class ModulHttp {
    /**
     * @param {object} [opt] Aufbau
     * @param {string} [opt.bind] Adresse, auf der gelauscht wird (Vorgabe 127.0.0.1)
     */
    constructor(opt = {}) {
        this.bind = opt.bind || '127.0.0.1';
        this.eintraege = []; // {modul, hosts: Set<string>, port?: number, netz}
        this.server = new Map(); // Port -> http.Server
        this.zaehler = { anfragen: 0, verboten: 0, verbotenNach: {}, unbekannt: 0 };
        /** Testschalter: so lange zeigt die Einstellungsseite nach einer Aenderung noch den alten Stand. */
        this.rueckleseMs = opt.rueckleseMs || 0;
        this.jetzt = opt.jetzt || (() => Date.now());
    }

    /**
     * Modul anmelden.
     *
     * @param {import('./modul').Modul} modul Modul
     * @param {{hosts?: string[], port?: number, mqtthost?: string, mqttuser?: string}} [opt] Aliasnamen, eigener Port, Anzeige
     */
    anmelden(modul, opt = {}) {
        const hosts = new Set([modul.name, modul.id, ...(opt.hosts || [])].map(h => String(h).toLowerCase()));
        this.eintraege.push({ modul, hosts, port: opt.port, netz: { mqtthost: opt.mqtthost, mqttuser: opt.mqttuser } });
    }

    /**
     * Das Modul, wie es die Einstellungsseite zeigt: mit Ruecklese-Verzoegerung erscheinen geaenderte
     * Einstellungen erst `rueckleseMs` nach der ersten Abfrage, die sie haette zeigen koennen.
     *
     * @param {object} eintrag Eintrag aus anmelden()
     * @returns {object} Modul bzw. Sicht darauf mit dem aelteren Stand der Einstellungen
     */
    sicht(eintrag) {
        const jetzt = this.jetzt();
        const aktuell = JSON.stringify(eintrag.modul.e);
        if (!this.rueckleseMs || eintrag.gezeigt === undefined) {
            eintrag.gezeigt = aktuell;
            eintrag.neuSeit = null;
            return eintrag.modul;
        }
        if (aktuell !== eintrag.gezeigt) {
            eintrag.neuSeit = eintrag.neuSeit ?? jetzt;
            if (jetzt - eintrag.neuSeit >= this.rueckleseMs) {
                eintrag.gezeigt = aktuell;
                eintrag.neuSeit = null;
            }
        }
        const sicht = Object.create(eintrag.modul);
        Object.defineProperty(sicht, 'e', { value: JSON.parse(eintrag.gezeigt) });
        return sicht;
    }

    /**
     * Welches Modul ist gemeint?
     *
     * @param {string} hostKopf Host-Header
     * @param {number} port Port, auf dem die Anfrage ankam
     * @returns {object|null} Eintrag
     */
    finden(hostKopf, port) {
        const eigener = this.eintraege.find(e => typeof e.port === 'number' && e.port === port);
        if (eigener) {
            return eigener;
        }
        const host = String(hostKopf || '')
            .replace(/:\d+$/, '')
            .replace(/\.local$/i, '')
            .toLowerCase();
        const treffer = this.eintraege.find(e => e.hosts.has(host));
        if (treffer) {
            return treffer;
        }
        const gemeinsam = this.eintraege.filter(e => typeof e.port !== 'number');
        return gemeinsam.length === 1 ? gemeinsam[0] : null;
    }

    /**
     * Anfrage beantworten (auch direkt aus Tests aufrufbar).
     *
     * @param {{method: string, url: string, host: string, port: number}} a Anfrage
     * @returns {{status: number, typ: string, text: string, kopf?: Record<string, string>}} Antwort
     */
    antwort(a) {
        this.zaehler.anfragen++;
        const eintrag = this.finden(a.host, a.port);
        if (a.method !== 'GET' && a.method !== 'HEAD') {
            const name = eintrag ? eintrag.modul.name : '?';
            this.zaehler.verboten++;
            this.zaehler.verbotenNach[name] = (this.zaehler.verbotenNach[name] || 0) + 1;
            return { status: 405, typ: 'text/plain', text: 'simulator is read-only\n', kopf: { Allow: 'GET, HEAD' } };
        }
        if (!eintrag) {
            this.zaehler.unbekannt++;
            return { status: 404, typ: 'text/plain', text: 'unknown module (Host header)\n' };
        }
        const url = new URL(a.url, 'http://x');
        if (url.pathname === '/__test') {
            // Testschalter (nur Simulator): Ruecklese-Verzoegerung in ms. Ein echtes Modul zeigt einen per
            // MQTT gesetzten Wert auf seiner Einstellungsseite erst nach etwa 30 s.
            if (url.searchParams.has('rueckleseMs')) {
                this.rueckleseMs = Math.max(0, Number(url.searchParams.get('rueckleseMs')) || 0);
            }
            return { status: 200, typ: 'application/json', text: `${JSON.stringify({ rueckleseMs: this.rueckleseMs })}\n` };
        }
        if (url.pathname === '/') {
            return { status: 200, typ: 'text/html; charset=utf-8', text: startSeite(eintrag.modul) };
        }
        if (url.pathname === '/revk-settings') {
            const seite = url.searchParams.has('_page') ? Number(url.searchParams.get('_page')) : -1;
            return {
                status: 200,
                typ: 'text/html; charset=utf-8',
                text: einstellungsSeite(this.sicht(eintrag), seite, eintrag.netz),
            };
        }
        return { status: 404, typ: 'text/plain', text: 'not found\n' };
    }

    /**
     * Lauschen: ein gemeinsamer Port (0 = keiner) und die eigenen Ports der Module.
     *
     * @param {number} [gemeinsamerPort] Port fuer die Auswahl ueber den Host-Header
     * @returns {Promise<number[]>} tatsaechliche Ports
     */
    async start(gemeinsamerPort) {
        const plan = this.eintraege.filter(e => typeof e.port === 'number').map(e => ({ port: e.port, eintrag: e }));
        if (typeof gemeinsamerPort === 'number') {
            plan.push({ port: gemeinsamerPort, eintrag: null });
        }
        const offen = [];
        for (const { port, eintrag } of plan) {
            const server = http.createServer((req, res) => {
                req.resume(); // einen etwaigen Koerper verwerfen, nie auswerten
                const r = this.antwort({
                    method: req.method,
                    url: req.url,
                    host: req.headers.host,
                    port: server.address().port,
                });
                res.writeHead(r.status, { 'Content-Type': r.typ, Connection: 'close', ...(r.kopf || {}) });
                res.end(req.method === 'HEAD' ? '' : r.text);
            });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, this.bind, resolve);
            });
            const echt = server.address().port;
            if (eintrag) {
                eintrag.port = echt; // Port 0 = vom System gewaehlt
            }
            this.server.set(echt, server);
            offen.push(echt);
        }
        return offen;
    }

    /** @returns {Promise<void>} alle Server geschlossen */
    async stop() {
        await Promise.all([...this.server.values()].map(s => new Promise(r => s.close(() => r()))));
        this.server.clear();
    }
}

module.exports = { ModulHttp, einstellungsSeite, startSeite };
