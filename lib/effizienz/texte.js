'use strict';

/**
 * Namen der Datenpunkte unter <Geraet>.efficiency.* und Meldungen der Effizienz-Befehle in allen elf Sprachen.
 * Platzhalter in geschweiften Klammern.
 */

const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** Namen der Kanaele und Datenpunkte. */
const NAMEN = {
    kanal: { en: 'Efficiency', de: 'Effizienz' },
    kanalWaerme: { en: 'Heat', de: 'Wärme' },
    kanalKaelte: { en: 'Cooling energy', de: 'Kälte' },
    heatOutput: { en: 'Heat output (estimated)', de: 'Wärmeleistung (geschätzt)' },
    coolingOutput: { en: 'Cooling output (estimated)', de: 'Kälteleistung (geschätzt)' },
    cop: { en: 'COP/EER now (smoothed)', de: 'COP/EER jetzt (geglättet)' },
    airflow: { en: 'Airflow', de: 'Luftstrom' },
    outletTemperature: { en: 'Outlet air temperature (estimated)', de: 'Austrittstemperatur (geschätzt)' },
    defrosting: { en: 'Defrosting', de: 'Abtauen' },
    state: { en: 'What the unit is doing', de: 'Was die Anlage gerade tut' },
    quality: { en: 'Quality of the values', de: 'Güte der Werte' },
    uncertainty: { en: 'Uncertainty of the output', de: 'Unsicherheit der Leistung' },
    missing: { en: 'Missing values of the unit', de: 'Fehlende Werte der Anlage' },
    today: { en: 'Today', de: 'Heute' },
    yesterday: { en: 'Yesterday', de: 'Gestern' },
    thisMonth: { en: 'This month', de: 'Dieser Monat' },
    lastMonth: { en: 'Last month', de: 'Letzter Monat' },
    copToday: { en: 'COP today', de: 'COP heute' },
    copYesterday: { en: 'COP yesterday', de: 'COP gestern' },
    copThisMonth: { en: 'COP this month', de: 'COP dieser Monat' },
    copLastMonth: { en: 'COP last month', de: 'COP letzter Monat' },
    eerToday: { en: 'EER today', de: 'EER heute' },
    eerYesterday: { en: 'EER yesterday', de: 'EER gestern' },
    eerThisMonth: { en: 'EER this month', de: 'EER dieser Monat' },
    eerLastMonth: { en: 'EER last month', de: 'EER letzter Monat' },
    heatPrice: { en: 'Cost per kWh of heat today', de: 'Kosten je kWh Wärme heute' },
    hoursJson: {
        en: 'Heat, cooling and electricity, last 48 hours (JSON)',
        de: 'Wärme, Kälte und Strom, letzte 48 Stunden (JSON)',
    },
    daysJson: {
        en: 'Heat, cooling and electricity, last 62 days (JSON)',
        de: 'Wärme, Kälte und Strom, letzte 62 Tage (JSON)',
    },
    monthsJson: {
        en: 'Heat, cooling and electricity, last 24 months (JSON)',
        de: 'Wärme, Kälte und Strom, letzte 24 Monate (JSON)',
    },
};

/** Werte des Datenpunkts quality. */
const GUETE = {
    estimated: { en: 'estimated', de: 'geschätzt' },
    calibrated: { en: 'calibrated', de: 'kalibriert' },
    measured: { en: 'measured', de: 'gemessen' },
    unavailable: { en: 'not available', de: 'nicht verfügbar' },
};

/** Werte des Datenpunkts state. */
const ZUSTAND = {
    heating: { en: 'heating', de: 'heizt' },
    cooling: { en: 'cooling', de: 'kühlt' },
    defrosting: { en: 'defrosting', de: 'taut ab' },
    idle: { en: 'paused', de: 'pausiert' },
    off: { en: 'off', de: 'aus' },
    unavailable: { en: 'not available', de: 'nicht verfügbar' },
};

/** Meldungen der Befehle. */
const MELDUNGEN = {
    geraetUnbekannt: { en: 'Unknown unit "{geraet}".', de: 'Unbekannte Anlage „{geraet}“.' },
    sensorFehlt: {
        en: 'The data point "{dp}" does not exist or holds no number.',
        de: 'Den Datenpunkt „{dp}“ gibt es nicht oder er enthält keine Zahl.',
    },
    sensorWaehlen: {
        en: 'Choose the data point of the outlet sensor first.',
        de: 'Zuerst den Datenpunkt des Austrittssensors wählen.',
    },
    keineMessung: { en: 'No measurement is running for this unit.', de: 'Für diese Anlage läuft keine Messung.' },
    keinePunkte: {
        en: 'There are no usable measuring points yet.',
        de: 'Es gibt noch keine brauchbaren Messpunkte.',
    },
    nichtVerfuegbar: {
        en: 'This unit does not report {fehlt} – heat output and COP cannot be calculated.',
        de: 'Diese Anlage meldet {fehlt} nicht – Wärmeleistung und COP lassen sich nicht berechnen.',
    },
    handUnbrauchbar: {
        en: 'This measurement cannot be used: {grund}.',
        de: 'Diese Messung ist nicht brauchbar: {grund}.',
    },
    grundAbtauen: { en: 'the unit was defrosting', de: 'die Anlage taute gerade ab' },
    grundSteht: { en: 'compressor or fan was not running', de: 'Verdichter oder Lüfter standen' },
    grundKleinerAbstand: {
        en: 'the heat exchanger was less than {k} K away from the room temperature',
        de: 'das Register lag weniger als {k} K von der Raumtemperatur entfernt',
    },
    grundVorzeichen: {
        en: 'the outlet temperature does not fit the operating mode',
        de: 'die Austrittstemperatur passt nicht zur Betriebsart',
    },
    grundUnvollstaendig: { en: 'values are missing', de: 'es fehlen Werte' },
    kalibrierungFehlt: { en: 'This calibration no longer exists.', de: 'Diese Kalibrierung gibt es nicht mehr.' },
};

/**
 * Text in einer Sprache mit eingesetzten Werten.
 *
 * @param {Record<string, string>} eintrag  Text je Sprache
 * @param {string} sprache  Sprachkuerzel
 * @param {Record<string, string|number>} [werte]  Platzhalter
 * @returns {string} Text
 */
function t(eintrag, sprache, werte = {}) {
    let s = (eintrag && (eintrag[sprache] || eintrag.en)) || '';
    for (const [k, v] of Object.entries(werte)) {
        s = s.split(`{${k}}`).join(String(v));
    }
    return s;
}

module.exports = { SPRACHEN, NAMEN, GUETE, ZUSTAND, MELDUNGEN, t };
