'use strict';

/**
 * Vorlage oder eigener Wert - die EINE Regel fuer Regelung, Einstellungsseite und Karten
 * (Nutzerentscheid 21.11.2026, Runde 2): Es gibt keinen Haken "individuell" mehr. Je TEIL gilt:
 * hat die Geraetezeile dafuer einen eigenen Wert, gilt er - sonst die globale Vorlage der Instanz.
 * Ein eigener Wert entsteht beim Aendern (Punkt ziehen, Stufe aendern, Auswahl treffen), "Zuruecksetzen"
 * leert ihn wieder.
 *
 * Rein und ohne Abhaengigkeiten: die Einstellungsseite (src-admin) bindet diese Datei ebenfalls ein.
 */

/** Teile einer Geraetezeile und ihre Felder (Reihenfolge = Reihenfolge der Anzeige). */
const TEILE = {
    kennlinieHeizen: ['kennlinieHeizen'],
    kennlinieKuehlen: ['kennlinieKuehlen'],
    grenzen: ['untergrenze', 'obergrenze'],
    stufen: ['stufen'],
    strategie: ['strategie', 'vortagBezug', 'vortagZuschlag', 'vortagReferenzW'],
    feuchte: ['feuchteMassnahme'],
};

/** Felder einer Geraetezeile, die einen Wert der Vorlage ersetzen koennen. */
const VORLAGEN_FELDER = Object.values(TEILE).flat();

/** Leerwert je Feld - so, wie ihn die Einstellungsseite fuer "es gilt die Vorlage" schreibt. */
const LEER = {
    kennlinieHeizen: [],
    kennlinieKuehlen: [],
    stufen: [],
    strategie: '',
    vortagBezug: '',
    feuchteMassnahme: '',
};

/**
 * Hat das Feld einen eigenen Wert? Leer sind: fehlend, null, '', nur Leerzeichen, leere Liste.
 *
 * @param {unknown} v  Wert des Felds
 * @returns {boolean} true = eigener Wert
 */
