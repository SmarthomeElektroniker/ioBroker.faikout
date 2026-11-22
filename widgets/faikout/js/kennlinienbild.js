/*
 * Bilder der Klimaregelung als SVG-Text - EINE Quelle fuer Adapter und VIS-Baustein.
 * Im Adapter laedt lib/kennlinienbild.js diese Datei (require), in VIS steht sie als
 * window.faikoutKennlinienbild bereit (eingebunden in widgets/faikout.html).
 */
(function (wurzel, fabrik) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = fabrik();
    } else {
        wurzel.faikoutKennlinienbild = fabrik();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';


/**
 * Bilder der Klimaregelung als SVG-Text - reine Funktionen ohne Zustand und ohne Adapter.
 *
 *  - kennlinie(): Heiz- oder Kuehlkennlinie mit Stuetzpunkten, den Zonen unter der Untergrenze und
 *    ueber der Obergrenze und (wenn bekannt) dem aktuellen Arbeitspunkt
 *  - verlauf():   gesendete Leistungsgrenze der letzten 24 Stunden als Treppenlinie
 *  - balken():    Leistungsgrenze als Stufenbalken (30..100 % in 5-%-Stufen)
 *
 * HELL UND DUNKEL: Achsen, Raster und Schrift nehmen `currentColor` - eingebettet in die Seite
 * (inline-SVG in einem HTML-Text des Admins) erben sie die Schriftfarbe des Themas. Die Akzentfarben
 * sind so gewaehlt, dass sie auf hellem wie dunklem Grund tragen. Als eigenstaendiges Bild (<img>,
 * data:-URL) gibt es kein currentColor der Seite - dafuer `farbe` setzen.
 */

/** Akzentfarben: Heizen warm, Kuehlen kalt - beide mit genug Kontrast auf Weiss und auf #1e1e1e. */
const FARBEN = { heizen: '#d2562f', kuehlen: '#2b86c9' };

const esc = s =>
    String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const r1 = n => Math.round(n * 10) / 10;

/**
 * Zahl und Einheit gehoeren zusammen: das Leerzeichen zwischen einer Ziffer und einer Einheit ("21,5 °C",
 * "60 %", "270 W", "0,03 kWh", "0,5 K", "10 min") wird ein geschuetztes (U+00A0) - sonst bricht die Zeile
 * dazwischen um und "°C" steht allein (Nutzerfund 22.11.2026). EINE Regel fuer alle Oberflaechen; dieselbe
 * Zeichenkette steht in lib/kennlinienzug.js fuer die Einstellungsseite (Test: sprachen).
 * Bewusst ohne Unicode-Klassen und u-Schalter: alte Browser der VIS-Tafeln kennen das nicht.
 * Nur fuer die ANZEIGE - Datenpunktwerte und Logs behalten das gewoehnliche Leerzeichen.
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
const einheitFest = text => String(text === undefined || text === null ? '' : text).replace(EINHEIT_RE, '$1\u00a0');

/** Sprachen mit Punkt als Dezimalzeichen; alle anderen der elf schreiben ein Komma. */
const PUNKT_SPRACHEN = ['en', 'zh-cn'];

/**
 * Zahl in Anzeigeform: Dezimalzeichen der Sprache (Englisch und Chinesisch Punkt, sonst Komma),
 * echtes Minus. Ohne Sprache gilt das Komma.
 *
 * @param {number} n  Zahl
 * @param {number} [stellen]  Nachkommastellen
 * @param {string} [sprache]  Sprachkuerzel
 */
const zahl = (n, stellen = 0, sprache = '') => {
    const text = r1(Number(n)).toFixed(stellen).replace('-', '−');
    return PUNKT_SPRACHEN.indexOf(sprache) >= 0 ? text : text.replace('.', ',');
};

/**
 * Wert der stueckweise linearen Kennlinie (Enden waagerecht) - wie lib/regel/kennlinie.wert, hier
 * noch einmal, damit das Bild auch im Browser (VIS) ohne die Regelung auskommt.
 *
 * @param {number[][]} punkte  Stuetzpunkte [[x, y], ...], x aufsteigend
 * @param {number} x  Aussentemperatur
 * @returns {number} Prozent
 */
function wertAuf(punkte, x) {
    if (x <= punkte[0][0]) {
        return punkte[0][1];
    }
    const letzter = punkte[punkte.length - 1];
    if (x >= letzter[0]) {
        return letzter[1];
    }
    for (let i = 1; i < punkte.length; i++) {
        if (x <= punkte[i][0]) {
            const [x0, y0] = punkte[i - 1];
            const [x1, y1] = punkte[i];
            return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
    }
    return letzter[1];
}

/**
 * Brauchbare Stuetzpunkte aus beliebiger Eingabe: nur endliche Zahlen, nach x sortiert.
 *
 * @param {unknown} roh  [[x, y], ...] oder [{x, y}, ...]
 * @returns {number[][]} Punkte
 */
function punkteSaeubern(roh) {
    return (Array.isArray(roh) ? roh : [])
        .map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p && p.x), Number(p && p.y)]))
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
        .sort((a, b) => a[0] - b[0]);
}

