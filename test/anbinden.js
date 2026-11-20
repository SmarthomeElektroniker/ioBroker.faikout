'use strict';

/*
 * Module anbinden (Stufe 2 von "Module suchen"): Formulardaten, Plan, Rueckfrage-Vorschau,
 * frischer Fingerprint vor dem POST, Erfolgskontrolle und Rueckweg - gegen ein nachgebautes
 * Modul (HTTP-Server mit dem Verhalten von revk_web_settings/revk_settings_store).
 */

const { expect } = require('chai');
const http = require('node:http');
const proxyquire = require('proxyquire').noCallThru();
const discovery = require('../lib/discovery');
const anbinden = require('../lib/anbinden');

const GEHEIM = '•'.repeat(8);

/** Nachgebautes faikout-Modul: GET zeigt die Basic-Seite, POST speichert wie die Firmware. */
class Modul {
    constructor(werte = {}) {
        this.werte = {
            hostname: 'TCL_Ferienhaus',
            id: '3C0F02E2CC94',
            mqtthost: '192.168.30.90:1888',
            mqttuser: 'alt',
            mqttpass: 'altpass',
            password: '',
            version: 'tcl-ea64592',
            ...werte,
        };
        this.posts = [];
        this.neustarts = 0;
        this.server = http.createServer((req, res) => this.antworten(req, res));
    }
    starten() {
        return new Promise(r => this.server.listen(0, '127.0.0.1', r));
    }
    stoppen() {
        return new Promise(r => this.server.close(r));
    }
    request() {
        return (o, cb) => http.request({ ...o, host: '127.0.0.1', port: this.server.address().port }, cb);
    }
    eingabe(feld, wert, ph = '') {
        return `<tr><td>${feld}</td><td nowrap><input id="${feld}" name="_${feld}" onchange="this.name='${feld}';" value="${wert}" placeholder="${ph}"></td></tr>`;
    }
    seite(eingeloggt, fehler = '') {
        const w = this.werte;
        let html = `<html><body><h1>${w.hostname} <b id=_msg class=status>MQTT connected</b></h1>`;
        if (fehler) {
            html += `<p class=error>${fehler}</p>`;
        }
        html += `<form action='/revk-settings' name='settings' method='post'><table>`;
        if (w.password && !eingeloggt) {
            html += `<tr><td>Password</td><td colspan=2 nowrap><input name=password size=40 type=password autofocus></td></tr>`;
        } else {
            if (w.password) {
                html += `<input name=password type=hidden value="${w.password}">`;
            }
            html +=
                this.eingabe('hostname', w.hostname, w.id) +
                this.eingabe('mqtthost', w.mqtthost) +
                this.eingabe('mqttuser', w.mqttuser) +
                this.eingabe('mqttpass', w.mqttpass ? GEHEIM : '') +
                this.eingabe('password', w.password);
        }
        return `${html}</table></form><hr><address><a href=/>Home</a> Faikout<small>-S3-MINI-N4-R2</small>: ${w.version} 2026-11-15T19:00:43</address></body></html>`;
    }
    antworten(req, res) {
        if (req.method === 'GET') {
            return res.end(this.seite(false));
        }
        let daten = '';
        req.on('data', d => (daten += d));
        req.on('end', () => {
            const paare = [...new URLSearchParams(daten)];
            this.posts.push(paare);
            // revk_settings_store: bei gesetztem Passwort muss es als erstes kommen
            let eingeloggt = !this.werte.password;
            let start = 0;
            if (this.werte.password) {
                if (!paare.length || paare[0][0] !== 'password') {
                    return res.end(this.seite(false, 'Password required to change settings'));
                }
                if (paare[0][1] !== this.werte.password) {
                    return res.end(this.seite(false, 'Wrong password'));
                }
                eingeloggt = true;
                start = 1;
            }
            for (const [k, v] of paare.slice(start)) {
                if (k === '_reboot') {
                    this.neustarts++;
                } else if (!k.startsWith('_')) {
                    this.werte[k] = v;
                }
            }
            res.end(this.seite(eingeloggt));
        });
    }
}

