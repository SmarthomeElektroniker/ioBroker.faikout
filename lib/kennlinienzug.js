'use strict';

/**
 * Stuetzpunkte einer Kennlinie mit der Maus oder den Pfeiltasten verschieben - reine Funktionen
 * ohne Zustand, ohne Adapter und ohne Browser. Die Einstellungsseite (src-admin/src/Kennlinie.tsx)
 * nutzt genau diese Funktionen; die Tests pruefen sie ohne Oberflaeche.
 *
 * Regeln der Kennlinie (wie kennliniePruefen in lib/oberflaeche.js):
 *  - mindestens zwei Punkte, x (Aussentemperatur) streng aufsteigend
 *  - Heizen: y (Leistung) faellt mit x oder bleibt gleich; Kuehlen: y steigt mit x oder bleibt gleich
 *  - y zwischen 0 und 100
 *
 * Beim Ziehen rastet x auf 1 °C und y auf 5 %. Die Nachbarpunkte begrenzen den Weg - ein gezogener
 * Punkt kann die Kennlinie also nie ungueltig machen.
 *
 * Dazu die beiden Leistungsgrenzen als waagerechte Linien (5-%-Raster): Untergrenze 30 ... Obergrenze,
 * Obergrenze Untergrenze ... 100 - dieselbe Regel wie in lib/regel/bedarf.js.
 */

/** Raster beim Ziehen und fuer die Pfeiltasten. */
const RASTER = { x: 1, y: 5 };

/** Erlaubter Bereich der Stuetzpunkte (wie die Felder der Einstellungsseite). */
const GRENZEN = { xMin: -40, xMax: 50, yMin: 0, yMax: 100 };

/** Raster und Bereich der beiden Leistungsgrenzen (Unter-/Obergrenze). */
const GRENZLINIE = { raster: 5, min: 30, max: 100 };

/** Werksvorgabe der Leistungsgrenzen (wie regelUntergrenze/regelObergrenze der Instanz). */
const VORGABE_GRENZEN = { untergrenze: 40, obergrenze: 100 };

/** Werksvorgaben - dieselben Punkte wie lib/regel/kennlinie.js (dort als [[x, y], ...]). */
const VORGABE = {
    heizen: [
        { x: -10, y: 100 },
        { x: 0, y: 75 },
        { x: 7, y: 55 },
        { x: 15, y: 40 },
    ],
    kuehlen: [
        { x: 25, y: 40 },
        { x: 30, y: 65 },
        { x: 35, y: 95 },
    ],
};

const istLeer = v => v === undefined || v === null || v === '';

/**
 * Zahl aus einem Tabellenfeld: leer und Unlesbares werden NaN (nicht 0 - ein leeres Feld ist ein
 * Eingabefehler und kein Punkt bei 0).
 *
 * @param {unknown} v  Feldwert
 * @returns {number} Zahl oder NaN
 */
function zahl(v) {
    if (typeof v === 'number') {
        return v;
    }
    if (istLeer(v) || typeof v !== 'string' || !v.trim()) {
        return NaN;
    }
    return Number(v.trim().replace(',', '.'));
}

/**
 * Zeilen der Tabelle als Punkte {x, y} in der Reihenfolge der Tabelle (nichts wird sortiert oder
 * verworfen - die Zeilennummer bleibt die Nummer des Punktes).
 *
 * @param {unknown} roh  [{x, y}, ...] oder [[x, y], ...]
 * @returns {{x: number, y: number}[]} Punkte
 */
function punkte(roh) {
    return (Array.isArray(roh) ? roh : []).map(p =>
        Array.isArray(p) ? { x: zahl(p[0]), y: zahl(p[1]) } : { x: zahl(p && p.x), y: zahl(p && p.y) },
    );
}

/**
 * Prueft die Punkte und nennt den ersten Fehler als Schluessel (dieselben Schluessel wie
 * kennliniePruefen in lib/oberflaeche.js - die Texte dazu stehen in den Sprachdateien).
 *
 * @param {{x: number, y: number}[]} p  Punkte
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @returns {{schluessel: string, n?: number}|null} Fehler oder null
 */
function pruefen(p, richtung) {
    if (!Array.isArray(p) || p.length < 2) {
        return { schluessel: 'fZuWenig' };
    }
    for (let i = 0; i < p.length; i++) {
        const { x, y } = p[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { schluessel: 'fZahl', n: i + 1 };
        }
        if (y < GRENZEN.yMin || y > GRENZEN.yMax) {
            return { schluessel: 'fBereich', n: i + 1 };
        }
        if (i > 0) {
            if (x <= p[i - 1].x) {
                return { schluessel: 'fAufsteigend' };
            }
            if (richtung !== 'kuehlen' && y > p[i - 1].y) {
                return { schluessel: 'fFallend' };
            }
            if (richtung === 'kuehlen' && y < p[i - 1].y) {
                return { schluessel: 'fSteigend' };
            }
        }
    }
    return null;
}

