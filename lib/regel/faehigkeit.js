'use strict';

/**
 * Faehigkeit "demand" je Anlage: 'unknown' | 'yes' | 'no'.
 *
 * Firmware-Befund (Faikout.c, 20.11.2026): Das Modul sendet `D7` (demand + econo) und gibt das
 * Feld erst frei, wenn die Rueckmeldung `G7` den gesetzten Wert zeigt. Bleibt sie nach
 * `s21.tries` Runden anders, meldet es `failed-set` und verwirft die Aenderung. Die Firmware selbst
 * prueft dabei NICHT, ob die Anlage laeuft - ob ein Wert bei ausgeschalteter Anlage haengen bleibt,
 * entscheidet die Anlage. Beim Sparbetrieb ist belegt, dass eine ausgeschaltete Anlage ihn nicht
 * zurueckmeldet (failed-set), ihn aber beim Einschalten uebernimmt. Deshalb:
 *  - failed-set bei Geraet AUS   -> nicht aussagekraeftig, Faehigkeit bleibt wie sie war
 *  - failed-set bei Geraet EIN   -> 'no' (grundsaetzlich bzw. derzeit nicht faehig)
 *    Nutzerbefund 20.11.2026 (im Betrieb geprueft): Daikin uebernimmt demand nur, wenn das ORIGINALE
 *    Daikin-WLAN-Modul eingeschaltet ist (Internet/Cloud nicht noetig) und in der Daikin-App die
 *    Leistungssteuerung auf "Ein" steht. "Aus" = immer 100 %, S21-Werte wirkungslos; "Auto" = Cloud
 *    regelt; bei "Ein" gilt der zuletzt geschriebene Wert (App oder faikout).
 *    Gegenbefund 22.11.2026 (FernetMenta, Multisplit, Daikin-Modul mit Cloud): erst mit "Aus" wirkte der
 *    Wert. Vermutung (unbestaetigt): mit Cloud "Aus", ohne Internet "Ein" - so steht es im Hinweistext.
 *  - Ruecklesen < 100 / gleich dem gesendeten Wert -> 'yes'
 *  - Statusmeldung ohne Feld demand (Modul kennt es nicht, nodemand) -> 'no'
 */

const texte = require('./texte');

/**
 * Hat das Modul zuletzt gar kein demand gemeldet? Massgeblich ist das Maschinenfeld `code`; ein
 * gespeicherter Zustand aus der Zeit vor der Uebersetzung (ohne `code`) wird am deutschen Alttext
 * erkannt.
 *
 * @param {{wert: string, grund: string, code?: string}} a  bisherige Bewertung
 * @returns {boolean} true: Grund war "Modul meldet kein demand"
 */
function ohneDemand(a) {
    if (a.code !== undefined) {
        return a.code === 'keinDemand';
    }
    return String(a.grund || '').startsWith('Modul meldet kein demand');
}

/**
 * `code` ist der sprachunabhaengige Grund ('offen', 'keinDemand', 'meldet', 'wieder',
 * 'abgelehnt', 'uebernommen'); `grund` der Text in der Sprache zum Zeitpunkt der Bewertung.
 *
 * @param {{wert: string, grund: string, code?: string}|null} alt  bisherige Bewertung
 * @param {object} ereignis  {art:'status', demand?, vollstaendig} | {art:'abgelehnt', power, wert} | {art:'angenommen', wert}
 * @returns {{wert: string, grund: string, code?: string}} neue Bewertung
 */
function bewerten(alt, ereignis) {
    const a = alt && alt.wert ? alt : { wert: 'unknown', code: 'offen', grund: texte.t('faehig.keineRueckmeldung') };
    switch (ereignis && ereignis.art) {
        case 'status':
            if (ereignis.vollstaendig && (ereignis.demand === undefined || ereignis.demand === null)) {
                return { wert: 'no', code: 'keinDemand', grund: texte.t('faehig.keinDemand') };
            }
            if (Number.isFinite(ereignis.demand) && ereignis.demand < 100) {
                return { wert: 'yes', code: 'meldet', grund: texte.t('faehig.meldet', { wert: ereignis.demand }) };
            }
            if (Number.isFinite(ereignis.demand) && a.wert === 'no' && ohneDemand(a)) {
                return { wert: 'unknown', code: 'wieder', grund: texte.t('faehig.wieder') };
            }
            return a;
        case 'abgelehnt':
            if (ereignis.power) {
                return {
                    wert: 'no',
                    code: 'abgelehnt',
                    grund: texte.t('faehig.abgelehntBetrieb', { wert: ereignis.wert }),
                };
            }
            // `code` bleibt, wie er war: ein "kein demand" davor muss erkennbar bleiben. Ein alter
            // Zustand ohne `code` behaelt seinen (deutschen) Textanfang und wird weiter daran erkannt.
            return {
                wert: a.wert,
                ...(a.code !== undefined ? { code: a.code } : {}),
                grund: texte.t('faehig.abgelehntAus', { grund: a.grund, wert: ereignis.wert }),
            };
        case 'angenommen':
            return { wert: 'yes', code: 'uebernommen', grund: texte.t('faehig.uebernommen', { wert: ereignis.wert }) };
        default:
            return a;
    }
}

module.exports = { bewerten };
