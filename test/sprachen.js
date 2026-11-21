'use strict';

/**
 * Alle Texte des Adapters in den elf Sprachen - quer ueber alle Quellen: Vollstaendigkeit, Platzhalter,
 * Schreibweise (Gedankenstrich, Dezimalzeichen) und der Begriff "Temperaturstufe" statt "Szene".
 * Die Einzeltests der Quellen (regeltexte, oberflaeche, devicemanager, kennlinienzug) bleiben daneben bestehen;
 * hier stehen die Regeln, die fuer JEDE Quelle gelten, und die Komponententexte src-admin/src/*.texte.ts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

const WURZEL = path.join(__dirname, '..');
const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const lies = datei => fs.readFileSync(path.join(WURZEL, datei), 'utf8');
const platzhalter = t =>
    [...String(t).matchAll(/\{\w+\}|%s|\$\{[^}]*\}/g)]
        .map(m => m[0])
        .sort()
        .join(' ');

/**
 * Liest die Texttabelle einer Komponente (src-admin/src/<Name>.texte.ts) als { schluessel: { sprache: text } }.
 * Die Tabellen sind reines JavaScript; es gibt sie in drei Formen (je Schluessel, je Sprache, je Sprache als
 * eigene Konstante).
 *
 * @param {string} datei  Dateiname in src-admin/src
 * @returns {Record<string, Record<string, string>>} Texte je Schluessel und Sprache
 */
function komponentenTexte(datei) {
    const quelle = lies(`src-admin/src/${datei}`);
    const werte = block => new Function(`return ${block}`)();
    const jeSchluessel = {};
    const einzeln = [...quelle.matchAll(/\nconst (en|de|ru|pt|nl|fr|it|es|pl|uk|zhCn)(?:: \w+)? = (\{[\s\S]*?\n\});\n/g)];
    let jeSprache;
    if (einzeln.length) {
        jeSprache = Object.fromEntries(einzeln.map(m => [m[1] === 'zhCn' ? 'zh-cn' : m[1], werte(m[2])]));
    } else {
        const block = quelle.match(/\n(?:export )?const TEXTE = (\{[\s\S]*?\n\})(?: satisfies [^;]+)?;\n/);
        expect(block, `${datei}: Block TEXTE nicht gefunden`).to.not.equal(null);
        const tabelle = werte(block[1]);
        if (typeof Object.values(tabelle.en || {})[0] !== 'string') {
            return tabelle; // schon je Schluessel
        }
        jeSprache = tabelle;
    }
    for (const [sprache, satz] of Object.entries(jeSprache)) {
        for (const [k, text] of Object.entries(satz)) {
            (jeSchluessel[k] = jeSchluessel[k] || {})[sprache] = text;
        }
    }
    return jeSchluessel;
}

/** Sucht in einer beliebigen Struktur jedes Uebersetzungsobjekt (Zeichenketten unter "en" und "de"). */
function sammle(wurzel, wo, ziel) {
    const lauf = (x, pfad) => {
        if (!x || typeof x !== 'object') {
            return;
        }
        if (typeof x.en === 'string' && typeof x.de === 'string') {
            ziel.push([`${wo}${pfad}`, x]);
            return;
        }
        for (const [k, v] of Object.entries(x)) {
            lauf(v, `${pfad}.${k}`);
        }
    };
    lauf(wurzel, '');
}

/**
 * Laedt die VIS-Bausteine wie der Browser (ohne module, mit einer Attrappe fuer `vis`).
 *
 * @param {string} [sprache]  VIS-Sprache
 * @returns {Record<string, any>} vis.binds.faikout
 */
function bausteine(sprache = 'en') {
    const vm = require('node:vm');
    const fenster = {};
    const umgebung = { self: fenster, window: fenster, vis: { binds: {}, language: sprache } };
    vm.runInNewContext(lies('widgets/faikout/js/kennlinienbild.js'), umgebung);
    vm.runInNewContext(lies('widgets/faikout/js/faikout.js'), umgebung);
    return umgebung.vis.binds.faikout;
}

/** Texttabelle der VIS-Bausteine als { schluessel: { sprache: text } }. */
function bausteinTexte() {
    const b = bausteine();
    return Object.fromEntries(Object.entries(b.TEXTE).map(([k, liste]) => [k, Object.fromEntries(b.SPRACHEN.map((s, i) => [s, liste[i]]))]));
}

/** Uebersetzungstabelle des VIS-Editors (systemDictionary in widgets/faikout.html). */
function editorTexte() {
    const block = lies('widgets/faikout.html').match(/\$\.extend\(true, systemDictionary, (\{[\s\S]*?\n {8}\})\);/);
    expect(block, 'systemDictionary in widgets/faikout.html').to.not.equal(null);
    return new Function(`return ${block[1]}`)();
}

