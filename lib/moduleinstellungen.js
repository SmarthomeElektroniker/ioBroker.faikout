'use strict';

/**
 * Einstellungen im faikout-Modul aendern - die Rechenbausteine und der Ablauf
 * Sichern -> Schreiben -> Zuruecklesen. Ohne Adapter: Senden, Lesen, Warten und Uhr kommen herein.
 *
 * SCHREIBWEG: EINE MQTT-Nachricht `setting/<Geraetename>` mit JSON nur der geaenderten Felder.
 * Kein HTTP-POST. Das Modul speichert die Werte im Flash; nicht-live Einstellungen starten es
 * nach etwa 3 s neu.
 *
 * FESTE FELDLISTE: Geschrieben wird ausschliesslich, was in FELDER steht. Alles zu Firmware/OTA,
 * Broker, WLAN und Passwoertern ist zusaetzlich ausdruecklich gesperrt (VERBOTEN) - auch wenn
 * jemand die Liste spaeter erweitert, kommt so ein Feld nie in eine Nachricht.
 */

/**
 * Einstellungen, die gelesen, gezeigt und geschrieben werden duerfen. `feld` ist der Name im
 * Modul, `form` das Feld im Formular der Einstellungsseite, `art` bestimmt Typ und Vergleich,
 * `min`/`max` begrenzen Zahlen.
 */
const FELDER = [
    { feld: 'reporting', form: '_modReporting', art: 'zahl', min: 1, max: 3600 },
    { feld: 'livestatus', form: '_modLivestatus', art: 'bool' },
    { feld: 'ha1c', form: '_modHa1c', art: 'bool' },
    { feld: 'thermostat', form: '_modThermostat', art: 'bool' },
    { feld: 'nodemand', form: '_modNodemand', art: 'bool' },
    { feld: 'topicgroup1', form: '_modTopicgroup1', art: 'text', muster: /^[\w.-]{0,32}$/ },
];

/** Nie schreibbar, egal was in FELDER steht: Firmware/OTA, Broker, WLAN, Zugangsdaten, Name. */
const VERBOTEN = /^(ota|upgrade|firmware|mqtt|wifi|ap|password|pass|cookie|hostname|instance|_)|pass|host$/i;

/** So viele Sicherungen bleiben je Geraet. */
const SICHERUNGEN_MAX = 5;

/** Zeitlimit fuer das Zuruecklesen (Neustart des Moduls eingeschlossen) und Abstand der Versuche. */
const RUECKLESEN_MS = 60000;
const ABSTAND_MS = 4000;
const ERSTE_PAUSE_MS = 2500;

/**
 * Beschreibung eines Feldes oder null, wenn es nicht geschrieben werden darf.
 *
 * @param {string} feld  Feldname im Modul
 * @returns {{feld: string, form: string, art: string, min?: number, max?: number, muster?: RegExp}|null} Beschreibung
 */
function feldVon(feld) {
    const f = FELDER.find(x => x.feld === feld);
    return f && !VERBOTEN.test(f.feld) ? f : null;
}

/**
 * Wandelt einen Wert in den Typ des Feldes. Ungueltiges liefert `fehler`.
 *
 * @param {'zahl'|'bool'|'text'} art  Typ
 * @param {unknown} wert  Rohwert (Formular, Seite des Moduls oder Sicherung)
 * @param {{min?: number, max?: number, muster?: RegExp}} [grenzen]  Grenzen
 * @returns {{wert?: number|boolean|string, fehler?: string}} gewandelter Wert oder Fehler
 */
function wandeln(art, wert, grenzen = {}) {
    if (art === 'bool') {
        if (wert === true || wert === 'true' || wert === 1 || wert === '1' || wert === 'on') {
            return { wert: true };
        }
        if (wert === false || wert === 'false' || wert === 0 || wert === '0' || wert === '' || wert === 'off') {
            return { wert: false };
        }
        return { fehler: 'bool' };
    }
    if (art === 'zahl') {
        const n =
            typeof wert === 'number'
                ? wert
                : Number(
                      String(wert ?? '')
                          .trim()
                          .replace(',', '.'),
                  );
        if (wert === '' || wert === null || wert === undefined || !Number.isFinite(n)) {
            return { fehler: 'zahl' };
        }
        if ((grenzen.min !== undefined && n < grenzen.min) || (grenzen.max !== undefined && n > grenzen.max)) {
            return { fehler: 'bereich' };
        }
        return { wert: n };
    }
    const s = String(wert ?? '').trim();
    if (grenzen.muster && !grenzen.muster.test(s)) {
        return { fehler: 'text' };
    }
    return { wert: s };
}