/**
 * Wohin der Punkt i darf: die Nachbarn begrenzen x (streng aufsteigend, im Raster) und y (monoton
 * in der Richtung der Kennlinie).
 *
 * @param {{x: number, y: number}[]} p  gueltige Punkte
 * @param {number} i  Nummer des Punktes (ab 0)
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @returns {{xMin: number, xMax: number, yMin: number, yMax: number}} erlaubter Bereich
 */
function bereich(p, i, richtung) {
    const davor = i > 0 ? p[i - 1] : null;
    const danach = i < p.length - 1 ? p[i + 1] : null;
    // naechster Rasterwert echt hinter dem linken und echt vor dem rechten Nachbarn
    const xMin = davor ? Math.max(GRENZEN.xMin, Math.floor(davor.x / RASTER.x) * RASTER.x + RASTER.x) : GRENZEN.xMin;
    const xMax = danach ? Math.min(GRENZEN.xMax, Math.ceil(danach.x / RASTER.x) * RASTER.x - RASTER.x) : GRENZEN.xMax;
    const links = davor ? davor.y : null;
    const rechts = danach ? danach.y : null;
    const kuehlen = richtung === 'kuehlen';
    const oben = kuehlen ? rechts : links;
    const unten = kuehlen ? links : rechts;
    return {
        xMin,
        xMax,
        yMin: unten === null ? GRENZEN.yMin : Math.max(GRENZEN.yMin, unten),
        yMax: oben === null ? GRENZEN.yMax : Math.min(GRENZEN.yMax, oben),
    };
}

const rasten = (wert, raster) => Math.round(wert / raster) * raster;
const klemmen = (wert, min, max) => Math.min(max, Math.max(min, wert));

/**
 * Setzt den Punkt i auf die gewuenschte Stelle - gerastet und von den Nachbarn begrenzt. Ist
 * zwischen den Nachbarn kein Rasterwert frei, bleibt die Achse unveraendert.
 *
 * @param {{x: number, y: number}[]} p  gueltige Punkte
 * @param {number} i  Nummer des Punktes (ab 0)
 * @param {{x: number, y: number}} ziel  gewuenschte Stelle (beliebige Zahlen)
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @param {{xMin?: number, xMax?: number}} [rahmen]  zusaetzliche Grenze fuer x (sichtbare Achse)
 * @returns {{x: number, y: number}[]} neue Liste (die alte bleibt unveraendert)
 */
function ziehen(p, i, ziel, richtung, rahmen = {}) {
    const neu = p.map(q => ({ x: q.x, y: q.y }));
    if (!neu[i] || !ziel) {
        return neu;
    }
    const b = bereich(neu, i, richtung);
    const xMin = Math.max(b.xMin, Number.isFinite(rahmen.xMin) ? Math.ceil(rahmen.xMin) : b.xMin);
    const xMax = Math.min(b.xMax, Number.isFinite(rahmen.xMax) ? Math.floor(rahmen.xMax) : b.xMax);
    if (Number.isFinite(ziel.x) && xMin <= xMax) {
        neu[i].x = klemmen(rasten(ziel.x, RASTER.x), xMin, xMax);
    }
    if (Number.isFinite(ziel.y) && b.yMin <= b.yMax) {
        neu[i].y = klemmen(rasten(ziel.y, RASTER.y), b.yMin, b.yMax);
    }
    return neu;
}

/**
 * Pfeiltasten: der Punkt i geht um ganze Rasterschritte weiter (links/rechts 1 °C, hoch/runter 5 %).
 * Ein Wert neben dem Raster rastet beim ersten Schritt in Laufrichtung ein.
 *
 * @param {{x: number, y: number}[]} p  gueltige Punkte
 * @param {number} i  Nummer des Punktes (ab 0)
 * @param {number} dx  Schritte nach rechts (negativ: links)
 * @param {number} dy  Schritte nach oben (negativ: unten)
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @returns {{x: number, y: number}[]} neue Liste
 */
function schritt(p, i, dx, dy, richtung) {
    if (!p[i]) {
        return p.map(q => ({ x: q.x, y: q.y }));
    }
    const weiter = (wert, n, raster) => {
        if (!n) {
            return NaN;
        }
        const unten = Math.floor(wert / raster) * raster;
        const aufRaster = unten === wert;
        if (n > 0) {
            return unten + n * raster;
        }
        return aufRaster ? wert + n * raster : unten + (n + 1) * raster;
    };
    return ziehen(p, i, { x: weiter(p[i].x, dx, RASTER.x), y: weiter(p[i].y, dy, RASTER.y) }, richtung);
}

