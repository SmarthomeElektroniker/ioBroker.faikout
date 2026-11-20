'use strict';

/*
 * Module suchen: Fingerprint der Einstellungsseite, mDNS-Auswertung mit Reflektor, Status.
 *
 * Die HTML-Attrappen folgen revk_web_settings()/revk_web_foot() der RevK-Bibliothek (revk.c) -
 * Feldnamen mit "_" davor, Geheimnisse als Platzhalter, Fusszeile mit App, Hardware, Version, Build.
 */

const { expect } = require('chai');
const http = require('node:http');
const discovery = require('../lib/discovery');
const suche = require('../lib/suche');

/** Platzhalter, den die Firmware statt eines Geheimnisses zeigt (revk_settings_secret). */
const GEHEIM = '•'.repeat(8);

function eingabe(feld, wert, platzhalter = '') {
    return `<tr><td>${feld}</td><td nowrap><input id="${feld}" name="_${feld}" onchange="this.name='${feld}';" value="${wert}" autocapitalize='off' autocomplete='off' spellcheck='false' size=40 autocorrect='off' placeholder="${platzhalter}"></td><td></td></tr>`;
}

function kopf(titel, status) {
    return `<!DOCTYPE html><meta name='viewport' content='width=device-width, initial-scale=.75'><title>Settings</title><style>body{}</style><html><body><h1>${titel} <b id=_msg class=status>${status}</b></h1>`;
}

function fuss(app = 'Faikout', hw = '-S3-MINI-N4-R2', version = 'f4ba4a82', build = '2026-10-11T08:15:45') {
    return `<hr><address><a href=/>Home</a> ${app}${hw ? `<small>${hw}</small>` : ''}: ${version} ${build}</address></body></html>`;
}

function seite({ titel = 'Daikin 1OG', status = 'MQTT connected', hostname = 'Daikin 1OG', id = '983DAEF12630', mqtthost = '192.168.30.90:1888', mqttuser = 'admin' } = {}) {
    return (
        kopf(titel, status) +
        `<form action='/revk-settings' name='settings' method='post'><table>` +
        `<tr id=_set><td valign=top><input name=_save type=submit value='Save'></td><td colspan=2 nowrap>` +
        `<label class=box style="width:5em"><input type=radio name='_page' value='-1' checked><span class=button>Basic</span></label></td></tr>` +
        eingabe('wifissid', 'IoT') +
        eingabe('wifipass', GEHEIM) +
        eingabe('hostname', hostname, id) +
        eingabe('instance', '') +
        eingabe('mqtthost', mqtthost, 'hostname') +
        eingabe('mqttuser', mqttuser, 'username') +
        eingabe('mqttpass', mqttuser ? GEHEIM : '', 'password') +
        eingabe('cookie', '') +
        eingabe('password', '') +
        `</table></form>` +
        fuss()
    );
}

const PASSWORTSEITE =
    kopf('Labor &amp; Test', 'MQTT connected') +
    `<form action='/revk-settings' name='settings' method='post'><table>` +
    `<tr><td>Password</td><td colspan=2 nowrap><input name=password size=40 type=password autofocus> Not sent securely, so use with care on local network you control</td></tr>` +
    `<tr id=_set><td><input type=submit value='Login'></td></tr></table></form>` +
    fuss('Faikout', '-S3-MINI-N4-R2', 'tcl-ea64592', '2026-11-15T19:00:43');

const WEBLOGIN =
    '<html><head><script>document.location="/login";</script></head><body><a href="/login">Login required</a></body></html>';