/**
 * Achsenbereich der Aussentemperatur: die Stuetzpunkte mit 5 K Rand, auf 5er-Schritte gerundet,
 * erweitert um den Arbeitspunkt.
 *
 * @param {number[][]} punkte  Stuetzpunkte
 * @param {number|null} [x]  Arbeitspunkt
 * @returns {{min: number, max: number, schritt: number}} Bereich
 */
function achse(punkte, x) {
    const xs = punkte.map(p => p[0]);
    if (Number.isFinite(x)) {
        xs.push(x);
    }
    let min = Math.floor((Math.min(...xs) - 3) / 5) * 5;
    let max = Math.ceil((Math.max(...xs) + 3) / 5) * 5;
    if (max - min < 10) {
        min -= 5;
        max += 5;
    }
    return { min, max, schritt: max - min > 45 ? 10 : 5 };
}

/**
 * Kennlinie als SVG.
 *
 * @param {object} o  Angaben
 * @param {unknown} o.punkte  Stuetzpunkte [[°C, %], ...] oder [{x, y}, ...]
 * @param {'heizen'|'kuehlen'} [o.richtung]  bestimmt die Farbe
 * @param {number} [o.untergrenze]  Untergrenze in %
 * @param {number} [o.obergrenze]  Obergrenze in %
 * @param {{x: number, wert?: number|null, text?: string, unterzeile?: string}|null} [o.arbeitspunkt]  Arbeitspunkt
 * @param {{untergrenze?: string, obergrenze?: string, titel?: string, leer?: string}} [o.texte]  Beschriftungen
 * @param {number} [o.breite]  Breite der Zeichenflaeche (viewBox)
 * @param {number} [o.hoehe]  Hoehe der Zeichenflaeche (viewBox)
 * @param {boolean} [o.kompakt]  ohne Achsenbeschriftung (Kachel)
 * @param {string} [o.farbe]  feste Schriftfarbe statt currentColor (fuer <img>)
 * @param {boolean} [o.blass]  Kennlinie gedaempft (Regelung ruht)
 * @param {string} [o.sprache]  Sprache der Zahlen (Dezimalzeichen)
 * @returns {string} SVG
 */
