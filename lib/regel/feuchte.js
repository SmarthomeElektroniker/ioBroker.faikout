'use strict';

/**
 * Feuchte- und Taupunktregelung. Rein, die Uhr kommt herein; der Zustand besteht nur aus
 * Zeitstempeln und ist damit neustartfest (ein Neustart mitten im Entfeuchten setzt die
 * Mindestlaufzeit fort statt sie neu zu beginnen).
 *
 * ΔTP = Raumtemperatur - Taupunkt. Je kleiner, desto schwueler. Eingriff, wenn ΔTP unter die
 * Grenze faellt ODER die relative Feuchte ueber die Grenze steigt; Ende erst, wenn BEIDE
 * Ende-Bedingungen erfuellt sind und die Mindestlaufzeit um ist. Danach Pause. Eine Hoechstlaufzeit
 * verhindert Dauerbetrieb bei unerreichbarem Ziel.
 *
 * Massnahmen:
 *  - `entfeuchten`: Betriebsart "dry" - nur wenn die Anlage nicht heizt (im Heizbetrieb wuerde
 *    Entfeuchten den Raum auskuehlen; dann wird nur gemeldet).
 *  - `zielSenken`:  beim Kuehlen das Ziel um `senkenK` senken (laengere Laufzeit = mehr Entzug).
 *  - `melden`:      nur anzeigen.
 */

const texte = require('./texte');

const VORGABEN = {
    dtpEin: 4,
    dtpAus: 6,
    rhEin: 65,
    rhAus: 58,
    massnahme: 'entfeuchten',
    minLaufMin: 20,
    pauseMin: 30,
    maxLaufMin: 120,
    senkenK: 1,
};

/**
 * Taupunkt nach Magnus (ueber Wasser, -45..60 °C).
 *
 * @param {number} t   Lufttemperatur in °C
 * @param {number} rh  relative Feuchte in %
 * @returns {number|null} Taupunkt in °C
 */
function taupunkt(t, rh) {
    if (!Number.isFinite(t) || !Number.isFinite(rh) || rh <= 0 || rh > 100) {
        return null;
    }
    const a = 17.62;
    const b = 243.12;
    const g = Math.log(rh / 100) + (a * t) / (b + t);
    return Math.round(((b * g) / (a - g)) * 10) / 10;
}

/**
 * Fuehrt Konfiguration und Vorgaben zusammen und prueft sie.
 *
 * @param {object} [roh]  Konfiguration
 * @returns {{konfig: object, fehler: string|null}} gepruefte Konfiguration
 */
function konfigPruefen(roh = {}) {
    const k = { ...VORGABEN };
    for (const f of Object.keys(VORGABEN)) {
        if (roh[f] !== undefined && roh[f] !== null && roh[f] !== '') {
            k[f] = f === 'massnahme' ? String(roh[f]) : Number(roh[f]);
        }
    }
    const zahlen = ['dtpEin', 'dtpAus', 'rhEin', 'rhAus', 'minLaufMin', 'pauseMin', 'maxLaufMin', 'senkenK'];
    const fehler =
        (zahlen.some(f => !Number.isFinite(k[f])) && texte.t('feuchte.keineZahl')) ||
        (!(k.dtpAus > k.dtpEin) && texte.t('feuchte.dtpReihenfolge', { aus: k.dtpAus, ein: k.dtpEin })) ||
        (!(k.rhAus < k.rhEin) && texte.t('feuchte.rhReihenfolge', { aus: k.rhAus, ein: k.rhEin })) ||
        (!['entfeuchten', 'zielSenken', 'melden'].includes(k.massnahme) &&
            texte.t('feuchte.massnahmeUnbekannt', { wert: k.massnahme })) ||
        (!(k.maxLaufMin >= k.minLaufMin) && texte.t('feuchte.laufzeiten')) ||
        null;
    return { konfig: k, fehler };
}

/** Leerer Zustand. */
function neuerZustand() {
    return { seit: null, pauseBis: 0, massnahme: null };
}