/**
 * Neuer Punkt: mitten in die groesste Luecke der Aussentemperatur, die Leistung zwischen den
 * Nachbarn - die Kennlinie bleibt gueltig. Ohne Luecke kommt er aussen an (5 K weiter, gleiche
 * Leistung). Geht auch das nicht, bleibt die Liste, wie sie ist.
 *
 * @param {{x: number, y: number}[]} p  gueltige Punkte
 * @returns {{punkte: {x: number, y: number}[], neu: number}} neue Liste und Nummer des neuen Punktes (-1: keiner)
 */
function hinzu(p) {
    const liste = p.map(q => ({ x: q.x, y: q.y }));
    let beste = -1;
    let weite = 0;
    for (let i = 1; i < liste.length; i++) {
        const w = liste[i].x - liste[i - 1].x;
        // nur Luecken, in denen ein Rasterwert echt zwischen den Nachbarn liegt
        if (w > weite && Math.floor(liste[i - 1].x) + 1 <= Math.ceil(liste[i].x) - 1) {
            weite = w;
            beste = i;
        }
    }
    if (beste > 0) {
        const a = liste[beste - 1];
        const b = liste[beste];
        const x = klemmen(Math.round((a.x + b.x) / 2), Math.floor(a.x) + 1, Math.ceil(b.x) - 1);
        const y = klemmen(rasten((a.y + b.y) / 2, RASTER.y), Math.min(a.y, b.y), Math.max(a.y, b.y));
        liste.splice(beste, 0, { x, y });
        return { punkte: liste, neu: beste };
    }
    const letzter = liste[liste.length - 1];
    if (letzter && letzter.x + 1 <= GRENZEN.xMax) {
        liste.push({ x: Math.min(GRENZEN.xMax, Math.floor(letzter.x) + 5), y: letzter.y });
        return { punkte: liste, neu: liste.length - 1 };
    }
    const erster = liste[0];
    if (erster && erster.x - 1 >= GRENZEN.xMin) {
        liste.unshift({ x: Math.max(GRENZEN.xMin, Math.ceil(erster.x) - 5), y: erster.y });
        return { punkte: liste, neu: 0 };
    }
    return { punkte: liste, neu: -1 };
}

/**
 * Neuer Punkt an einer bestimmten Stelle (Doppelklick ins Bild): x und y rasten ein, die Nachbarn
 * begrenzen die Leistung wie beim Ziehen. Liegt an der Stelle schon ein Punkt, rueckt der neue um
 * einen Rasterschritt zur Seite des Klicks; ist auch dort nichts frei, bleibt die Liste, wie sie ist.
 *
 * @param {{x: number, y: number}[]} p  gueltige Punkte
 * @param {{x: number, y: number}} ziel  gewuenschte Stelle (beliebige Zahlen)
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @param {{xMin?: number, xMax?: number}} [rahmen]  zusaetzliche Grenze fuer x (sichtbare Achse)
 * @returns {{punkte: {x: number, y: number}[], neu: number}} neue Liste und Nummer des neuen Punktes (-1: keiner)
 */
function einfuegen(p, ziel, richtung, rahmen = {}) {
    const liste = p.map(q => ({ x: q.x, y: q.y }));
    if (!ziel || !Number.isFinite(ziel.x) || !Number.isFinite(ziel.y)) {
        return { punkte: liste, neu: -1 };
    }
    const xMin = Math.max(GRENZEN.xMin, Number.isFinite(rahmen.xMin) ? Math.ceil(rahmen.xMin) : GRENZEN.xMin);
    const xMax = Math.min(GRENZEN.xMax, Number.isFinite(rahmen.xMax) ? Math.floor(rahmen.xMax) : GRENZEN.xMax);
    if (xMin > xMax) {
        return { punkte: liste, neu: -1 };
    }
    const frei = x => x >= xMin && x <= xMax && !liste.some(q => q.x === x);
    const mitte = klemmen(rasten(ziel.x, RASTER.x), xMin, xMax);
    // besetzt: erst zur Seite des Klicks ausweichen, dann zur anderen
    const seite = ziel.x >= mitte ? RASTER.x : -RASTER.x;
    const x = [mitte, mitte + seite, mitte - seite].find(frei);
    if (x === undefined) {
        return { punkte: liste, neu: -1 };
    }
    const i = liste.filter(q => q.x < x).length;
    liste.splice(i, 0, { x, y: 0 });
    const b = bereich(liste, i, richtung);
    liste[i].y = klemmen(rasten(ziel.y, RASTER.y), b.yMin, b.yMax);
    return { punkte: liste, neu: i };
}