function kennlinie(o) {
    const B = o.breite || 640;
    const H = o.hoehe || 300;
    const kompakt = !!o.kompakt;
    const rand = kompakt ? { l: 4, r: 4, o: 6, u: 6 } : { l: 44, r: 14, o: o.texte && o.texte.titel ? 30 : 12, u: 28 };
    const fg = o.farbe || 'currentColor';
    const akzent = FARBEN[o.richtung === 'kuehlen' ? 'kuehlen' : 'heizen'];
    const texte = o.texte || {};
    const punkte = punkteSaeubern(o.punkte);
    const kopf =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${B} ${H}" role="img" ` +
        `style="display:block;width:100%;height:auto;max-width:${B}px;font-family:inherit" ` +
        `font-size="11" fill="${fg}">`;
    if (punkte.length < 2) {
        return (
            `${kopf}<rect x="0.5" y="0.5" width="${B - 1}" height="${H - 1}" rx="6" fill="none" stroke="${fg}" stroke-opacity="0.25"/>` +
            `<text x="${B / 2}" y="${H / 2}" text-anchor="middle" fill-opacity="0.7">${esc(texte.leer || '–')}</text></svg>`
        );
    }
    const ap = o.arbeitspunkt && Number.isFinite(Number(o.arbeitspunkt.x)) ? o.arbeitspunkt : null;
    const a = achse(punkte, ap ? Number(ap.x) : null);
    const w = B - rand.l - rand.r;
    const h = H - rand.o - rand.u;
    const X = x => r1(rand.l + ((x - a.min) / (a.max - a.min)) * w);
    const Y = y => r1(rand.o + (1 - Math.min(100, Math.max(0, y)) / 100) * h);
    const teile = [kopf];
    if (texte.titel) {
        teile.push(`<text x="${rand.l}" y="16" font-size="13" font-weight="600">${esc(texte.titel)}</text>`);
    }
    // Raster und Achsenbeschriftung
    if (!kompakt) {
        for (const y of [0, 25, 50, 75, 100]) {
            teile.push(
                `<line x1="${rand.l}" x2="${B - rand.r}" y1="${Y(y)}" y2="${Y(y)}" stroke="${fg}" stroke-opacity="${y ? 0.12 : 0.35}"/>`,
                `<text x="${rand.l - 6}" y="${Y(y) + 4}" text-anchor="end" fill-opacity="0.7">${y} %</text>`,
            );
        }
        for (let x = a.min; x <= a.max; x += a.schritt) {
            teile.push(
                `<line x1="${X(x)}" x2="${X(x)}" y1="${Y(0)}" y2="${Y(0) + 4}" stroke="${fg}" stroke-opacity="0.35"/>`,
                `<text x="${X(x)}" y="${H - 8}" text-anchor="middle" fill-opacity="0.7">${zahl(x, 0, o.sprache)}${x + a.schritt > a.max ? ' °C' : ''}</text>`,
            );
        }
    }
    // Zonen: unter der Untergrenze und ueber der Obergrenze regelt der Adapter nicht
    const unter = Number.isFinite(Number(o.untergrenze)) ? Number(o.untergrenze) : null;
    const ober = Number.isFinite(Number(o.obergrenze)) ? Number(o.obergrenze) : null;
    const zone = (von, bis) =>
        `<rect x="${rand.l}" y="${Y(bis)}" width="${w}" height="${r1(Y(von) - Y(bis))}" fill="${fg}" fill-opacity="0.08"/>`;
    const grenze = (y, text, oben) =>
        `<line x1="${rand.l}" x2="${B - rand.r}" y1="${Y(y)}" y2="${Y(y)}" stroke="${fg}" stroke-opacity="0.55" stroke-dasharray="5 4"/>${
            kompakt || !text
                ? ''
                : `<text x="${B - rand.r - 4}" y="${Y(y) + (oben ? 13 : -5)}" text-anchor="end" fill-opacity="0.75">${esc(text)} ${zahl(y, 0, o.sprache)} %</text>`
        }`;
    if (unter !== null && unter > 0) {
        teile.push(zone(0, unter));
    }
    if (ober !== null && ober < 100) {
        teile.push(zone(ober, 100));
    }
    // Flaeche und Linie der Kennlinie (Enden waagerecht bis zum Rand)
    const linie = [[a.min, punkte[0][1]], ...punkte, [a.max, punkte[punkte.length - 1][1]]];
    const pfad = linie.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x)} ${Y(y)}`).join(' ');
    const deck = o.blass ? 0.45 : 1;
    teile.push(
        `<path d="${pfad} L${X(a.max)} ${Y(0)} L${X(a.min)} ${Y(0)} Z" fill="${akzent}" fill-opacity="${o.blass ? 0.06 : 0.12}"/>`,
        `<path d="${pfad}" fill="none" stroke="${akzent}" stroke-opacity="${deck}" stroke-width="${kompakt ? 2 : 2.4}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    if (unter !== null) {
        teile.push(grenze(unter, texte.untergrenze, false));
    }
    if (ober !== null) {
        teile.push(grenze(ober, texte.obergrenze, true));
    }
    if (!kompakt) {
        for (const [x, y] of punkte) {
            teile.push(
                `<circle cx="${X(x)}" cy="${Y(y)}" r="4.5" fill="${akzent}" fill-opacity="0.18" stroke="${akzent}" stroke-width="2"/>`,
            );
        }
    }
    // Arbeitspunkt: Stelle auf der Kennlinie (Ring) und der Wert, der daraus wird (Punkt)
    if (ap) {
        const x = Math.min(a.max, Math.max(a.min, Number(ap.x)));
        const aufLinie = wertAuf(punkte, x);
        const wert = Number.isFinite(Number(ap.wert)) && ap.wert !== null ? Number(ap.wert) : null;
        teile.push(
            `<line x1="${X(x)}" x2="${X(x)}" y1="${Y(100)}" y2="${Y(0)}" stroke="${fg}" stroke-opacity="0.5" stroke-dasharray="2 3"/>`,
            `<circle cx="${X(x)}" cy="${Y(aufLinie)}" r="${kompakt ? 4 : 5.5}" fill="none" stroke="${akzent}" stroke-width="2"/>`,
        );
        if (wert !== null) {
            teile.push(
                `<line x1="${X(x)}" x2="${X(x)}" y1="${Y(aufLinie)}" y2="${Y(wert)}" stroke="${fg}" stroke-width="1.5"/>`,
                `<circle cx="${X(x)}" cy="${Y(wert)}" r="${kompakt ? 4 : 5}" fill="${fg}"/>`,
            );
        }
        if (!kompakt && ap.text) {
            // Beschriftung links vom Punkt, wenn rechts kein Platz ist
            const links = X(x) > rand.l + w * 0.55;
            const tx = X(x) + (links ? -10 : 10);
            // Unter der Kennlinie und unter der Untergrenze ist Platz: dort kreuzt weder die Kurve noch
            // eine Grenzlinie die Schrift. Reicht die Kurve fast bis zum Boden, steht sie unter dem Punkt.
            const boden = Math.min(...punkte.map(p => p[1]), unter === null ? 100 : unter);
            const ty =
                boden >= 22
                    ? r1((Y(boden) + Y(0)) / 2 - 3)
                    : Math.min(Y(0) - 22, Math.max(rand.o + 14, Y(wert === null ? aufLinie : wert) + 22));
            const anker = links ? 'end' : 'start';
            teile.push(
                `<text x="${tx}" y="${ty}" text-anchor="${anker}" font-size="12" font-weight="700" paint-order="stroke">${esc(ap.text)}</text>`,
            );
            if (ap.unterzeile) {
                teile.push(
                    `<text x="${tx}" y="${ty + 14}" text-anchor="${anker}" fill-opacity="0.75">${esc(ap.unterzeile)}</text>`,
                );
            }
        }
    }
    teile.push('</svg>');
    return teile.join('');
}