/**
 * Ein Bewertungsschritt.
 *
 * @param {object} e  Eingang {raum: number|null, feuchte: number|null, power, mode, heizt: boolean, erlaubt: boolean}
 * @param {object} k  gepruefte Konfiguration
 * @param {object|null} z  bisheriger Zustand
 * @param {number} jetzt  Uhr (ms)
 * @returns {{ergebnis: {taupunkt: number|null, abstand: number|null, bedarf: boolean, massnahme: string|null, zustand: string, grund: string}, zustand: object}} Ergebnis
 */
function bewerten(e, k, z, jetzt) {
    const zustand = { ...neuerZustand(), ...(z || {}) };
    const tp = taupunkt(e.raum, e.feuchte);
    const abstand = tp === null ? null : Math.round((e.raum - tp) * 10) / 10;
    const erg = { taupunkt: tp, abstand, bedarf: false, massnahme: null, zustand: 'ok', grund: '' };
    const beenden = (grund, pause) => {
        if (zustand.seit !== null && pause) {
            zustand.pauseBis = jetzt + k.pauseMin * 60000;
        }
        zustand.seit = null;
        zustand.massnahme = null;
        erg.grund = grund;
        return { ergebnis: erg, zustand };
    };

    if (!e.erlaubt) {
        erg.zustand = 'off';
        return beenden(texte.t('feuchte.aus'), false);
    }
    if (tp === null) {
        erg.zustand = 'fault';
        return beenden(texte.t('feuchte.fuehlerFehlt'), false);
    }
    const zuFeucht = abstand < k.dtpEin || e.feuchte > k.rhEin;
    const trocken = abstand > k.dtpAus && e.feuchte < k.rhAus;
    const werte = texte.t('feuchte.werte', { abstand, rh: Math.round(e.feuchte) });

    if (zustand.seit !== null) {
        const laufMin = (jetzt - zustand.seit) / 60000;
        if (laufMin >= k.maxLaufMin) {
            return beenden(texte.t('feuchte.hoechstlaufzeit', { werte, min: k.maxLaufMin }), true);
        }
        if (trocken && laufMin >= k.minLaufMin) {
            return beenden(texte.t('feuchte.trocken', { werte, min: k.pauseMin }), true);
        }
        erg.bedarf = true;
        erg.grund = trocken
            ? texte.t('feuchte.mindestlaufzeit', { werte, min: Math.ceil(k.minLaufMin - laufMin) })
            : texte.t('feuchte.laeuft', { werte, min: Math.floor(laufMin) });
    } else if (zuFeucht) {
        if (jetzt < zustand.pauseBis) {
            erg.grund = texte.t('feuchte.pause', { werte, min: Math.ceil((zustand.pauseBis - jetzt) / 60000) });
            return { ergebnis: erg, zustand };
        }
        zustand.seit = jetzt;
        erg.bedarf = true;
        erg.grund = texte.t('feuchte.zuFeucht', { werte, dtp: k.dtpEin, rh: k.rhEin });
    } else {
        erg.grund = texte.t('feuchte.inOrdnung', { werte });
        return { ergebnis: erg, zustand };
    }

    // Massnahme waehlen - abhaengig davon, was die Anlage gerade tut.
    let m = k.massnahme;
    if (!e.power) {
        m = 'melden';
        erg.grund += `; ${texte.t('feuchte.geraetAus')}`;
    } else if (m === 'entfeuchten' && e.heizt) {
        m = 'melden';
        erg.grund += `; ${texte.t('feuchte.heizt')}`;
    } else if (m === 'zielSenken' && (e.heizt || e.mode === 'dry' || e.mode === 'fan_only')) {
        m = 'melden';
        erg.grund += `; ${texte.t('feuchte.nurKuehlen')}`;
    }
    erg.massnahme = m;
    zustand.massnahme = m;
    return { ergebnis: erg, zustand };
}

module.exports = { VORGABEN, taupunkt, konfigPruefen, neuerZustand, bewerten };
