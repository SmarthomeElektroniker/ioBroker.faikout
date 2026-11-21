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
    const io = JSON.parse(lies('io-package.json'));
    sammle({ titleLang: io.common.titleLang, desc: io.common.desc, news: { [io.common.version]: io.common.news[io.common.version] } }, 'io-package', liste);
    sammle(io.instanceObjects, 'io-package.instanceObjects', liste);
    return liste;
}

describe('Sprachen: Komponententexte src-admin/src/*.texte.ts', () => {
    const dateien = fs.readdirSync(path.join(WURZEL, 'src-admin', 'src')).filter(d => d.endsWith('.texte.ts'));

    it('alle sieben Komponenten werden gefunden', () => {
        expect(dateien.sort()).to.eql(['Erklaerung.texte.ts', 'Feuchte.texte.ts', 'Geraete.texte.ts', 'Kennlinie.texte.ts', 'Stufen.texte.ts', 'Werkzeugleiste.texte.ts', 'Zeitplaene.texte.ts']);
    });

    // Woerter, die in einer Sprache wirklich wie im Englischen heissen ("Datei:schluessel:sprache")
    const GLEICH = new Set(['Stufen.texte.ts:komfort:nl', 'Stufen.texte.ts:komfort:it', 'Stufen.texte.ts:betriebsart:fr', 'Geraete.texte.ts:individuell:pt', 'Geraete.texte.ts:individuell:es']);

    for (const datei of dateien) {
        it(`${datei}: jeder Schluessel in elf Sprachen, nicht leer, gleiche Platzhalter, uebersetzt`, () => {
            const texte = komponentenTexte(datei);
            expect(Object.keys(texte).length, datei).to.be.greaterThan(10);
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
        for (const quelle of ['Zeitplaene.texte.ts', 'Stufen.texte.ts', 'admin/i18n', 'src-admin/src/i18n', 'oberflaeche', 'regel', 'anbinden', 'suche', 'verbrauchbild', 'io-package']) {
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
