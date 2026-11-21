'use strict';

/**
 * Waerme- bzw. Kaelteleistung des Innengeraets aus den Werten, die die Anlage ohnehin meldet.
 *
 *     Q = ρ(T_ein) · c_p · V · (T_aus − T_ein),   T_aus = T_ein + ε · (T_ref − T_ein)
 *
 * V kommt aus Luefterstufe bzw. Drehzahl (luftstrom.js), ε aus Datenblatt-Schaetzung oder Kalibrierung
 * (wirksamkeit.js, kalibrierung.js), T_ref ist `liquid`, T_ein ist `achome`. Reine Funktion: alles kommt
 * als Eingang herein, nichts wird gemerkt.
 *
 * Was NICHT gerechnet wird, steht ausdruecklich im Ergebnis: Abtauen (Leistung 0, Kennzeichen),
 * Stillstand (0), fehlende Datenpunkte (nicht verfuegbar, mit Liste). Beim Kuehlen ist das Ergebnis die
 * FUEHLBARE Kaelte; die latente (Entfeuchtung) kommt nur dazu, wenn Feuchte am Ein- und Austritt
 * gemessen wird - sonst ist die Kaelteleistung unterschaetzt und so gekennzeichnet.
 */

const luft = require('./luft');
const luftstrom = require('./luftstrom');
const wirksamkeit = require('./wirksamkeit');

/** Unter diesem Abstand zwischen liquid und Ansaugluft (K) gilt der Wert als unsicher (kleine Last). */
const KLEINE_LAST_K = 3;
/** So lange nach dem Verdichterstart (s) gilt der Wert als unsicher (Anlauf, Takten). */
const ANLAUF_SEK = 180;
/** Angenommener Fehler der Temperaturdifferenz aus Aufloesung und Abgleich der Sensoren (K). */
const SENSORFEHLER_K = 0.5;
/** Abtauen: liquid liegt mindestens so weit unter der Ansaugluft (K), waehrend der Verdichter heizt. */
const ABTAU_UNTER_K = 1;
/** Elektrische Leistung, unter der kein COP gebildet wird (W) - der Quotient waere beliebig. */
const P_MIN_W = 50;

const istZahl = x => typeof x === 'number' && isFinite(x);

/**
 * Heizt oder kuehlt die Anlage gerade (der Betriebsart nach)?
 *
 * @param {object} e  Eingang wie bei schaetzen()
 * @returns {'heizen'|'kuehlen'|null} Richtung oder null (aus, nur Luefter)
 */
function richtung(e) {
    if (e.power === false) {
        return null;
    }
    switch (String(e.mode)) {
        case 'heat':
            return 'heizen';
        case 'cool':
        case 'dry':
            return 'kuehlen';
        case 'heat_cool':
            if (!istZahl(e.tRef) || !istZahl(e.tEin)) {
                return null;
            }
            return e.tRef >= e.tEin ? 'heizen' : 'kuehlen';
        default:
            return null;
    }
}

/**
 * Welche Datenpunkte fehlen fuer die Rechnung?
 *
 * @param {object} e  Eingang wie bei schaetzen()
 * @returns {string[]} Namen der fehlenden Datenpunkte (status.*)
 */
function fehlend(e) {
    const f = [];
    if (!istZahl(e.tEin)) {
        f.push('achome');
    }
    if (!istZahl(e.tRef)) {
        f.push('liquid');
    }
    if (!istZahl(e.rpm) && !luftstrom.stufeVon(e.fan) && String(e.fan) !== 'auto') {
        f.push('fanfreq');
    }
    return f;
}