describe('Module suchen: Einstellungsseite auswerten', () => {
    it('erkennt ein faikout-Modul mit Firmware, Hardware, Hostname, ID und Broker', () => {
        const r = discovery.seiteAuswerten(seite());
        expect(r).to.include({
            faikout: true,
            art: 'seite',
            app: 'Faikout',
            hardware: 'S3-MINI-N4-R2',
            version: 'f4ba4a82',
            build: '2026-10-11T08:15:45',
            titel: 'Daikin 1OG',
            mqttStatus: 'MQTT connected',
            hostname: 'Daikin 1OG',
            revkId: '983DAEF12630',
            mqtthost: '192.168.30.90:1888',
            mqttuserGesetzt: true,
        });
        // Der Benutzername selbst und Passwortplatzhalter gehoeren nicht ins Ergebnis.
        expect(JSON.stringify(r)).to.not.include('admin');
        expect(JSON.stringify(r)).to.not.include(GEHEIM);
    });

    it('nimmt ohne eigenen Hostnamen die Hardware-ID aus dem Platzhalter', () => {
        const r = discovery.seiteAuswerten(seite({ titel: '3C0F02E2CC94', hostname: '', id: '3C0F02E2CC94', mqtthost: '' }));
        expect(r.hostname).to.equal('3C0F02E2CC94');
        expect(r.mqtthost).to.equal('');
    });

    it('erkennt die alte Firmware "Faikin" und eine Fusszeile ohne Hardware', () => {
        const html = seite().replace(fuss(), fuss('Faikin', '', 'abc123', '2024-01-01T00:00:00'));
        const r = discovery.seiteAuswerten(html);
        expect(r).to.include({ faikout: true, app: 'Faikin', hardware: '', version: 'abc123' });
    });

    it('Passwortseite: kein Formular, Status passwortgeschuetzt, Name entmaskiert', () => {
        const r = discovery.seiteAuswerten(PASSWORTSEITE);
        expect(r).to.include({ faikout: true, art: 'passwort', titel: 'Labor & Test', version: 'tcl-ea64592' });
        expect(r.mqtthost).to.equal(undefined);
    });

    it('Web-Login: Weiterleitung auf /login', () => {
        expect(discovery.seiteAuswerten(WEBLOGIN)).to.eql({ faikout: false, art: 'weblogin' });
    });

    it('fremde Geraete mit _http._tcp werden nicht fuer faikout gehalten', () => {
        expect(discovery.seiteAuswerten('<html><body><h1>Drucker</h1></body></html>').faikout).to.equal(false);
        // andere RevK-App (gleiche Bibliothek, anderer Name)
        expect(discovery.seiteAuswerten(seite().replace(fuss(), fuss('SolarSpot'))).faikout).to.equal(false);
        expect(discovery.seiteAuswerten('').art).to.equal('fremd');
    });
});

