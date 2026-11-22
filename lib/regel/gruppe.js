'use strict';

/**
 * Multisplit: EINE Leistungsgrenze je Aussengeraet (Gruppe). Rein: keine Timer, kein Adapter.
 *
 * Nutzerentscheid 22.11.2026: Alle Innengeraete einer Gruppe bekommen denselben demand-Wert, auch die
 * ausgeschalteten. Der Wert ist das MAXIMUM der Anforderungen der laufenden Innengeraete. Damit ist es
 * egal, ob die Anlage das Minimum, das Maximum oder "hoechster unter 100" nimmt (nicht belegt, siehe
 * messungen/faikout-multisplit-leistungsgrenze.md) - und kein Raum wird unterversorgt.
 *
 *  - Jedes laufende Innengeraet rechnet seine Anforderung wie bisher (Kennlinie bzw. Vortag, Raumkorrektur,
 *    Feuchte, Handeingriff, Frostschutz, Temperaturstufe). "voll" (100) an einem Geraet gilt fuer alle.
 *  - Laeuft kein Innengeraet: einmal 100 an alle, danach Ruhe (keine Vorgabe), bis wieder eines laeuft.
 *  - Ein Schreiber je Gruppe (Haltezeiten, Abstand, Obergrenze je Stunde wie lib/regel/schreiber.js);
 *    ein Befehl der Gruppe geht an alle erreichbaren Mitglieder zusammen.
 *  - Die Gruppe regelt nur, wenn die Bedarfsregelung an ALLEN Innengeraeten eingeschaltet ist und keines
 *    die Leistungsgrenze grundsaetzlich ablehnt (Faehigkeit 'no'). Sonst waere der Wert nicht gleich.
 *  - failed-set an einem AUSGESCHALTETEN Innengeraet ist kein "nicht faehig" (lib/regel/faehigkeit.js)
 *    und auch kein Grund, den Wert immer wieder zu senden: das Geraet zaehlt fuer den Abgleich nicht, bis
 *    es laeuft oder der Gruppenwert sich aendert.
 */

const schreiber = require('./schreiber');
const texte = require('./texte');

/** @returns {{schreiber: object, ruhe: boolean}} leerer Gruppenzustand */
function neuerZustand() {
    return { schreiber: schreiber.neuerZustand(), ruhe: false };
}

/**
 * Mitglied einer Gruppe (ein Innengeraet mit Modul): {id, name, bekannt (die Regelung kennt es), online
 * (Meldung in den letzten 5 min), aktiv (Bedarfsregelung eingeschaltet), faehig ('yes'|'no'|'unknown'),
 * laeuft (heizt bzw. kuehlt, auch Frostschutz und nach Handeingriff), anforderung (eigene Anforderung in %,
 * nur wenn es laeuft), voll (volle Freigabe), abweichung (K hinter dem Ziel), ist (gemeldetes demand),
 * abgelehnt ({wert}: failed-set im ausgeschalteten Zustand), gesendet ({wert}: zuletzt gesendeter Gruppenwert)}.
 *
 */

/**
 * Gruppenwert aus den Mitgliedern.
 *
 * @param {Mitglied[]} mitglieder  alle Innengeraete der Gruppe (mit Modul)
 * @param {object|null} zustand    Gruppenzustand
 * @returns {{art: string, sollwert: number|null, leader: Mitglied|null, laufend: Mitglied[], aus: Mitglied[], offline: Mitglied[], betroffen: Mitglied[], faehig: string, zustand: object}}
 *   art: 'max' | 'eins' | 'keinerLaeuft' | 'ruhe' | 'nichtAktiv' | 'nichtFaehig'
 */
function berechnen(mitglieder, zustand) {
    const z = { ...neuerZustand(), ...(zustand || {}) };
    const liste = Array.isArray(mitglieder) ? mitglieder : [];
    const bekannt = liste.filter(m => m.bekannt);
    const offline = liste.filter(m => !m.bekannt || !m.online);
    const laufend = liste.filter(m => m.bekannt && m.online && m.laeuft && Number.isFinite(m.anforderung));
    const aus = liste.filter(m => m.bekannt && m.online && !laufend.includes(m));
    const basis = { sollwert: null, leader: null, laufend, aus, offline, betroffen: [], faehig: 'unknown' };
    const nichtAktiv = bekannt.filter(m => !m.aktiv);
    if (nichtAktiv.length) {
        return { ...basis, art: 'nichtAktiv', betroffen: nichtAktiv, zustand: z };
    }
    const nichtFaehig = bekannt.filter(m => m.faehig === 'no');
    if (nichtFaehig.length) {
        return { ...basis, art: 'nichtFaehig', betroffen: nichtFaehig, faehig: 'no', zustand: z };
    }
    const faehig = bekannt.some(m => m.faehig === 'yes') ? 'yes' : 'unknown';
    if (laufend.length) {
        z.ruhe = false;
        // Leitgeraet: hoechste Anforderung; bei Gleichstand die volle Freigabe, dann der Raum, der am
        // weitesten hinter seinem Ziel liegt (Kennlinie: dessen Raumkorrektur bestimmt die Gruppe)
        const sortiert = [...laufend].sort(
            (a, b) =>
                b.anforderung - a.anforderung ||
                Number(!!b.voll) - Number(!!a.voll) ||
                (Number.isFinite(b.abweichung) ? b.abweichung : -99) -
                    (Number.isFinite(a.abweichung) ? a.abweichung : -99),
        );
        const leader = sortiert[0];
        return {
            ...basis,
            laufend: sortiert,
            art: laufend.length === 1 ? 'eins' : 'max',
            sollwert: schreiber.geraeteStufe(leader.anforderung),
            leader,
            faehig,
            zustand: z,
        };
    }
    if (!z.ruhe) {
        return { ...basis, art: 'keinerLaeuft', sollwert: 100, faehig, zustand: z };
    }
    return { ...basis, art: 'ruhe', faehig, zustand: z };
}

