'use strict';

/**
 * Koordinator: fuehrt je Geraet Wochenplan, Handeingriff, Schutz, Feuchte und Bedarf zu EINEM
 * Wunschzustand zusammen. Rein: Uhr, Eingaenge und Zustand kommen herein.
 *
 * Vorrang (hoch -> niedrig): Schutz > Handeingriff > Wochenplan/Abwesenheit; Feuchte und Bedarf
 * arbeiten auf dem, was danach gilt.
 *  - Handeingriff sperrt NUR Plan und Szenen (Nutzerentscheid 20.11.2026). Schutz, Feuchte und
 *    Leistungsgrenze laufen weiter.
 *  - Schutz (Frost): Raum unter der Frostgrenze -> Heizen auf Frostziel, auch wenn der Plan "aus" sagt.
 *  - Wochenplan liefert die Szene (power, mode, soll, fan, Deckel, Bedarf/Feuchte erlaubt).
 *  - Feuchte darf die Betriebsart auf Entfeuchten stellen oder das Kuehlziel senken.
 *  - Bedarf rechnet die Leistungsgrenze fuer das, was am Ende gilt; der Deckel der Szene begrenzt sie.
 *
 * Betriebsart "adapter": der Adapter stellt power/mode/target/fan. "faikout": das Modul regelt
 * selbst (Faikout-Auto: autoe && autor > 0) - die Betriebsart Heizen/Kuehlen waehlt dann das Modul,
 * der Adapter liefert power, Ziel (das Modul legt es als autot ab), Luefter, Fuehlerwert, Grenze.
 */

const bedarf = require('./bedarf');
const feuchte = require('./feuchte');
const control = require('./control');
const texte = require('./texte');

const VORGABEN = {
    betrieb: 'adapter',
    frostAb: 0,
    frostZiel: 10,
    band: 0.5,
    envAbstandMs: 120000,
    envHaltMs: 300000,
    envSchritt: 0.2,
    fuehlerWeg: 'sollwert',
    korrAbstandMs: 30 * 60000,
    korrMittelMs: 45 * 60000,
    korrTotK: 0.3,
    korrMaxK: 3,
};

/** Leerer Zustand des Koordinators (Bedarf und Feuchte liegen daneben). */
function neuerZustand() {
    return { frost: false, control: null };
}

/**
 * @param {object} e  Eingang
 * @param {object} e.status    gemeldeter Stand {power, mode, heat, target, fan, demand, econo, abtauen, autoe, autor, ble, schritt}
 * @param {number|null} [e.internRaum]  Raumfuehler der Anlage (fuer die Fuehlerkorrektur)
 * @param {object} e.fuehler   {aussen, raum, feuchte} je {messung, quelle, stand, text}
 * @param {object} e.schalter  {plan, feuchte, bedarf}
 * @param {object|null} e.szene  Szene laut Plan (oder null: kein Plan / Plan aus)
 * @param {boolean} e.gesperrt  Handeingriff-Sperre aktiv
 * @param {string} e.faehig    Faehigkeit demand
 * @param {object|null} e.vortag  Vortagswerte
 * @param {object} k  Konfiguration {betrieb, bedarf, feuchte, frostAb, frostZiel, band}
 * @param {object} z  Zustand {koordinator, bedarf, feuchte}
 * @param {number} jetzt  Uhr (ms)
 * @returns {object} {wunsch, demand, control, bedarf, feuchte, gruende, zustandText, zustand}
 */
