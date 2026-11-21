'use strict';

/**
 * Umzug der Datenpunkte der Regelung von den deutschen IDs des Vorabstands (`<Geraet>.regel.*`,
 * `info.demandFaehig`) auf die englischen (`<Geraet>.regulation.*`, `info.demandCapable`).
 *
 * Nutzerentscheid 21.11.2026: Die IDs heissen englisch wie in control.*, status.*, info.* und
 * consumption.*. 1.0.0 war noch nicht veroeffentlicht, darum gibt es keine Alias-Objekte - aber
 * Testinstallationen tragen den Vorabstand. Beim Start wird je Geraet einmal umgezogen:
 *   1. neue Objekte anlegen (dieselben Definitionen wie im Betrieb),
 *   2. Werte uebernehmen - Schalter, Wochenplan, Abwesenheit, gespeicherter Zustand, Verlauf und die
 *      Anzeigewerte; deutsche Zustandswerte werden dabei auf die englischen umgesetzt,
 *   3. eigene Einstellungen der alten Objekte (common.custom, z. B. History) uebernehmen,
 *   4. alte Objekte samt Kanaelen loeschen.
 * Gibt es ein neues Objekt schon (abgebrochener Umzug, bereits gelaufener Adapter), bleibt sein Wert
 * stehen. Ohne alte Objekte geschieht nichts - der Umzug darf beliebig oft laufen.
 *
 * Zweiter Schritt (21.11.2026, "Szenen" heissen "Temperaturstufen"): die Datenpunkte des
 * Zwischenstands `regulation.schedule.scene` / `nextScene` ziehen nach `level` / `nextLevel` - mit
 * Wert und eigenen Einstellungen, das alte Objekt wird geloescht.
 */

const regel = require('./index');
const zustandSpeicher = require('./zustand');

const ALT_WURZEL = 'regel';

/** Kanaele: alt -> neu */
const KANAELE = {
    bedarf: 'demand',
    plan: 'schedule',
    feuchte: 'humidity',
    hand: 'manual',
    ziel: 'target',
    fuehler: 'sensors',
};

/** Datenpunkte je altem Kanal ('' = direkt unter regel): alt -> neu */
const BLAETTER = {
    '': {
        zustand: 'state',
        grund: 'reason',
        betrieb: 'mode',
        letzterBefehl: 'lastCommand',
        verlaufJson: 'historyJson',
    },
    bedarf: {
        aktiv: 'active',
        probelauf: 'dryRun',
        sollwert: 'setpoint',
        rohwert: 'rawValue',
        aussenMittel: 'outsideMean',
        grund: 'reason',
        zustand: 'state',
        wuerdeSenden: 'wouldSend',
        befehleStunde: 'commandsPerHour',
        strategie: 'strategy',
        zustandJson: 'stateJson',
        kennlinieJson: 'curveJson',
        faehigGrund: 'capableReason',
    },
    plan: {
        aktiv: 'active',
        wocheJson: 'weekJson',
        abwesenheitJson: 'absenceJson',
        szene: 'level',
        naechster: 'next',
        naechsteSzene: 'nextLevel',
        fehlt: 'missing',
    },
    feuchte: {
        aktiv: 'active',
        taupunkt: 'dewPoint',
        abstand: 'margin',
        eingriff: 'intervention',
        grund: 'reason',
    },
    hand: { gesperrt: 'locked', bis: 'until', aufheben: 'resume' },
    ziel: { plus: 'up', minus: 'down' },
    fuehler: {
        aussen: 'outside',
        aussenQuelle: 'outsideSource',
        aussenStand: 'outsideStatus',
        aussenArt: 'outsideKind',
        raum: 'room',
        raumQuelle: 'roomSource',
        raumStand: 'roomStatus',
        raumArt: 'roomKind',
        feuchte: 'humidity',
        feuchteQuelle: 'humiditySource',
        feuchteStand: 'humidityStatus',
        feuchteArt: 'humidityKind',
        korrektur: 'correction',
        ziel: 'target',
        hinweis: 'note',
    },
};

/** Vollstaendige Zuordnung relativ zum Geraet: 'regel.bedarf.aktiv' -> 'regulation.demand.active' */
const PFADE = {};
for (const [kanal, blaetter] of Object.entries(BLAETTER)) {
    for (const [alt, neu] of Object.entries(blaetter)) {
        const altPfad = kanal ? `${kanal}.${alt}` : alt;
        const neuPfad = kanal ? `${KANAELE[kanal]}.${neu}` : neu;
        PFADE[`${ALT_WURZEL}.${altPfad}`] = `${regel.WURZEL}.${neuPfad}`;
    }
}
PFADE['info.demandFaehig'] = 'info.demandCapable';