describe('Module suchen: mDNS-Antworten', () => {
    const antwort = (instanz, host, ip) => ({
        answers: [{ name: '_http._tcp.local', type: 'PTR', data: `${instanz}._http._tcp.local` }],
        additionals: [
            { name: `${instanz}._http._tcp.local`, type: 'SRV', data: { target: `${host}.local`, port: 80 } },
            ...(ip ? [{ name: `${host}.local`, type: 'A', data: ip }] : []),
        ],
    });

    it('nimmt die IP aus dem A-Record, nicht vom Absender', () => {
        const r = discovery.mdnsAuswerten([{ antwort: antwort('TCL_Ferienhaus', 'TCL_Ferienhaus', '192.168.30.72'), absender: '192.168.30.72' }]);
        expect(r).to.eql([{ ip: '192.168.30.72', name: 'TCL_Ferienhaus', host: 'TCL_Ferienhaus' }]);
    });

    it('Reflektor: wiederholte Antwort vom Router ergibt die Adresse des Moduls, nicht die des Routers', () => {
        const r = discovery.mdnsAuswerten([
            { antwort: antwort('Daikin 1OG', 'Daikin-1OG', '192.168.30.70'), absender: '192.168.10.1' },
            { antwort: antwort('Daikin 1OG', 'Daikin-1OG', '192.168.30.70'), absender: '192.168.30.70' },
        ]);
        expect(r.map(k => k.ip)).to.eql(['192.168.30.70']);
    });

    it('ohne A-Record kein Kandidat (Absender koennte der Reflektor sein)', () => {
        expect(discovery.mdnsAuswerten([{ antwort: antwort('X', 'x', null), absender: '192.168.10.1' }])).to.eql([]);
    });

    it('A-Record aus einer spaeteren Antwort wird zugeordnet, andere Dienste werden uebergangen', () => {
        const r = discovery.mdnsAuswerten([
            { antwort: antwort('Wohnzimmer', 'wz', null) },
            { antwort: { answers: [{ name: 'wz.local', type: 'A', data: '192.168.30.71' }] } },
            { antwort: { answers: [{ name: 'Drucker._ipp._tcp.local', type: 'SRV', data: { target: 'drucker.local' } }] } },
        ]);
        expect(r).to.eql([{ ip: '192.168.30.71', name: 'Wohnzimmer', host: 'wz' }]);
    });

    it('mdnsSuchen fragt nach _http._tcp, sammelt und gibt den Client wieder frei', async () => {
        const handler = {};
        const fragen = [];
        let zerstoert = false;
        const attrappe = {
            on: (ev, fn) => (handler[ev] = fn),
            query: q => {
                fragen.push(q);
                handler.response(antwort('TCL_Ferienhaus', 'TCL_Ferienhaus', '192.168.30.72'), { address: '192.168.10.1' });
            },
            destroy: () => (zerstoert = true),
        };
        const r = await discovery.mdnsSuchen({ dauerMs: 50, fabrik: () => attrappe });
        expect(fragen[0].questions[0]).to.eql({ name: '_http._tcp.local', type: 'PTR' });
        expect(fragen.length).to.equal(2);
        expect(zerstoert).to.equal(true);
        expect(r.kandidaten.map(k => k.ip)).to.eql(['192.168.30.72']);
    });

    it('fehlendes multicast-dns legt den Adapter nicht lahm', async () => {
        const r = await discovery.mdnsSuchen({
            dauerMs: 10,
            fabrik: () => {
                throw new Error('Cannot find module');
            },
        });
        expect(r.kandidaten).to.eql([]);
        expect(r.fehler).to.match(/mDNS unavailable/);
    });
});

describe('Module suchen: Status', () => {
    const ctx = {
        adressen: ['192.168.30.90', 'iobroker'],
        port: 1888,
        geraete: [
            { name: 'Daikin 1OG', modulId: '983DAEF12630', verbunden: true },
            { name: 'TCL_Ferienhaus', modulId: '3C0F02E2CC94', verbunden: false },
        ],
    };
    const fp = over => ({ ...discovery.seiteAuswerten(seite()), ...over });

    it('verbunden mit diesem Adapter (ID passt)', () => {
        expect(discovery.statusBestimmen(fp({ hostname: 'Neu' }), ctx)).to.eql({ code: 'verbunden', geraet: 'Daikin 1OG' });
    });

    it('auf diesen Adapter eingestellt, aber nicht verbunden', () => {
        expect(discovery.statusBestimmen(fp({ hostname: 'TCL_Ferienhaus', revkId: '3C0F02E2CC94' }), ctx)).to.eql({
            code: 'eingestellt',
            geraet: 'TCL_Ferienhaus',
        });
        expect(discovery.statusBestimmen(fp({ revkId: 'AAAAAAAAAAAA', hostname: 'X', mqtthost: 'IOBROKER:1888' }), ctx).code).to.equal(
            'eingestellt',
        );
    });

    it('kein Broker, anderer Broker, anderer Port, Standardport 1883', () => {
        const fremd = { revkId: 'AAAAAAAAAAAA', hostname: 'X' };
        expect(discovery.statusBestimmen(fp({ ...fremd, mqtthost: '' }), ctx).code).to.equal('keinBroker');
        expect(discovery.statusBestimmen(fp({ ...fremd, mqtthost: '192.168.10.5:1888' }), ctx).code).to.equal('andererBroker');
        expect(discovery.statusBestimmen(fp({ ...fremd, mqtthost: '192.168.30.90:1886' }), ctx).code).to.equal('andererBroker');
        expect(discovery.statusBestimmen(fp({ ...fremd, mqtthost: '192.168.30.90' }), { ...ctx, port: 1883 }).code).to.equal(
            'eingestellt',
        );
    });

    it('Passwort und Web-Login', () => {
        expect(discovery.statusBestimmen(discovery.seiteAuswerten(PASSWORTSEITE), ctx).code).to.equal('passwort');
        expect(discovery.statusBestimmen(discovery.seiteAuswerten(WEBLOGIN), ctx).code).to.equal('weblogin');
    });

    it('brokerZerlegen', () => {
        expect(discovery.brokerZerlegen('Host:1888')).to.eql({ host: 'host', port: 1888 });
        expect(discovery.brokerZerlegen('host')).to.eql({ host: 'host', port: 1883 });
        expect(discovery.brokerZerlegen('[fd00::1]:1888')).to.eql({ host: 'fd00::1', port: 1888 });
        expect(discovery.brokerZerlegen(' ')).to.equal(null);
    });
});