function koordinieren(e, k, z, jetzt) {
    const kz = { ...neuerZustand(), ...((z && z.koordinator) || {}) };
    const st = e.status || {};
    const raum = e.fuehler.raum.messung ? e.fuehler.raum.messung.wert : null;
    const rh = e.fuehler.feuchte.messung ? e.fuehler.feuchte.messung.wert : null;
    const faikoutAuto = k.betrieb === 'faikout';
    const gruende = [];
    let zustandText = 'ok';
    /** Wunsch: undefined = nicht anfassen */
    let wunsch = {};
    const szene = e.schalter.plan && !e.gesperrt ? e.szene : null;

    // 1. Wochenplan
    if (szene) {
        wunsch = szene.power ? { power: true, mode: szene.mode, target: szene.soll, fan: szene.fan } : { power: false };
        gruende.push(texte.t('koord.planSzene', { name: szene.name }));
    } else if (e.schalter.plan) {
        gruende.push(texte.t('koord.planKeine'));
    }
    // Handeingriff (Nutzerentscheid 20.11.2026): sperrt NUR Plan und Szenen. Schutz, Feuchte und
    // Bedarf laufen weiter.
    if (e.gesperrt) {
        wunsch = {};
        gruende.length = 0;
        gruende.push(texte.t('koord.hand'));
        zustandText = 'manual';
    }

    // 2. Schutz (Frost) - ueber dem Plan
    if (k.frostAb > 0 && Number.isFinite(raum)) {
        if (raum < k.frostAb) {
            kz.frost = true;
        } else if (raum > k.frostAb + 1) {
            kz.frost = false;
        }
    } else {
        kz.frost = false;
    }
    if (kz.frost) {
        const heiztSchon = wunsch.power === true && wunsch.mode === 'heat' && wunsch.target >= k.frostZiel;
        const laeuftSchon = !szene && st.power === true && st.mode === 'heat' && st.target >= k.frostZiel;
        if (!heiztSchon && !laeuftSchon) {
            wunsch = { power: true, mode: 'heat', target: k.frostZiel, fan: wunsch.fan };
            gruende.push(texte.t('koord.frost', { raum, grenze: k.frostAb }));
        }
    }

    // 3. Feuchte - bezogen auf das, was ohne Feuchteeingriff gelten wuerde
    const basisPower = wunsch.power !== undefined ? wunsch.power : st.power === true;
    const basisMode = wunsch.mode !== undefined ? wunsch.mode : kz.feuchteVorMode || st.mode;
    const heizt = basisMode === 'heat' || ((basisMode === 'heat_cool' || basisMode === 'auto') && st.heat !== false);
    const feuchteErlaubt = e.schalter.feuchte && (!szene || szene.feuchte) && !kz.frost;
    const f = feuchte.bewerten(
        { raum, feuchte: rh, power: basisPower, mode: basisMode, heizt, erlaubt: feuchteErlaubt },
        k.feuchte,
        z && z.feuchte,
        jetzt,
    );
    if (f.ergebnis.bedarf && !faikoutAuto) {
        if (f.ergebnis.massnahme === 'entfeuchten') {
            if (wunsch.mode === undefined && !kz.feuchteVorMode && st.mode && st.mode !== 'dry' && st.mode !== 'off') {
                kz.feuchteVorMode = st.mode; // ohne Plan: Betriebsart fuer das Zurueckstellen merken
            }
            wunsch = { ...wunsch, power: true, mode: 'dry' };
        } else if (f.ergebnis.massnahme === 'zielSenken') {
            const basisZiel = wunsch.target !== undefined ? wunsch.target : (kz.feuchteVorZiel ?? st.target);
            if (wunsch.target === undefined && kz.feuchteVorZiel === undefined && Number.isFinite(st.target)) {
                kz.feuchteVorZiel = st.target;
            }
            if (Number.isFinite(basisZiel)) {
                wunsch = { ...wunsch, target: basisZiel - k.feuchte.senkenK };
            }
        }
    } else if (!f.ergebnis.bedarf) {
        // Eingriff vorbei: ohne Plan den Stand von vorher wiederherstellen
        if (kz.feuchteVorMode) {
            if (wunsch.mode === undefined && st.mode === 'dry') {
                wunsch = { ...wunsch, mode: kz.feuchteVorMode };
            } else {
                delete kz.feuchteVorMode;
            }
        }
        if (kz.feuchteVorZiel !== undefined) {
            if (wunsch.target === undefined && Number.isFinite(st.target) && st.target < kz.feuchteVorZiel) {
                wunsch = { ...wunsch, target: kz.feuchteVorZiel };
            } else {
                delete kz.feuchteVorZiel;
            }
        }
    }
    if (f.ergebnis.zustand !== 'off') {
        gruende.push(texte.t('koord.feuchte', { grund: f.ergebnis.grund }));
    }

    // Faikout-Auto: die Betriebsart waehlt das Modul
    if (faikoutAuto) {
        delete wunsch.mode;
        if (!(st.autoe === true && Number(st.autor) > 0)) {
            gruende.push(texte.t('koord.faikoutAutoAus'));
            // Faikout-Auto im Modul noch nicht eingeschaltet: Einrichtung offen, keine Stoerung
            if (zustandText === 'ok') {
                zustandText = 'setup';
            }
        }
    }

    // 5. Bedarf - fuer den Stand, der am Ende gilt
    const endPower = wunsch.power !== undefined ? wunsch.power : st.power === true;
    const endMode = wunsch.mode !== undefined ? wunsch.mode : st.mode;
    // Ziel ohne Plan: der gemeldete Sollwert - AUSSER das Modul fuehrt ihn gerade selbst nach
    // (Zielband aktiv: der Sollwert der Anlage pendelt dann weit um das Ziel und taugt nicht als
    // Vorgabe; ihn zurueckzufuettern schaukelte das Band hoch). Dann gilt das gemerkte Ziel.
    const bandLaeuft = kz.bandAktiv === true || (Number.isFinite(kz.bandEnde) && jetzt - kz.bandEnde < 11 * 60000);
    if (!bandLaeuft && Number.isFinite(st.target)) {
        kz.bandZiel = st.target;
    }
    const zielOhnePlan = bandLaeuft && Number.isFinite(kz.bandZiel) ? kz.bandZiel : st.target;
    let endZiel = wunsch.target !== undefined ? wunsch.target : zielOhnePlan;

    // 4b. Fremder Raumfuehler als Datenpunkt, Weg "Sollwertkorrektur" (Vorgabe): Die Anlage regelt
    // weiter mit ihrem eigenen Fuehler und ihrem Inverter (kein Takten durch das Modul); der Adapter
    // verschiebt nur ihren Sollwert langsam, bis der Fremdfuehler das Ziel zeigt. Der Fremdfuehler darf
    // traege sein (anderer Raum): korrigiert wird nur im Beharrungszustand und hoechstens alle
    // korrAbstandMs. Es geht keine control-Nachricht hinaus.
    const rq = e.fuehler.raum.quelle;
    const korrWeg = rq === 'dp' && !faikoutAuto && k.fuehlerWeg !== 'modul';
    let korrektur = null;
    if (korrWeg && endPower && !e.gesperrt && (endMode === 'heat' || endMode === 'cool')) {
        const schritt = Number(st.schritt) >= 0.5 ? Number(st.schritt) : 0.5;
        const runden = v => Math.round(v / schritt) * schritt;
        const eigenerBefehl = Number.isFinite(kz.korrZeit) && jetzt - kz.korrZeit < 90000;
        let basis;
        if (wunsch.target !== undefined) {
            basis = wunsch.target;
        } else {
            // Ohne Plan ist das Ziel der Wert, den der Nutzer eingestellt hat. Ein von aussen geaenderter
            // Sollwert der Anlage (Fernbedienung, Datenpunkt) ist ein neues Ziel - der eigene nicht.
            const geaendert =
                Number.isFinite(st.target) &&
                Number.isFinite(kz.korrGemeldet) &&
                Math.abs(st.target - kz.korrGemeldet) > 0.05 &&
                !(Number.isFinite(kz.korrSoll) && Math.abs(st.target - kz.korrSoll) < 0.05) &&
                !eigenerBefehl;
            if (!Number.isFinite(kz.basisZiel) || geaendert) {
                kz.basisZiel = Number.isFinite(st.target) ? st.target : kz.basisZiel;
            }
            basis = kz.basisZiel;
        }
        if (Number.isFinite(st.target)) {
            kz.korrGemeldet = st.target;
        }
        const fremdWert = Number.isFinite(e.fuehler.raum.fremd) ? e.fuehler.raum.fremd : raum;
        let korr = Number.isFinite(kz.zielKorr) ? kz.zielKorr : 0;
        if (Number.isFinite(basis) && Number.isFinite(fremdWert)) {
            const fehler = basis - fremdWert; // > 0: am Fremdfuehler zu kalt -> Sollwert der Anlage hoeher
            const tot = Math.max(k.korrTotK, schritt * 0.6);
            // Beharrungszustand: die Anlage hat ihren eigenen Sollwert erreicht (falls sie einen Fuehler meldet)
            const intern = Number(e.internRaum);
            const beharrt =
                e.internRaum === null ||
                e.internRaum === undefined ||
                !Number.isFinite(intern) ||
                !Number.isFinite(st.target) ||
                Math.abs(intern - st.target) <= 0.7;
            // Der Fehler wird gemittelt (Zeitkonstante korrMittelMs): Die Anlage pendelt bei Schwachlast
            // selbst um ihren Sollwert, und ein traeger Fuehler hinkt nach - einzelne Werte sagen nichts.
            // Gemittelt wird nur im Beharrungszustand und bei ruhigem Fremdfuehler (hoechstens 0,2 K
            // Aenderung in 10 min), sonst wuerde das Aufheizen als Fuehlerversatz gelernt.
            if (!Number.isFinite(kz.korrRuhigZeit) || jetzt - kz.korrRuhigZeit >= 10 * 60000) {
                kz.korrRuhig = Number.isFinite(kz.korrFremdAlt) && Math.abs(fremdWert - kz.korrFremdAlt) <= 0.2;
                kz.korrFremdAlt = fremdWert;
                kz.korrRuhigZeit = jetzt;
            }
            if (!Number.isFinite(kz.korrMittelZeit)) {
                kz.korrMittel = 0;
                kz.korrSchrittZeit = jetzt; // erste Korrektur fruehestens nach einem vollen Abstand
            } else if (beharrt && kz.korrRuhig === true) {
                const dt = Math.min(5 * 60000, Math.max(0, jetzt - kz.korrMittelZeit));
                kz.korrMittel += (1 - Math.exp(-dt / k.korrMittelMs)) * (fehler - kz.korrMittel);
            }
            kz.korrMittelZeit = jetzt;
            if (Math.abs(kz.korrMittel) > tot && jetzt - kz.korrSchrittZeit >= k.korrAbstandMs) {
                const richtung = Math.sign(kz.korrMittel);
                const neu = Math.max(-k.korrMaxK, Math.min(k.korrMaxK, korr + richtung * schritt));
                if (neu !== korr) {
                    korr = neu;
                    // Die erwartete Wirkung des Schritts vorwegnehmen - der naechste Schritt braucht
                    // neue Belege, sonst schaukelt sich die Korrektur am traegen Fuehler auf.
                    kz.korrMittel -= richtung * schritt;
                }
                kz.korrSchrittZeit = jetzt;
            }
            kz.zielKorr = korr;
            const soll = runden(basis + korr);
            if (soll !== kz.korrSoll) {
                kz.korrSoll = soll;
                kz.korrZeit = jetzt;
            }
            wunsch = { ...wunsch, target: soll };
            endZiel = basis;
            korrektur = { ziel: basis, soll, korr };
            gruende.push(
                texte.t('koord.korrektur', {
                    ziel: basis,
                    soll,
                    korr: `${korr >= 0 ? '+' : ''}${korr}`,
                    fremd: fremdWert,
                }),
            );
        }
    } else if (!korrWeg) {
        delete kz.basisZiel;
        delete kz.korrGemeldet;
        delete kz.korrSoll;
    }
    const b = bedarf.berechnen(
        {
            power: endPower,
            mode: endMode,
            heat: st.heat,
            aussen: e.fuehler.aussen.messung,
            aussenGrund: e.fuehler.aussen.messung ? null : e.fuehler.aussen.text,
            raum: e.fuehler.raum.messung,
            ziel: endZiel,
            econo: st.econo === true,
            abtauen: st.abtauen === true,
            faehig: e.faehig,
            vortag: e.vortag,
        },
        k.bedarf,
        z && z.bedarf,
        jetzt,
    );
    let demand = null;
    // Nutzerentscheid 20.11.2026: Regelt das Modul selbst (Faikout-Auto), setzt der Adapter die
    // Leistungsgrenze nur im Modus "Auto" (Vortag + Zuschlag); mit Kennlinie ruht die Bedarfsregelung.
    const ruhtAuto = faikoutAuto && k.bedarf.strategie !== 'vortag';
    if (e.schalter.bedarf && ruhtAuto) {
        gruende.push(texte.t('koord.bedarfRuhtAuto'));
    } else if (e.schalter.bedarf && e.faehig === 'no') {
        // Anlage ohne Leistungsgrenze (z. B. IR-Bruecke oder Geraet, das den Wert nie uebernimmt):
        // die Bedarfsregelung ruht - das ist kein Fehler der Regelung.
        gruende.push(texte.t('koord.bedarfNichtFaehig'));
    } else if (e.schalter.bedarf) {
        if (szene && !szene.bedarf) {
            demand = 100;
            gruende.push(texte.t('koord.bedarfSzeneOhne', { name: szene.name }));
        } else if (b.ergebnis.zustand !== 'neutral') {
            demand = b.ergebnis.sollwert;
            let text = b.ergebnis.grund;
            // Die volle Freigabe (Raum weit hinter dem Ziel, Rueckfall) geht an der Hoechstleistung der
            // Temperaturstufe vorbei - ein gewoehnlicher Kennlinienwert von 100 % nicht (seit die
            // Obergrenze 100 sein darf, sagt die Zahl allein das nicht mehr).
            if (szene && demand !== null && !b.ergebnis.voll && szene.deckel < demand) {
                demand = szene.deckel;
                text += `; ${texte.t('koord.deckel', { name: szene.name, deckel: szene.deckel })}`;
            }
            gruende.push(
                texte.t('koord.bedarf', { grund: `${text}${b.ergebnis.konflikt ? ` | ${b.ergebnis.konflikt}` : ''}` }),
            );
        } else {
            gruende.push(texte.t('koord.bedarf', { grund: b.ergebnis.grund }));
        }
        if (b.ergebnis.zustand === 'fault' && (zustandText === 'ok' || zustandText === 'setup')) {
            zustandText = 'fault';
        }
    }

    // 6. control-Nachricht (Fuehlerwert / Zielband) - nur wenn ein fremder Fuehler fuehren soll
    let ctl = null;
    const fremd = (rq === 'dp' && !korrWeg) || rq === 'ble';
    if (fremd && endPower && !e.gesperrt) {
        const ziel = Number(endZiel);
        ctl = control.controlNachricht({
            betrieb: faikoutAuto ? 'faikoutAuto' : 'adapter',
            env: rq === 'dp' ? raum : null,
            // Ziel als einzelne Zahl (min = max): das Modul regelt mit seiner eigenen Hysterese um das
            // Ziel und schaltet die Anlage NICHT selbst aus (siehe control.js).
            min: Number.isFinite(ziel) ? ziel : null,
            max: Number.isFinite(ziel) ? ziel : null,
            ble: st.ble === true,
        });
        // Firmware (Faikout.c ~4428): eine control-Nachricht nur mit env - ohne Zielband und ohne
        // Faikout-Auto - laesst das Modul im Sekundentakt melden. Deshalb: Entfeuchten/Umluft und
        // ein Modul ohne eingeschaltetes Faikout-Auto bekommen keine control-Nachricht.
        if (ctl && !ctl.target && !(faikoutAuto && st.autoe === true && Number(st.autor) > 0)) {
            ctl = null;
        }
        if (ctl && ctl.target && (endMode === 'dry' || endMode === 'fan_only' || endMode === 'off')) {
            ctl = null; // Zielband nur beim Heizen/Kuehlen
        }
    }
    const bandJetzt = !!(ctl && ctl.target);
    if (kz.bandAktiv && !bandJetzt) {
        kz.bandEnde = jetzt;
    }
    kz.bandAktiv = bandJetzt;
    return {
        wunsch,
        bedarfRuht: ruhtAuto,
        korrektur,
        demand,
        control: ctl,
        bedarf: b.ergebnis,
        feuchte: f.ergebnis,
        gruende,
        zustandText,
        zustand: { koordinator: kz, bedarf: b.zustand, feuchte: f.zustand },
    };
}

