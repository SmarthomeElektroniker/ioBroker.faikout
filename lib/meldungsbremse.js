'use strict';

/*
 * Bremse fuer sich wiederholende Fehlermeldungen der Module (Issue #15).
 *
 * Ist die Klimaanlage stromlos oder die Leitung zum Innengeraet gestoert, meldet das Modul etwa alle
 * 0,5 s `error/<Name>/comms` (z. B. {"protocol":"S21","timeout":true}). Bis 1.2.2 stand jede Meldung als
 * Warnung im Log - bei zwei Modulen vier Zeilen je Sekunde. Jetzt je Modul und Fehlerart eine "Stoerung":
 *   - die erste Meldung als Warnung,
 *   - jede weitere nur noch im Debug-Log mit Zaehler,
 *   - waehrend die Stoerung anhaelt, alle ERINNERN_MS eine Zusammenfassung (info),
 *   - kommt RUHE_MS lang keine Meldung dieser Art mehr, eine Zeile "wieder in Ordnung" (info) mit Anzahl
 *     und Dauer - nur, wenn es mehr als eine Meldung war (eine einzelne steht schon vollstaendig als Warnung
 *     im Log). Die naechste Meldung beginnt eine neue Stoerung (wieder mit Warnung).
 *
 * Rein Zustand rein, Text raus - frei von ioBroker, die Zeit kommt vom Aufrufer (testbar mit Fake-Uhr).
 */

/** So lange ohne neue Meldung gilt eine Stoerung als vorbei (ms). */
const RUHE_MS = 2 * 60000;
/** Abstand der Zusammenfassungen waehrend einer anhaltenden Stoerung (ms). */
const ERINNERN_MS = 15 * 60000;

/**
 * Dauer als kurzer englischer Text (Log).
 *
 * @param {number} ms  Dauer in ms
 * @returns {string} z. B. "45 s", "12 min", "2 h 5 min"
 */
function dauerText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return `${s} s`;
    }
    const min = Math.round(s / 60);
    if (min < 60) {
        return `${min} min`;
    }
    return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Sorte einer Fehlermeldung innerhalb ihres Unterpfads: Zeitueberschreitung und abgelehnte Befehle sind
 * verschiedene Stoerungen (im Log von Issue #15 kam erst `{"cmd":"F6",...,"noack":true}`, eine halbe Minute
 * spaeter die Flut `{"timeout":true}` - die erste Zeitueberschreitung soll trotzdem als Warnung erscheinen).
 *
 * @param {string} text  Nutzlast der Meldung
 * @returns {string} "timeout", "cmd <Befehl>" oder "" (sonstige)
 */
function sorte(text) {
    let d;
    try {
        d = JSON.parse(text);
    } catch {
        return '';
    }
    if (!d || typeof d !== 'object') {
        return '';
    }
    if (d.timeout) {
        return 'timeout';
    }
    return typeof d.cmd === 'string' && d.cmd ? `cmd ${d.cmd}` : '';
}

/** Fasst wiederholte Fehlermeldungen je Modul, Unterpfad und Sorte zu einer Stoerung zusammen. */
class Meldungsbremse {
    /**
     * @param {{ruheMs?: number, erinnernMs?: number}} [opt]  Zeiten (fuer Tests)
     */
    constructor(opt = {}) {
        this.ruheMs = opt.ruheMs || RUHE_MS;
        this.erinnernMs = opt.erinnernMs || ERINNERN_MS;
        /** Laufende Stoerungen: Map<string, {geraet: string, art: string, sorte: string, seit: number, zuletzt: number, anzahl: number, erinnert: number, seitErinnerung: number}> */
        this.stoerungen = new Map();
    }

