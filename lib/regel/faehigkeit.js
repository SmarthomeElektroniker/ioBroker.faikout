'use strict';

/**
 * Faehigkeit "demand" je Anlage: 'unbekannt' | 'ja' | 'nein'.
 *
 * Firmware-Befund (Faikout.c, 20.11.2026): Das Modul sendet `D7` (demand + econo) und gibt das
 * Feld erst frei, wenn die Rueckmeldung `G7` den gesetzten Wert zeigt. Bleibt sie nach
 * `s21.tries` Runden anders, meldet es `failed-set` und verwirft die Aenderung. Die Firmware selbst
 * prueft dabei NICHT, ob die Anlage laeuft - ob ein Wert bei ausgeschalteter Anlage haengen bleibt,
 * entscheidet die Anlage. Beim Sparbetrieb ist belegt, dass eine ausgeschaltete Anlage ihn nicht
 * zurueckmeldet (failed-set), ihn aber beim Einschalten uebernimmt. Deshalb:
 *  - failed-set bei Geraet AUS   -> nicht aussagekraeftig, Faehigkeit bleibt wie sie war
 *  - failed-set bei Geraet EIN   -> 'nein' (grundsaetzlich bzw. derzeit nicht faehig)
 *  - Ruecklesen < 100 / gleich dem gesendeten Wert -> 'ja'
 *  - Statusmeldung ohne Feld demand (Modul kennt es nicht, nodemand) -> 'nein'
 */

/**
 * @param {{wert: string, grund: string}|null} alt  bisherige Bewertung
 * @param {object} ereignis  {art:'status', demand?, vollstaendig} | {art:'abgelehnt', power, wert} | {art:'angenommen', wert}
 * @returns {{wert: string, grund: string}} neue Bewertung
 */
function bewerten(alt, ereignis) {
    const a = alt && alt.wert ? alt : { wert: 'unbekannt', grund: 'noch keine Rückmeldung' };
    switch (ereignis && ereignis.art) {
        case 'status':
            if (ereignis.vollstaendig && (ereignis.demand === undefined || ereignis.demand === null)) {
                return { wert: 'nein', grund: 'Modul meldet kein demand (Anlage ohne Bedarfssteuerung oder nodemand)' };
            }
            if (Number.isFinite(ereignis.demand) && ereignis.demand < 100) {
                return { wert: 'ja', grund: `Anlage meldet demand ${ereignis.demand} %` };
            }
            if (
                Number.isFinite(ereignis.demand) &&
                a.wert === 'nein' &&
                a.grund.startsWith('Modul meldet kein demand')
            ) {
                return { wert: 'unbekannt', grund: 'Modul meldet demand wieder' };
            }
            return a;
        case 'abgelehnt':
            if (ereignis.power) {
                return { wert: 'nein', grund: `demand ${ereignis.wert} im Betrieb abgelehnt (failed-set)` };
            }
            return {
                wert: a.wert,
                grund: `${a.grund}; demand ${ereignis.wert} bei Gerät aus abgelehnt – nicht aussagekräftig`,
            };
        case 'angenommen':
            return { wert: 'ja', grund: `demand ${ereignis.wert} übernommen (zurückgelesen)` };
        default:
            return a;
    }
}

module.exports = { bewerten };
