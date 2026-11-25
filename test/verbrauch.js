'use strict';

const { expect } = require('chai');
const v = require('../lib/verbrauch');

/** Fester Zeitpunkt, damit die Tests nicht an der echten Uhr haengen. */
const zeit = (tag, stunde) => new Date(2026, 7, tag, stunde, 30, 0);

describe('Verbrauchsrechnung', () => {
    it('liefert beim ersten Wert überall null-Verbrauch, aber den Gesamtzähler', () => {
        const r = v.verarbeiten(null, 3774300, zeit(17, 10));
        expect(r.werte.total).to.equal(3774.3);
        expect(r.werte.currentHour).to.equal(0);
        expect(r.werte.today).to.equal(0);
        expect(r.werte.lastHour).to.equal(null);
        expect(r.hinweise).to.be.empty;
    });

    it('rechnet innerhalb einer Stunde die Differenz', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 1000400, zeit(17, 10));
        expect(r.werte.currentHour).to.equal(0.4);
        expect(r.werte.today).to.equal(0.4);
        expect(r.werte.total).to.equal(1000.4);
    });

    it('schließt die Stunde beim Stundenwechsel ab', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 1000500, zeit(17, 11));
        expect(r.werte.lastHour, 'die volle Stunde 10 Uhr').to.equal(0.4);
        expect(r.werte.currentHour, 'in der neuen Stunde erst 100 Wh').to.equal(0.1);
        expect(r.werte.today, 'der Tag läuft weiter').to.equal(0.5);
        expect(r.werte.hours).to.have.lengthOf(1);
        expect(r.werte.hours[0]).to.deep.equal({ hour: '2026-08-17T10', kwh: 0.4 });
    });

    it('schließt den Tag beim Tageswechsel ab', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 23)).stand;
        s = v.verarbeiten(s, 1002000, zeit(17, 23)).stand;
        const r = v.verarbeiten(s, 1002100, zeit(18, 0));
        expect(r.werte.yesterday).to.equal(2);
        expect(r.werte.today).to.equal(0.1);
    });

    it('bucht einen zurückgesprungenen Zähler NICHT als Verbrauch', () => {
        // Passiert beim Neustart des Moduls - eine negative Differenz waere sonst ein
        // gewaltiger Fantasieverbrauch.
        let s = v.verarbeiten(null, 3774300, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 3774800, zeit(17, 10)).stand;
        const r = v.verarbeiten(s, 12, zeit(17, 10));
        // der Sprung selbst zaehlt nicht - was bis dahin gezaehlt war (0,5 kWh), bleibt aber stehen
        expect(r.werte.currentHour, 'bisher Gezaehltes bleibt, der Sprung zaehlt nicht').to.equal(0.5);
        expect(r.werte.today).to.equal(0.5);
        expect(r.werte.thisMonth).to.equal(0.5);
        expect(r.werte.total).to.equal(0.012);
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
    });

    it('nach einem Zählerrücksprung zählen Stunde, Tag und Monat nahtlos weiter und bleiben zueinander stimmig', () => {
        let s = v.verarbeiten(null, 5000000, zeit(17, 9)).stand;
        s = v.verarbeiten(s, 5001000, zeit(17, 9)).stand; // 1,0 kWh in Stunde 9
        s = v.verarbeiten(s, 5001400, zeit(17, 10)).stand; // 0,4 kWh in Stunde 10
        s = v.verarbeiten(s, 100, zeit(17, 10)).stand; // Modul neu gestartet, Zaehler bei 100 Wh
        const r = v.verarbeiten(s, 700, zeit(17, 10)); // danach 0,6 kWh
        expect(r.werte.currentHour).to.equal(1);
        expect(r.werte.today).to.equal(2);
        expect(r.werte.thisMonth).to.equal(2);
        // Stundenring plus laufende Stunde ergibt den Tageswert
        const ring = r.werte.hours.reduce((a, h) => a + (h.kwh || 0), 0);
        expect(ring + r.werte.currentHour).to.equal(r.werte.today);
        expect(r.werte.days[r.werte.days.length - 1].kwh).to.equal(2);
        expect(r.werte.months[r.werte.months.length - 1].kwh).to.equal(2);
    });

    it('vermerkt Ausfallzeiten als Lücke statt sie einer Stunde zuzuschlagen', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // Der Adapter war 3 Stunden weg und meldet sich um 14 Uhr zurueck.
        const r = v.verarbeiten(s, 1002000, zeit(17, 14));
        expect(r.werte.lastHour, 'die 10-Uhr-Stunde ist sauber abgeschlossen').to.equal(0.4);
        const luecken = r.werte.hours.filter(e => e.kwh === null);
        expect(luecken, 'drei unbekannte Stunden').to.have.lengthOf(3);
        expect(r.hinweise.join(' ')).to.match(/gap/);
    });

    it('begrenzt den Ringpuffer auf 48 Stunden', () => {
        let s = v.verarbeiten(null, 0, zeit(1, 0)).stand;
        for (let i = 1; i < 60; i++) {
            s = v.verarbeiten(s, i * 100, new Date(2026, 7, 1 + Math.floor(i / 24), i % 24, 30)).stand;
        }
        expect(s.ring.length).to.be.at.most(v.RING_STUNDEN);
    });

    it('erkennt den Stundenwechsel auch ohne neuen Zählerstand', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // Das Modul sendet nur alle 60 s - um Punkt 11 Uhr kommt eventuell nichts.
        const r = v.pruefen(s, zeit(17, 11));
        expect(r.werte, 'der Timer schließt die Stunde ab').to.not.equal(null);
        expect(r.werte.lastHour).to.equal(0.4);
    });

    it('tut beim Prüfen nichts, wenn sich die Stunde nicht geändert hat', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        const r = v.pruefen(s, zeit(17, 10));
        expect(r.werte).to.equal(null);
    });

    it('überlebt einen Zustand aus einer älteren Fassung ohne die neuen Ringe', () => {
        // Genau so sah der gespeicherte Zustand in 0.0.1 aus. Fehlten ringTage/ringMonate,
        // brach der Tageswechsel mit "Cannot read properties of undefined (reading 'push')".
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 23)).stand;
        const alt = JSON.parse(JSON.stringify(s));
        delete alt.ringTage;
        delete alt.ringMonate;
        delete alt.monat;
        delete alt.basisMonat;
        delete alt.letzterMonat;

        const r = v.verarbeiten(alt, 1001000, zeit(18, 8));
        expect(r.werte.yesterday, 'der Tageswechsel läuft durch').to.equal(0.4);
        expect(r.werte.days, 'die Tagesreihe entsteht neu').to.be.an('array');
        expect(r.werte.months, 'die Monatsreihe entsteht neu').to.be.an('array');
    });

    it('bucht den ersten gesehenen Monat nicht als Vormonat', () => {
        // Aus 0.0.1 kam ein Zustand ohne Monatsfelder. Ohne Ausnahme wurde beim ersten
        // Wert der volle Zaehlerstand (3783 kWh) als Verbrauch des Vormonats gebucht.
        let s = v.verarbeiten(null, 3780000, zeit(17, 10)).stand;
        const alt = JSON.parse(JSON.stringify(s));
        delete alt.monat;
        delete alt.basisMonat;
        delete alt.letzterMonat;
        delete alt.ringMonate;

        const r = v.verarbeiten(alt, 3780500, zeit(17, 11));
        expect(r.werte.lastMonth, 'es gibt keinen Vormonat').to.equal(null);
        // 0,5 statt 0: die Basis ist der zuletzt bekannte Stand, der Verbrauch seither zaehlt mit.
        expect(r.werte.thisMonth, 'der laufende Monat zählt ab dem letzten Stand').to.equal(0.5);
        expect(r.stand.ringMonate, 'kein Phantom-Monat im Ring').to.be.empty;
    });

    it('überlebt einen Neustart, wenn der Zustand gespeichert wurde', () => {
        let s = v.verarbeiten(null, 1000000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 1000400, zeit(17, 10)).stand;
        // So landet der Zustand im Geraeteobjekt und kommt wieder heraus.
        const gespeichert = JSON.parse(JSON.stringify(s));
        const r = v.verarbeiten(gespeichert, 1000900, zeit(17, 10));
        expect(r.werte.today, 'die Tagesbasis ist erhalten geblieben').to.equal(0.9);
    });
});

