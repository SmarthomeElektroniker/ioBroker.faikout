'use strict';

/*
 * Module suchen (Reiter "Module suchen" in den Instanzeinstellungen).
 *
 * Nur lesend: Die Suche fragt mDNS nach `_http._tcp` und holt von jedem Kandidaten die
 * Einstellungsseite `/revk-settings` per GET. Ein GET ohne Parameter speichert nichts (siehe
 * revk_web_settings() in ESP32-RevK/revk.c: gespeichert wird nur mit _upgrade/_reboot/_save...
 * bzw. bei einem POST). Gesucht wird einmalig je Klick, nie im Hintergrund und nie als Bereichsscan.
 *
 * Was ein faikout-Modul ausmacht (RevK-Bibliothek, revk.c):
 *  - mDNS: `mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0)` - Instanzname = Beschreibung
 *    (`instance`) oder Hostname, KEIN TXT. Am Dienst allein ist ein faikout also nicht zu erkennen.
 *  - Fusszeile jeder Seite: `<address>... Faikout<small>-S3-MINI-N4-R2</small>: <Version> <Build></address>`
 *  - Ueberschrift: `<h1>Name <b id=_msg class=status>MQTT connected</b></h1>`
 *  - Felder `<input id="mqtthost" name="_mqtthost" ... value="...">`; der Platzhalter von `hostname`
 *    ist die Hardware-ID (revk_id, die MAC), unter der das Modul ohne Hostnamen auftritt.
 *  - Geheimnisse (mqttpass, wifipass) zeigt die Seite nur als Platzhalter - nicht rueckholbar.
 *  - Settings-Passwort gesetzt: die Seite zeigt nur ein Passwortfeld (`<input name=password ...>`).
 *  - Web-Passwort (cookie) gesetzt: statt der Seite kommt `document.location="/login"`.
 *
 * DATENSCHUTZ: Formularwerte (Broker, Benutzer, Passwortplatzhalter) werden weder geloggt noch
 * gespeichert. Das Ergebnis enthaelt den Broker nur, um den Status zu bestimmen; der Benutzername
 * erscheint nur als ja/nein.
 */

const http = require('node:http');
const os = require('node:os');

/** mDNS-Dienst, unter dem die RevK-Module ihre Weboberflaeche ankuendigen. */
const DIENST = '_http._tcp.local';

/** Groesste gelesene Seite - die Basic-Seite hat rund 9 KB. */
const MAX_SEITE = 128 * 1024;

/** Ab Werk benutzter Port, wenn mqtthost keinen enthaelt (mqttport1 im Reiter Library). */
const MQTT_STANDARDPORT = 1883;

/** Firmware-Namen der RevK-Klimamodule (frueher "Faikin"). */
const APPS = ['Faikout', 'Faikin'];

/**
 * Zeitgeber: der des Adapters (raeumt beim Beenden selbst ab), sonst die globalen.
 *
 * @param {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} [t] Zeitgeber des Adapters
 * @returns {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} Zeitgeber
 */
function zeitgeber(t) {
    if (t && typeof t.setTimeout === 'function') {
        return { setTimeout: t.setTimeout.bind(t), clearTimeout: t.clearTimeout.bind(t) };
    }
    return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h) };
}

/**
 * HTML-Maskierung der Firmware (revk_web_safe) zuruecknehmen.
 *
 * @param {string} s maskierter Text
 * @returns {string} Klartext
 */
