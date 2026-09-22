'use strict';

const { expect } = require('chai');
const felder = require('../lib/fields');
const namen = require('../lib/namen');

/**
 * Die elf Sprachen, die der Objektstruktur-Pruefer des ioBroker-Repositories erwartet.
 * Fehlt eine davon an einem Datenpunkt, meldet er E6001.
 */
const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('Datenpunktnamen', () => {
    /*
     * DER EIGENTLICHE ZWECK DIESES TESTS.
     * Am 22.09.2026 meldete der Pruefer 143 von 160 Objekten als unvollstaendig uebersetzt.
     * Ein neues Feld in fields.js ohne Eintrag in namen.js wuerde denselben Fehler
     * zurueckbringen - und zwar erst Wochen spaeter im Antrag. Hier faellt es sofort auf.
     */
    it('jedes Feld hat eine Uebersetzung', () => {
        const alle = Object.values(felder.FELDER)
            .map(d => d.name)
            .filter(Boolean);
        expect(alle.length).to.be.greaterThan(50);
        expect(namen.ohneUebersetzung(alle)).to.eql([]);
    });

    it('vollerName liefert alle elf Sprachen', () => {
        const voll = namen.vollerName({ en: 'Power', de: 'Ein/Aus' });
        for (const sprache of SPRACHEN) {
            expect(voll, `Sprache ${sprache} fehlt`).to.have.property(sprache);
            expect(voll[sprache], `Sprache ${sprache} ist leer`).to.be.a('string').and.not.empty;
        }
    });

    it('jede Uebersetzung fuehrt die neun zusaetzlichen Sprachen', () => {
        const zusatz = SPRACHEN.filter(s => s !== 'en' && s !== 'de');
        for (const [name, werte] of Object.entries(namen.UEBERSETZUNGEN)) {
            for (const sprache of zusatz) {
                expect(werte, `"${name}": ${sprache} fehlt`).to.have.property(sprache);
            }
        }
    });

    it('laesst unbekannte Namen unveraendert, statt zu scheitern', () => {
        const unbekannt = { en: 'Something new', de: 'Etwas Neues' };
        expect(namen.vollerName(unbekannt)).to.eql(unbekannt);
        expect(namen.vollerName('Schlichter Text')).to.equal('Schlichter Text');
        expect(namen.vollerName(undefined)).to.equal(undefined);
    });
});

describe('Rollen', () => {
    /*
     * Der Pruefer kennt einen festen Rollenkatalog. "info" allein steht nicht darin (nur
     * "info.<etwas>"), und die Rollen "level.mode.*" verlangen eine Zahl - unsere
     * Betriebsarten sind aber Texte mit Zustandsliste. Beides kostete am 22.09.2026
     * achtzehn Beanstandungen.
     */
    it('benutzt keine Rolle "info" ohne Zusatz', () => {
        const daneben = Object.entries(felder.FELDER)
            .filter(([, d]) => d.role === 'info')
            .map(([k]) => k);
        expect(daneben).to.eql([]);
    });

    it('benutzt keine level.mode-Rolle fuer Textfelder', () => {
        const daneben = Object.entries(felder.FELDER)
            .filter(([, d]) => d.type === 'string' && String(d.role).startsWith('level.mode'))
            .map(([k]) => k);
        expect(daneben).to.eql([]);
    });
});