describe('Überlauf des 16-Bit-Zählers bei 6553,5 kWh (Codeberg RevK/ESP32-Faikout #682)', () => {
    const MAX = 6553500; // 0xFFFF * 100 Wh

    it('Überlauf: der Zuwachs bis zum Maximum und ab 0 zählt weiter (Stunde, Tag, Monat)', () => {
        let s = v.verarbeiten(null, MAX - 1000, zeit(17, 10)).stand;
        s = v.verarbeiten(s, MAX - 300, zeit(17, 10)).stand; // 0,7 kWh gezaehlt
        const r = v.verarbeiten(s, 200, zeit(17, 10)); // 300 Wh bis FFFF, 100 Wh FFFF -> 0, dann 200 Wh
        expect(r.hinweise.join(' ')).to.match(/wrapped around/);
        expect(r.werte.currentHour).to.equal(1.3);
        expect(r.werte.today).to.equal(1.3);
        expect(r.werte.thisMonth).to.equal(1.3);
        expect(r.werte.total, 'der Rohwert des Moduls bleibt sichtbar').to.equal(0.2);
        expect(r.stand.ueberlaeufe).to.equal(1);
    });

    it('Überlauf über einen Stunden- und Tageswechsel: Werte stimmen zueinander, Ring ohne Minuswerte', () => {
        let s = v.verarbeiten(null, MAX - 2000, zeit(17, 23)).stand;
        s = v.verarbeiten(s, MAX - 500, zeit(17, 23)).stand; // 1,5 kWh am 17.
        const r = v.verarbeiten(s, 400, zeit(18, 0)); // 0,5 + 0,1 + 0,4 = 1,0 kWh ueber den Ueberlauf
        expect(r.werte.yesterday).to.equal(1.5);
        expect(r.werte.today).to.equal(1);
        expect(r.werte.hours.every(h => h.kwh === null || h.kwh >= 0)).to.equal(true);
        expect(r.werte.thisMonth).to.equal(2.5);
    });

    it('Neustart nach dem Überlauf: gespeicherter Zustand zählt weiter, Überläufe bleiben gemerkt', () => {
        let s = v.verarbeiten(null, MAX - 100, zeit(17, 10)).stand;
        s = v.verarbeiten(s, 100, zeit(17, 10)).stand;
        const gespeichert = JSON.parse(JSON.stringify(s));
        const r = v.verarbeiten(gespeichert, 600, zeit(17, 10));
        expect(r.werte.today).to.equal(0.8);
        expect(r.stand.ueberlaeufe).to.equal(1);
        expect(r.hinweise).to.be.empty;
        // Modul-Neustart meldet denselben Stand: nichts passiert
        expect(v.verarbeiten(r.stand, 600, zeit(17, 10)).werte.today).to.equal(0.8);
    });

    it('echter Reset bleibt Neuaufsetzen: alter Wert nicht am oberen Ende oder neuer Wert nicht nahe 0', () => {
        // alter Wert mitten im Bereich (Modul-/Platinentausch, Reset)
        let s = v.verarbeiten(null, 3000000, zeit(17, 10)).stand;
        let r = v.verarbeiten(s, 100, zeit(17, 10));
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
        expect(r.werte.today).to.equal(0);
        expect(r.stand.ueberlaeufe).to.equal(0);
        // alter Wert am oberen Ende, neuer aber nicht nahe 0 (> 50 kWh): kein Ueberlauf
        s = v.verarbeiten(null, MAX - 1000, zeit(17, 10)).stand;
        r = v.verarbeiten(s, 60000, zeit(17, 10));
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
        expect(r.werte.today).to.equal(0);
        // kleiner Ruecksprung am oberen Ende (Modul meldet kurz einen aelteren Stand): kein Ueberlauf
        s = v.verarbeiten(null, MAX - 1000, zeit(17, 10)).stand;
        r = v.verarbeiten(s, MAX - 1200, zeit(17, 10));
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
    });

    it('Grenzen des Fensters: alt > Maximum − 50 kWh und neu < 50 kWh', () => {
        expect(v.istUeberlauf(MAX, 0)).to.equal(true);
        expect(v.istUeberlauf(MAX - 49900, 49900)).to.equal(true);
        expect(v.istUeberlauf(MAX - 50000, 100)).to.equal(false);
        expect(v.istUeberlauf(MAX - 100, 50000)).to.equal(false);
        expect(v.istUeberlauf(100, 50)).to.equal(false);
        expect(v.istUeberlauf(MAX - 100, MAX)).to.equal(false);
    });

    it('zaehlerAbstand rechnet auf dem Kreis, auch mit fortlaufenden Werten', () => {
        expect(v.zaehlerAbstand(MAX, 100)).to.equal(200);
        expect(v.zaehlerAbstand(100, MAX)).to.equal(200);
        expect(v.zaehlerAbstand(v.ZAEHLER_MODUL_WH + 100, 300)).to.equal(200);
        expect(v.zaehlerAbstand(1000000, 1001000)).to.equal(1000);
    });

    it('aussenZaehler liefert den fortlaufenden Stand, gemeinsameZaehler gruppiert über den Überlauf', () => {
        const geraete = new Map([
            ['a', { zaehler: { energy: { letzterWert: 0, ueberlaeufe: 1 } } }],
            ['b', { zaehler: { energy: { letzterWert: MAX } } }],
            ['c', { zaehler: { energy: { letzterWert: 2000000 } } }],
        ]);
        const z = v.aussenZaehler(geraete);
        expect(z.get('a')).to.equal(v.ZAEHLER_MODUL_WH);
        expect([...v.gemeinsameZaehler(z)]).to.deep.equal([
            ['a', 'a'],
            ['b', 'a'],
        ]);
        // auch ohne gemerkten Ueberlauf (z. B. frisch angelegtes Geraet) ueber die Kreisgrenze
        expect(
            [
                ...v.gemeinsameZaehler(
                    new Map([
                        ['x', 50100],
                        ['y', 50000],
                        ['z', MAX],
                    ]),
                ),
            ].length,
        ).to.equal(2);
    });
});