/**
 * Punkt entfernen (Rechtsklick oder Entf). Zwei Punkte bleiben immer - darunter gibt es keine Kennlinie.
 *
 * @param {{x: number, y: number}[]} p  Punkte
 * @param {number} i  Nummer des Punktes (ab 0)
 * @returns {{punkte: {x: number, y: number}[], entfernt: boolean}} neue Liste und ob etwas entfernt wurde
 */
function entfernen(p, i) {
    const liste = p.map(q => ({ x: q.x, y: q.y }));
    if (liste.length <= 2 || !Number.isInteger(i) || i < 0 || i >= liste.length) {
        return { punkte: liste, entfernt: false };
    }
    liste.splice(i, 1);
    return { punkte: liste, entfernt: true };
}

/**
 * Sind die beiden Leistungsgrenzen zulaessig? (30 <= Untergrenze <= Obergrenze <= 100)
 *
 * @param {number} untergrenze  Untergrenze in %
 * @param {number} obergrenze  Obergrenze in %
 * @returns {boolean} zulaessig
 */
function grenzenGueltig(untergrenze, obergrenze) {
    return untergrenze >= GRENZLINIE.min && untergrenze <= obergrenze && obergrenze <= GRENZLINIE.max;
}

/**
 * Wohin eine Grenzlinie darf: die Untergrenze von 30 % bis zur Obergrenze, die Obergrenze von der
 * Untergrenze bis 100 % - jeweils auf dem 5-%-Raster (eine krumme Gegenlinie zaehlt nach innen).
 *
 * @param {'unter'|'ober'} welche  Linie
 * @param {{untergrenze: number, obergrenze: number}} grenzen  aktueller Stand
 * @returns {{min: number, max: number}} erlaubter Bereich (min > max: nichts frei)
 */
function grenzBereich(welche, grenzen) {
    const r = GRENZLINIE.raster;
    const unter = Number.isFinite(grenzen.untergrenze) ? grenzen.untergrenze : GRENZLINIE.min;
    const ober = Number.isFinite(grenzen.obergrenze) ? grenzen.obergrenze : GRENZLINIE.max;
    return welche === 'ober'
        ? { min: Math.max(GRENZLINIE.min, Math.ceil(unter / r) * r), max: GRENZLINIE.max }
        : { min: GRENZLINIE.min, max: Math.min(GRENZLINIE.max, Math.floor(ober / r) * r) };
}

/**
 * Zieht eine Grenzlinie auf die gewuenschte Hoehe - gerastet und von der anderen Linie begrenzt.
 *
 * @param {'unter'|'ober'} welche  Linie
 * @param {number} ziel  gewuenschte Leistung in % (beliebige Zahl)
 * @param {{untergrenze: number, obergrenze: number}} grenzen  aktueller Stand
 * @returns {number} neuer Wert der Linie (unveraendert, wenn nichts frei ist)
 */
function grenzeZiehen(welche, ziel, grenzen) {
    const alt = welche === 'ober' ? grenzen.obergrenze : grenzen.untergrenze;
    const b = grenzBereich(welche, grenzen);
    if (!Number.isFinite(ziel) || b.min > b.max) {
        return alt;
    }
    return klemmen(rasten(ziel, GRENZLINIE.raster), b.min, b.max);
}

/**
 * Pfeiltasten an einer Grenzlinie: n Rasterschritte (5 %) nach oben, negativ nach unten. Ein Wert
 * neben dem Raster rastet beim ersten Schritt in Laufrichtung ein.
 *
 * @param {'unter'|'ober'} welche  Linie
 * @param {number} n  Schritte
 * @param {{untergrenze: number, obergrenze: number}} grenzen  aktueller Stand
 * @returns {number} neuer Wert der Linie
 */
function grenzeSchritt(welche, n, grenzen) {
    const alt = welche === 'ober' ? grenzen.obergrenze : grenzen.untergrenze;
    if (!n || !Number.isFinite(alt)) {
        return alt;
    }
    const r = GRENZLINIE.raster;
    const unten = Math.floor(alt / r) * r;
    const ziel = n > 0 ? unten + n * r : unten === alt ? alt + n * r : unten + (n + 1) * r;
    return grenzeZiehen(welche, ziel, grenzen);
}