/**
 * Gleichheit zweier Werte eines Feldes (nach Typwandlung; die Seite des Moduls liefert Text).
 *
 * @param {'zahl'|'bool'|'text'} art  Typ
 * @param {unknown} a  Wert
 * @param {unknown} b  Wert
 * @returns {boolean} gleich
 */
function gleich(art, a, b) {
    const x = wandeln(art, a);
    const y = wandeln(art, b);
    return !x.fehler && !y.fehler && x.wert === y.wert;
}

/**
 * Unterschied zwischen dem Stand im Modul und den gewuenschten Werten.
 *
 * @param {Record<string, unknown>} gelesen  Stand aus dem Modul (Feldnamen des Moduls)
 * @param {Record<string, unknown>} wunsch  gewuenschte Werte (Feldnamen des Moduls)
 * @returns {{aenderungen: Array<{feld: string, art: string, alt: unknown, neu: number|boolean|string}>, fehler: Array<{feld: string, grund: string}>}} Aenderungen und abgewiesene Felder
 */
function unterschied(gelesen, wunsch) {
    const aenderungen = [];
    const fehler = [];
    for (const [feld, roh] of Object.entries(wunsch || {})) {
        const f = feldVon(feld);
        if (!f) {
            fehler.push({ feld, grund: 'verboten' });
            continue;
        }
        if (roh === undefined || roh === null || !(feld in (gelesen || {}))) {
            continue; // dieses Modul kennt die Einstellung nicht
        }
        const neu = wandeln(f.art, roh, f);
        if (neu.fehler) {
            fehler.push({ feld, grund: neu.fehler });
        } else if (!gleich(f.art, gelesen[feld], neu.wert)) {
            aenderungen.push({ feld, art: f.art, alt: gelesen[feld], neu: neu.wert });
        }
    }
    return { aenderungen, fehler };
}

/**
 * Baut die eine MQTT-Nachricht. Wirft bei einem Feld ausserhalb der Liste - dann wird NICHTS gesendet.
 *
 * @param {string} name  Geraetename, wie sich das Modul am Broker meldet
 * @param {Array<{feld: string, neu: unknown}>} aenderungen  zu schreibende Felder
 * @returns {{topic: string, nutzlast: string}} Nachricht
 */