describe('Gemeinsames Außengerät (Multisplit, Issue #8)', () => {
    it('gleiche energy-Zähler (auf eine 100-Wh-Stufe) bilden eine Gruppe, die kleinste ID ist die Kennung', () => {
        const g = v.gemeinsameZaehler(
            new Map([
                ['faik-bedroom', 812300],
                ['faik-attic', 812400],
                ['og', 3970200],
                ['wz', 3131200],
            ]),
        );
        expect([...g].sort()).to.deep.equal([
            ['faik-attic', 'faik-attic'],
            ['faik-bedroom', 'faik-attic'],
        ]);
    });
    it('Single-Split: verschiedene Zähler, kleine Zähler (neue Geräte) und fehlende Werte bilden keine Gruppe', () => {
        expect(
            v.gemeinsameZaehler(
                new Map([
                    ['a', 3970200],
                    ['b', 3131200],
                ]),
            ).size,
        ).to.equal(0);
        expect(
            v.gemeinsameZaehler(
                new Map([
                    ['a', 500],
                    ['b', 500],
                ]),
            ).size,
        ).to.equal(0);
        expect(
            v.gemeinsameZaehler(
                new Map([
                    ['a', null],
                    ['b', undefined],
                    ['c', 20000],
                ]),
            ).size,
        ).to.equal(0);
        expect(
            v.gemeinsameZaehler(
                new Map([
                    ['a', 20000],
                    ['b', 20101],
                ]),
            ).size,
        ).to.equal(0);
        expect(v.gemeinsameZaehler(undefined).size).to.equal(0);
    });
    it('liest den letzten Rohwert aus dem gemerkten Zählerstand der Geräte', () => {
        const m = v.aussenZaehler(
            new Map([
                ['a', { zaehler: { energy: { letzterWert: 12345 } } }],
                ['b', { zaehler: {} }],
            ]),
        );
        expect([...m]).to.deep.equal([
            ['a', 12345],
            ['b', null],
        ]);
    });

    it('Stromausfall (Forum 25.11.2026): Rücksprung auf volle kWh ist kein Überlauf, Gezähltes bleibt, es zählt weiter', () => {
        const MAX = v.ZAEHLER_MODUL_WH - 100; // 0xFFFF * 100 Wh
        // energyheat eines Innengeraets: 163800 -> 163000 Wh nach dem Stromlosmachen
        let s = v.verarbeiten(null, 160000, zeit(25, 5)).stand;
        s = v.verarbeiten(s, 163800, zeit(25, 6)).stand;
        let r = v.verarbeiten(s, 163000, zeit(25, 7));
        expect(v.istUeberlauf(163800, 163000)).to.equal(false);
        expect(r.hinweise.join(' ')).to.match(/went backwards \(163800 -> 163000 Wh\)/);
        expect(r.hinweise.join(' ')).to.not.match(/wrapped/);
        expect(r.stand.ueberlaeufe).to.equal(0);
        expect(r.werte.today).to.equal(3.8); // bis zum Ausfall Gezaehltes bleibt
        expect(r.werte.lastHour).to.equal(3.8);
        r = v.verarbeiten(r.stand, 163400, zeit(25, 7));
        expect(r.werte.today).to.equal(4.2); // nur der echte Zuwachs nach dem Ausfall kommt dazu
        expect(r.werte.currentHour).to.equal(0.4);
        expect(r.werte.total).to.equal(163.4);
        // Modulzaehler 626400 -> 626000: ebenso
        expect(v.istUeberlauf(626400, 626000)).to.equal(false);
        // auch knapp unter dem Maximum fuehrt Abrunden auf volle kWh nie in das Ueberlauf-Fenster (neu < 50 kWh)
        expect(v.istUeberlauf(MAX - 400, MAX - 1000)).to.equal(false);
        s = v.verarbeiten(null, MAX - 400, zeit(25, 7)).stand;
        r = v.verarbeiten(s, MAX - 1000, zeit(25, 7));
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
        expect(r.stand.ueberlaeufe).to.equal(0);
        // nach dem Ueberlauf (Zaehler knapp ueber 0) und Abrunden auf 0: Ruecksprung, kein zweiter Ueberlauf
        s = v.verarbeiten(null, MAX, zeit(25, 7)).stand;
        s = v.verarbeiten(s, 800, zeit(25, 7)).stand;
        expect(s.ueberlaeufe).to.equal(1);
        r = v.verarbeiten(s, 0, zeit(25, 7));
        expect(r.stand.ueberlaeufe).to.equal(1);
        expect(r.hinweise.join(' ')).to.match(/went backwards/);
        expect(r.werte.today).to.equal(0.9);
    });
});