describe('Anbinden: Bausteine', () => {
    it('Formulardaten: Passwort zuerst, nur gesendet wenn verlangt; Neustart zuletzt', () => {
        expect(anbinden.koerper({ mqtthost: '192.168.30.10:8089' })).to.equal('mqtthost=192.168.30.10%3A8089&_reboot=Reboot');
        expect(anbinden.koerper({ passwort: 'p&w', mqtthost: 'h:1', mqttuser: 'u', mqttpass: 'x' })).to.equal(
            'password=p%26w&mqtthost=h%3A1&mqttuser=u&mqttpass=x&_reboot=Reboot',
        );
        // nie OTA/mqtthost2 o. ae.
        expect(anbinden.koerper({ mqtthost: 'h:1' })).to.not.match(/upgrade|ota|mqtthost2/);
    });

    it('Plan und Vorschau: anderer Broker, schon hier, Benutzer aus dem Adapter', () => {
        const gelesen = {
            fp: { ...discovery.seiteAuswerten(new Modul().seite(false)), adresse: '192.168.30.72' },
            werte: { mqtthost: '192.168.10.5:1883', mqttuser: 'alt' },
        };
        const ziel = { adresse: '192.168.30.10', port: 8089, user: '', eigeneAdressen: ['192.168.30.10'] };
        const plan = anbinden.planen(gelesen, ziel);
        expect(plan).to.include({ ip: '192.168.30.72', hostname: 'TCL_Ferienhaus', revkId: '3C0F02E2CC94', anderer: true, schonHier: false });
        expect(plan.neu).to.eql({ mqtthost: '192.168.30.10:8089', mqttuser: undefined });
        const text = anbinden.vorschau(plan, 'de');
        expect(text).to.include('MQTT host: 192.168.10.5:1883 → 192.168.30.10:8089');
        expect(text).to.include('ACHTUNG');
        expect(text).to.not.include('Benutzer');
        expect(anbinden.vorschau(anbinden.planen(gelesen, { ...ziel, user: 'iob' }), 'de')).to.include('nicht rücklesbar');
        const hier = anbinden.planen({ ...gelesen, werte: { mqtthost: '192.168.30.10:8089' } }, ziel);
        expect(hier.schonHier).to.equal(true);
    });

    it('Abweichung zwischen Pruefen und Anbinden wird erkannt', () => {
        const a = { revkId: 'A', hostname: 'h', version: '1', alt: { mqtthost: 'x' } };
        expect(anbinden.abweichung(a, { ...a })).to.equal('');
        expect(anbinden.abweichung(a, { ...a, revkId: 'B', alt: { mqtthost: 'y' } })).to.equal('revkId, mqtthost');
    });

    it('warten: Erfolg, Zeitueberschreitung, Abbruch', async () => {
        const timer = { setTimeout: (f, ms) => setTimeout(f, ms) };
        let n = 0;
        expect(await anbinden.warten(() => ++n > 2, { maxMs: 1000, schrittMs: 5, timer })).to.equal(true);
        expect(await anbinden.warten(() => false, { maxMs: 30, schrittMs: 5, timer })).to.equal(false);
        const t0 = Date.now();
        expect(await anbinden.warten(() => false, { maxMs: 5000, schrittMs: 5, timer, abbruch: () => true })).to.equal(false);
        expect(Date.now() - t0).to.be.below(500);
    });

    it('alle Texte in allen elf Sprachen', () => {
        const sprachen = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
        for (const [k, v] of Object.entries(anbinden.TEXTE)) {
            expect(Object.keys(v).sort(), k).to.eql([...sprachen].sort());
        }
    });
});