function entmaskieren(s) {
    return String(s ?? '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Attribute eines HTML-Tags lesen (mit "", '' oder ohne Anfuehrungszeichen).
 *
 * @param {string} tag Inhalt zwischen `<input` und `>`
 * @returns {Record<string, string>} Attribute in Kleinschreibung
 */
function attribute(tag) {
    const a = {};
    const re = /([a-zA-Z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(tag))) {
        a[m[1].toLowerCase()] = entmaskieren(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return a;
}

/**
 * Wertet die Antwort von GET /revk-settings aus.
 *
 * @param {string} html Seiteninhalt
 * @returns {{
 *   faikout: boolean, art: 'seite'|'passwort'|'weblogin'|'fremd',
 *   app?: string, hardware?: string, version?: string, build?: string,
 *   titel?: string, mqttStatus?: string, hostname?: string, revkId?: string,
 *   mqtthost?: string, mqttuserGesetzt?: boolean
 * }} Auswertung
 */
function seiteAuswerten(html) {
    const text = String(html || '');
    // Web-Login (cookie): revk_web_redirect() liefert nur ein Skript mit Weiterleitung.
    if (/document\.location\s*=\s*"\/login"/.test(text) && /Login required/.test(text)) {
        return { faikout: false, art: 'weblogin' };
    }
    const fuss = text.match(/<address>([\s\S]*?)<\/address>/);
    if (!fuss) {
        return { faikout: false, art: 'fremd' };
    }
    const app = fuss[1].match(/(?:^|[\s>])([A-Za-z][\w-]*)(?:<small>([^<]*)<\/small>)?:\s*(\S+)\s+(\S+)/);
    if (!app || !APPS.includes(app[1])) {
        return { faikout: false, art: 'fremd' };
    }
    const r = {
        faikout: true,
        art: 'seite',
        app: app[1],
        hardware: entmaskieren(app[2] || '').replace(/^-/, ''),
        version: entmaskieren(app[3]),
        build: entmaskieren(app[4]).replace(/<.*$/, ''),
    };
    const h1 = text.match(/<h1>([\s\S]*?)\s*<b id=_msg class=status>([\s\S]*?)<\/b><\/h1>/);
    if (h1) {
        r.titel = entmaskieren(h1[1]).trim();
        r.mqttStatus = entmaskieren(h1[2]).trim();
    }
    const felder = {};
    let passwortAbfrage = false;
    for (const m of text.matchAll(/<input\b([^>]*)>/g)) {
        const a = attribute(m[1]);
        const name = a.name || '';
        // Felder heissen im Formular "_feld" und werden erst bei Aenderung in "feld" umbenannt.
        const feld = name.startsWith('_') && !name.startsWith('__') ? name.slice(1) : name;
        if (feld === 'password' && a.type === 'password' && !a.value) {
            passwortAbfrage = true;
        }
        if (feld && !(feld in felder)) {
            felder[feld] = { wert: a.value || '', platzhalter: a.placeholder || '' };
        }
    }
    if (passwortAbfrage && !felder.mqtthost) {
        r.art = 'passwort';
        return r;
    }
    if (felder.hostname) {
        // Ohne eigenen Hostnamen nutzt das Modul seine Hardware-ID - sie steht als Platzhalter da.
        r.revkId = /^[0-9A-F]{12}$/i.test(felder.hostname.platzhalter) ? felder.hostname.platzhalter.toUpperCase() : '';
        r.hostname = felder.hostname.wert || r.revkId;
    }
    if (felder.mqtthost) {
        r.mqtthost = felder.mqtthost.wert;
        r.mqttuserGesetzt = !!(felder.mqttuser && felder.mqttuser.wert);
    }
    return r;
}

/**
 * Holt /revk-settings per GET. Keine Weiterleitung, kein Schreiben.
 *
 * @param {string} adresse IP oder Hostname
 * @param {object} [opt] Optionen
 * @param {number} [opt.timeoutMs] Zeitlimit gesamt (Standard 2000)
 * @param {typeof http.request} [opt.request] fuer Tests austauschbar
 * @param {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} [opt.timer] Zeitgeber des Adapters
 * @returns {Promise<{ok: boolean, adresse: string, fehler?: string} & ReturnType<typeof seiteAuswerten>>} Auswertung
 */
function fingerprint(adresse, opt = {}) {
    const timeoutMs = opt.timeoutMs || 2000;
    const request = opt.request || http.request;
    const timer = zeitgeber(opt.timer);
    return new Promise(resolve => {
        let fertig = false;
        const ende = r => {
            if (!fertig) {
                fertig = true;
                timer.clearTimeout(uhr);
                resolve({ adresse, ...r });
            }
        };
        let req;
        const uhr = timer.setTimeout(() => {
            if (req) {
                req.destroy();
            }
            ende({ ok: false, faikout: false, art: 'fremd', fehler: 'timeout' });
        }, timeoutMs);
        try {
            req = request(
                { host: adresse, port: 80, path: '/revk-settings', method: 'GET', headers: { Connection: 'close' } },
                res => {
                    if (
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        /\/login/.test(String(res.headers.location || ''))
                    ) {
                        res.resume();
                        return ende({ ok: true, faikout: false, art: 'weblogin' });
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return ende({ ok: false, faikout: false, art: 'fremd', fehler: `HTTP ${res.statusCode}` });
                    }
                    const teile = [];
                    let laenge = 0;
                    res.on('data', d => {
                        laenge += d.length;
                        if (laenge > MAX_SEITE) {
                            req.destroy();
                            return ende({ ok: false, faikout: false, art: 'fremd', fehler: 'too large' });
                        }
                        teile.push(d);
                    });
                    res.on('end', () => ende({ ok: true, ...seiteAuswerten(Buffer.concat(teile).toString('utf8')) }));
                    res.on('error', e => ende({ ok: false, faikout: false, art: 'fremd', fehler: e.message }));
                },
            );
            req.on('error', e => ende({ ok: false, faikout: false, art: 'fremd', fehler: e.code || e.message }));
            req.end();
        } catch (e) {
            ende({ ok: false, faikout: false, art: 'fremd', fehler: e.message });
        }
    });
}

/**
 * Wertet gesammelte mDNS-Antworten aus.
 *
 * Reflektor-Schutz: Ein mDNS-Reflektor (UniFi-Gateway, Avahi enable-reflector) wiederholt die
 * Antworten der Module aus anderen Netzen von SEINER Adresse. Massgeblich ist deshalb der A-Record
 * des Ziels aus dem SRV-Eintrag, nie die Absenderadresse des Pakets. Ohne A-Record bleibt der
 * Eintrag weg - der Absender koennte der Reflektor sein.
 *
 * @param {Array<{antwort: {answers?: object[], additionals?: object[]}, absender?: string}>} pakete gesammelte Antworten
 * @returns {Array<{ip: string, name: string, host: string}>} Kandidaten, je IP einmal
 */
function mdnsAuswerten(pakete) {
    const instanzen = new Map(); // Instanzname -> Ziel-Host
    const adressen = new Map(); // Host -> IPv4
    const ptr = new Set();
    for (const p of pakete || []) {
        const r = (p && p.antwort) || {};
        for (const a of [...(r.answers || []), ...(r.additionals || [])]) {
            if (!a || !a.name) {
                continue;
            }
            const name = String(a.name);
            if (a.type === 'PTR' && name.toLowerCase() === DIENST) {
                ptr.add(String(a.data));
            } else if (a.type === 'SRV' && name.toLowerCase().endsWith(`.${DIENST}`)) {
                instanzen.set(name, String((a.data && a.data.target) || ''));
            } else if (a.type === 'A' && typeof a.data === 'string') {
                const host = name.toLowerCase();
                if (!adressen.has(host)) {
                    adressen.set(host, a.data);
                }
            }
        }
    }
    const ergebnis = new Map();
    for (const [instanz, host] of instanzen) {
        const ip = adressen.get(host.toLowerCase());
        if (!ip || ergebnis.has(ip)) {
            continue;
        }
        ergebnis.set(ip, {
            ip,
            name: instanz.slice(0, -(DIENST.length + 1)).replace(/\\032/g, ' '),
            host: host.replace(/\.local\.?$/i, ''),
        });
    }
    return [...ergebnis.values()];
}

/**
 * Fragt einmal per mDNS nach `_http._tcp` und sammelt die Antworten.
 *
 * multicast-dns wird erst hier geladen: Fehlt es (abgebrochene Installation), darf das nicht den
 * Adapter am Start abstuerzen lassen - die Suche faellt dann auf die Einzeladresse zurueck.
 *
 * @param {object} [opt] Optionen
 * @param {number} [opt.dauerMs] Sammelzeit (Standard 3000)
 * @param {() => object} [opt.fabrik] erzeugt den mDNS-Client (Tests)
 * @param {{setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (t: unknown) => void}} [opt.timer] Zeitgeber des Adapters
 * @returns {Promise<{kandidaten: Array<{ip: string, name: string, host: string}>, fehler?: string}>} Kandidaten
 */
function mdnsSuchen(opt = {}) {
    const dauerMs = opt.dauerMs || 3000;
    const timer = zeitgeber(opt.timer);
    return new Promise(resolve => {
        let mdns;
        try {
            mdns = opt.fabrik ? opt.fabrik() : require('multicast-dns')();
        } catch (e) {
            return resolve({ kandidaten: [], fehler: `mDNS unavailable: ${e.message}` });
        }
        const pakete = [];
        let fehler;
        mdns.on('response', (antwort, rinfo) => pakete.push({ antwort, absender: rinfo && rinfo.address }));
        mdns.on('error', e => (fehler = e.message));
        const fragen = () => {
            try {
                mdns.query({ questions: [{ name: DIENST, type: 'PTR' }] });
            } catch (e) {
                fehler = e.message;
            }
        };
        fragen();
        const zweite = timer.setTimeout(fragen, Math.min(1000, dauerMs / 2));
        timer.setTimeout(() => {
            timer.clearTimeout(zweite);
            // Fehlende A-Records: Das Modul antwortet meist mit allem in den additionals; wenn nicht,
            // fehlt der Eintrag eben - die Einzeladresse bleibt als Weg.
            try {
                mdns.destroy();
            } catch {
                // egal
            }
            resolve({ kandidaten: mdnsAuswerten(pakete), fehler });
        }, dauerMs);
    });
}

/**
 * Arbeitet eine Liste mit begrenzter Gleichzeitigkeit ab.
 *
 * @template T, R
 * @param {T[]} liste Eingaben
 * @param {number} parallel hoechstens gleichzeitig
 * @param {(e: T) => Promise<R>} fn Arbeit je Eintrag
 * @returns {Promise<R[]>} Ergebnisse in Eingabereihenfolge
 */
async function begrenzt(liste, parallel, fn) {
    const ergebnis = new Array(liste.length);
    let naechster = 0;
    const arbeiter = async () => {
        while (naechster < liste.length) {
            const i = naechster++;
            ergebnis[i] = await fn(liste[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, liste.length) }, arbeiter));
    return ergebnis;
}

/**
 * Zerlegt mqtthost ("host" oder "host:port").
 *
 * @param {string} wert Eintrag am Modul
 * @returns {{host: string, port: number} | null} null bei leerem Eintrag
 */
function brokerZerlegen(wert) {
    const s = String(wert || '').trim();
    if (!s) {
        return null;
    }
    const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) || s.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) {
        return { host: s.toLowerCase(), port: MQTT_STANDARDPORT };
    }
    return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : MQTT_STANDARDPORT };
}

/**
 * Status eines gefundenen Moduls aus Sicht dieses Adapters.
 *
 * @param {ReturnType<typeof seiteAuswerten> & {ok?: boolean}} fp Fingerprint
 * @param {object} ctx Umgebung
 * @param {string[]} ctx.adressen Adressen, unter denen dieser Adapter erreichbar ist (klein geschrieben)
 * @param {number} ctx.port Broker-Port dieses Adapters
 * @param {Array<{name: string, modulId?: string|null, verbunden?: boolean}>} ctx.geraete Geraete dieses Adapters
 * @returns {{code: string, geraet?: string}} code: verbunden|eingestellt|keinBroker|andererBroker|passwort|weblogin|fremd
 */
function statusBestimmen(fp, ctx) {
    if (!fp || fp.art === 'weblogin') {
        return { code: fp ? 'weblogin' : 'fremd' };
    }
    if (!fp.faikout) {
        return { code: 'fremd' };
    }
    const geraet = (ctx.geraete || []).find(
        g =>
            (fp.revkId && g.modulId && g.modulId.toUpperCase() === fp.revkId) ||
            (fp.hostname && g.name === fp.hostname),
    );
    if (fp.art === 'passwort') {
        return { code: 'passwort', geraet: geraet && geraet.name };
    }
    const broker = brokerZerlegen(fp.mqtthost);
    if (!broker) {
        return { code: 'keinBroker' };
    }
    const eigene = new Set((ctx.adressen || []).map(a => String(a).toLowerCase()));
    const unserer = eigene.has(broker.host) && broker.port === Number(ctx.port);
    if (!unserer) {
        // Verbindet es sich trotzdem hier (z. B. ueber einen Namen, den wir nicht kennen), zaehlt das.
        if (geraet && geraet.verbunden) {
            return { code: 'verbunden', geraet: geraet.name };
        }
        return { code: 'andererBroker' };
    }
    if (geraet && geraet.verbunden) {
        return { code: 'verbunden', geraet: geraet.name };
    }
    return { code: 'eingestellt', geraet: geraet && geraet.name };
}

/**
 * Eigene IPv4-Adressen und ein Vorschlag fuer "Adresse fuer Module".
 *
 * Adressen aus 172.16.0.0/12 sind fast immer Docker-Bruecken: Die Module erreichen sie nicht. Gibt
 * es nur solche, bleibt der Vorschlag leer und das Feld muss von Hand gefuellt werden.
 *
 * @param {ReturnType<typeof os.networkInterfaces>} [schnittstellen] fuer Tests
 * @returns {{adressen: string[], vorschlag: string, nurDocker: boolean}} Ergebnis
 */
function adressenErmitteln(schnittstellen = os.networkInterfaces()) {
    const adressen = [];
    for (const liste of Object.values(schnittstellen || {})) {
        for (const a of liste || []) {
            const v4 = a.family === 'IPv4' || a.family === 4;
            if (v4 && !a.internal && a.address) {
                adressen.push(a.address);
            }
        }
    }
    const docker = a => {
        const [x, y] = a.split('.').map(Number);
        return x === 172 && y >= 16 && y <= 31;
    };
    const brauchbar = adressen.filter(a => !docker(a) && !a.startsWith('169.254.'));
    return { adressen, vorschlag: brauchbar[0] || '', nurDocker: adressen.length > 0 && !brauchbar.length };
}

/**
 * Text "So traegst du es am Modul ein".
 *
 * @param {object} p Werte
 * @param {string} p.adresse Adresse fuer Module
 * @param {number} p.port Broker-Port
 * @param {string} [p.user] MQTT-Benutzer des Adapters
 * @param {'de'|'en'} [p.sprache] Sprache
 * @returns {string} mehrzeiliger Text
 */
function anleitung({ adresse, port, user, sprache }) {
    const de = sprache === 'de';
    if (!adresse) {
        return de ? 'Zuerst oben die "Adresse für Module" eintragen.' : 'Enter the "Address for modules" above first.';
    }
    const zeilen = [
        de ? 'Weboberfläche des Moduls → Settings → Basic:' : "Module's web interface → Settings → Basic:",
        `MQTT host: ${adresse}:${port}`,
    ];
    if (user) {
        zeilen.push(`MQTT user: ${user}`);
        zeilen.push(
            de ? 'MQTT pass: (Passwort aus dem Reiter MQTT-Broker)' : 'MQTT pass: (password from the MQTT broker tab)',
        );
    } else {
        zeilen.push(de ? 'MQTT user / MQTT pass: beliebig oder leer' : 'MQTT user / MQTT pass: anything or empty');
    }
    zeilen.push(de ? 'Dann "Save" - das Modul verbindet sich neu.' : 'Then "Save" - the module reconnects.');
    return zeilen.join('\n');
}

module.exports = {
    DIENST,
    MQTT_STANDARDPORT,
    entmaskieren,
    seiteAuswerten,
    fingerprint,
    mdnsAuswerten,
    mdnsSuchen,
    begrenzt,
    brokerZerlegen,
    statusBestimmen,
    adressenErmitteln,
    anleitung,
};