describe('Module suchen: Adressen und Anleitung', () => {
    it('schlaegt die erste Nicht-Docker-Adresse vor', () => {
        const r = discovery.adressenErmitteln({
            lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
            docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
            eth0: [
                { family: 'IPv6', address: 'fe80::1', internal: false },
                { family: 'IPv4', address: '192.168.10.90', internal: false },
            ],
        });
        expect(r).to.eql({ adressen: ['172.17.0.1', '192.168.10.90'], vorschlag: '192.168.10.90', nurDocker: false });
    });

    it('nur Docker-Adressen: kein Vorschlag, Pflichtfeld', () => {
        const r = discovery.adressenErmitteln({ eth0: [{ family: 4, address: '172.18.0.5', internal: false }] });
        expect(r).to.eql({ adressen: ['172.18.0.5'], vorschlag: '', nurDocker: true });
        // 172.32.x gehoert nicht mehr zu 172.16.0.0/12
        expect(discovery.adressenErmitteln({ e: [{ family: 'IPv4', address: '172.32.0.1' }] }).nurDocker).to.equal(false);
    });

    it('Anleitung mit fertigem mqtthost und ohne Passwort im Text', () => {
        const t = discovery.anleitung({ adresse: '192.168.30.90', port: 1888, user: 'admin', sprache: 'de' });
        expect(t).to.include('MQTT host: 192.168.30.90:1888');
        expect(t).to.include('MQTT user: admin');
        expect(discovery.anleitung({ adresse: '', port: 1888 })).to.match(/Address for modules/);
    });
});