describe('Anbinden: gegen ein nachgebautes Modul', () => {
    let modul;
    afterEach(() => modul && modul.stoppen());

    it('lesen ohne Passwortschutz: nur GET, Formularwerte im Speicher', async () => {
        modul = new Modul();
        await modul.starten();
        const g = await anbinden.lesen('m', '', { request: modul.request() });
        expect(g.fp).to.include({ faikout: true, art: 'seite', hostname: 'TCL_Ferienhaus' });
        expect(g.werte).to.eql({ mqtthost: '192.168.30.90:1888', mqttuser: 'alt' });
        expect(modul.posts).to.eql([]);
    });

    it('lesen mit Passwortschutz: Login-POST nur mit password, aendert nichts', async () => {
        modul = new Modul({ password: 'geheim' });
        await modul.starten();
        const ohne = await anbinden.lesen('m', '', { request: modul.request() });
        expect(ohne.fp.art).to.equal('passwort');
        expect(modul.posts).to.eql([]);
        const falsch = await anbinden.lesen('m', 'falsch', { request: modul.request() });
        expect(falsch.fehler).to.equal('Wrong password');
        const mit = await anbinden.lesen('m', 'geheim', { request: modul.request() });
        expect(mit.fp).to.include({ art: 'seite', geschuetzt: true });
        expect(mit.werte.mqtthost).to.equal('192.168.30.90:1888');
        expect(modul.posts.at(-1)).to.eql([['password', 'geheim']]);
        expect(modul.werte).to.include({ password: 'geheim', mqtthost: '192.168.30.90:1888' });
        expect(modul.neustarts).to.equal(0);
    });

    it('posten: Fehlermeldung des Moduls wird erkannt', async () => {
        modul = new Modul({ password: 'geheim' });
        await modul.starten();
        const r = await anbinden.posten('m', anbinden.koerper({ mqtthost: 'h:1' }), { request: modul.request() });
        expect(r).to.eql({ ok: false, fehler: 'Password required to change settings' });
        expect(modul.werte.mqtthost).to.equal('192.168.30.90:1888');
    });
});