/**
 * Schaetzt Leistung, Austrittstemperatur und Arbeitszahl fuer einen Augenblick.
 *
 * @param {object} e  Messwerte
 * @param {boolean} [e.power]  Anlage eingeschaltet
 * @param {string} [e.mode]  Betriebsart (control.mode)
 * @param {string} [e.fan]  Luefterstufe (control.fan)
 * @param {string} [e.action]  gemeldete Taetigkeit (status.action), falls vorhanden
 * @param {number|null} [e.rpm]  Luefterdrehzahl in 1/min
 * @param {number|null} [e.comp]  Verdichter (Hz oder 1/min; nur 0 / nicht 0 zaehlt)
 * @param {number|null} [e.tEin]  Ansaugluft in °C (status.achome)
 * @param {number|null} [e.tRef]  Bezugstemperatur in °C (status.liquid)
 * @param {number|null} [e.pEl]  elektrische Leistung in W (status.consumption)
 * @param {number|null} [e.tAus]  gemessene Austrittstemperatur in °C (Sensor), sonst wird geschaetzt
 * @param {number|null} [e.rfEin]  relative Feuchte am Ansaug in %
 * @param {number|null} [e.rfAus]  relative Feuchte am Austritt in %
 * @param {number|null} [e.seitStart]  Sekunden seit dem Verdichterstart
 * @param {object} k  Konfiguration des Geraets
 * @param {{werte: Record<string, number>, generisch?: boolean}} k.heizen  Luftstromkennlinie Heizen
 * @param {{werte: Record<string, number>, generisch?: boolean}} k.kuehlen  Luftstromkennlinie Kuehlen
 * @param {{heizen: object, kuehlen: object}} k.eps  je Betriebsart {stufen, unsicherheit, guete, interpolieren}
 * @param {{heizen?: Record<string, number[]>, kuehlen?: Record<string, number[]>}} [k.drehzahlen]  gelernte Drehzahlen
 * @returns {object} Ergebnis: {art, leistungW, latentW, cop, luftstromM3h, stufe, tAus, eps, guete, unsicherheit, unsicher,
 *   abtauen, fehlt, nurFuehlbar, luftstromQuelle}
 */