/**
 * Soll die control-Nachricht jetzt gesendet werden? Gesendet wird bei geaendertem Inhalt
 * (fruehestens nach `envAbstandMs`) und spaetestens nach `envHaltMs`, damit die Gueltigkeit im
 * Modul (tcontrol = 600 s) nicht ablaeuft.
 *
 * @param {object|null} ctl      gewuenschte Nachricht
 * @param {object|null} letzte   {text, zeit} der letzten gesendeten Nachricht
 * @param {number} jetzt         Uhr
 * @param {object} [g]           Grenzen
 * @returns {boolean} senden
 */
function controlFaellig(ctl, letzte, jetzt, g = VORGABEN) {
    if (!ctl) {
        return false;
    }
    if (!letzte || !Number.isFinite(letzte.zeit)) {
        return true;
    }
    const alter = jetzt - letzte.zeit;
    if (alter >= g.envHaltMs) {
        return true;
    }
    if (JSON.stringify(ctl) === letzte.text || alter < g.envAbstandMs) {
        return false;
    }
    // Fuehlerrauschen (0,1 K hin und her) ist kein Grund fuer einen Befehl: gesendet wird erst bei
    // einer Aenderung des Fuehlerwerts um mindestens envSchritt oder bei geaendertem Zielband.
    let alt;
    try {
        alt = JSON.parse(letzte.text);
    } catch {
        return true;
    }
    const bandGleich = JSON.stringify(alt.target) === JSON.stringify(ctl.target);
    const envGleich =
        (alt.env === undefined && ctl.env === undefined) ||
        (Number.isFinite(alt.env) && Number.isFinite(ctl.env) && Math.abs(alt.env - ctl.env) < g.envSchritt);
    return !(bandGleich && envGleich);
}

module.exports = { VORGABEN, neuerZustand, koordinieren, controlFaellig };