describe('Anbinden: Ablauf im Adapter (Pruefen, Anbinden, Erfolg, Zurueckstellen)', () => {
    class Attrappe {
        constructor() {
            this.namespace = 'faikout.0';
            this.config = { port: 8089, moduleAddress: '192.168.30.10', user: '', pass: '' };
            this.logs = [];
            const merk = t => this.logs.push(String(t));
            this.log = { debug: merk, info: merk, warn: merk, error: merk };
        }
        on() {}
        sendTo() {}
        async getForeignObjectAsync() {
            return { common: { language: 'de' } };
        }
        setTimeout(fn, ms) {
            return setTimeout(fn, ms);
        }
        clearTimeout(t) {
            clearTimeout(t);
        }
    }

    let modul;
    let adapter;
    beforeEach(async () => {
        modul = new Modul();
        await modul.starten();
        const echt = anbinden;
        const mitServer = o => ({ ...o, request: modul.request() });
        adapter = proxyquire('../main', {
            '@iobroker/adapter-core': { Adapter: Attrappe },
            './lib/anbinden': {
                ...echt,
                lesen: (ip, pw, o) => echt.lesen(ip, pw, mitServer(o)),
                posten: (ip, d, o) => echt.posten(ip, d, mitServer(o)),
            },
        })({});
    });
    afterEach(() => modul.stoppen());

    const senden = (command, message) =>
        new Promise(resolve => {
            adapter.sendTo = (_f, _c, antwort) => resolve(antwort);
            adapter.onMessage({ command, message, from: 'system.adapter.admin.0', callback: { id: 1 } });
        });

    /** Simuliert das Modul nach dem Neustart: verbindet sich mit dem Broker und meldet sich. */
    const meldetSich = (ms = 300) =>
        setTimeout(() => {
            adapter.mqttClients.add('Faikout:TCL_Ferienhaus');
            adapter.gesehen.set('TCL_Ferienhaus', Date.now());
        }, ms);

    it('Anbinden ohne Pruefen geht nicht', async () => {
        const r = await senden('anbinden', { ip: 'm', pass: '' });
        expect(r.error).to.equal('Zuerst das Modul prüfen.');
        expect(modul.posts).to.eql([]);
    });

    it('voller Ablauf: Vorschau, zweite Rueckfrage, POST nur mit mqtthost, Erfolg, Zurueckstellen', async () => {
        modul.werte.mqtthost = '192.168.10.5:1883'; // anderer Broker
        const p = await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10', pass: '' });
        expect(p.native._bindPlan).to.equal('m');
        expect(p.native._bindOther).to.equal(true);
        expect(p.native._bindPreview).to.include('192.168.10.5:1883 → 192.168.30.10:8089');
        expect(modul.posts).to.eql([]);

        // ohne Haken "Anderen Broker ersetzen" kein POST
        const ohneHaken = await senden('anbinden', { ip: 'm', pass: '', andererOk: false });
        expect(ohneHaken.error).to.match(/Anderen Broker ersetzen/);
        expect(modul.posts).to.eql([]);

        meldetSich();
        const r = await senden('anbinden', { ip: 'm', pass: '', andererOk: true });
        expect(r.result).to.match(/ist mit diesem Adapter verbunden/);
        expect(modul.posts).to.eql([
            [
                ['mqtthost', '192.168.30.10:8089'],
                ['_reboot', 'Reboot'],
            ],
        ]);
        expect(modul.werte).to.include({ mqtthost: '192.168.30.10:8089', mqttuser: 'alt', mqttpass: 'altpass' });

        const z = await senden('zurueckstellen', { ip: 'm', pass: '' });
        expect(z.result).to.match(/auf MQTT host 192\.168\.10\.5:1883 zurückgestellt/);
        expect(modul.werte.mqtthost).to.equal('192.168.10.5:1883');
        expect(modul.neustarts).to.equal(2);
        // Alte Werte und Passwoerter nie im Log
        expect(adapter.logs.join('\n')).to.not.match(/192\.168\.10\.5|altpass|alt\b/);
    });

    it('Zeitueberschreitung: Fehler, Rueckweg bleibt moeglich', async () => {
        await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10' });
        const r = await senden('anbinden', { ip: 'm', wartenMs: 60, andererOk: true });
        expect(r.error).to.match(/nicht binnen \d+ s gemeldet/);
        expect(modul.werte.mqtthost).to.equal('192.168.30.10:8089');
        const z = await senden('zurueckstellen', { ip: 'm' });
        expect(z.result).to.match(/192\.168\.30\.90:1888/);
        expect(modul.werte.mqtthost).to.equal('192.168.30.90:1888');
    });

    it('Modul hat sich zwischen Pruefen und Anbinden veraendert: kein POST', async () => {
        await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10' });
        modul.werte.mqtthost = '10.0.0.1:1883';
        const r = await senden('anbinden', { ip: 'm', andererOk: true });
        expect(r.error).to.match(/verändert \(mqtthost\)/);
        expect(modul.posts).to.eql([]);
    });

    it('Adapter mit Benutzer: mqttuser/mqttpass werden gesetzt, beim Zurueckstellen Warnung', async () => {
        adapter.config.user = 'iob';
        adapter.config.pass = 'neu';
        await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10' });
        meldetSich();
        await senden('anbinden', { ip: 'm', andererOk: true });
        expect(modul.werte).to.include({ mqttuser: 'iob', mqttpass: 'neu' });
        const z = await senden('zurueckstellen', { ip: 'm' });
        expect(z.result).to.match(/nicht rücklesbar/);
        expect(modul.werte).to.include({ mqtthost: '192.168.30.90:1888', mqttuser: 'alt' });
        expect(adapter.logs.join('\n')).to.not.match(/\bneu\b|altpass/);
    });

    it('Passwortschutz: Passwort als erstes Feld, nur fuer diesen Aufruf', async () => {
        modul.werte.password = 'geheim';
        const ohne = await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10' });
        expect(ohne.error).to.match(/Settings-Passwort/);
        await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10', pass: 'geheim' });
        meldetSich();
        const r = await senden('anbinden', { ip: 'm', pass: 'geheim', andererOk: true });
        expect(r.result).to.match(/verbunden/);
        expect(modul.posts.at(-1)[0]).to.eql(['password', 'geheim']);
        expect(modul.werte.password).to.equal('geheim');
        expect(JSON.stringify([...adapter.anbindenPlaene, ...adapter.rueckwege])).to.not.include('geheim');
        expect(adapter.logs.join('\n')).to.not.include('geheim');
    });

    it('ungeschuetztes Modul bekommt nie ein password-Feld', async () => {
        await senden('anbindenPruefen', { ip: 'm', adresse: '192.168.30.10', pass: 'versehentlich' });
        meldetSich();
        await senden('anbinden', { ip: 'm', pass: 'versehentlich', andererOk: true });
        expect(modul.posts.flat().map(([k]) => k)).to.not.include('password');
        expect(modul.werte.password).to.equal('');
    });
});