/** Alle Texte aller Quellen als Liste [Ort, { sprache: text }]. */
function alleTexte() {
    const liste = [];
    for (const datei of fs.readdirSync(path.join(WURZEL, 'src-admin', 'src')).filter(d => d.endsWith('.texte.ts'))) {
        sammle(komponentenTexte(datei), datei, liste);
    }
    for (const ordner of ['admin/i18n', 'src-admin/src/i18n']) {
        const jeSchluessel = {};
        for (const s of SPRACHEN) {
            for (const [k, text] of Object.entries(JSON.parse(lies(`${ordner}/${s}.json`)))) {
                (jeSchluessel[k] = jeSchluessel[k] || {})[s] = text;
            }
        }
        sammle(jeSchluessel, ordner, liste);
    }
    sammle(require('../lib/oberflaeche').TEXTE, 'oberflaeche', liste);
    sammle(require('../lib/regel/texte').TEXTE, 'regel', liste);
    sammle(require('../lib/anbinden'), 'anbinden', liste);
    sammle(require('../lib/suche'), 'suche', liste);
    sammle(require('../lib/verbrauchbild'), 'verbrauchbild', liste);
    sammle(bausteinTexte(), 'widgets', liste);
    sammle(editorTexte(), 'widgets-editor', liste);
    const io = JSON.parse(lies('io-package.json'));
    sammle({ titleLang: io.common.titleLang, desc: io.common.desc, news: { [io.common.version]: io.common.news[io.common.version] } }, 'io-package', liste);
    sammle(io.instanceObjects, 'io-package.instanceObjects', liste);
    return liste;
}

describe('Sprachen: Komponententexte src-admin/src/*.texte.ts', () => {
    const dateien = fs.readdirSync(path.join(WURZEL, 'src-admin', 'src')).filter(d => d.endsWith('.texte.ts'));

    it('alle neun Texttabellen der Komponenten werden gefunden', () => {
        expect(dateien.sort()).to.eql(['Abschnitt.texte.ts', 'Erklaerung.texte.ts', 'Feuchte.texte.ts', 'Geraete.texte.ts', 'Kennlinie.texte.ts', 'Rechenweg.texte.ts', 'Stufen.texte.ts', 'Werkzeugleiste.texte.ts', 'Zeitplaene.texte.ts']);
    });

    // Woerter, die in einer Sprache wirklich wie im Englischen heissen ("Datei:schluessel:sprache")
    // (nl "curve": niederlaendisches Fachwort, im ganzen Bestand benutzt - die Zeile des Rechenwegs gilt fuer Heizen und Kuehlen)
    const GLEICH = new Set(['Stufen.texte.ts:komfort:nl', 'Stufen.texte.ts:komfort:it', 'Stufen.texte.ts:betriebsart:fr', 'Rechenweg.texte.ts:kennlinie:nl']);

    for (const datei of dateien) {
        it(`${datei}: jeder Schluessel in elf Sprachen, nicht leer, gleiche Platzhalter, uebersetzt`, () => {
            const texte = komponentenTexte(datei);
            // der Abschnitt ist nur eine Huelle mit vier Texten
            expect(Object.keys(texte).length, datei).to.be.greaterThan(datei === 'Abschnitt.texte.ts' ? 3 : 10);
            const fehler = [];
            for (const [k, t] of Object.entries(texte)) {
                if (Object.keys(t).sort().join() !== [...SPRACHEN].sort().join()) {
                    fehler.push(`${k}: Sprachen ${Object.keys(t).join()}`);
                    continue;
                }
                for (const s of SPRACHEN) {
                    if (typeof t[s] !== 'string' || !t[s].trim()) {
                        fehler.push(`${k}/${s}: leer`);
                    } else if (platzhalter(t[s]) !== platzhalter(t.en)) {
                        fehler.push(`${k}/${s}: Platzhalter`);
                    } else if (s !== 'en' && t[s] === t.en && /[a-z]{4}/i.test(t.en) && !GLEICH.has(`${datei}:${k}:${s}`)) {
                        fehler.push(`${k}/${s}: wie Englisch "${t.en}"`);
                    }
                }
            }
            expect(fehler).to.eql([]);
        });
    }
});

