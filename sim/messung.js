'use strict';

/*
 * Auswertung einer Messdatei (JSONL aus dienst.js bzw. welt.zeile()) zu Kennzahlen je Modul.
 * Reine Funktion auswerten(); als Programm: node sim/messung.js datei.jsonl -> JSON.
 *
 * Als Sollwert zaehlt `soll` der Zeile (Wunsch des Bewohners laut Szenario), sonst `ziel`
 * (worauf Modul/Anlage gerade regelt). Zaehlerstaende (befehle, flash, failedSet, starts, wh)
 * sind fortlaufend; ausgewertet wird die Differenz zwischen erster und letzter Zeile, die Befehle
 * der ersten Minute zaehlen mit.
 */

const fs = require('node:fs');

const rund = (x, n = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);

/**
 * Quantil einer Zahlenliste.
 *
 * @param {number[]} werte Werte
 * @param {number} q 0..1
 * @returns {number|null} Quantil
 */
function quantil(werte, q) {
    if (!werte.length) {
        return null;
    }
    const s = [...werte].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

/**
 * Zeilen einer JSONL-Datei lesen; kaputte Zeilen werden uebergangen.
 *
 * @param {string} text Dateiinhalt
 * @returns {object[]} Zeilen
 */
function lesen(text) {
    const zeilen = [];
    for (const z of String(text).split('\n')) {
        if (z.trim()) {
            try {
                zeilen.push(JSON.parse(z));
            } catch {
                // abgeschnittene letzte Zeile
            }
        }
    }
    return zeilen;
}

/**
 * Kennzahlen eines Moduls.
 *
 * @param {object[]} z Zeilen dieses Moduls, zeitlich geordnet
 * @param {{band?: number, fensterMin?: number}} opt Toleranzband (K) und Fenster nach einem Sollwertsprung
 * @returns {object} Kennzahlen
 */
function modulAuswerten(z, opt) {
    const band = opt.band ?? 0.5;
    const fenster = (opt.fensterMin ?? 120) * 60;
    const erste = z[0];
    const letzte = z[z.length - 1];
    const dauerSek = Math.max(60, letzte.sek - erste.sek + 60);
    const stunden = dauerSek / 3600;
    const sollVon = x => (typeof x.soll === 'number' ? x.soll : x.ziel);
    const an = z.filter(x => x.power && typeof sollVon(x) === 'number');
    const abw = an.map(x => Math.abs(x.raum - sollVon(x)));
    const watt = z.map(x => x.watt).filter(Number.isFinite);

    // Verdichterstarts: Zaehler der Physik, ersatzweise Flanken von comp.
    let starts = 0;
    if (typeof letzte.starts === 'number') {
        starts = letzte.starts - (erste.starts || 0);
    } else {
        for (let i = 1; i < z.length; i++) {
            if (z[i].comp > 0 && !(z[i - 1].comp > 0)) {
                starts++;
            }
        }
    }
    const befehle = {};
    let befehleGesamt = 0;
    for (const [topic, n] of Object.entries(letzte.befehle || {})) {
        befehle[topic] = { anzahl: n, jeStunde: rund(n / stunden) };
        befehleGesamt += n;
    }

    // Sollwertspruenge: Ueberschwingen = weiteste Ueberschreitung des neuen Sollwerts in Sprungrichtung.
    const spruenge = [];
    for (let i = 1; i < z.length; i++) {
        const vor = sollVon(z[i - 1]);
        const nach = sollVon(z[i]);
        if (typeof vor !== 'number' || typeof nach !== 'number' || Math.abs(nach - vor) < 0.5) {
            continue;
        }
        const hoch = nach > vor;
        let ueber = 0;
        let unter = 0;
        let erreicht = null;
        for (let k = i; k < z.length && z[k].sek - z[i].sek <= fenster; k++) {
            if (sollVon(z[k]) !== nach) {
                break;
            }
            const d = (z[k].raum - nach) * (hoch ? 1 : -1); // > 0: ueber das Ziel hinaus
            if (erreicht === null && Math.abs(z[k].raum - nach) <= band) {
                erreicht = (z[k].sek - z[i].sek) / 60;
            }
            ueber = Math.max(ueber, d);
            if (erreicht !== null) {
                unter = Math.max(unter, -d); // nach dem Erreichen wieder zurueckgefallen
            }
        }
        spruenge.push({
            zeit: z[i].zeit,
            von: vor,
            nach,
            ueberschwingen: rund(ueber),
            unterschwingen: rund(unter),
            einschwingMin: erreicht === null ? null : rund(erreicht, 1),
        });
    }

    return {
        welt: erste.welt,
        szenario: letzte.szenario,
        typ: erste.typ,
        zeilen: z.length,
        dauerStunden: rund(stunden),
        anteilEin: rund(an.length / z.length, 3),
        mittlereAbweichung: abw.length ? rund(abw.reduce((a, b) => a + b, 0) / abw.length, 3) : null,
        groessteAbweichung: abw.length ? rund(Math.max(...abw), 3) : null,
        anteilImBand: abw.length ? rund(abw.filter(a => a <= band).length / abw.length, 3) : null,
        verdichterstarts: starts,
        verdichterstartsJe24h: rund((starts / stunden) * 24, 1),
        abtauungen: typeof letzte.abtauungen === 'number' ? letzte.abtauungen - (erste.abtauungen || 0) : null,
        leistungMax: watt.length ? Math.max(...watt) : null,
        leistungP95: quantil(watt, 0.95),
        energieKWh: rund(((letzte.wh || 0) - (erste.wh || 0)) / 1000, 3),
        befehle,
        befehleJeStunde: rund(befehleGesamt / stunden),
        flash: letzte.flash || 0,
        failedSet: letzte.failedSet || 0,
        neustarts: letzte.neustarts || 0,
        sollwertspruenge: spruenge,
        groesstesUeberschwingen: spruenge.length ? Math.max(...spruenge.map(s => s.ueberschwingen)) : null,
    };
}

/**
 * Messdatei auswerten.
 *
 * @param {object[]|string} eingabe Zeilen oder Dateiinhalt
 * @param {{band?: number, fensterMin?: number}} [opt] Toleranzband (K, Vorgabe 0,5), Fenster nach Sprung (min, Vorgabe 120)
 * @returns {{module: Record<string, object>, marken: object[]}} Kennzahlen je "<welt>/<modul>"
 */
function auswerten(eingabe, opt = {}) {
    const zeilen = typeof eingabe === 'string' ? lesen(eingabe) : eingabe;
    const gruppen = new Map();
    const marken = [];
    for (const z of zeilen) {
        if (z.marke) {
            marken.push(z);
        } else if (z.modul) {
            const k = `${z.welt || 'welt'}/${z.modul}`;
            if (!gruppen.has(k)) {
                gruppen.set(k, []);
            }
            gruppen.get(k).push(z);
        }
    }
    const module = {};
    for (const [k, z] of gruppen) {
        module[k] = modulAuswerten(z, opt);
    }
    return { module, marken };
}

if (require.main === module) {
    const datei = process.argv[2];
    if (!datei) {
        console.error('usage: node sim/messung.js file.jsonl');
        process.exit(2);
    }
    console.log(JSON.stringify(auswerten(fs.readFileSync(datei, 'utf8')), null, 2));
}

module.exports = { auswerten, lesen, quantil };
