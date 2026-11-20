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

const VORGABEN = {
    betrieb: 'adapter',
    frostAb: 0,
    frostZiel: 10,
    band: 0.5,
    envAbstandMs: 120000,
    envHaltMs: 300000,
    envSchritt: 0.2,
};

/** Leerer Zustand des Koordinators (Bedarf und Feuchte liegen daneben). */
function neuerZustand() {
    return { frost: false, control: null };
}

/**
 * @param {object} e  Eingang
 * @param {object} e.status    gemeldeter Stand {power, mode, heat, target, fan, demand, econo, abtauen, autoe, autor, ble}
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
        gruende.push(`Plan: Szene ${szene.name}`);
    } else if (e.schalter.plan) {
        gruende.push('Plan: keine Szene');
    }
    // Handeingriff (Nutzerentscheid 20.11.2026): sperrt NUR Plan und Szenen. Schutz, Feuchte und
    // Bedarf laufen weiter.
    if (e.gesperrt) {
        wunsch = {};
        gruende.length = 0;
        gruende.push('Handeingriff: Plan und Szenen warten');
        zustandText = 'hand';
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
            gruende.push(`Frostschutz: Raum ${raum} °C unter ${k.frostAb} °C`);
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
    if (f.ergebnis.zustand !== 'aus') {
        gruende.push(`Feuchte: ${f.ergebnis.grund}`);
    }

    // Faikout-Auto: die Betriebsart waehlt das Modul
    if (faikoutAuto) {
        delete wunsch.mode;
        if (!(st.autoe === true && Number(st.autor) > 0)) {
            gruende.push('Faikout-Auto ist im Modul nicht eingeschaltet (autoe/autor)');
            zustandText = 'gestört';
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
    const endZiel = wunsch.target !== undefined ? wunsch.target : zielOhnePlan;
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
        gruende.push('Bedarf: ruht – bei Faikout-Auto nur im Modus „Auto“ (Vortag + Zuschlag)');
    } else if (e.schalter.bedarf && e.faehig === 'nein') {
        // Anlage ohne Leistungsgrenze (z. B. IR-Bruecke oder Geraet, das den Wert nie uebernimmt):
        // die Bedarfsregelung ruht - das ist kein Fehler der Regelung.
        gruende.push('Bedarf: Anlage übernimmt keine Leistungsgrenze – ruht');
    } else if (e.schalter.bedarf) {
        if (szene && !szene.bedarf) {
            demand = 100;
            gruende.push(`Bedarf: Szene ${szene.name} ohne Leistungsgrenze → 100 %`);
        } else if (b.ergebnis.zustand !== 'neutral') {
            demand = b.ergebnis.sollwert;
            let text = b.ergebnis.grund;
            if (szene && demand !== null && demand !== 100 && szene.deckel < demand) {
                demand = szene.deckel;
                text += `; Deckel der Szene ${szene.name} ${szene.deckel} %`;
            }
            gruende.push(`Bedarf: ${text}${b.ergebnis.konflikt ? ` | ${b.ergebnis.konflikt}` : ''}`);
        } else {
            gruende.push(`Bedarf: ${b.ergebnis.grund}`);
        }
        if (b.ergebnis.zustand === 'gestört' && zustandText === 'ok') {
            zustandText = 'gestört';
        }
    }

    // 6. control-Nachricht (Fuehlerwert / Zielband) - nur wenn ein fremder Fuehler fuehren soll
    let ctl = null;
    const rq = e.fuehler.raum.quelle;
    const fremd = rq === 'dp' || rq === 'ble';
    if (fremd && endPower && !e.gesperrt) {
        const ziel = Number(endZiel);
        ctl = control.controlNachricht({
            betrieb: faikoutAuto ? 'faikoutAuto' : 'adapter',
            env: rq === 'dp' ? raum : null,
            // Firmware (Faikout.c ~4201/4460): beim Heizen regelt das Modul auf die UNTERE Bandkante,
            // beim Kuehlen auf die obere. Damit der Raum das Ziel trifft, liegt das Band beim Heizen
            // ueber, beim Kuehlen unter dem Ziel; nur im Automatikbetrieb liegt es mittig.
            min: Number.isFinite(ziel)
                ? ziel - (endMode === 'heat' ? 0 : endMode === 'cool' ? 2 * k.band : k.band)
                : null,
            max: Number.isFinite(ziel)
                ? ziel + (endMode === 'heat' ? 2 * k.band : endMode === 'cool' ? 0 : k.band)
                : null,
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
