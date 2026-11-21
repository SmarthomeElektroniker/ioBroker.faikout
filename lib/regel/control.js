'use strict';

/**
 * Baustein fuer spaetere Etappen (Fuehler-/Sollwertsteuerung ueber command/<Name>/control).
 *
 * Firmware-Befund (Faikout.c ~1595-1660, 3626-3666): Jede control-Nachricht ersetzt env UND das
 * Zielband - nicht enthaltene Felder werden NAN. Einzelne Nachrichten {"env"} und {"target"}
 * ueberschreiben sich also gegenseitig. Ist ein BLE-Fuehler gekoppelt, ignoriert das Modul env;
 * bei Faikout-Auto (autoe && autor > 0) ignoriert es target. Jede control verlaengert die
 * Gueltigkeit um tcontrol (600 s).
 *
 * Deshalb baut genau EIN Sender je Geraet immer die VOLLSTAENDIGE Nachricht. Diese Funktion
 * liefert sie - oder null, wenn ein Pflichtteil fehlt. Eine Teilnachricht entsteht nie.
 */

/**
 * @param {object} p  Eingang
 * @param {'adapter'|'faikoutAuto'} p.betrieb  "ioBroker-Adapter regelt" (env + target) oder "Faikout-Auto" (nur env)
 * @param {number|null} p.env      Raumtemperatur fuer das Modul
 * @param {number|null} [p.min]    Zielband unten
 * @param {number|null} [p.max]    Zielband oben
 * @param {boolean} [p.ble]        BLE-Fuehler gekoppelt (dann kein env)
 * @returns {{env?: number, target?: number[]}|null} vollstaendige control-Nachricht oder null
 */
function controlNachricht({ betrieb, env, min, max, ble }) {
    const envOk = Number.isFinite(env) && !ble;
    const bandOk = Number.isFinite(min) && Number.isFinite(max) && min <= max;
    if (betrieb === 'faikoutAuto') {
        return envOk ? { env } : null; // target wuerde ignoriert; ohne env gibt es nichts zu senden
    }
    if (betrieb !== 'adapter' || !bandOk) {
        return null;
    }
    // Ein Ziel als EINZELNE Zahl setzt min = max, ohne das Modul in den "remote"-Betrieb zu schalten.
    // Ein Ziel als FELD [min, max] schaltet ihn ein (Faikout.c ~1633) - und dann schaltet das Modul
    // die Anlage von selbst aus, sobald der Raum im Band liegt (auto.ptemp, ab Werk 0,5 K).
    const target = min === max ? min : [min, max];
    if (ble) {
        return { target }; // env kommt vom BLE-Fuehler
    }
    return envOk ? { env, target } : null;
}

module.exports = { controlNachricht };