/**
 * Zaehlt dieses Mitglied beim Abgleich "ist = soll" nicht mit? Ein ausgeschaltetes Geraet, das genau
 * diesen Wert abgelehnt hat (failed-set) oder nach dem Senden gar keinen Wert meldet, wird nicht immer
 * wieder beschrieben - es uebernimmt den Wert ggf. beim Einschalten, dann zaehlt es wieder.
 *
 * @param {Mitglied} m  Mitglied
 * @param {number} stufe  Gruppenwert (Geraetestufe)
 * @returns {boolean} true = nicht mitzaehlen
 */
function ausgenommen(m, stufe) {
    if (m.laeuft) {
        return false;
    }
    if (m.abgelehnt && m.abgelehnt.wert === stufe) {
        return true;
    }
    return !Number.isFinite(m.ist) && !!m.gesendet && m.gesendet.wert === stufe;
}

/**
 * Istwert der Gruppe fuer den Schreiber: alle gleich -> dieser Wert. Weichen Mitglieder ab, waehlt die
 * Funktion den Wert, der die Richtung (und damit die Haltezeit) richtig setzt: liegt das Ziel unter dem
 * hoechsten gemeldeten Wert, wird gesenkt (lange Haltezeit), sonst angehoben (kurze).
 *
 * @param {number} stufe  Gruppenwert (Geraetestufe)
 * @param {Mitglied[]} mitglieder  Mitglieder
 * @returns {number} Istwert (NaN: ein Mitglied meldet keinen Wert)
 */
function istwert(stufe, mitglieder) {
    const relevant = (mitglieder || []).filter(m => m.bekannt && m.online && !ausgenommen(m, stufe));
    if (!relevant.length) {
        return stufe; // niemand erreichbar oder alle ausgenommen: nichts zu tun
    }
    const werte = relevant.map(m => Number(m.ist));
    if (werte.some(w => !Number.isFinite(w))) {
        return NaN;
    }
    const max = Math.max(...werte);
    const min = Math.min(...werte);
    if (max === min) {
        return max;
    }
    return stufe < max ? max : min;
}

/**
 * Mitglieder, deren gemeldeter Wert vom Gruppenwert abweicht (fuer die Anzeige).
 *
 * @param {number|null} stufe  Gruppenwert
 * @param {Mitglied[]} mitglieder  Mitglieder
 * @returns {Mitglied[]} abweichende, erreichbare Mitglieder (ohne ausgenommene)
 */
function abweichend(stufe, mitglieder) {
    if (!Number.isFinite(stufe)) {
        return [];
    }
    return (mitglieder || []).filter(m => m.bekannt && m.online && !ausgenommen(m, stufe) && Number(m.ist) !== stufe);
}

/**
 * Satz "So entsteht der Wert gerade" fuer die Gruppe in der geltenden Sprache.
 *
 * @param {ReturnType<typeof berechnen>} g  Ergebnis von berechnen()
 * @param {string} gruppenName  Name des Aussengeraets
 * @param {Mitglied[]} mitglieder  Mitglieder (fuer Abweichungen und Ablehnungen)
 * @returns {string} Satz
 */
function satz(g, gruppenName, mitglieder) {
    const namen = l => l.map(m => m.name).join(', ');
    const teile = [];
    if (g.art === 'nichtAktiv') {
        teile.push(texte.t('gruppe.nichtAktiv', { namen: namen(g.betroffen) }));
    } else if (g.art === 'nichtFaehig') {
        teile.push(texte.t('gruppe.nichtFaehig', { namen: namen(g.betroffen) }));
    } else if (g.art === 'max' || g.art === 'eins') {
        const eintrag = m =>
            `${m.name} ${Math.round(m.anforderung)}${m.voll ? ` (${texte.t('gruppe.vollKurz')})` : ''}`;
        teile.push(
            g.art === 'eins'
                ? texte.t('gruppe.eins', { wert: g.sollwert, name: eintrag(g.leader) })
                : texte.t('gruppe.max', { wert: g.sollwert, liste: g.laufend.map(eintrag).join(', ') }),
        );
    } else if (g.art === 'keinerLaeuft') {
        teile.push(texte.t('gruppe.keinerLaeuft'));
    } else {
        teile.push(texte.t('gruppe.ruhe'));
    }
    if (g.aus.length && !['nichtAktiv', 'nichtFaehig'].includes(g.art) && g.laufend.length) {
        teile.push(texte.t('gruppe.ausFolgt', { namen: namen(g.aus) }));
    }
    if (g.offline.length) {
        teile.push(texte.t('gruppe.offline', { namen: namen(g.offline) }));
    }
    if (Number.isFinite(g.sollwert)) {
        const ab = abweichend(g.sollwert, mitglieder).filter(m => Number.isFinite(Number(m.ist)));
        if (ab.length) {
            teile.push(texte.t('gruppe.weicht', { liste: ab.map(m => `${m.name} ${m.ist}`).join(', ') }));
        }
        const abgelehnt = (mitglieder || []).filter(
            m => m.bekannt && !m.laeuft && m.abgelehnt && m.abgelehnt.wert === g.sollwert,
        );
        if (abgelehnt.length) {
            teile.push(texte.t('gruppe.abgelehntAus', { namen: namen(abgelehnt) }));
        }
    }
    return texte.t('gruppe.titel', { name: gruppenName, text: teile.join('; ') });
}

module.exports = { neuerZustand, berechnen, istwert, ausgenommen, abweichend, satz };