/**
 * Verlauf der Leistungsgrenze (24 h) als Treppenlinie.
 *
 * @param {object} o  Angaben
 * @param {unknown} o.verlauf  [[Zeit ms, Prozent], ...] aufsteigend
 * @param {number} o.jetzt  Uhr (ms)
 * @param {{jetzt?: string, leer?: string, stunde?: string}} [o.texte]  Beschriftungen
 * @param {number} [o.breite]  Breite (viewBox)
 * @param {number} [o.hoehe]  Hoehe (viewBox)
 * @param {number} [o.stunden]  Zeitraum, Vorgabe 24
 * @param {string} [o.farbe]  feste Schriftfarbe statt currentColor
 * @returns {string} SVG
 */
function verlauf(o) {
    const B = o.breite || 640;
    const H = o.hoehe || 150;
    const fg = o.farbe || 'currentColor';
    const texte = o.texte || {};
    const stunden = o.stunden || 24;
    const rand = { l: 44, r: 14, o: 10, u: 26 };
    const w = B - rand.l - rand.r;
    const h = H - rand.o - rand.u;
    const von = o.jetzt - stunden * 3600000;
    const alle = (Array.isArray(o.verlauf) ? o.verlauf : [])
        .map(e => [Number(e && e[0]), Number(e && e[1])])
        .filter(([t, p]) => Number.isFinite(t) && Number.isFinite(p) && t <= o.jetzt)
        .sort((x, y) => x[0] - y[0]);
    const kopf =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${B} ${H}" role="img" ` +
        `style="display:block;width:100%;height:auto;max-width:${B}px;font-family:inherit" font-size="11" fill="${fg}">`;
    const X = t => r1(rand.l + ((Math.max(von, t) - von) / (o.jetzt - von)) * w);
    const Y = p => r1(rand.o + (1 - (Math.min(100, Math.max(30, p)) - 30) / 70) * h);
    const teile = [kopf];
    for (const p of [40, 70, 100]) {
        teile.push(
            `<line x1="${rand.l}" x2="${B - rand.r}" y1="${Y(p)}" y2="${Y(p)}" stroke="${fg}" stroke-opacity="0.12"/>`,
            `<text x="${rand.l - 6}" y="${Y(p) + 4}" text-anchor="end" fill-opacity="0.7">${p} %</text>`,
        );
    }
    for (let s = stunden; s >= 0; s -= stunden / 4) {
        const t = o.jetzt - s * 3600000;
        const text = s ? `−${s} ${texte.stunde || 'h'}` : texte.jetzt || '0';
        teile.push(
            `<text x="${X(t)}" y="${H - 8}" text-anchor="${s === stunden ? 'start' : s ? 'middle' : 'end'}" fill-opacity="0.7">${esc(text)}</text>`,
        );
    }
    // Der letzte Wert VOR dem Fenster gilt am linken Rand weiter.
    const davor = alle.filter(([t]) => t < von).pop();
    const drin = alle.filter(([t]) => t >= von);
    const punkte = davor ? [[von, davor[1]], ...drin] : drin;
    if (!punkte.length) {
        teile.push(
            `<text x="${rand.l + w / 2}" y="${rand.o + h / 2 + 4}" text-anchor="middle" fill-opacity="0.7">${esc(texte.leer || '–')}</text></svg>`,
        );
        return teile.join('');
    }
    let d = `M${X(punkte[0][0])} ${Y(punkte[0][1])}`;
    for (let i = 1; i < punkte.length; i++) {
        d += ` H${X(punkte[i][0])} V${Y(punkte[i][1])}`;
    }
    d += ` H${X(o.jetzt)}`;
    const letzter = punkte[punkte.length - 1][1];
    teile.push(
        `<path d="${d}" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/>`,
        `<circle cx="${X(o.jetzt)}" cy="${Y(letzter)}" r="4" fill="${fg}"/>`,
        '</svg>',
    );
    return teile.join('');
}

/** Stufen des Balkens: 30..100 % in 5-%-Schritten. */
const BALKEN_VON = 30;
const BALKEN_SCHRITT = 5;
const BALKEN_ANZAHL = (100 - BALKEN_VON) / BALKEN_SCHRITT + 1;

/**
 * Wie viele Stufen des Balkens gefuellt sind.
 *
 * @param {number} prozent  Leistungsgrenze
 * @returns {number} 0..15
 */
function balkenStufen(prozent) {
    const p = Number(prozent);
    if (!Number.isFinite(p) || p < BALKEN_VON) {
        return 0;
    }
    return Math.min(BALKEN_ANZAHL, Math.floor((p - BALKEN_VON) / BALKEN_SCHRITT) + 1);
}

return {
    FARBEN,
    kennlinie,
    verlauf,
    wertAuf,
    punkteSaeubern,
    achse,
    balkenStufen,
    BALKEN_ANZAHL,
    BALKEN_VON,
    BALKEN_SCHRITT,
    zahl,
    esc,
    EINHEIT_MUSTER,
    einheitFest,
};
});