function schaetzen(e, k) {
    const leer = {
        art: 'aus',
        leistungW: 0,
        latentW: null,
        cop: null,
        luftstromM3h: null,
        stufe: null,
        tAus: null,
        eps: null,
        guete: 'unavailable',
        unsicherheit: null,
        unsicher: [],
        abtauen: false,
        fehlt: [],
        nurFuehlbar: false,
        luftstromQuelle: null,
    };
    const fehlt = fehlend(e);
    if (fehlt.length) {
        return { ...leer, art: 'nichtVerfuegbar', leistungW: null, fehlt };
    }
    const art = richtung(e);
    if (!art) {
        return { ...leer, guete: k.eps && k.eps.heizen ? k.eps.heizen.guete : 'estimated' };
    }
    const seite = k[art] || { werte: {} };
    const eps = (k.eps && k.eps[art]) || {
        stufen: {},
        unsicherheit: wirksamkeit.UNSICHER_GENERISCH,
        guete: 'estimated',
    };
    const basis = { ...leer, art, guete: eps.guete || 'estimated' };

    // Stillstand: Verdichter steht (Pause der Anlage, Thermo-Aus)
    if (istZahl(e.comp) && e.comp <= 0) {
        return { ...basis, art: 'stillstand' };
    }
    // Abtauen: nur beim Heizen - der Kreis laeuft rueckwaerts, das Register ist kalt
    if (art === 'heizen' && (e.action === 'defrosting' || e.tRef < e.tEin - ABTAU_UNTER_K)) {
        return { ...basis, art: 'abtauen', abtauen: true };
    }
    // Kuehlen mit warmem Register: die Anlage kuehlt gerade nicht
    if (art === 'kuehlen' && e.tRef > e.tEin) {
        return { ...basis, art: 'stillstand' };
    }

    const v = luftstrom.bestimmen({
        fan: e.fan,
        rpm: istZahl(e.rpm) ? e.rpm : null,
        werte: seite.werte,
        drehzahlen: k.drehzahlen && k.drehzahlen[art],
    });
    if (v.m3min === null) {
        return { ...leer, art: 'nichtVerfuegbar', leistungW: null, fehlt: ['fanfreq'] };
    }
    const m3s = v.m3min / 60;
    const dRef = e.tRef - e.tEin;
    const gemessen = istZahl(e.tAus);
    const epsWert = gemessen
        ? null
        : wirksamkeit.fuer(
              eps.stufen || {},
              seite.werte,
              v.stufe,
              v.m3min,
              v.quelle === 'drehzahl' && !!eps.interpolieren,
          );
    if (!gemessen && epsWert === null) {
        return { ...leer, art: 'nichtVerfuegbar', leistungW: null, fehlt: ['fanfreq'] };
    }
    const tAus = gemessen ? e.tAus : e.tEin + epsWert * dRef;
    const roh = luft.fuehlbar(m3s, e.tEin, tAus);
    // Vorzeichen: Heizen gibt Waerme ab (positiv), Kuehlen entzieht sie (als positive Kaelteleistung)
    let leistung = Math.max(0, art === 'heizen' ? roh : -roh);
    let latentW = null;
    let nurFuehlbar = false;
    if (art === 'kuehlen') {
        if (istZahl(e.rfEin) && istZahl(e.rfAus)) {
            latentW = luft.latent(m3s, e.tEin, e.rfEin, tAus, e.rfAus);
            leistung += latentW;
        } else {
            nurFuehlbar = true;
        }
    }

    const unsicher = [];
    if (Math.abs(dRef) < KLEINE_LAST_K) {
        unsicher.push('kleineLast');
    }
    if (istZahl(e.seitStart) && e.seitStart < ANLAUF_SEK) {
        unsicher.push('anlauf');
    }
    if (v.quelle === 'mitte') {
        unsicher.push('luefterAuto');
    }
    // Unsicherheit: ε, Luftstrom und Temperaturdifferenz, unabhaengig angenommen
    const dT = Math.abs(gemessen ? tAus - e.tEin : dRef);
    const anteile = [
        gemessen ? 0 : (eps.unsicherheit ?? wirksamkeit.UNSICHER_GENERISCH),
        Math.max(v.unsicherheit, seite.generisch ? 0.2 : 0.1),
        dT > 0 ? Math.min(1, SENSORFEHLER_K / dT) : 1,
        unsicher.includes('anlauf') ? 0.15 : 0,
    ];
    const unsicherheit = Math.min(99, Math.round(100 * Math.sqrt(anteile.reduce((s, a) => s + a * a, 0))));

    return {
        ...basis,
        leistungW: Math.round(leistung),
        latentW: latentW === null ? null : Math.round(latentW),
        cop: istZahl(e.pEl) && e.pEl >= P_MIN_W ? leistung / e.pEl : null,
        luftstromM3h: Math.round(v.m3min * 60),
        stufe: v.stufe,
        tAus: Math.round(tAus * 10) / 10,
        eps: epsWert,
        guete: gemessen ? 'measured' : eps.guete || 'estimated',
        unsicherheit,
        unsicher,
        nurFuehlbar,
        luftstromQuelle: v.quelle,
    };
}

/**
 * Exponentielle Glaettung mit Zeitkonstante (fuer die Anzeige von Leistung und COP).
 *
 * @param {number|null} alt     bisheriger Wert (null = noch keiner)
 * @param {number} neu          neuer Messwert
 * @param {number} dtSek        Sekunden seit dem letzten Wert
 * @param {number} [tauSek]     Zeitkonstante in Sekunden
 * @returns {number} geglaetteter Wert
 */
function glaetten(alt, neu, dtSek, tauSek = 300) {
    if (!istZahl(alt) || !(dtSek > 0) || dtSek > 4 * tauSek) {
        return neu;
    }
    const a = 1 - Math.exp(-dtSek / tauSek);
    return alt + a * (neu - alt);
}

module.exports = {
    KLEINE_LAST_K,
    ANLAUF_SEK,
    SENSORFEHLER_K,
    ABTAU_UNTER_K,
    P_MIN_W,
    richtung,
    fehlend,
    schaetzen,
    glaetten,
};