function gesetzt(v) {
    if (Array.isArray(v)) {
        return v.length > 0;
    }
    return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Welche Teile dieser Zeile sind eigen? Leere Liste = alles aus der Vorlage.
 *
 * @param {object} [zeile]  Zeile aus regelGeraete
 * @returns {string[]} Namen der eigenen Teile (Schluessel von TEILE)
 */
function eigeneTeile(zeile) {
    const z = zeile && typeof zeile === 'object' ? zeile : {};
    return Object.keys(TEILE).filter(teil => TEILE[teil].some(feld => gesetzt(z[feld])));
}

/**
 * Umzug einer Zeile vom Haken `individuell` auf "eigen entsteht beim Aendern" - ohne dass sich das
 * Regelverhalten aendert:
 *   - `individuell: true`: die Geraetewerte galten schon - sie bleiben, nur der Haken entfaellt.
 *   - sonst (false, fehlend, kein Boolean): es galt die Vorlage; gespeicherte Geraetewerte wurden
 *     ignoriert. Sie werden geleert, sonst wuerden sie mit dem Umzug ploetzlich wirksam.
 * Zeilen ohne das Feld `individuell` bleiben mit `nurMitHaken` unberuehrt (Import: eine Datei, die
 * schon im neuen Format geschrieben wurde).
 *
 * @param {object} zeile  Zeile aus regelGeraete
 * @param {{nurMitHaken?: boolean}} [opt]  nurMitHaken: Zeilen ohne das Feld nicht anfassen
 * @returns {{zeile: object, geaendert: boolean, verworfen: string[]}} neue Zeile, ob sie sich aendert, geleerte Felder
 */
function zeileUmziehen(zeile, opt = {}) {
    if (!zeile || typeof zeile !== 'object' || Array.isArray(zeile)) {
        return { zeile, geaendert: false, verworfen: [] };
    }
    const hatHaken = Object.prototype.hasOwnProperty.call(zeile, 'individuell');
    if (!hatHaken && opt.nurMitHaken) {
        return { zeile, geaendert: false, verworfen: [] };
    }
    const z = { ...zeile };
    const verworfen = [];
    if (z.individuell !== true) {
        for (const feld of VORLAGEN_FELDER) {
            if (gesetzt(z[feld])) {
                verworfen.push(feld);
                if (feld in LEER) {
                    z[feld] = Array.isArray(LEER[feld]) ? [] : LEER[feld];
                } else {
                    delete z[feld];
                }
            }
        }
    }
    delete z.individuell;
    return { zeile: z, geaendert: hatHaken || verworfen.length > 0, verworfen };
}

/**
 * Vorgaben einer Geraetezeile - genau die Felder, die die Einstellungsseite mit `default` fuehrt (Geraetekarte
 * in admin/jsonConfig.json; ein Test haelt beide gleich). Fehlt eines davon in einer gespeicherten Zeile,
 * traegt die Seite es beim Oeffnen der Karte selbst ein - dann waere "Speichern" aktiv, ohne dass jemand
 * etwas geaendert hat. Jeder Wert ist der, mit dem die Regelung bei fehlendem Feld ohnehin rechnet.
 */
const ZEILEN_VORGABEN = {
    betrieb: 'adapter',
    aussenQuelle: 'auto',
    raumQuelle: 'auto',
    fuehlerWeg: 'sollwert',
    feuchteQuelle: 'auto',
    feuchteMassnahme: '',
    strategie: '',
    vortagBezug: '',
    frostAb: 0,
};

/**
 * Fehlende Vorgabe-Felder einer Zeile nachtragen (vorhandene Werte bleiben, auch leere Texte und 0).
 *
 * @param {object} zeile  Zeile aus regelGeraete
 * @returns {{zeile: object, geaendert: boolean}} ergaenzte Zeile
 */
function zeileErgaenzen(zeile) {
    if (!zeile || typeof zeile !== 'object' || Array.isArray(zeile)) {
        return { zeile, geaendert: false };
    }
    const z = { ...zeile };
    let geaendert = false;
    for (const [feld, wert] of Object.entries(ZEILEN_VORGABEN)) {
        if (z[feld] === undefined) {
            z[feld] = wert;
            geaendert = true;
        }
    }
    return { zeile: z, geaendert };
}

/**
 * "Auf die Vorlage zuruecksetzen" bei den Temperaturstufen einer Anlage: Welche Stufen benutzt ihr Wochenplan,
 * die es in der Vorlage nicht gibt - und welche Stufe der Vorlage liegt jeweils am naechsten? Eine ausgeschaltete
 * Stufe wird durch eine ausgeschaltete ersetzt, wenn die Vorlage eine hat; sonst zaehlt die Zieltemperatur.
 * Die Einstellungsseite fragt mit diesem Vorschlag nach, bevor sie zuruecksetzt.
 *
 * @param {Array<{id: string, name?: string, power?: boolean, soll?: number}>} eigene  eigene Stufen der Anlage
 * @param {Array<{id: string, name?: string, power?: boolean, soll?: number}>} vorlageStufen  Stufen der Vorlage
 * @param {string[]} planIds  IDs, die der Wochenplan (und die Abwesenheit) der Anlage nennt
 * @returns {Array<{id: string, name: string, ersatz: string}>} betroffene Stufen mit vorgeschlagener Ersatz-ID
 */
function ersatzVorschlag(eigene, vorlageStufen, planIds) {
    const liste = l => (Array.isArray(l) ? l.filter(s => s && typeof s === 'object' && s.id) : []);
    const ziel = liste(vorlageStufen);
    const kennt = new Set(ziel.map(s => String(s.id)));
    const zahl = v => (Number.isFinite(Number(v)) ? Number(v) : 20);
    const aus = [];
    for (const id of [...new Set((Array.isArray(planIds) ? planIds : []).map(String))]) {
        if (!id || kennt.has(id) || !ziel.length) {
            continue;
        }
        const s = liste(eigene).find(x => String(x.id) === id) || { id, name: id };
        const istAus = s.power === false;
        const gleicheArt = ziel.filter(z => (z.power === false) === istAus);
        // ohne passende Art (z. B. keine "Aus"-Stufe in der Vorlage): die kaelteste bzw. naechstliegende
        const wahl = (gleicheArt.length ? gleicheArt : ziel).reduce((a, b) =>
            Math.abs(zahl(b.soll) - zahl(s.soll)) < Math.abs(zahl(a.soll) - zahl(s.soll)) ? b : a,
        );
        aus.push({ id, name: String(s.name || id), ersatz: String(wahl.id) });
    }
    return aus;
}

module.exports = {
    TEILE,
    VORLAGEN_FELDER,
    LEER,
    ZEILEN_VORGABEN,
    gesetzt,
    eigeneTeile,
    zeileUmziehen,
    zeileErgaenzen,
    ersatzVorschlag,
};