describe('Sprachen: Regeln fuer alle Quellen', () => {
    const texte = alleTexte();

    it('es werden wirklich alle Quellen gelesen', () => {
        expect(texte.length).to.be.greaterThan(850);
        for (const quelle of ['Zeitplaene.texte.ts', 'Stufen.texte.ts', 'admin/i18n', 'src-admin/src/i18n', 'oberflaeche', 'regel', 'anbinden', 'suche', 'verbrauchbild', 'io-package', 'widgets.', 'widgets-editor']) {
            expect(texte.filter(([ort]) => ort.startsWith(quelle)).length, quelle).to.be.greaterThan(1);
        }
    });

    it('jede Sprache vorhanden, Platzhalter wie im Englischen', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN) {
                if (typeof t[s] !== 'string' || !t[s].trim()) {
                    fehler.push(`${ort}: ${s} fehlt`);
                } else if (platzhalter(t[s]) !== platzhalter(t.en)) {
                    fehler.push(`${ort}: ${s} Platzhalter`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('kein Text spricht noch von Szenen (heisst Temperaturstufe)', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN) {
                // Platzhalternamen wie {szene} sind kein sichtbarer Text
                if (/szene|scene|scène|cenário|escena|scenari|сцен|场景/i.test(String(t[s]).replace(/\{\w+\}/g, ''))) {
                    fehler.push(`${ort}: ${s}`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('Deutsch sagt "Sensor" - kein "Fühler" (auch nicht als "Fuehler") in sichtbaren Texten, Namen der Datenpunkte und der Anleitung', () => {
        // Nutzerentscheid 21.11.2026: Raumsensor, Aussensensor, Feuchtesensor, BLE-Sensor, "Sensor der Anlage",
        // Sensorquelle, Sensorkorrektur ... Datenpunkt-IDs (sensors.*) und interne Bezeichner bleiben, wie sie sind.
        const VERBOTEN = /f(ü|ue)hler/i;
        const fehler = [];
        for (const [ort, t] of texte) {
            if (VERBOTEN.test(String(t.de).replace(/\{\w+\}/g, ''))) {
                fehler.push(`${ort}: "${String(t.de).slice(0, 60)}"`);
            }
        }
        // Namen von Datenpunkten und Kanaelen, feste Texte im Quelltext, Schema der Einstellungsseite, Anleitung:
        // dort steht die Umlautform nie mehr (Kommentare und Bezeichner des Quelltexts schreiben ASCII "Fuehler")
        const ordner = (wurzel, endung) =>
            fs
                .readdirSync(path.join(WURZEL, wurzel), { recursive: true })
                .map(String)
                .filter(d => endung.test(d) && !/node_modules/.test(d))
                .map(d => path.join(wurzel, d));
        const dateien = [
            'main.js',
            'io-package.json',
            'README.md',
            'docs/de/README.md',
            'admin/jsonConfig.json',
            'admin/i18n/de.json',
            ...ordner('lib', /\.js$/),
            ...ordner('widgets', /\.(js|html)$/),
            ...ordner('admin', /\.html$/),
            ...ordner('src-admin/src', /\.(tsx?|json)$/),
            ...ordner('vis-templates', /\.json$/),
        ];
        expect(dateien.length).to.be.greaterThan(60);
        for (const datei of dateien) {
            lies(datei)
                .split('\n')
                .forEach((zeile, nr) => {
                    if (/f\u00fchler/i.test(zeile)) {
                        fehler.push(`${datei}:${nr + 1}: "${zeile.trim().slice(0, 60)}"`);
                    }
                });
        }
        // deutsche Namen der Datenpunkte: auch die ASCII-Form waere dort sichtbar
        const namen = [];
        sammle(require('../lib/fields').FELDER, 'fields', namen);
        sammle(require('../lib/regel').DATENPUNKTE, 'regel.DATENPUNKTE', namen);
        sammle(require('../lib/regel').DATENPUNKTE_REGEL, 'regel.DATENPUNKTE_REGEL', namen);
        sammle(require('../lib/regel').KANAELE, 'regel.KANAELE', namen);
        expect(namen.length).to.be.greaterThan(40);
        for (const [ort, t] of namen) {
            if (VERBOTEN.test(t.de)) {
                fehler.push(`${ort}: "${t.de}"`);
            }
        }
        expect(fehler).to.eql([]);
        // die Pruefung selbst greift: beide Schreibweisen werden erkannt, "Sensor" nicht
        expect(['Raumfühler', 'BLE-Fühler am Modul', 'Fuehlerkorrektur', 'AUSSENFÜHLER'.toLowerCase()].every(w => VERBOTEN.test(w))).to.equal(true);
        expect(VERBOTEN.test('Raumsensor, Sensorquelle, Sensor der Anlage')).to.equal(false);
    });

    it('"Faikout-Auto" ist veraltet: die Wahl heisst "Faikout-Modul regelt selbst" (Kurzform "Modul regelt selbst")', () => {
        // Nutzerentscheid 21.11.2026. Interne Werte (regulation.mode = faikout, betrieb 'faikoutAuto') und der Kanal
        // "Faikout-Automatik" der Modul-Einstellungen (autoe/autor/autot) bleiben, wie sie sind.
        const VERALTET = /faikout[-  ](auto(?![a-zäöü])|авто(?![а-яіїє])|automático|自动)/i;
        const fehler = [];
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN) {
                if (VERALTET.test(t[s])) {
                    fehler.push(`${ort}: ${s} "${String(t[s]).slice(0, 60)}"`);
                }
            }
        }
        // Anleitung, Schema und Seiten: dort steht der alte Name auch nicht mehr
        for (const datei of ['README.md', 'docs/de/README.md', 'docs/en/README.md', 'admin/jsonConfig.json', 'admin/wochenplan.html', 'admin/verbrauch.html', 'widgets/faikout.html']) {
            lies(datei)
                .split('\n')
                .forEach((zeile, nr) => {
                    if (VERALTET.test(zeile)) {
                        fehler.push(`${datei}:${nr + 1}: "${zeile.trim().slice(0, 60)}"`);
                    }
                });
        }
        expect(fehler).to.eql([]);
        expect(['Faikout-Auto', 'Faikout auto', 'ruht (Faikout-Auto)', 'Faikout-авто', 'Faikout automático', 'Faikout 自动'].every(w => VERALTET.test(w))).to.equal(true);
        expect(['Faikout-Automatik (Zeit- und Temperaturschaltung)', 'Faikout automation', 'Faikout-Modul regelt selbst'].some(w => VERALTET.test(w))).to.equal(false);

        // das Paar der Auswahl "Wer regelt": Einstellungsseite und Details-Dialog nennen beide Wahlen wortgleich
        const i18n = k => Object.fromEntries(SPRACHEN.map(s => [s, JSON.parse(lies(`admin/i18n/${s}.json`))[k]]));
        const o = require('../lib/oberflaeche').TEXTE;
        const regel = require('../lib/regel/texte').TEXTE;
        const marke = komponentenTexte('Geraete.texte.ts').faikoutAuto;
        const paar = [];
        for (const s of SPRACHEN) {
            const modul = i18n('optBetriebFaikout')[s];
            const adapter = i18n('optBetriebAdapter')[s];
            const kurz = marke[s].toLowerCase();
            if (o.betriebFaikout[s] !== modul || o.betriebAdapter[s] !== adapter) {
                paar.push(`${s}: Details-Dialog weicht von der Einstellungsseite ab`);
            }
            if (!modul.includes('Faikout') || !adapter.includes('ioBroker')) {
                paar.push(`${s}: Paar nennt Faikout/ioBroker nicht`);
            }
            // die Kurzform (Marke der Geraetekarte) steht wortgleich auf Karte/VIS und in der Begruendung
            for (const [wo, text] of [
                ['oberflaeche.ruht', o.ruht[s]],
                ['regel index.ruhtAuto', regel['index.ruhtAuto'][s]],
                ['helpBand', i18n('helpBand')[s]],
                ['textRuht', i18n('textRuht')[s]],
                ['kFaikoutPlan', o.kFaikoutPlan[s]],
            ]) {
                const erwartet = wo === 'oberflaeche.ruht' || wo.startsWith('regel') ? kurz : modul.toLowerCase();
                if (!text.toLowerCase().includes(erwartet)) {
                    paar.push(`${s}: ${wo} ohne "${erwartet}"`);
                }
            }
            if (!o.kFaikoutPlan[s].includes(adapter)) {
                paar.push(`${s}: kFaikoutPlan empfiehlt nicht "${adapter}"`);
            }
        }
        expect(paar).to.eql([]);
        expect(marke.de).to.equal('Modul regelt selbst');
        expect(o.betriebFaikout.de).to.equal('Faikout-Modul regelt selbst');
        expect(o.betriebFaikout.en).to.equal('Faikout module controls itself');
    });

    it('Gedankenstrich statt " - ", keine geraden doppelten Anfuehrungszeichen', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN) {
                if (/\S - \S/.test(t[s]) || /"/.test(String(t[s]).replace(/\$\{[^}]*\}/g, ''))) {
                    fehler.push(`${ort}: ${s}`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('Dezimalzeichen: Punkt nur in Englisch und Chinesisch, sonst Komma', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN) {
                // Versionsnummern, Adressen und Objekt-IDs (a.0.b) sind keine Dezimalzahlen
                const text = String(t[s])
                    .replace(/\d+\.\d+\.\d+(\.\d+)?/g, '')
                    .replace(/[a-z_]+\.\d+(\.[\w.]+)?/gi, '')
                    .replace(/\d\.\.\d/g, '');
                const punkt = /(^|[^\d.])\d+\.\d+([^\d.]|$)/.test(text);
                const komma = /(^|[^\d,])\d+,\d+([^\d,]|$)/.test(text);
                if (s === 'en' || s === 'zh-cn' ? komma : punkt) {
                    fehler.push(`${ort}: ${s} "${text.slice(0, 60)}"`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('Chinesisch: vollbreite Klammern und Satzzeichen zwischen chinesischen Zeichen', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            const text = t['zh-cn'];
            if (/[一-鿿][,;?!]|[,;?!]\s*[一-鿿]|[一-鿿]\s*\(|\)[一-鿿]/.test(text)) {
                fehler.push(`${ort}: "${text.slice(0, 60)}"`);
            }
        }
        expect(fehler).to.eql([]);
    });

    it('Deutsch duzt (kein "Sie" als Anrede, kein "Ihre Anlage")', () => {
        const fehler = [];
        for (const [ort, t] of texte) {
            if (/\b(können|sollten|müssen|wählen|klicken|geben|tragen|prüfen) Sie\b|\bIhre[mnrs]? (Anlage|Modul|Broker|Adapter|Einstellung)/.test(t.de)) {
                fehler.push(ort);
            }
        }
        expect(fehler).to.eql([]);
    });
});

describe('Sprachen: keine festen Texte, keine Kopien des deutschen oder englischen Texts', () => {
    it('Komponenten (src-admin/src/*.tsx): kein sichtbarer Text ausserhalb der Texttabellen', () => {
        // TypeScript kommt mit der Entwicklungsumgebung (eslint-config); ohne es waere der Test blind
        const ts = require('typescript');
        const ATTRIBUTE = new Set(['title', 'aria-label', 'placeholder', 'label', 'alt', 'helperText']);
        const wort = t => /[A-Za-zÄÖÜäöüß]{3,}/.test(t);
        // feste Zeichenketten, die bewusst in keiner Sprache uebersetzt werden ("Datei:Text")
        const ERLAUBT = new Set([]);
        const funde = [];
        const ordner = path.join(WURZEL, 'src-admin', 'src');
        const dateien = fs.readdirSync(ordner).filter(d => d.endsWith('.tsx') && !['smokeRender.tsx', 'index.tsx'].includes(d));
        expect(dateien.length).to.be.greaterThan(5);
        for (const datei of dateien) {
            const sf = ts.createSourceFile(datei, fs.readFileSync(path.join(ordner, datei), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            const melde = (knoten, text) => {
                if (!ERLAUBT.has(`${datei}:${text.trim()}`)) {
                    funde.push(`${datei}:${sf.getLineAndCharacterOfPosition(knoten.getStart()).line + 1} "${text.trim().slice(0, 60)}"`);
                }
            };
            const lauf = n => {
                if (ts.isJsxText(n) && wort(n.text)) {
                    melde(n, n.text);
                } else if (ts.isJsxAttribute(n) && ATTRIBUTE.has(n.name.getText()) && n.initializer && ts.isStringLiteral(n.initializer) && wort(n.initializer.text)) {
                    melde(n, n.initializer.text);
                } else if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteral(n.expression) && wort(n.expression.text) && !ts.isJsxAttribute(n.parent)) {
                    melde(n, n.expression.text);
                }
                ts.forEachChild(n, lauf);
            };
            lauf(sf);
        }
        expect(funde).to.eql([]);
    });

    it('Seiten (admin/wochenplan.html, admin/verbrauch.html): kein fester Text im Seitenrumpf', () => {
        const funde = [];
        for (const datei of ['admin/wochenplan.html', 'admin/verbrauch.html']) {
            const rumpf = lies(datei)
                .replace(/^[\s\S]*<body[^>]*>/, '')
                .replace(/<script[\s\S]*?<\/script>/g, '')
                .replace(/<style[\s\S]*?<\/style>/g, '')
                .replace(/<!--[\s\S]*?-->/g, '');
            for (const m of rumpf.replace(/<[^>]*>/g, '\n').matchAll(/[A-Za-zÄÖÜäöüß]{3,}[^\n]*/g)) {
                funde.push(`${datei}: "${m[0].trim().slice(0, 60)}"`);
            }
            for (const m of rumpf.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*[A-Za-zÄÖÜäöüß]{3}[^"]*)"/g)) {
                funde.push(`${datei}: Attribut "${m[1]}"`);
            }
        }
        expect(funde).to.eql([]);
    });

    it('keine fremde Sprache enthaelt den deutschen oder englischen Text unveraendert (gepflegte Ausnahmen)', () => {
        // Maschinenwerte und Eigennamen bleiben in jeder Sprache gleich
        const TECHNIK = /^((ha|no)\.\w+|livestatus|reporting|Faikout|Firmware \/ hardware|IP|max\.|h|\d+|%s: %s|⌀ 30 min)$/;
        // Woerter, die in der Sprache wirklich so heissen ("sprache:Text")
        const GLEICH = new Set([
            ...['Auto', 'Total', 'Turbo'].map(w => `es:${w}`),
            ...['Absence', 'Auto', 'Maximum %', 'Minimum %', 'Mode', 'Module', 'Point %s', 'Port', 'Total', 'Turbo', 'active'].map(w => `fr:${w}`),
            ...['Auto', 'Comfort', 'Turbo'].map(w => `it:${w}`),
            ...['curve %s %', 'eigen: %s', 'Sensoren', 'Alles', 'Auto', 'Automatisch', 'Client-ID', 'Comfort', 'Compressor', 'Effect', 'Later', 'Module', 'Status', 'Strategie', 'Turbo', 'Ventilator', 'Week', 'morgen'].map(w => `nl:${w}`),
            ...['Auto', 'Komfort', 'Port', 'Punkt %s', 'Status', 'Turbo'].map(w => `pl:${w}`),
            ...['Auto', 'Compressor', 'Total', 'Turbo'].map(w => `pt:${w}`),
        ]);
        const texte = alleTexte();
        const fehler = [];
        const benutzt = new Set();
        for (const [ort, t] of texte) {
            for (const s of SPRACHEN.filter(x => x !== 'en' && x !== 'de')) {
                if ((t[s] === t.de || t[s] === t.en) && !TECHNIK.test(t[s])) {
                    benutzt.add(`${s}:${t[s]}`);
                    if (!GLEICH.has(`${s}:${t[s]}`)) {
                        fehler.push(`${ort}: ${s} = "${String(t[s]).slice(0, 50)}"`);
                    }
                }
            }
        }
        expect(fehler).to.eql([]);
        // die Ausnahmeliste enthaelt nichts Ueberfluessiges
        expect([...GLEICH].filter(g => !benutzt.has(g))).to.eql([]);
    });

    it('Russisch und Ukrainisch in kyrillischer, Chinesisch in chinesischer Schrift (laengere Texte)', () => {
        const fehler = [];
        for (const [ort, t] of alleTexte()) {
            for (const s of ['ru', 'uk']) {
                if (t[s].length > 14 && /[a-z]{5}/i.test(t[s]) && !/[а-яіїєґё]/i.test(t[s])) {
                    fehler.push(`${ort}: ${s}`);
                }
            }
            if (t['zh-cn'].length > 14 && !/[一-鿿]/.test(t['zh-cn'])) {
                fehler.push(`${ort}: zh-cn`);
            }
            if (/[а-яіїєґё一-鿿]/i.test(t.de + t.en)) {
                fehler.push(`${ort}: de/en mit fremder Schrift`);
            }
        }
        expect(fehler).to.eql([]);
    });
});

describe('Sprachen: VIS-Bausteine (widgets/) und Seitentitel', () => {
    const ts = require('typescript');
    const texte = bausteinTexte();
    const quelltext = lies('widgets/faikout/js/faikout.js');
    const BUCHSTABEN = /[A-Za-zÄÖÜäöüßА-яЁёІіЇїЄєҐґ一-鿿]{3,}/g;

    /**
     * Sichtbare Woerter einer Zeichenkette aus dem Quelltext der Bausteine: in HTML/SVG die Beschriftungen in
     * Attributen und alles zwischen den Marken; ohne Marken Umlaute oder fremde Schrift, ein grossgeschriebenes
     * Wort oder mehrere Woerter. Klassen, Selektoren, Datenpunkte und Schluessel der Texttabelle zaehlen nicht.
     *
     * @param {string} text  Inhalt der Zeichenkette
     * @returns {string[]} Fundstellen
     */
    const sichtbareWoerter = text => {
        if (/[<>]/.test(text)) {
            const aus = [];
            for (const m of text.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)/g)) {
                aus.push(...(m[1].match(BUCHSTABEN) || []));
            }
            const zwischen = text
                .replace(/<[^>]*>/g, ' ')
                .replace(/<[^>]*$/, ' ')
                .replace(/^[^<>]*>/, ' ')
                .replace(/&[a-z]+;/g, ' ');
            return aus.concat(zwischen.match(BUCHSTABEN) || []);
        }
        if (/fk-|^[.#]|^use strict$/.test(text)) {
            return [];
        }
        const auffaellig =
            /[ÄÖÜäöüßА-яЁёІіЇїЄєҐґ一-鿿]/.test(text) || /^[A-ZÄÖÜ][a-zäöüß]{2,}/.test(text) || /[A-Za-zäöüß]{2,} [·–-]? ?[A-Za-zäöüß]{2,}/.test(text);
        return auffaellig ? [text.trim().slice(0, 40)] : [];
    };

    it('Texttabelle: jeder Schluessel in elf Sprachen, nicht leer, gleiche Platzhalter', () => {
        const b = bausteine();
        expect(Array.from(b.SPRACHEN)).to.eql(SPRACHEN);
        expect(Object.keys(texte).length).to.be.greaterThan(60);
        const fehler = [];
        for (const [k, liste] of Object.entries(b.TEXTE)) {
            if (!/^[a-z][A-Za-z0-9]*$/.test(k)) {
                fehler.push(`${k}: Schluessel ist kein schlichter Name`);
            }
            if (liste.length !== SPRACHEN.length) {
                fehler.push(`${k}: ${liste.length} Sprachen`);
                continue;
            }
            for (const s of SPRACHEN) {
                if (typeof texte[k][s] !== 'string' || !texte[k][s].trim()) {
                    fehler.push(`${k}/${s}: leer`);
                } else if (platzhalter(texte[k][s]) !== platzhalter(texte[k].en)) {
                    fehler.push(`${k}/${s}: Platzhalter`);
                }
            }
        }
        expect(fehler).to.eql([]);
    });

    it('gemeinsame Begriffe stehen wortgleich wie im Adapter', () => {
        const o = require('../lib/oberflaeche').TEXTE;
        const dm = require('../lib/devicemanager');
        const vb = require('../lib/verbrauchbild').TEXTE;
        const stufen = komponentenTexte('Stufen.texte.ts');
        const ausO = ['zOk', 'zHand', 'zEinrichten', 'zGestoert', 'zOffline', 'zAus', 'probelauf', 'grenze', 'grenzeAus', 'ruht', 'aktWochenplan']
            .concat(['mAn', 'mAus', 'mVerbunden', 'fAussen', 'fRaum', 'aussenBei', 'zielKurz', 'tipWaermer', 'tipKuehler'])
            .map(k => [k, o[k]]);
        // Schluessel des Bausteins -> derselbe Text im Adapter
        const GLEICH = {
            ...Object.fromEntries(ausO),
            leistung: dm.TEXTE.leistung,
            tipEinschalten: dm.TEXTE.tipEinschalten,
            tipAusschalten: dm.TEXTE.tipAusschalten,
            modusHeatCool: dm.MODUS_TEXTE.heat_cool,
            modusCool: dm.MODUS_TEXTE.cool,
            modusHeat: dm.MODUS_TEXTE.heat,
            modusDry: dm.MODUS_TEXTE.dry,
            modusFanOnly: dm.MODUS_TEXTE.fan_only,
            betriebsart: stufen.betriebsart,
            luefter: stufen.luefter,
            luefterLeise: stufen.fan_night,
            tag: vb.tag,
            monat: vb.monat,
            jahr: vb.jahr,
            summe: vb.summe,
        };
        // Kurzformen: der Text des Bausteins steckt im (laengeren) Text des Adapters
        const ENTHALTEN = {
            bedarfsregelung: o.tipBedarfAn,
            feuchteregelung: o.tipFeuchteAn,
            nichtUnterstuetzt: o.nichtUnterstuetzt,
        };
        expect(Object.keys(GLEICH).length).to.equal(35);
        const fehler = [];
        for (const [k, adapter] of Object.entries(GLEICH)) {
            for (const s of SPRACHEN) {
                if (!adapter || !texte[k] || texte[k][s] !== adapter[s]) {
                    fehler.push(`${k}/${s}: "${texte[k] && texte[k][s]}" statt "${adapter && adapter[s]}"`);
                }
            }
        }
        for (const [k, adapter] of Object.entries(ENTHALTEN)) {
            for (const s of SPRACHEN) {
                if (!adapter[s].toLowerCase().includes(texte[k][s].toLowerCase())) {
                    fehler.push(`${k}/${s}: "${texte[k][s]}" nicht in "${adapter[s]}"`);
                }
            }
        }
        // der Hinweis "kein Geraet gewaehlt" nennt das Attribut so, wie der Editor es beschriftet
        const editor = editorTexte();
        for (const s of SPRACHEN) {
            if (!texte.keinGeraet[s].includes(editor.deviceOid[s])) {
                fehler.push(`keinGeraet/${s}: Attributname "${editor.deviceOid[s]}" fehlt`);
            }
        }
        expect(fehler).to.eql([]);
    });

    it('jeder benutzte Schluessel steht in der Tabelle, jeder Eintrag der Tabelle wird benutzt', () => {
        const ohneTabelle = quelltext.replace(/\n {4}TEXTE: \{[\s\S]*?\n {4}\},\n/, '\n');
        expect(ohneTabelle.length).to.be.below(quelltext.length - 5000);
        const benutzt = new Set();
        const nimm = (muster, teil) => {
            for (const m of ohneTabelle.matchAll(muster)) {
                for (const k of m[1].matchAll(teil)) {
                    benutzt.add(k[1]);
                }
            }
        };
        // t('schluessel', ...) - auch mit Auswahl t(a ? 'x' : 'y'); nur das erste Argument ist ein Schluessel
        nimm(/\bt\(((?:[^(),]|\([^()]*\))*)/g, /'([A-Za-z0-9]+)'/g);
        // Listen (name: 'schluessel') und Zuordnungen (ZUSTAND, TITEL, Umschalter Tag/Monat/Jahr)
        nimm(/\b(name: '[A-Za-z0-9]+')/g, /'([A-Za-z0-9]+)'/g);
        nimm(/var (?:ZUSTAND|TITEL) = \{([^}]*)\}/g, /: '([A-Za-z0-9]+)'/g);
        nimm(/b\.t\(\{([^}]*)\}\[/g, /: '([A-Za-z0-9]+)'/g);
        expect([...benutzt].filter(k => !texte[k]), 'benutzt, aber nicht in TEXTE').to.eql([]);
        expect(Object.keys(texte).filter(k => !benutzt.has(k)), 'in TEXTE, aber unbenutzt').to.eql([]);
        // ohne Tabelleneintrag liefert t() den Schluessel - der Vergleich oben haelt das aus dem Bild heraus
        expect(bausteine('fr').t('gibtEsNicht')).to.equal('gibtEsNicht');
    });

    it('kein fester sichtbarer Text in widgets/faikout/js/*.js ausserhalb der Tabelle', () => {
        // Woerter, die bewusst in keiner Sprache uebersetzt werden ("Datei:Wort")
        const ERLAUBT = new Set([
            // Beispiel-Objekt und Platzhalter in den Hinweisen "kein Geraet gewaehlt" / "Datenpunkt fehlt" (in <code>)
            'faikout.js:faikout',
            'faikout.js:Wohnzimmer',
            'faikout.js:consumption',
            'faikout.js:type',
            // Einheitenzeichen
            'faikout.js:kWh',
        ]);
        const funde = [];
        const benutzt = new Set();
        for (const datei of ['faikout.js', 'kennlinienbild.js']) {
            const sf = ts.createSourceFile(datei, lies(`widgets/faikout/js/${datei}`), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            const lauf = n => {
                // die Texttabelle selbst und die Symbol-Pfade (SVG ohne Text) sind kein fester Text
                if (ts.isPropertyAssignment(n) && ['TEXTE', 'SYM', 'REGEL_SYMBOLE'].includes(n.name.getText())) {
                    return;
                }
                if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
                    for (const wort of sichtbareWoerter(n.text)) {
                        benutzt.add(`${datei}:${wort}`);
                        if (!ERLAUBT.has(`${datei}:${wort}`)) {
                            funde.push(`${datei}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} "${wort}"`);
                        }
                    }
                }
                ts.forEachChild(n, lauf);
            };
            lauf(sf);
        }
        expect(funde).to.eql([]);
        expect([...ERLAUBT].filter(e => !benutzt.has(e)), 'Ausnahmeliste ohne Ueberfluessiges').to.eql([]);
        // Gegenprobe: die Pruefung erkennt die Texte, die frueher fest im Code standen ...
        for (const alt of ['<span class="fk-punkt">verbunden</span>', '<button aria-label="Sollwert senken">', 'Ein/Aus', 'gesendet · warte', 'Kühlen', 'Jan']) {
            expect(sichtbareWoerter(alt), alt).to.not.eql([]);
        }
        // ... und laesst Klassen, Selektoren, Datenpunkte und Schluessel in Ruhe
        for (const technisch of ['fk-pille fk-nur-text', '.fk-kopf .fk-schalter', 'control.power', 'zEinrichten', '<div class="fk-fuss">', 'data-wert', '°C']) {
            expect(sichtbareWoerter(technisch), technisch).to.eql([]);
        }
    });

    it('widgets/faikout.html: Editor-Tabelle vollstaendig, jedes Attribut beschriftet, kein fester Text ausser den Bausteinnamen', () => {
        const html = lies('widgets/faikout.html');
        const editor = editorTexte();
        const fehler = [];
        for (const [k, t] of Object.entries(editor)) {
            if (Object.keys(t).sort().join() !== [...SPRACHEN].sort().join() || SPRACHEN.some(s => !String(t[s]).trim())) {
                fehler.push(`${k}: Sprachen ${Object.keys(t).join()}`);
            }
        }
        // jedes Attribut, jede Auswahl und jede Gruppe der Vorlagen hat einen Eintrag
        const namen = new Set(['faikout_group_faikout']);
        for (const m of html.matchAll(/data-vis-attrs0?="([^"]*)"/g)) {
            for (const teil of m[1].split(';').filter(Boolean)) {
                const [name, art = ''] = teil.split('/');
                namen.add(name.replace(/^group\./, 'group_'));
                if (art.startsWith('select,')) {
                    art.split(',')
                        .slice(1)
                        .forEach(wahl => namen.add(wahl));
                }
            }
        }
        expect(namen.size).to.be.greaterThan(40);
        for (const n of namen) {
            if (!editor[n]) {
                fehler.push(`${n}: kein Eintrag in systemDictionary`);
            }
        }
        expect(fehler).to.eql([]);
        // Bausteinnamen in der Auswahl des Editors (data-vis-name) bleiben englisch - gepflegte Liste
        const NAMEN = [
            'Climate tile (complete)',
            'Set point arc',
            'Mode (horizontal)',
            'Mode (vertical)',
            'Fan speed (horizontal)',
            'Fan speed (vertical)',
            'Power limit',
            'Climate control (display)',
            'Extra functions (horizontal)',
            'Extra functions (vertical)',
            'Energy history (day/month/year)',
            'Readings (block, selectable)',
            'Consumption (today / this month)',
            'Reading (single)',
        ];
        expect([...html.matchAll(/data-vis-name="([^"]*)"/g)].map(m => m[1])).to.eql(NAMEN);
        // sonst steht in der Datei kein sichtbarer Text: nur Kommentare, Skripte und Vorlagen ohne Textknoten
        const rest = html
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<script type="text\/javascript">[\s\S]*?<\/script>/g, '')
            .replace(/<%[\s\S]*?%>/g, '')
            .replace(/<[^>]*>/g, '\n');
        expect(rest.match(/[A-Za-zÄÖÜäöüß]{3,}[^\n]*/g) || []).to.eql([]);
        expect([...html.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)].map(m => m[1])).to.eql([]);
    });

    it('Sprache aus VIS mit Rueckfall Englisch; Zahlen und Datum in der Sprache', () => {
        const sprache = l => bausteine(l).sprache();
        expect(SPRACHEN.map(sprache)).to.eql(SPRACHEN);
        expect(['de-DE', 'zh', 'zh_TW', 'PT-br', 'sv', ''].map(sprache)).to.eql(['de', 'zh-cn', 'zh-cn', 'pt', 'en', 'en']);
        // unbekannte Sprache -> englischer Text; Platzhalter der Reihe nach
        expect(bausteine('sv').t('zHand')).to.equal('manual override');
        expect(bausteine('de').t('zHand')).to.equal('Handeingriff');
        expect(bausteine('fr').t('paar', 'A', 'B')).to.equal('A : B');
        expect(bausteine('de').t('aussenBei', '−3,5')).to.equal('außen −3,5 °C');
        // Dezimalpunkt nur in Englisch und Chinesisch, echtes Minus ueberall
        for (const s of SPRACHEN) {
            expect(bausteine(s).zahl(-3.5, 1), s).to.equal(s === 'en' || s === 'zh-cn' ? '−3.5' : '−3,5');
        }
        // Monat und Tag kommen vom Browser (Intl) - keine eigenen Listen
        expect(bausteine('de').verlaufBeschriftung('2026-03', 'year')).to.match(/^Mär/);
        expect(bausteine('fr').verlaufBeschriftung('2026-03', 'year')).to.match(/^mars/);
        expect(bausteine('zh-cn').verlaufBeschriftung('2026-03', 'year')).to.equal('3月');
        expect(bausteine('de').verlaufBeschriftung('2026-03-07', 'month')).to.equal('7');
        expect(bausteine('zh-cn').verlaufBeschriftung('2026-03-07', 'month')).to.equal('7日');
    });

    it('Seitentitel: im HTML neutral, gesetzt aus den Texten des Adapters', () => {
        const plan = lies('admin/wochenplan.html');
        const verbrauch = lies('admin/verbrauch.html');
        for (const seite of [plan, verbrauch]) {
            expect([...seite.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1])).to.eql(['faikout']);
        }
        expect(plan).to.contain('document.title = `faikout – ${info.texts.aktWochenplan}`');
        expect(verbrauch).to.contain("document.title = `faikout – ${T('titel')}`");
        const o = require('../lib/oberflaeche');
        const vb = require('../lib/verbrauchbild');
        const titel = new Set();
        for (const s of SPRACHEN) {
            expect(o.planTexte(s).aktWochenplan, s).to.equal(o.TEXTE.aktWochenplan[s]);
            expect(vb.TEXTE.titel[s], s).to.be.a('string').and.not.equal('');
            titel.add(o.planTexte(s).aktWochenplan);
        }
        // wirklich uebersetzt (einzelne Sprachen duerfen gleich heissen)
        expect(titel.size).to.be.greaterThan(8);
    });
});