const STAND = { rueckfall: 'fallback', fehlt: 'missing' };
const ART = { intern: 'internal' };

/** Zwischenstand unter der heutigen Wurzel: alter Pfad -> neuer Pfad (relativ zum Geraet) */
const PFADE_ZWISCHEN = {
    [`${regel.WURZEL}.schedule.scene`]: `${regel.WURZEL}.schedule.level`,
    [`${regel.WURZEL}.schedule.nextScene`]: `${regel.WURZEL}.schedule.nextLevel`,
};

/** Zustandswerte: alter Pfad -> {alter Wert: neuer Wert}; nicht genannte Werte bleiben. */
const WERTE = {
    'regel.zustand': { hand: 'manual', einrichten: 'setup', gestört: 'fault', aus: 'off' },
    'regel.bedarf.zustand': { gestört: 'fault', 'nicht fähig': 'notCapable', aus: 'off' },
    'regel.bedarf.strategie': { kennlinie: 'curve', vortag: 'previousDay' },
    'regel.fuehler.aussenStand': STAND,
    'regel.fuehler.raumStand': STAND,
    'regel.fuehler.feuchteStand': STAND,
    'regel.fuehler.aussenArt': ART,
    'regel.fuehler.raumArt': ART,
    'regel.fuehler.feuchteArt': ART,
    'info.demandFaehig': { unbekannt: 'unknown', ja: 'yes', nein: 'no' },
};

/** Tasten haben keinen Wert, der zu uebernehmen waere. */
const TASTEN = new Set(['regel.hand.aufheben', 'regel.ziel.plus', 'regel.ziel.minus']);

/**
 * Setzt den Wert eines alten Datenpunkts auf den heutigen um.
 *
 * @param {string} altPfad  alter Pfad relativ zum Geraet
 * @param {unknown} wert    alter Wert
 * @returns {unknown} Wert fuer den neuen Datenpunkt
 */
function wertUmsetzen(altPfad, wert) {
    if (altPfad === 'regel.bedarf.zustandJson') {
        // lesen() setzt die gespeicherten Faehigkeitswerte (ja/nein/unbekannt) um; Unlesbares bleibt.
        if (typeof wert !== 'string' || !wert) {
            return wert;
        }
        try {
            JSON.parse(wert);
        } catch {
            return wert;
        }
        return zustandSpeicher.schreiben(zustandSpeicher.lesen(wert));
    }
    const tabelle = WERTE[altPfad];
    return tabelle && typeof wert === 'string' && Object.prototype.hasOwnProperty.call(tabelle, wert)
        ? tabelle[wert]
        : wert;
}

/**
 * Zieht die alten Datenpunkte eines Geraets um.
 *
 * @param {object} a   Adapter
 * @param {string} id  Geraete-ID
 * @returns {Promise<{umgezogen: number, geloescht: boolean, umbenannt: number}>} Zahl der uebernommenen Datenpunkte
 */
async function geraetUmziehen(a, id) {
    const erg = await wurzelUmziehen(a, id);
    const zwischen = await zwischenstandUmziehen(a, id);
    return { umgezogen: erg.umgezogen + zwischen, geloescht: erg.geloescht, umbenannt: zwischen };
}

/**
 * Datenpunkte des Zwischenstands (`schedule.scene`, `schedule.nextScene`) auf die heutigen IDs.
 *
 * @param {object} a   Adapter
 * @param {string} id  Geraete-ID
 * @returns {Promise<number>} Zahl der umbenannten Datenpunkte
 */
async function zwischenstandUmziehen(a, id) {
    const alte = [];
    for (const altPfad of Object.keys(PFADE_ZWISCHEN)) {
        const objekt = await a.getObjectAsync(`${id}.${altPfad}`);
        if (objekt) {
            alte.push({ altPfad, objekt });
        }
    }
    if (!alte.length) {
        return 0;
    }
    const schonDa = new Set();
    for (const { altPfad } of alte) {
        if (await a.getObjectAsync(`${id}.${PFADE_ZWISCHEN[altPfad]}`)) {
            schonDa.add(altPfad);
        }
    }
    await regel.objekteAnlegen(a, id, !!(a.config && a.config.regelAktiv === true));
    for (const { altPfad, objekt } of alte) {
        const neu = `${id}.${PFADE_ZWISCHEN[altPfad]}`;
        const custom = objekt.common && objekt.common.custom;
        if (custom && typeof custom === 'object' && Object.keys(custom).length) {
            const ziel = await a.getObjectAsync(neu);
            if (!(ziel && ziel.common && ziel.common.custom && Object.keys(ziel.common.custom).length)) {
                await a.extendObject(neu, { common: { custom } });
            }
        }
        if (!schonDa.has(altPfad)) {
            const alt = await a.getStateAsync(`${id}.${altPfad}`);
            if (alt && alt.val !== null && alt.val !== undefined) {
                await a.setStateAsync(neu, { val: alt.val, ack: true });
            }
        }
        await a.delObjectAsync(`${id}.${altPfad}`);
    }
    return alte.length;
}