/**
 * Inhalt der Zwischenablage fuer eine Kennlinie pruefen: Punkte (gueltig fuer die Richtung) und die
 * beiden Grenzen. Unbrauchbare Grenzen fallen weg, eine unbrauchbare Kennlinie ergibt null.
 *
 * @param {unknown} inhalt  {punkte: [{x, y}, ...], untergrenze, obergrenze}
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @returns {{punkte: {x: number, y: number}[], untergrenze: number|null, obergrenze: number|null}|null} gepruefter Inhalt
 */
function inhaltLesen(inhalt, richtung) {
    if (!inhalt || typeof inhalt !== 'object') {
        return null;
    }
    const p = punkte(inhalt.punkte);
    if (pruefen(p, richtung)) {
        return null;
    }
    const unter = zahl(inhalt.untergrenze);
    const ober = zahl(inhalt.obergrenze);
    const gut = grenzenGueltig(unter, ober);
    return { punkte: p, untergrenze: gut ? unter : null, obergrenze: gut ? ober : null };
}

/**
 * Zahl mit fester Zahl von Nachkommastellen (z. B. "−4,0"): Dezimalzeichen der Sprache, echtes Minus.
 *
 * @param {number} n  Zahl
 * @param {number} stellen  Nachkommastellen
 * @param {string} [sprache]  Sprache der Oberflaeche (de, en, ...)
 * @returns {string} Text
 */
function anzeigeFest(n, stellen, sprache) {
    const faktor = Math.pow(10, stellen);
    // -0,04 wird 0,0 und nicht −0,0
    const rund = Math.round(Number(n) * faktor) / faktor || 0;
    let text;
    try {
        text = new Intl.NumberFormat(sprache || 'en', {
            minimumFractionDigits: stellen,
            maximumFractionDigits: stellen,
            useGrouping: false,
        }).format(rund);
    } catch {
        text = rund.toFixed(stellen);
    }
    return text.replace(/^-/, '−');
}

/**
 * Zahl fuer die Anzeige: Dezimalzeichen der Sprache, echtes Minus, hoechstens eine Nachkommastelle.
 *
 * @param {number} n  Zahl
 * @param {string} [sprache]  Sprache der Oberflaeche (de, en, ...)
 * @returns {string} Text
 */
function anzeige(n, sprache) {
    const rund = Math.round(Number(n) * 10) / 10;
    let text;
    try {
        text = new Intl.NumberFormat(sprache || 'en', { maximumFractionDigits: 1, useGrouping: false }).format(rund);
    } catch {
        text = String(rund);
    }
    return text.replace(/^-/, '−');
}

/**
 * Etikett am gezogenen Punkt, z. B. "−5 °C · 85 %".
 *
 * @param {{x: number, y: number}} p  Punkt
 * @param {string} [sprache]  Sprache der Oberflaeche
 * @returns {string} Text
 */
function etikett(p, sprache) {
    return einheitFest(`${anzeige(p.x, sprache)} °C · ${anzeige(p.y, sprache)} %`);
}

/**
 * Geschuetztes Leerzeichen (U+00A0) zwischen Zahl und Einheit - dieselbe Regel wie
 * widgets/faikout/js/kennlinienbild.js (dort beschrieben; der Test "sprachen" haelt beide gleich).
 * Hier eigens, weil die Komponenten der Einstellungsseite nur dieses Modul einbinden.
 */
const EINHEIT_MUSTER =
    '(\\d) (?=(?:°C|°F|%|kWh|Wh|kW|W|K|dBm|Hz|ms|min|h|s|кВт·ч|Вт|дБм|мин|хв|год|ч|с|分钟|小时|秒)(?![A-Za-z0-9À-ɏЀ-ӿ一-鿿]))';
const EINHEIT_RE = new RegExp(EINHEIT_MUSTER, 'g');

/**
 * Text fuer die Anzeige: geschuetztes Leerzeichen zwischen Zahl und Einheit.
 *
 * @param {unknown} text  Text
 * @returns {string} Text mit U+00A0 zwischen Zahl und Einheit
 */
function einheitFest(text) {
    return String(text === undefined || text === null ? '' : text).replace(EINHEIT_RE, '$1\u00a0');
}

module.exports = {
    RASTER,
    GRENZEN,
    GRENZLINIE,
    VORGABE,
    VORGABE_GRENZEN,
    zahl,
    punkte,
    pruefen,
    bereich,
    ziehen,
    schritt,
    hinzu,
    einfuegen,
    entfernen,
    grenzenGueltig,
    grenzBereich,
    grenzeZiehen,
    grenzeSchritt,
    inhaltLesen,
    anzeige,
    anzeigeFest,
    etikett,
    EINHEIT_MUSTER,
    einheitFest,
};