function nachricht(name, aenderungen) {
    const n = String(name || '').trim();
    if (!n || /[#+/]/.test(n)) {
        throw new Error('invalid module name');
    }
    if (!Array.isArray(aenderungen) || !aenderungen.length) {
        throw new Error('nothing to write');
    }
    const daten = {};
    for (const a of aenderungen) {
        const f = feldVon(a && a.feld);
        if (!f) {
            throw new Error(`setting "${a && a.feld}" must not be written`);
        }
        const w = wandeln(f.art, a.neu, f);
        if (w.fehler) {
            throw new Error(`setting "${f.feld}": invalid value`);
        }
        daten[f.feld] = w.wert;
    }
    return { topic: `setting/${n}`, nutzlast: JSON.stringify(daten) };
}

/**
 * Vergleicht nach dem Schreiben, was im Modul steht.
 *
 * @param {Array<{feld: string, art: string, neu: unknown}>} aenderungen  geschriebene Felder
 * @param {Record<string, unknown>} gelesen  zurueckgelesener Stand
 * @returns {Array<{feld: string, soll: unknown, ist: unknown, ok: boolean}>} Ergebnis je Feld
 */
function ruecklesen(aenderungen, gelesen) {
    return aenderungen.map(a => ({
        feld: a.feld,
        soll: a.neu,
        ist: gelesen ? gelesen[a.feld] : undefined,
        ok: !!gelesen && a.feld in gelesen && gleich(a.art, gelesen[a.feld], a.neu),
    }));
}

/**
 * Haengt eine Sicherung an (nur Felder der Liste), hoechstens SICHERUNGEN_MAX, neueste zuletzt.
 *
 * @param {unknown} liste  bisherige Sicherungen
 * @param {Record<string, unknown>} werte  Stand vor dem Schreiben
 * @param {number} zeit  Zeitstempel
 * @returns {Array<{zeit: number, werte: Record<string, unknown>}>} neue Liste
 */
function sicherungAnhaengen(liste, werte, zeit) {
    const nur = {};
    for (const f of FELDER) {
        if (werte && f.feld in werte && feldVon(f.feld)) {
            nur[f.feld] = werte[f.feld];
        }
    }
    const alt = (Array.isArray(liste) ? liste : []).filter(s => s && typeof s.zeit === 'number' && s.werte);
    return [...alt, { zeit, werte: nur }].slice(-SICHERUNGEN_MAX);
}

/**
 * Ablauf Schreiben -> Zuruecklesen.
 *
 * @param {object} o  Angaben
 * @param {string} o.name  Geraetename
 * @param {Array<{feld: string, art: string, alt: unknown, neu: unknown}>} o.aenderungen  Aenderungen aus unterschied()
 * @param {(topic: string, nutzlast: string) => Promise<boolean>} o.senden  MQTT-Publish
 * @param {() => Promise<{ok: boolean, werte?: Record<string, unknown>}>} o.lesen  Stand per HTTP GET lesen
 * @param {(ms: number) => Promise<void>} o.warten  Pause
 * @param {() => number} [o.jetzt]  Uhr
 * @param {number} [o.zeitlimitMs]  Zeitlimit fuer das Zuruecklesen
 * @param {number} [o.abstandMs]  Abstand der Leseversuche
 * @returns {Promise<{ok: boolean, art: 'ok'|'ungueltig'|'nichtGesendet'|'zeit'|'abweichung', fehler?: string, felder: Array<{feld: string, soll: unknown, ist: unknown, ok: boolean}>, werte?: Record<string, unknown>}>} Ergebnis
 */
async function schreiben(o) {
    const jetzt = o.jetzt || (() => Date.now());
    let n;
    try {
        n = nachricht(o.name, o.aenderungen);
    } catch (e) {
        return { ok: false, art: 'ungueltig', fehler: e.message, felder: [] };
    }
    if (!(await o.senden(n.topic, n.nutzlast))) {
        return { ok: false, art: 'nichtGesendet', felder: ruecklesen(o.aenderungen, null) };
    }
    const ende = jetzt() + (o.zeitlimitMs || RUECKLESEN_MS);
    const abstand = o.abstandMs || ABSTAND_MS;
    await o.warten(Math.min(ERSTE_PAUSE_MS, abstand));
    let letzter = null;
    for (;;) {
        const r = await o.lesen();
        if (r && r.ok && r.werte) {
            letzter = r.werte;
            const felder = ruecklesen(o.aenderungen, r.werte);
            if (felder.every(f => f.ok)) {
                return { ok: true, art: 'ok', felder, werte: r.werte };
            }
        }
        if (jetzt() + abstand > ende) {
            break;
        }
        await o.warten(abstand);
    }
    // nie erreicht: Zeitueberschreitung; erreicht, aber anderer Wert: Abweichung
    return letzter
        ? { ok: false, art: 'abweichung', felder: ruecklesen(o.aenderungen, letzter), werte: letzter }
        : { ok: false, art: 'zeit', felder: ruecklesen(o.aenderungen, null) };
}

module.exports = {
    FELDER,
    VERBOTEN,
    SICHERUNGEN_MAX,
    RUECKLESEN_MS,
    ABSTAND_MS,
    feldVon,
    wandeln,
    gleich,
    unterschied,
    nachricht,
    ruecklesen,
    sicherungAnhaengen,
    schreiben,
};