/**
 * Zieht die Datenpunkte unter der alten Wurzel `regel` um.
 *
 * @param {object} a   Adapter
 * @param {string} id  Geraete-ID
 * @returns {Promise<{umgezogen: number, geloescht: boolean}>} Zahl der uebernommenen Datenpunkte
 */
async function wurzelUmziehen(a, id) {
    const alte = [];
    for (const altPfad of Object.keys(PFADE)) {
        const objekt = await a.getObjectAsync(`${id}.${altPfad}`);
        if (objekt) {
            alte.push({ altPfad, objekt });
        }
    }
    const kanalDa = !!(await a.getObjectAsync(`${id}.${ALT_WURZEL}`));
    if (!alte.length && !kanalDa) {
        return { umgezogen: 0, geloescht: false };
    }
    // Was es unter der neuen ID schon gibt, behaelt seinen Wert.
    const schonDa = new Set();
    for (const { altPfad } of alte) {
        if (await a.getObjectAsync(`${id}.${PFADE[altPfad]}`)) {
            schonDa.add(altPfad);
        }
    }
    if (alte.length) {
        await regel.objekteAnlegen(a, id, !!(a.config && a.config.regelAktiv === true));
    }
    let umgezogen = 0;
    for (const { altPfad, objekt } of alte) {
        const neu = `${id}.${PFADE[altPfad]}`;
        const custom = objekt.common && objekt.common.custom;
        if (custom && typeof custom === 'object' && Object.keys(custom).length) {
            const ziel = await a.getObjectAsync(neu);
            if (!(ziel && ziel.common && ziel.common.custom && Object.keys(ziel.common.custom).length)) {
                await a.extendObject(neu, { common: { custom } });
            }
        }
        if (TASTEN.has(altPfad) || schonDa.has(altPfad)) {
            continue;
        }
        const alt = await a.getStateAsync(`${id}.${altPfad}`);
        if (alt && alt.val !== null && alt.val !== undefined) {
            await a.setStateAsync(neu, { val: wertUmsetzen(altPfad, alt.val), ack: true });
            umgezogen++;
        }
    }
    await a.delObjectAsync(`${id}.${ALT_WURZEL}`, { recursive: true });
    if (alte.some(e => e.altPfad === 'info.demandFaehig')) {
        await a.delObjectAsync(`${id}.info.demandFaehig`);
    }
    return { umgezogen, geloescht: true };
}

/**
 * Zieht bei allen Geraeten der Instanz die alten Datenpunkte um. Fehler an einem Geraet halten den
 * Start nicht auf - die alten Objekte bleiben dann stehen und der naechste Start versucht es erneut.
 *
 * @param {object} a  Adapter
 * @returns {Promise<number>} Zahl der umgezogenen Geraete
 */
async function umziehen(a) {
    let geraete;
    try {
        geraete = await a.getDevicesAsync();
    } catch (e) {
        a.log.debug(`Control state migration skipped: ${e.message}`);
        return 0;
    }
    let anzahl = 0;
    for (const geraet of geraete || []) {
        const id = geraet._id.slice(a.namespace.length + 1);
        try {
            const erg = await geraetUmziehen(a, id);
            if (erg.umbenannt) {
                a.log.info(
                    `${id}: ${erg.umbenannt} control states renamed ("schedule.scene" -> "schedule.level"), old objects removed.`,
                );
            }
            if (erg.geloescht) {
                anzahl++;
                const name = (geraet.common && geraet.common.name) || id;
                a.log.info(
                    `${typeof name === 'object' ? name.en || name.de || id : name}: ${erg.umgezogen} control states moved from "${ALT_WURZEL}.*" to "${regel.WURZEL}.*", old objects removed.`,
                );
            }
        } catch (e) {
            a.log.warn(`${id}: control states could not be moved to "${regel.WURZEL}.*" - ${e.message}`);
        }
    }
    return anzahl;
}

module.exports = { umziehen, geraetUmziehen, wertUmsetzen, PFADE, PFADE_ZWISCHEN, WERTE, ALT_WURZEL };
