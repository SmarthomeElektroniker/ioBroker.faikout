'use strict';

/**
 * Stoffwerte feuchter Luft fuer die Waermebilanz am Innengeraet.
 *
 * Reine Funktionen ohne Zustand. Gerechnet wird mit dem Volumenstrom am ANSAUG (so geben ihn die
 * Datenblaetter an), deshalb zaehlt die Dichte der Ansaugluft.
 */

/** Spezifische Waermekapazitaet trockener Luft in J/(kg·K). */
const CP_LUFT = 1006;
/** Spezifische Waermekapazitaet von Wasserdampf in J/(kg·K). */
const CP_DAMPF = 1860;
/** Verdampfungswaerme von Wasser bei 0 °C in J/kg. */
const R0 = 2501000;
/** Gaskonstante trockener Luft in J/(kg·K). */
const R_LUFT = 287.05;
/** Normaldruck in Pa. */
const DRUCK = 101325;

/**
 * Dichte trockener Luft.
 *
 * @param {number} t        Temperatur in °C
 * @param {number} [druck]  Luftdruck in Pa
 * @returns {number} Dichte in kg/m³
 */
function dichte(t, druck = DRUCK) {
    return druck / (R_LUFT * (t + 273.15));
}

/**
 * Saettigungsdampfdruck (Magnus).
 *
 * @param {number} t  Temperatur in °C
 * @returns {number} Druck in Pa
 */
function saettigungsdruck(t) {
    return 611.2 * Math.exp((17.62 * t) / (243.12 + t));
}

/**
 * Wassergehalt der Luft.
 *
 * @param {number} t        Temperatur in °C
 * @param {number} rf       relative Feuchte in %
 * @param {number} [druck]  Luftdruck in Pa
 * @returns {number} kg Wasser je kg trockene Luft
 */
function wassergehalt(t, rf, druck = DRUCK) {
    const pd = (saettigungsdruck(t) * Math.min(100, Math.max(0, rf))) / 100;
    return (0.622 * pd) / (druck - pd);
}

/**
 * Fuehlbarer Waermestrom, den ein Luftstrom aufnimmt (positiv) oder abgibt (negativ).
 *
 * @param {number} m3s    Volumenstrom am Ansaug in m³/s
 * @param {number} tEin   Ansaugtemperatur in °C
 * @param {number} tAus   Austrittstemperatur in °C
 * @returns {number} Waermestrom in W
 */
function fuehlbar(m3s, tEin, tAus) {
    return dichte(tEin) * CP_LUFT * m3s * (tAus - tEin);
}

/**
 * Latenter Waermestrom beim Entfeuchten: nur was am Register wirklich als Wasser ausfaellt.
 *
 * @param {number} m3s    Volumenstrom am Ansaug in m³/s
 * @param {number} tEin   Ansaugtemperatur in °C
 * @param {number} rfEin  relative Feuchte am Ansaug in %
 * @param {number} tAus   Austrittstemperatur in °C
 * @param {number} rfAus  relative Feuchte am Austritt in %
 * @returns {number} entzogene latente Leistung in W (nie negativ)
 */
function latent(m3s, tEin, rfEin, tAus, rfAus) {
    const dx = wassergehalt(tEin, rfEin) - wassergehalt(tAus, rfAus);
    return Math.max(0, dichte(tEin) * m3s * dx * R0);
}

module.exports = { CP_LUFT, CP_DAMPF, R0, DRUCK, dichte, saettigungsdruck, wassergehalt, fuehlbar, latent };