    /**
     * Eine Fehlermeldung eines Moduls.
     *
     * @param {string} geraet  Name des Moduls (fuer den Text)
     * @param {string} art     Unterpfad der Meldung (comms, ...)
     * @param {string} text    Nutzlast der Meldung
     * @param {number} [jetzt] Zeit in ms
     * @returns {{stufe: 'warn'|'info'|'debug', text: string}[]} Logzeilen (die erste Meldung: warn, danach debug,
     *   dazwischen ggf. eine Zusammenfassung als info)
     */
    melden(geraet, art, text, jetzt = Date.now()) {
        const sorteText = sorte(text);
        const schluessel = `${geraet}\u0000${art}\u0000${sorteText}`;
        const aus = [];
        const praefix = `${geraet}: ${art ? `${art}: ` : ''}`;
        let s = this.stoerungen.get(schluessel);
        if (s && jetzt - s.zuletzt >= this.ruheMs) {
            // die alte Stoerung ist vorbei, ohne dass pruefen() sie abgeschlossen hat
            if (s.anzahl > 1) {
                aus.push(this.schluss(s));
            }
            this.stoerungen.delete(schluessel);
            s = undefined;
        }
        if (!s) {
            this.stoerungen.set(schluessel, {
                geraet,
                art,
                sorte: sorteText,
                seit: jetzt,
                zuletzt: jetzt,
                anzahl: 1,
                erinnert: jetzt,
                seitErinnerung: 0,
            });
            aus.push({
                stufe: 'warn',
                text: `${praefix}${text} - further messages of this kind are logged at debug level until the module reports normally again`,
            });
            return aus;
        }
        s.anzahl++;
        s.seitErinnerung++;
        s.zuletzt = jetzt;
        aus.push({ stufe: 'debug', text: `${praefix}${text} (#${s.anzahl})` });
        if (jetzt - s.erinnert >= this.erinnernMs) {
            aus.push({
                stufe: 'info',
                text: `${praefix}${sorteText ? `${sorteText} ` : ''}still failing for ${dauerText(jetzt - s.seit)} (${s.seitErinnerung} messages in the last ${dauerText(jetzt - s.erinnert)}, ${s.anzahl} in total)`,
            });
            s.erinnert = jetzt;
            s.seitErinnerung = 0;
        }
        return aus;
    }

    /**
     * Zyklisch aufrufen: Stoerungen ohne Meldung seit RUHE_MS abschliessen.
     *
     * @param {number} [jetzt] Zeit in ms
     * @returns {{stufe: 'info', text: string}[]} je beendeter Stoerung mit mehr als einer Meldung eine Zeile
     */
    pruefen(jetzt = Date.now()) {
        const aus = [];
        for (const [k, s] of [...this.stoerungen]) {
            if (jetzt - s.zuletzt >= this.ruheMs) {
                if (s.anzahl > 1) {
                    aus.push(this.schluss(s));
                }
                this.stoerungen.delete(k);
            }
        }
        return aus;
    }

    /**
     * Geraet ist weg (umbenannt, geloescht): seine Stoerungen ohne Logzeile vergessen.
     *
     * @param {string} geraet  Name des Moduls
     */
    vergessen(geraet) {
        for (const [k, s] of [...this.stoerungen]) {
            if (s.geraet === geraet) {
                this.stoerungen.delete(k);
            }
        }
    }

    /**
     * Logzeile zum Ende einer Stoerung.
     *
     * @param {{geraet: string, art: string, sorte?: string, seit: number, zuletzt: number, anzahl: number}} s  Stoerung
     * @returns {{stufe: 'info', text: string}} Logzeile
     */
    schluss(s) {
        return {
            stufe: 'info',
            text: `${s.geraet}: ${s.art ? `${s.art}: ` : ''}${s.sorte ? `${s.sorte} - ` : ''}no more error messages - ${s.anzahl} message${s.anzahl === 1 ? '' : 's'} within ${dauerText(s.zuletzt - s.seit)}`,
        };
    }
}

module.exports = { Meldungsbremse, RUHE_MS, ERINNERN_MS, dauerText, sorte };