describe('Module suchen: Fingerprint ueber HTTP', () => {
    let server;
    let antwortFn;
    let anfragen;
    before(done => {
        server = http.createServer((req, res) => {
            anfragen.push(`${req.method} ${req.url}`);
            antwortFn(req, res);
        });
        server.listen(0, '127.0.0.1', done);
    });
    after(done => server.close(done));
    beforeEach(() => (anfragen = []));

    const request = (o, cb) => http.request({ ...o, host: '127.0.0.1', port: server.address().port }, cb);

    it('liest die Seite nur per GET', async () => {
        antwortFn = (req, res) => res.end(seite());
        const r = await discovery.fingerprint('modul', { request });
        expect(anfragen).to.eql(['GET /revk-settings']);
        expect(r).to.include({ ok: true, faikout: true, adresse: 'modul', hostname: 'Daikin 1OG' });
    });

    it('Zeitlimit greift', async () => {
        antwortFn = () => {}; // antwortet nie
        const start = Date.now();
        const r = await discovery.fingerprint('modul', { request, timeoutMs: 100 });
        expect(r).to.include({ ok: false, fehler: 'timeout' });
        expect(Date.now() - start).to.be.below(1000);
    });

    it('Weiterleitung auf /login = Web-Login, andere HTTP-Fehler = fremd', async () => {
        antwortFn = (req, res) => {
            res.writeHead(302, { Location: '/login' });
            res.end();
        };
        expect((await discovery.fingerprint('m', { request })).art).to.equal('weblogin');
        antwortFn = (req, res) => {
            res.writeHead(404);
            res.end();
        };
        expect(await discovery.fingerprint('m', { request })).to.include({ ok: false, art: 'fremd' });
    });

    it('begrenzt: hoechstens 4 gleichzeitig, Reihenfolge bleibt', async () => {
        let gleichzeitig = 0;
        let max = 0;
        const r = await discovery.begrenzt([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async x => {
            gleichzeitig++;
            max = Math.max(max, gleichzeitig);
            await new Promise(res => setTimeout(res, 5));
            gleichzeitig--;
            return x * 2;
        });
        expect(max).to.equal(4);
        expect(r).to.eql([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    });
});

describe('Module suchen: Ablauf', () => {
    const fps = {
        '192.168.30.70': { ...discovery.seiteAuswerten(seite()), ok: true, adresse: '192.168.30.70' },
        '192.168.30.72': {
            ...discovery.seiteAuswerten(
                seite({ titel: 'TCL_Ferienhaus', hostname: 'TCL_Ferienhaus', id: '3C0F02E2CC94', mqtthost: '192.168.30.90:1889' }),
            ),
            ok: true,
            adresse: '192.168.30.72',
        },
        '192.168.30.20': { ok: true, faikout: false, art: 'fremd', adresse: '192.168.30.20' },
    };
    const opt = {
        adressen: ['192.168.30.90'],
        port: 1888,
        geraete: [{ name: 'Daikin 1OG', modulId: '983DAEF12630', verbunden: true }],
        sprache: 'de',
        mdnsSuchen: async () => ({
            kandidaten: Object.keys(fps).map(ip => ({ ip, name: ip, host: ip })),
        }),
        fingerprint: async ip => fps[ip],
    };

    it('listet nur faikout-Module, mit Status in der Sprache des Systems', async () => {
        const r = await suche.suchen(opt);
        expect(r.zeilen).to.eql([
            {
                name: 'Daikin 1OG',
                ip: '192.168.30.70',
                firmware: 'f4ba4a82 (S3-MINI-N4-R2)',
                status: 'mit diesem Adapter verbunden (Daikin 1OG)',
                code: 'verbunden',
            },
            {
                name: 'TCL_Ferienhaus',
                ip: '192.168.30.72',
                firmware: 'f4ba4a82 (S3-MINI-N4-R2)',
                status: 'anderer MQTT-Broker',
                code: 'andererBroker',
            },
        ]);
        expect(r.text).to.equal('2 faikout-Modul(e) gefunden (3 mDNS-Kandidaten geprüft).');
        // Die Zeilen tragen keinen Broker und keinen Benutzer.
        expect(JSON.stringify(r.zeilen)).to.not.match(/1889|admin/);
    });

    it('einzelne Adresse: auch "kein faikout" bekommt eine Antwort, mDNS wird nicht gefragt', async () => {
        const r = await suche.suchen({
            ...opt,
            ziel: '192.168.30.20',
            mdnsSuchen: () => {
                throw new Error('mDNS darf nicht laufen');
            },
        });
        expect(r.zeilen.map(z => z.code)).to.eql(['keinFaikout']);
        expect(r.text).to.equal('192.168.30.20: unter dieser Adresse kein faikout-Modul');
    });

    it('alle Statustexte gibt es in allen elf Sprachen', () => {
        const sprachen = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
        for (const tabelle of [suche.STATUS_TEXTE, suche.ERGEBNIS_TEXTE]) {
            for (const [k, v] of Object.entries(tabelle)) {
                expect(Object.keys(v).sort(), k).to.eql([...sprachen].sort());
                for (const s of sprachen.filter(x => x !== 'en')) {
                    expect(v[s], `${k}/${s}`).to.not.equal(v.en);
                }
            }
        }
    });
});

describe('Module suchen: Nachrichten an den Adapter', () => {
    const proxyquire = require('proxyquire').noCallThru();

    class Attrappe {
        constructor() {
            this.namespace = 'faikout.0';
            this.config = { port: 1888, moduleAddress: '', user: 'admin' };
            this.logs = [];
            const merk = t => this.logs.push(String(t));
            this.log = { debug: merk, info: merk, warn: merk, error: merk };
            this.gesendet = [];
        }
        on() {}
        sendTo(from, command, antwort) {
            this.gesendet.push({ from, command, antwort });
        }
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

    const seiteHtml = seite({ mqtthost: '10.9.9.9:1777', mqttuser: 'geheimnutzer' });
    const adapter = () =>
        proxyquire('../main', {
            '@iobroker/adapter-core': { Adapter: Attrappe },
            './lib/suche': {
                ...suche,
                suchen: o =>
                    suche.suchen({
                        ...o,
                        mdnsSuchen: async () => ({ kandidaten: [{ ip: '192.168.30.70', name: 'x' }] }),
                        fingerprint: async ip => ({ ...discovery.seiteAuswerten(seiteHtml), ok: true, adresse: ip }),
                    }),
            },
        })({});

    const senden = async (a, command, message) => {
        await a.onMessage({ command, message, from: 'system.adapter.admin.0', callback: { id: 1 } });
        return a.gesendet.pop().antwort;
    };

    it('suchen: Ergebnis als _found (nicht gespeichert), nichts von Broker/Benutzer im Log', async () => {
        const a = adapter();
        const r = await senden(a, 'suchen', { adresse: '${data.moduleAddress}' });
        expect(r.native._found).to.have.length(1);
        expect(r.native._found[0]).to.have.keys('name', 'ip', 'firmware', 'status');
        expect(r.native._found[0].status).to.equal('anderer MQTT-Broker');
        expect(r.result).to.match(/1 faikout-Modul/);
        expect(a.logs.join('\n')).to.not.match(/10\.9\.9\.9|1777|geheimnutzer|192\.168\.30\.70/);
    });

    it('Einzelpruefungen sammeln sich in der Tabelle, neue Suche beginnt von vorn', async () => {
        const a = adapter();
        await senden(a, 'adressePruefen', { ziel: '192.168.30.70' });
        const r = await senden(a, 'adressePruefen', { ziel: '192.168.30.72' });
        expect(r.native._found.map(z => z.ip)).to.eql(['192.168.30.70', '192.168.30.72']);
        const r2 = await senden(a, 'adressePruefen', { ziel: '192.168.30.70' });
        expect(r2.native._found.map(z => z.ip)).to.eql(['192.168.30.72', '192.168.30.70']);
        const s = await senden(a, 'suchen', {});
        expect(s.native._found.map(z => z.ip)).to.eql(['192.168.30.70']);
    });

    it('adressePruefen ohne Adresse meldet einen Fehler', async () => {
        const r = await senden(adapter(), 'adressePruefen', { ziel: '${data._target}' });
        expect(r.error).to.match(/IP-Adresse/);
    });

    it('mqtthostWert und Anleitung nehmen die ungespeicherten Formularwerte', async () => {
        const a = adapter();
        expect(await senden(a, 'mqtthostWert', { adresse: 'nas.local', port: '1999' })).to.equal('nas.local:1999');
        expect(await senden(a, 'mqtthostWert', { adresse: '', port: '' })).to.equal('');
        const html = await senden(a, 'anleitung', { adresse: '<b>', port: '1888', user: '' });
        expect(html).to.include('MQTT host: &lt;b&gt;:1888<br>');
    });

    it('dm:-Befehle bleiben dem Device-Manager', async () => {
        const a = adapter();
        await a.onMessage({ command: 'dm:listDevices', callback: { id: 1 } });
        expect(a.gesendet).to.eql([]);
    });
});
