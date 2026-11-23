'use strict';

/**
 * Effizienz im Betrieb: Waerme-/Kaelteleistung, COP/EER, Tages- und Monatsmengen je Geraet.
 *
 * Diese Datei verbindet die reinen Rechenbausteine (rechnen, luftstrom, wirksamkeit, zaehler, kalibrierung)
 * mit dem Adapter: Sie nimmt jede Statusmeldung eines Moduls, schreibt die Datenpunkte unter
 * <Geraet>.efficiency.*, haelt Mengen, gelernte Luefterdrehzahlen, Kalibrierungen und eine laufende
 * Kalibriermessung im Geraeteobjekt (native.effizienz - uebersteht den Neustart) und beantwortet die Befehle
 * des Reiters "Effizienz".
 *
 * Der Kern je Meldung ist `schritt()` - ohne ioBroker, damit Tests ihn direkt mit dem Simulator fuettern.
 */

const verbrauch = require('../verbrauch');
const namen = require('../namen');
const rechnen = require('./rechnen');
const luftstrom = require('./luftstrom');
const wirksamkeit = require('./wirksamkeit');
const zaehler = require('./zaehler');
const kalibrierung = require('./kalibrierung');
const modelle = require('./modelle');
const texte = require('./texte');
const aufzeichnung = require('../aufzeichnung');

const KANAL = 'efficiency';
/** Die vier Mengen (eigene Zaehler in Wh) und wohin ihre Werte gehen. */
const MENGEN = ['waerme', 'kaelte', 'stromHeizen', 'stromKuehlen'];
/** Zeitkonstante der Glaettung von Leistung und COP in der Anzeige (s). */
const TAU_SEK = 300;
/**
 * Schreiblast: Die Datenpunkte unter efficiency.* werden hoechstens so oft geschrieben (ms) - ausser der
 * Zustand der Anlage wechselt (heizt/taut ab/steht). Die Reihen (JSON) noch seltener.
 */
const SCHREIBEN_MS = 30 * 1000;
const REIHEN_MS = 5 * 60 * 1000;
/** Sichern des Zustands im Geraeteobjekt hoechstens so oft (ms), ausser bei Stundenwechsel und Befehlen. */
const SICHERN_MS = 10 * 60 * 1000;
/** Eigener Verlauf fuer Handmessungen: eine Probe je Minute, 24 Stunden. */
const RING_ABSTAND_MS = 60 * 1000;
const RING_LAENGE = 24 * 60;
/** Kalibriermessung: Abstand der Messpunkte, Wartezeit nach dem Verdichterstart, Punkte je Stufe und Art. */
const MESS_ABSTAND_SEK = 120;
const MESS_ANLAUF_SEK = 300;
const MESS_PUNKTE_JE_STUFE = 120;
/** Ein Sensorwert darf hoechstens so alt sein (ms). */
const SENSOR_ALT_MS = 15 * 60 * 1000;
/** Handmessung: so weit darf die Probe aus dem Verlauf vom angegebenen Zeitpunkt entfernt sein (ms). */
const HAND_FENSTER_MS = 4 * 60 * 1000;

const istZahl = x => typeof x === 'number' && isFinite(x);
const runden = (x, stellen = 2) => (istZahl(x) ? Math.round(x * 10 ** stellen) / 10 ** stellen : null);
const text = v => String(v === undefined || v === null ? '' : v).trim();

/** Leerer Zustand eines Geraets. */
function neuerZustand() {
    return {
        letzte: {}, // zuletzt gemeldete Rohwerte (Meldungen koennen Teilmengen sein)
        zaehler: null, // Stand von zaehler.js
        mengen: {}, // je Menge der Stand von verbrauch.js
        drehzahlen: { heizen: {}, kuehlen: {} },
        kalibrierungen: [],
        aktiv: null, // ID der geltenden Kalibrierung, null = Datenblatt-Schaetzung
        messung: null,
        hand: [], // Handmessungen (Punkte), aus denen eine Kalibrierung wird
        glatt: { q: null, p: null, zeit: null },
        compSeit: null,
        leistungPruef: null, // Multisplit: passt status.consumption zum Innengeraete-Zaehler? (zaehler.leistungPruefen)
        ring: [],
        ergebnis: null, // letzte Schaetzung (fuer Anzeige und Messung)
        werte: null, // letzte Mengenwerte
    };
}

/**
 * Was vom Zustand ins Geraeteobjekt gehoert.
 *
 * @param {object} z  Zustand
 * @returns {object} zu sichernder Teil
 */
function zuSichern(z) {
    return {
        zaehler: z.zaehler,
        mengen: z.mengen,
        drehzahlen: z.drehzahlen,
        kalibrierungen: z.kalibrierungen,
        aktiv: z.aktiv,
        messung: z.messung,
        hand: z.hand,
        leistungPruef: z.leistungPruef || null,
    };
}

/**
 * Drehzahl in 1/min aus dem gemeldeten Wert (Hz oder 1/min je nach Einstellung des Moduls).
 *
 * @param {unknown} wert  gemeldeter Wert von fanfreq
 * @param {string|undefined} einheit  'Hz' | 'rpm' | unbekannt
 * @returns {number|null} Drehzahl oder null
 */
function drehzahl(wert, einheit) {
    if (!istZahl(wert)) {
        return null;
    }
    if (einheit === 'rpm') {
        return wert;
    }
    if (einheit === 'Hz') {
        return wert * 60;
    }
    // unbekannt: ein gebrochener oder kleiner Wert ist Hz
    return !Number.isInteger(wert) || wert <= 60 ? wert * 60 : wert;
}

/**
 * Loest die Einstellungen eines Geraets auf: Modell, Luftstromkennlinien, Datenblatt-Schaetzung von ε.
 *
 * @param {object|null|undefined} zeile  Eintrag aus effizienzGeraete
 * @param {object[]} [eigeneModelle]  effizienzModelle
 * @returns {{zeile: object, modell: object|null, heizen: object, kuehlen: object, vorgabe: {heizen: object, kuehlen: object}}} Einstellungen
 */
function aufloesen(zeile, eigeneModelle) {
    const z = zeile && typeof zeile === 'object' ? zeile : {};
    const modell = modelle.finde(z.modell, eigeneModelle);
    const heizen = luftstrom.kennlinie(modell && modell.luftstromHeizen, z.luftstromHeizen, 'heizen');
    const kuehlen = luftstrom.kennlinie(modell && modell.luftstromKuehlen, z.luftstromKuehlen, 'kuehlen');
    return {
        zeile: z,
        modell,
        heizen,
        kuehlen,
        vorgabe: {
            heizen: { ...wirksamkeit.vorgabe(modell, heizen.werte), guete: 'estimated' },
            kuehlen: { ...wirksamkeit.vorgabe(modell, kuehlen.werte), guete: 'estimated' },
        },
    };
}

/**
 * ε je Betriebsart, wie es gerade gilt: geltende Kalibrierung, sonst Datenblatt-Schaetzung.
 *
 * @param {object} z  Zustand des Geraets
 * @param {object} k  aufgeloeste Einstellungen
 * @returns {{heizen: object, kuehlen: object}} ε je Betriebsart
 */
function geltendesEps(z, k) {
    const kal = z.aktiv ? (z.kalibrierungen || []).find(e => e.id === z.aktiv) : null;
    return {
        heizen: (kal && kal.heizen) || k.vorgabe.heizen,
        kuehlen: (kal && kal.kuehlen) || k.vorgabe.kuehlen,
    };
}

/**
 * Verarbeitet eine Statusmeldung - ohne ioBroker.
 *
 * @param {object} z  Zustand des Geraets (wird veraendert)
 * @param {object} daten  gemeldete Felder des Moduls (state-JSON)
 * @param {object} k  aufgeloeste Einstellungen (aufloesen())
 * @param {number} jetzt  Zeitpunkt in ms
 * @param {object} [opt]  Zusaetze
 * @param {string} [opt.einheitFan]  Einheit von fanfreq ('Hz'|'rpm')
 * @param {number|null} [opt.tAus]  gemessene Austrittstemperatur (dauerhafter Sensor)
 * @param {boolean} [opt.multisplit]  das Modul meldet denselben Aussengeraete-Zaehler wie ein anderes: Strom
 *   aus dem Heiz- + Kuehlzaehler des Innengeraets statt aus Leistung/Zaehler des Aussengeraets
 * @returns {{ergebnis: object, mengen: Record<string, object>, hinweise: string[], stundenwechsel: boolean}} Schaetzung und Mengen
 */
function schritt(z, daten, k, jetzt, opt = {}) {
    for (const f of [
        'power',
        'mode',
        'fan',
        'action',
        'fanfreq',
        'comp',
        'achome',
        'home',
        'liquid',
        'outside',
        'consumption',
        'energy',
        'energyheat',
        'energycool',
        'hum',
    ]) {
        if (daten[f] !== undefined && daten[f] !== null) {
            z.letzte[f] = daten[f];
        }
    }
    const l = z.letzte;
    // Multisplit: status.energy ist der Zaehler des gemeinsamen Aussengeraets - als Strom EINES Innengeraets waere
    // er zu gross (COP zu klein). Rueckfall ist dann der Heiz- + Kuehlzaehler des Innengeraets (Issue #8).
    // status.consumption (S21 "FX60") ist dagegen die Leistung des INNENGERAETS (Faikout-Wiki; an einer
    // Multisplit-Anlage je Innengeraet verschieden, comp gleich - Tester, 22.11.2026): Sie bleibt der Strom, auch
    // fuer die momentane Arbeitszahl - es sei denn, die Plausibilitaet gegen den Innengeraete-Zaehler zeigt, dass
    // sie doch die des ganzen Aussengeraets ist (zaehler.leistungPruefen).
    const innen = !!opt.multisplit && (istZahl(l.energyheat) || istZahl(l.energycool));
    const energieInnen = (istZahl(l.energyheat) ? l.energyheat : 0) + (istZahl(l.energycool) ? l.energycool : 0);
    const gemeinsam = innen && !!z.leistungPruef && z.leistungPruef.bezug === 'aussen';
    const comp = istZahl(l.comp) ? l.comp : null;
    if (comp !== null && comp > 0) {
        z.compSeit = z.compSeit ?? jetzt;
    } else {
        z.compSeit = null;
    }
    const e = {
        power: typeof l.power === 'boolean' ? l.power : undefined,
        mode: l.mode,
        fan: l.fan,
        action: l.action,
        rpm: drehzahl(l.fanfreq, opt.einheitFan),
        comp,
        tEin: istZahl(l.achome) ? l.achome : istZahl(l.home) ? l.home : null,
        tRef: istZahl(l.liquid) ? l.liquid : null,
        pEl: !gemeinsam && istZahl(l.consumption) ? l.consumption : null,
        tAus: istZahl(opt.tAus) ? opt.tAus : null,
        rfEin: istZahl(opt.rfEin) ? opt.rfEin : null,
        rfAus: istZahl(opt.rfAus) ? opt.rfAus : null,
        seitStart: z.compSeit === null ? null : (jetzt - z.compSeit) / 1000,
    };
    const eps = geltendesEps(z, k);
    const r = rechnen.schaetzen(e, { heizen: k.heizen, kuehlen: k.kuehlen, eps, drehzahlen: z.drehzahlen });
    r.eingang = e;
    // seit wann laeuft die Anlage unveraendert auf dieser Luefterstufe und in dieser Art? (Messpunkte der
    // Kalibrierung zaehlen erst, wenn sich die Austrittsluft nach einem Wechsel eingestellt hat)
    const lage = `${r.art}/${l.fan}`;
    if (z.lage !== lage) {
        z.lage = lage;
        z.lageSeit = jetzt;
    }
    r.seitWechsel = (jetzt - (z.lageSeit ?? jetzt)) / 1000;
    r.aussen = istZahl(l.outside) ? l.outside : null;
    r.zeit = jetzt;
    r.multisplit = innen;
    r.leistungGemeinsam = gemeinsam;

    // Drehzahl der fest eingestellten Stufe lernen: nur im eingeschwungenen Betrieb
    const fest = luftstrom.stufeVon(l.fan);
    if (
        fest &&
        ['heizen', 'kuehlen'].includes(r.art) &&
        istZahl(e.rpm) &&
        e.rpm > 0 &&
        e.seitStart >= rechnen.ANLAUF_SEK
    ) {
        z.drehzahlen = { ...z.drehzahlen, [r.art]: luftstrom.lernen(z.drehzahlen[r.art], fest, e.rpm) };
    }

    // Mengen
    const richtung = r.art === 'nichtVerfuegbar' ? null : rechnen.richtung(e);
    z.zaehler = zaehler.probe(z.zaehler, {
        zeit: jetzt,
        richtung,
        leistung: r.leistungW,
        pEl: e.pEl,
        energie: innen ? energieInnen : istZahl(l.energy) ? l.energy : null,
        quelle: innen ? 'innen' : null,
    }).stand;
    z.leistungPruef = innen
        ? zaehler.leistungPruefen(z.leistungPruef, {
              zeit: jetzt,
              pEl: istZahl(l.consumption) ? l.consumption : null,
              energie: energieInnen,
              aktiv: richtung === 'heizen' || richtung === 'kuehlen',
          })
        : z.leistungPruef;
    const mengen = {};
    const hinweise = [];
    let stundenwechsel = false;
    for (const m of MENGEN) {
        const vorher = z.mengen[m] && z.mengen[m].stunde;
        const erg = verbrauch.verarbeiten(z.mengen[m] || null, Math.round(z.zaehler[m]), new Date(jetzt));
        z.mengen[m] = erg.stand;
        mengen[m] = erg.werte;
        hinweise.push(...erg.hinweise);
        stundenwechsel = stundenwechsel || (!!vorher && vorher !== erg.stand.stunde);
    }

    // Glaettung fuer die Anzeige (Verhaeltnis der geglaetteten Leistungen, nicht geglaettetes Verhaeltnis)
    const dt = z.glatt.zeit === null ? 0 : (jetzt - z.glatt.zeit) / 1000;
    if (istZahl(r.leistungW)) {
        z.glatt.q = rechnen.glaetten(z.glatt.q, r.leistungW, dt, TAU_SEK);
        // ohne Leistung (Multisplit: als die des ganzen Aussengeraets erkannt) gibt es keinen Momentan-COP
        z.glatt.p = istZahl(e.pEl) ? rechnen.glaetten(z.glatt.p, e.pEl, dt, TAU_SEK) : null;
        z.glatt.zeit = jetzt;
    } else {
        z.glatt = { q: null, p: null, zeit: null };
    }
    r.copGlatt =
        ['heizen', 'kuehlen'].includes(r.art) &&
        istZahl(z.glatt.q) &&
        istZahl(z.glatt.p) &&
        z.glatt.p >= rechnen.P_MIN_W
            ? z.glatt.q / z.glatt.p
            : null;

    // eigener Verlauf (fuer Handmessungen)
    const letzter = z.ring[z.ring.length - 1];
    if (!letzter || jetzt - letzter.zeit >= RING_ABSTAND_MS) {
        z.ring.push({
            zeit: jetzt,
            art: r.art,
            stufe: r.stufe,
            rpm: e.rpm,
            comp,
            tEin: e.tEin,
            tRef: e.tRef,
            aussen: r.aussen,
            pEl: e.pEl,
        });
        if (z.ring.length > RING_LAENGE) {
            z.ring = z.ring.slice(-RING_LAENGE);
        }
    }
    z.ergebnis = r;
    z.werte = mengen;
    return { ergebnis: r, mengen, hinweise, stundenwechsel };
}

/**
 * Reihen fuer Diagramme: Waerme, Kaelte und Strom je Stunde/Tag/Monat in einer Liste.
 *
 * @param {Record<string, object>} mengen  Werte je Menge (Ausgabe von verbrauch.js)
 * @param {'hours'|'days'|'months'} reihe  Reihe
 * @returns {object[]} [{hour|day|month, heat, cold, elHeat, elCool}]
 */
function reihen(mengen, reihe) {
    const schluessel = { hours: 'hour', days: 'day', months: 'month' }[reihe];
    const feld = { waerme: 'heat', kaelte: 'cold', stromHeizen: 'elHeat', stromKuehlen: 'elCool' };
    const basis = ((mengen.waerme || {})[reihe] || []).map(e => ({ [schluessel]: e[schluessel] }));
    for (const m of MENGEN) {
        const liste = (mengen[m] || {})[reihe] || [];
        // die vier Reihen laufen im Gleichschritt (gleiche Zeitpunkte); von hinten zuordnen
        for (let i = 1; i <= basis.length; i++) {
            const e = liste[liste.length - i];
            basis[basis.length - i][feld[m]] = e ? e.kwh : null;
        }
    }
    return basis;
}

/**
 * Tages- und Monatszahlen aus den Mengen.
 *
 * @param {Record<string, object>} mengen  Werte je Menge
 * @returns {object} {heat: {today,...}, cold: {...}, cop: {today,...}, eer: {...}}
 */
function zusammenfassung(mengen) {
    const zeiten = ['today', 'yesterday', 'thisMonth', 'lastMonth'];
    const von = m => Object.fromEntries(zeiten.map(t => [t, (mengen[m] || {})[t] ?? null]));
    const heat = von('waerme');
    const cold = von('kaelte');
    const elHeat = von('stromHeizen');
    const elCool = von('stromKuehlen');
    return {
        heat,
        cold,
        elHeat,
        elCool,
        cop: Object.fromEntries(zeiten.map(t => [t, zaehler.arbeitszahl(heat[t], elHeat[t])])),
        eer: Object.fromEntries(zeiten.map(t => [t, zaehler.arbeitszahl(cold[t], elCool[t])])),
    };
}

/** Wert des Datenpunkts state zu einer Art der Schaetzung. */
const ZUSTAND = {
    heizen: 'heating',
    kuehlen: 'cooling',
    abtauen: 'defrosting',
    stillstand: 'idle',
    aus: 'off',
    nichtVerfuegbar: 'unavailable',
};

/** Datenpunkte direkt unter efficiency (id, Typ, Rolle, Einheit). */
const FELDER = [
    { id: 'heatOutput', type: 'number', role: 'value.power', unit: 'kW' },
    { id: 'coolingOutput', type: 'number', role: 'value.power', unit: 'kW' },
    { id: 'cop', type: 'number', role: 'value' },
    { id: 'airflow', type: 'number', role: 'value', unit: 'm³/h' },
    { id: 'outletTemperature', type: 'number', role: 'value.temperature', unit: '°C' },
    { id: 'defrosting', type: 'boolean', role: 'indicator' },
    { id: 'state', type: 'string', role: 'state', states: Object.keys(texte.ZUSTAND) },
    { id: 'quality', type: 'string', role: 'state', states: Object.keys(texte.GUETE), immer: true },
    { id: 'uncertainty', type: 'number', role: 'value', unit: '%' },
    { id: 'missing', type: 'string', role: 'text', immer: true },
    { id: 'sharedOutdoorUnit', type: 'boolean', role: 'indicator' },
    { id: 'copToday', type: 'number', role: 'value' },
    { id: 'copYesterday', type: 'number', role: 'value' },
    { id: 'copThisMonth', type: 'number', role: 'value' },
    { id: 'copLastMonth', type: 'number', role: 'value' },
    { id: 'eerToday', type: 'number', role: 'value' },
    { id: 'eerYesterday', type: 'number', role: 'value' },
    { id: 'eerThisMonth', type: 'number', role: 'value' },
    { id: 'eerLastMonth', type: 'number', role: 'value' },
    { id: 'hoursJson', type: 'string', role: 'json' },
    { id: 'daysJson', type: 'string', role: 'json' },
    { id: 'monthsJson', type: 'string', role: 'json' },
];
const MENGEN_FELDER = ['today', 'yesterday', 'thisMonth', 'lastMonth'];

/** Laufzeit der Effizienzrechnung am Adapter. */
class Effizienz {
    /**
     * @param {object} adapter  Adapter (config, geraete, einheiten, wertSchreiben, zaehlerObjekt, extendObject, ...)
     */
    constructor(adapter) {
        this.adapter = adapter;
        /** Zustand je Geraete-ID */
        this.zustand = new Map();
        /** Geraete, fuer die "nicht verfuegbar" schon im Log stand */
        this.gemeldet = new Set();
        /** Geraete, fuer die "Multisplit" schon im Log stand */
        this.multisplitGemeldet = new Set();
    }

    /**
     * Eintrag eines Geraets in einer Liste von Zeilen (nach ID oder Name).
     *
     * @param {string} id  Geraete-ID
     * @param {object[]} [zeilen]  Zeilen (Vorgabe: gespeicherte Einstellungen)
     * @returns {object|null} Zeile oder null
     */
    zeile(id, zeilen) {
        const liste = Array.isArray(zeilen) ? zeilen : (this.adapter.config || {}).effizienzGeraete;
        const g = this.adapter.geraete.get(id);
        const name = g && g.name;
        return (
            (Array.isArray(liste) ? liste : []).find(
                z => z && (text(z.geraet) === id || (name && text(z.geraet) === name)),
            ) || null
        );
    }

    /**
     * Aufgeloeste Einstellungen eines Geraets.
     *
     * @param {string} id  Geraete-ID
     * @param {object} [formular]  ungespeicherte Werte {zeilen, modelle}
     * @returns {object} siehe aufloesen()
     */
    konfig(id, formular) {
        const f = formular || {};
        return aufloesen(
            this.zeile(id, f.zeilen),
            Array.isArray(f.modelle) ? f.modelle : (this.adapter.config || {}).effizienzModelle,
        );
    }

    /**
     * Zustand eines Geraets, beim ersten Mal aus dem Geraeteobjekt geladen.
     *
     * @param {string} id  Geraete-ID
     * @returns {Promise<object>} Zustand
     */
    async laden(id) {
        let z = this.zustand.get(id);
        if (z) {
            return z;
        }
        z = neuerZustand();
        try {
            const o = await this.adapter.getObjectAsync(id);
            const alt = o && o.native && o.native.effizienz;
            if (alt && typeof alt === 'object') {
                Object.assign(z, {
                    zaehler: alt.zaehler || null,
                    mengen: alt.mengen || {},
                    drehzahlen: { heizen: {}, kuehlen: {}, ...(alt.drehzahlen || {}) },
                    kalibrierungen: Array.isArray(alt.kalibrierungen) ? alt.kalibrierungen : [],
                    aktiv: alt.aktiv || null,
                    messung: alt.messung || null,
                    hand: Array.isArray(alt.hand) ? alt.hand : [],
                    leistungPruef:
                        alt.leistungPruef && typeof alt.leistungPruef === 'object' ? alt.leistungPruef : null,
                });
            }
        } catch (e) {
            this.adapter.log.debug(`Efficiency state of ${id} not loaded: ${e.message}`);
        }
        z.gesichert = Date.now();
        this.zustand.set(id, z);
        return z;
    }

    /**
     * Eine Statusmeldung eines Moduls.
     *
     * @param {string} id  Geraete-ID
     * @param {object} g  gemerkter Zustand des Geraets im Adapter
     * @param {object} daten  gemeldete Felder
     */
    async status(id, g, daten) {
        // nur Meldungen mit Messwerten (nicht jede Teilmeldung wie {"up":true})
        if (
            !daten ||
            !['liquid', 'achome', 'home', 'consumption', 'comp', 'fanfreq', 'power', 'mode'].some(f => f in daten)
        ) {
            return;
        }
        const z = await this.laden(id);
        const k = this.konfig(id);
        const einheiten = (this.adapter.einheiten && this.adapter.einheiten.get(id)) || {};
        const jetzt = Date.now();
        // Sensor, der dauerhaft am Luftaustritt bleibt: messen statt schaetzen
        const opt = { einheitFan: einheiten.fanfreq };
        if (k.zeile.dauerhaft && text(k.zeile.austrittDp)) {
            const s = await this.sensor(k.zeile.austrittDp, jetzt);
            opt.tAus = s.wert !== null && s.alter <= SENSOR_ALT_MS ? s.wert : null;
            if (opt.tAus !== null && text(k.zeile.feuchteDp) && g.feuchteEcht && istZahl(z.letzte.hum)) {
                const f = await this.sensor(k.zeile.feuchteDp, jetzt);
                if (f.wert !== null && f.alter <= SENSOR_ALT_MS) {
                    opt.rfEin = z.letzte.hum;
                    opt.rfAus = f.wert;
                }
            }
        }
        // Multisplit: meldet ein anderes Modul denselben Aussengeraete-Zaehler (lib/verbrauch.gemeinsameZaehler)?
        const gruppen = verbrauch.gemeinsameZaehler(verbrauch.aussenZaehler(this.adapter.geraete));
        opt.multisplit = gruppen.has(id);
        if (opt.multisplit && !this.multisplitGemeldet.has(id)) {
            this.multisplitGemeldet.add(id);
            const andere = [...gruppen]
                .filter(([x, kennung]) => x !== id && kennung === gruppen.get(id))
                .map(([x]) => (this.adapter.geraete.get(x) || {}).name || x);
            this.adapter.log.info(
                `${g.name}: reports the same outdoor unit meter (energy) as ${andere.join(', ')} - multi split. ` +
                    'Electricity of this indoor unit: its reported power (consumption), checked against its own ' +
                    'heating/cooling meter; the outdoor unit meter (energy) is counted once per outdoor unit.',
            );
        }
        const bezugVorher = z.leistungPruef ? z.leistungPruef.bezug : null;
        const r = schritt(z, daten, k, jetzt, opt);
        const bezug = z.leistungPruef ? z.leistungPruef.bezug : null;
        if (bezug && bezug !== bezugVorher) {
            this.adapter.log.info(
                bezug === 'aussen'
                    ? `${g.name}: reported power (consumption) is ${z.leistungPruef.faktor} times the increase of the ` +
                          'indoor unit meter - treated as power of the whole outdoor unit (counted once).'
                    : `${g.name}: reported power (consumption) matches the indoor unit meter ` +
                          `(factor ${z.leistungPruef.faktor}) - used as power of this indoor unit.`,
            );
        }
        z.geaendert = true;
        r.hinweise.forEach(h => this.adapter.log.debug(`${g.name} efficiency: ${h}`));
        if (r.ergebnis.art === 'nichtVerfuegbar' && !this.gemeldet.has(id)) {
            this.gemeldet.add(id);
            this.adapter.log.info(
                `${g.name}: heat output and COP are not available - the unit does not report ${r.ergebnis.fehlt.join(', ')}.`,
            );
        }
        await this.schreiben(id, g, z, r);
        if (r.stundenwechsel || jetzt - z.gesichert >= SICHERN_MS) {
            await this.sichern(id, g, z);
        }
    }

    /**
     * Legt Kanal und Datenpunkte an (einmal je Lauf).
     *
     * @param {string} id  Geraete-ID
     * @param {object} g  Geraet
     * @param {boolean} voll  alle Datenpunkte (false: nur Guete und fehlende Werte)
     */
    async anlegen(id, g, voll) {
        const marke = voll ? `${id}.${KANAL}` : `${id}.${KANAL}.quality`;
        if (g.angelegt.has(marke)) {
            return;
        }
        const a = this.adapter;
        const name = n => namen.vollerName(texte.NAMEN[n]);
        await a.extendObject(`${id}.${KANAL}`, { type: 'channel', common: { name: name('kanal') }, native: {} });
        for (const f of FELDER.filter(x => voll || x.immer)) {
            const common = { name: name(f.id), type: f.type, role: f.role, read: true, write: false };
            if (f.unit) {
                common.unit = f.unit;
            }
            if (f.states) {
                common.states = Object.fromEntries(f.states.map(s => [s, s]));
            }
            await a.extendObject(`${id}.${KANAL}.${f.id}`, { type: 'state', common, native: {} });
        }
        if (voll) {
            for (const [zweig, n] of [
                ['heat', 'kanalWaerme'],
                ['cold', 'kanalKaelte'],
            ]) {
                await a.extendObject(`${id}.${KANAL}.${zweig}`, {
                    type: 'channel',
                    common: { name: name(n) },
                    native: {},
                });
                for (const f of MENGEN_FELDER) {
                    await a.zaehlerObjekt(`${id}.${KANAL}.${zweig}.${f}`, texte.NAMEN[f], 'kWh', 'value.energy');
                }
            }
            if (this.preis() > 0) {
                await a.extendObject(`${id}.${KANAL}.heatPrice`, {
                    type: 'state',
                    common: {
                        name: name('heatPrice'),
                        type: 'number',
                        role: 'value',
                        unit: `${this.waehrung || '€'}/kWh`,
                        read: true,
                        write: false,
                    },
                    native: {},
                });
            }
        }
        g.angelegt.add(marke);
    }

    /** @returns {number} Strompreis je kWh aus den Einstellungen (0 = keiner) */
    preis() {
        const p = Number((this.adapter.config || {}).effizienzPreis);
        return isFinite(p) && p > 0 ? p : 0;
    }

    /**
     * Schreibt die Datenpunkte zu einer Schaetzung.
     *
     * @param {string} id  Geraete-ID
     * @param {object} g  Geraet
     * @param {object} z  Zustand
     * @param {object} r  Ergebnis von schritt()
     */
    async schreiben(id, g, z, r) {
        const e = r.ergebnis;
        const a = this.adapter;
        const basis = `${id}.${KANAL}`;
        if (e.art === 'nichtVerfuegbar') {
            await this.anlegen(id, g, false);
            await a.wertSchreiben(`${basis}.quality`, 'unavailable');
            await a.wertSchreiben(`${basis}.missing`, e.fehlt.join(', '));
            return;
        }
        await this.anlegen(id, g, true);
        // Module melden bei jeder Aenderung - nicht jede Meldung muss sechs Datenpunkte neu schreiben
        const jetzt = Date.now();
        if (
            z.geschriebenArt === e.art &&
            z.geschriebenGuete === e.guete &&
            jetzt - (z.geschriebenZeit || 0) < SCHREIBEN_MS
        ) {
            return;
        }
        z.geschriebenArt = e.art;
        z.geschriebenGuete = e.guete;
        z.geschriebenZeit = jetzt;
        const heizt = e.art === 'heizen';
        const kuehlt = e.art === 'kuehlen';
        const s = zusammenfassung(r.mengen);
        const werte = {
            heatOutput: heizt ? runden(e.leistungW / 1000, 2) : 0,
            coolingOutput: kuehlt ? runden(e.leistungW / 1000, 2) : 0,
            cop: runden(e.copGlatt, 2),
            airflow: e.luftstromM3h,
            outletTemperature: e.tAus,
            defrosting: e.abtauen,
            state: ZUSTAND[e.art] || 'off',
            quality: e.guete,
            uncertainty: e.unsicherheit,
            missing: '',
            sharedOutdoorUnit: !!e.multisplit,
            copToday: s.cop.today,
            copYesterday: s.cop.yesterday,
            copThisMonth: s.cop.thisMonth,
            copLastMonth: s.cop.lastMonth,
            eerToday: s.eer.today,
            eerYesterday: s.eer.yesterday,
            eerThisMonth: s.eer.thisMonth,
            eerLastMonth: s.eer.lastMonth,
        };
        const stunde = z.mengen.waerme && z.mengen.waerme.stunde;
        // Tages- und Monatsreihe tragen den laufenden Tag/Monat: alle paar Minuten und beim Stundenwechsel
        if (z.reiheStunde !== stunde || jetzt - (z.reihenZeit || 0) >= REIHEN_MS) {
            z.reihenZeit = jetzt;
            werte.daysJson = JSON.stringify(reihen(r.mengen, 'days'));
            werte.monthsJson = JSON.stringify(reihen(r.mengen, 'months'));
        }
        for (const [k, v] of Object.entries(werte)) {
            // null heisst "gerade kein Wert" (COP im Stillstand): der Datenpunkt wird geleert, nicht eingefroren
            await a.wertSchreiben(`${basis}.${k}`, v === undefined ? null : v);
        }
        // die Stundenreihe aendert sich nur beim Stundenwechsel
        if (z.reiheStunde !== stunde) {
            await a.wertSchreiben(`${basis}.hoursJson`, JSON.stringify(reihen(r.mengen, 'hours')));
            z.reiheStunde = stunde;
        }
        for (const [zweig, m] of [
            ['heat', s.heat],
            ['cold', s.cold],
        ]) {
            for (const f of MENGEN_FELDER) {
                if (m[f] !== null && m[f] !== undefined) {
                    await a.wertSchreiben(`${basis}.${zweig}.${f}`, m[f]);
                }
            }
        }
        if (this.preis() > 0) {
            await a.wertSchreiben(`${basis}.heatPrice`, s.cop.today ? runden(this.preis() / s.cop.today, 3) : null);
        }
    }

    /**
     * Sichert den Zustand eines Geraets im Geraeteobjekt.
     *
     * @param {string} id  Geraete-ID
     * @param {object} g  Geraet
     * @param {object} z  Zustand
     */
    async sichern(id, g, z) {
        if (typeof this.adapter.geraetNochDa === 'function' && !(await this.adapter.geraetNochDa(id, g))) {
            this.zustand.delete(id);
            return;
        }
        z.gesichert = Date.now();
        z.geaendert = false;
        await this.adapter.extendObject(id, { native: { effizienz: zuSichern(z) } });
    }

    /** Sichert alle Geraete (beim Beenden). */
    async sichernAlle() {
        for (const [id, z] of this.zustand) {
            const g = this.adapter.geraete.get(id);
            if (g && z.geaendert) {
                await this.sichern(id, g, z);
            }
        }
    }

    /**
     * Nimmt ein Geraet aus dem Speicher (geloescht oder umbenannt).
     *
     * @param {string} id  Geraete-ID
     */
    vergessen(id) {
        this.zustand.delete(id);
        this.gemeldet.delete(id);
        this.multisplitGemeldet.delete(id);
    }

    /**
     * Zeittakt (alle 30 s): Stundenwechsel der Mengen auch ohne Meldung, Messpunkte der laufenden Kalibrierung.
     */
    async takt() {
        const jetzt = Date.now();
        this.messTaktPruefen();
        for (const [id, z] of [...this.zustand]) {
            const g = this.adapter.geraete.get(id);
            if (!g) {
                continue;
            }
            // Stundenwechsel ohne neue Meldung (Modul weg): Mengen abschliessen
            let wechsel = false;
            for (const m of MENGEN) {
                const erg = verbrauch.pruefen(z.mengen[m] || null, new Date(jetzt));
                if (erg.werte) {
                    z.mengen[m] = erg.stand;
                    if (z.werte) {
                        z.werte[m] = erg.werte;
                    }
                    wechsel = true;
                }
            }
            if (wechsel && z.werte && z.ergebnis && z.ergebnis.art !== 'nichtVerfuegbar') {
                z.geschriebenZeit = 0; // Stundenwechsel: sofort schreiben
                await this.schreiben(id, g, z, { ergebnis: z.ergebnis, mengen: z.werte });
                await this.sichern(id, g, z);
            }
            if (z.messung && z.messung.status === 'laeuft') {
                await this.messpunkt(id, z, jetzt);
            }
        }
    }

    /**
     * Eigener, schneller Takt fuer Messpunkte - nur wenn eine laufende Messung einen kuerzeren Abstand als den
     * 30-s-Takt des Adapters verlangt (Tests am Simulator). Im Normalbetrieb (120 s) gibt es ihn nicht.
     */
    messTaktPruefen() {
        const a = this.adapter;
        const schnell = [...this.zustand.values()]
            .filter(z => z.messung && z.messung.status === 'laeuft' && (z.messung.abstandSek || MESS_ABSTAND_SEK) < 30)
            .map(z => z.messung.abstandSek);
        if (!schnell.length || typeof a.setInterval !== 'function') {
            this.stoppen();
            return;
        }
        if (this.messTakt) {
            return;
        }
        this.messTakt = a.setInterval(
            () => {
                const jetzt = Date.now();
                for (const [id, z] of [...this.zustand]) {
                    if (z.messung && z.messung.status === 'laeuft') {
                        this.messpunkt(id, z, jetzt).catch(e => a.log.debug(`Measuring point: ${e.message}`));
                    }
                }
                this.messTaktPruefen();
            },
            Math.max(2, Math.min(...schnell)) * 1000,
        );
    }

    /** Beendet den schnellen Messtakt (auch beim Beenden des Adapters). */
    stoppen() {
        if (this.messTakt) {
            this.adapter.clearInterval(this.messTakt);
            this.messTakt = null;
        }
    }

    /**
     * Liest einen Sensor (fremder Datenpunkt): Zahl, nicht zu alt.
     *
     * @param {string} dp  Objekt-ID
     * @param {number} jetzt  Zeitpunkt in ms
     * @returns {Promise<{wert: number|null, alter: number|null}>} Wert und Alter in ms
     */
    async sensor(dp, jetzt) {
        if (!text(dp)) {
            return { wert: null, alter: null };
        }
        try {
            const s = await this.adapter.getForeignStateAsync(text(dp));
            const wert = s && s.val !== null && s.val !== '' ? Number(s.val) : NaN;
            if (!isFinite(wert)) {
                return { wert: null, alter: null };
            }
            return { wert, alter: jetzt - (s.ts || 0) };
        } catch {
            return { wert: null, alter: null };
        }
    }

    /**
     * Nimmt - wenn faellig - einen Messpunkt der laufenden Kalibrierung auf.
     *
     * @param {string} id  Geraete-ID
     * @param {object} z  Zustand
     * @param {number} jetzt  Zeitpunkt in ms
     */
    async messpunkt(id, z, jetzt) {
        const m = z.messung;
        if (jetzt - (m.letzter || 0) < (m.abstandSek || MESS_ABSTAND_SEK) * 1000) {
            return;
        }
        m.letzter = jetzt;
        const r = z.ergebnis;
        const zaehlen = grund => {
            m.verworfen[grund] = (m.verworfen[grund] || 0) + 1;
            m.letzterGrund = grund;
            z.geaendert = true;
        };
        const s = await this.sensor(m.austrittDp, jetzt);
        m.sensorWert = s.wert;
        m.sensorAlter = s.alter;
        if (s.wert === null || s.alter > SENSOR_ALT_MS) {
            return zaehlen('sensorAlt');
        }
        if (!r || jetzt - r.zeit > zaehler.MAX_ABSTAND * 1000) {
            return zaehlen('ohneMeldung');
        }
        if (r.art === 'abtauen') {
            return zaehlen('abtauen');
        }
        if (!['heizen', 'kuehlen'].includes(r.art)) {
            return zaehlen('steht');
        }
        const e = r.eingang;
        const warten = m.anlaufSek ?? MESS_ANLAUF_SEK;
        if (!istZahl(e.seitStart) || e.seitStart < warten) {
            return zaehlen('anlauf');
        }
        // nach einem Wechsel der Luefterstufe braucht die Austrittsluft (und der Sensor) ebenso lange
        if (istZahl(r.seitWechsel) && r.seitWechsel < warten) {
            return zaehlen('wechsel');
        }
        const punkt = {
            zeit: jetzt,
            art: r.art,
            stufe: r.stufe,
            tEin: e.tEin,
            tRef: e.tRef,
            tAus: runden(s.wert, 2),
            aussen: r.aussen,
            rpm: e.rpm,
            comp: e.comp,
            pEl: e.pEl,
        };
        if (text(m.feuchteDp)) {
            const f = await this.sensor(m.feuchteDp, jetzt);
            punkt.rfAus = f.wert !== null && f.alter <= SENSOR_ALT_MS ? f.wert : null;
        }
        const urteil = kalibrierung.pruefen(punkt);
        if (!urteil.ok) {
            return zaehlen(urteil.grund);
        }
        // je Stufe und Art nur die juengsten Punkte behalten
        const gleiche = m.punkte.filter(p => p.art === punkt.art && p.stufe === punkt.stufe);
        if (gleiche.length >= MESS_PUNKTE_JE_STUFE) {
            m.punkte.splice(m.punkte.indexOf(gleiche[0]), 1);
        }
        m.punkte.push(punkt);
        m.letzterGrund = '';
        z.geaendert = true;
    }

    // ------------------------------------------------------------------ Befehle des Reiters

    /**
     * Geraete-ID zu dem, was die Seite schickt (ID oder Name).
     *
     * @param {unknown} wert  ID oder Name
     * @returns {string|null} ID oder null
     */
    geraetId(wert) {
        const w = text(wert);
        if (this.adapter.geraete.has(w)) {
            return w;
        }
        for (const [id, g] of this.adapter.geraete) {
            if (g.name === w) {
                return id;
            }
        }
        return null;
    }

    /**
     * Stand eines Geraets fuer die Oberflaeche.
     *
     * @param {string} id  Geraete-ID
     * @param {object} g  Geraet
     * @param {object} [formular]  ungespeicherte Werte {zeilen, modelle}
     * @returns {Promise<object>} Stand
     */
    async stand(id, g, formular) {
        const z = await this.laden(id);
        const k = this.konfig(id, formular);
        const eps = geltendesEps(z, k);
        const r = z.ergebnis;
        const m = z.messung;
        const seiten = { heizen: k.heizen.werte, kuehlen: k.kuehlen.werte };
        const kurz = e =>
            e && {
                stufen: e.stufen,
                unsicherheit: e.unsicherheit,
                guete: e.guete,
                zusammengefasst: !!e.zusammengefasst,
                unterschied: e.unterschied ?? null,
                restfehler: e.restfehler ?? null,
                n: e.n ?? null,
                bf: e.bf ?? null,
                generisch: !!e.generisch,
            };
        const auswertung = punkte => {
            const erg = kalibrierung.auswerten(punkte, k.vorgabe, seiten);
            return {
                heizen: kurz(erg.heizen),
                kuehlen: kurz(erg.kuehlen),
                abdeckung: {
                    heizen: kalibrierung.abdeckung(punkte, 'heizen'),
                    kuehlen: kalibrierung.abdeckung(punkte, 'kuehlen'),
                },
            };
        };
        return {
            id,
            name: g.name,
            online: g.up !== false,
            verfuegbar: !r || r.art !== 'nichtVerfuegbar',
            fehlt: r && r.art === 'nichtVerfuegbar' ? r.fehlt : [],
            wartet: !r,
            modell: k.modell ? k.modell.modell : null,
            generisch: k.heizen.generisch,
            kennlinie: { heizen: k.heizen, kuehlen: k.kuehlen },
            eps: { heizen: kurz(eps.heizen), kuehlen: kurz(eps.kuehlen) },
            vorgabe: { heizen: kurz(k.vorgabe.heizen), kuehlen: kurz(k.vorgabe.kuehlen) },
            drehzahlen: {
                heizen: luftstrom.gelernt(z.drehzahlen.heizen),
                kuehlen: luftstrom.gelernt(z.drehzahlen.kuehlen),
            },
            live: r
                ? {
                      art: r.art,
                      leistungKW: istZahl(r.leistungW) ? runden(r.leistungW / 1000, 2) : null,
                      cop: runden(r.copGlatt, 2),
                      luftstromM3h: r.luftstromM3h,
                      luftstromQuelle: r.luftstromQuelle,
                      stufe: r.stufe,
                      tEin: r.eingang.tEin,
                      tRef: r.eingang.tRef,
                      tAus: r.tAus,
                      pEl: r.eingang.pEl,
                      aussen: r.aussen,
                      // nach Uebernehmen/Zuruecksetzen sofort die neue Guete, nicht erst mit der naechsten Meldung
                      guete: r.guete === 'measured' || !eps[r.art] ? r.guete : eps[r.art].guete,
                      unsicherheit: r.unsicherheit,
                      unsicher: r.unsicher,
                      abtauen: r.abtauen,
                      nurFuehlbar: r.nurFuehlbar,
                      alter: Date.now() - r.zeit,
                  }
                : null,
            mengen: z.werte ? zusammenfassung(z.werte) : null,
            kalibrierungen: z.kalibrierungen.map(e => ({
                id: e.id,
                zeit: e.zeit,
                quelle: e.quelle,
                n: e.n,
                heizen: kurz(e.heizen),
                kuehlen: kurz(e.kuehlen),
                aktiv: e.id === z.aktiv,
            })),
            aktiv: z.aktiv,
            messung: m
                ? {
                      id: m.id,
                      status: m.status,
                      start: m.start,
                      austrittDp: m.austrittDp,
                      feuchteDp: m.feuchteDp || '',
                      sensorWert: m.sensorWert ?? null,
                      sensorAlter: m.sensorAlter ?? null,
                      punkte: m.punkte.length,
                      verworfen: m.verworfen,
                      letzterGrund: m.letzterGrund || '',
                      ...auswertung(m.punkte),
                  }
                : null,
            hand: { punkte: z.hand, ...auswertung(z.hand) },
        };
    }

    /**
     * Beantwortet einen Befehl des Reiters "Effizienz".
     *
     * @param {string} befehl  Name des Befehls
     * @param {object} msg  Nachricht
     * @returns {Promise<object>} Antwort ({error} bei Fehler)
     */
    async befehl(befehl, msg) {
        const a = this.adapter;
        const sprache = typeof a.sprache === 'function' ? await a.sprache() : 'en';
        const fehler = (schluessel, werte) => ({ error: texte.t(texte.MELDUNGEN[schluessel], sprache, werte) });
        if (befehl === 'effizienzStand') {
            const formular = {
                zeilen: Array.isArray(msg.zeilen) ? msg.zeilen : undefined,
                modelle: Array.isArray(msg.modelle) ? msg.modelle : undefined,
            };
            const geraete = [];
            for (const [id, g] of a.geraete) {
                geraete.push(await this.stand(id, g, formular));
            }
            const cfg = a.config || {};
            return {
                sprache,
                geraete,
                history: !!(aufzeichnung.instanzVon(a) && aufzeichnung.konfig(cfg).anmelden),
                grenzen: {
                    ok: kalibrierung.PUNKTE_OK,
                    knapp: kalibrierung.PUNKTE_KNAPP,
                    abstandK: kalibrierung.MIN_ABSTAND_K,
                },
            };
        }
        const id = this.geraetId(msg.geraet);
        const g = id && a.geraete.get(id);
        if (!g) {
            return fehler('geraetUnbekannt', { geraet: text(msg.geraet) });
        }
        const z = await this.laden(id);
        const k = this.konfig(id);
        const seiten = { heizen: k.heizen.werte, kuehlen: k.kuehlen.werte };
        const cfg = a.config || {};
        const zahlOder = (v, sonst) =>
            v !== undefined && v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : sonst;
        const fertig = async () => {
            this.messTaktPruefen();
            z.geschriebenZeit = 0; // Guete und Werte sofort neu schreiben
            await this.sichern(id, g, z);
            return { ok: true, geraet: await this.stand(id, g) };
        };
        const alsKalibrierung = (punkte, quelle) => {
            const erg = kalibrierung.auswerten(punkte, k.vorgabe, seiten);
            if (!erg.heizen && !erg.kuehlen) {
                return null;
            }
            return {
                id: `k${Date.now()}`,
                zeit: Date.now(),
                quelle,
                n: (erg.heizen ? erg.heizen.n : 0) + (erg.kuehlen ? erg.kuehlen.n : 0),
                heizen: erg.heizen,
                kuehlen: erg.kuehlen,
            };
        };
        switch (befehl) {
            case 'effizienzMessung': {
                const m = z.messung;
                switch (text(msg.aktion)) {
                    case 'start': {
                        const dp = text(msg.austrittDp);
                        if (!dp) {
                            return fehler('sensorWaehlen');
                        }
                        const s = await this.sensor(dp, Date.now());
                        if (s.wert === null) {
                            return fehler('sensorFehlt', { dp });
                        }
                        const feuchteDp = text(msg.feuchteDp);
                        if (feuchteDp && (await this.sensor(feuchteDp, Date.now())).wert === null) {
                            return fehler('sensorFehlt', { dp: feuchteDp });
                        }
                        z.messung = {
                            id: `m${Date.now()}`,
                            status: 'laeuft',
                            start: Date.now(),
                            austrittDp: dp,
                            feuchteDp,
                            // Abstand und Anlaufzeit lassen sich fuer Tests am Simulator verkuerzen: in der Nachricht
                            // oder (fuer den Assistenten der Einstellungsseite) ueber zwei undokumentierte Werte der
                            // Instanz, die es in keiner Auslieferung gibt
                            abstandSek: Math.max(
                                2,
                                zahlOder(msg.abstandSek, zahlOder(cfg.effizienzTestAbstandSek, MESS_ABSTAND_SEK)),
                            ),
                            anlaufSek: Math.max(
                                0,
                                zahlOder(msg.anlaufSek, zahlOder(cfg.effizienzTestAnlaufSek, MESS_ANLAUF_SEK)),
                            ),
                            punkte: [],
                            verworfen: {},
                            letzter: 0,
                            sensorWert: s.wert,
                            sensorAlter: s.alter,
                        };
                        a.log.info(`${g.name}: calibration measurement started (outlet sensor ${dp}).`);
                        return fertig();
                    }
                    case 'stopp':
                    case 'weiter':
                        if (!m) {
                            return fehler('keineMessung');
                        }
                        m.status = msg.aktion === 'stopp' ? 'fertig' : 'laeuft';
                        return fertig();
                    case 'uebernehmen': {
                        if (!m) {
                            return fehler('keineMessung');
                        }
                        const kal = alsKalibrierung(m.punkte, 'sensor');
                        if (!kal) {
                            return fehler('keinePunkte');
                        }
                        z.kalibrierungen = [...z.kalibrierungen, kal];
                        z.aktiv = kal.id;
                        z.messung = null;
                        a.log.info(`${g.name}: calibration from ${kal.n} measuring points adopted.`);
                        return fertig();
                    }
                    case 'verwerfen':
                        z.messung = null;
                        return fertig();
                    default:
                        return fehler('keineMessung');
                }
            }
            case 'effizienzKalibrierung': {
                const aktion = text(msg.aktion);
                if (aktion === 'datenblatt') {
                    z.aktiv = null;
                    return fertig();
                }
                const kal = z.kalibrierungen.find(e => e.id === text(msg.id));
                if (!kal) {
                    return fehler('kalibrierungFehlt');
                }
                if (aktion === 'aktivieren') {
                    z.aktiv = kal.id;
                } else if (aktion === 'loeschen') {
                    z.kalibrierungen = z.kalibrierungen.filter(e => e !== kal);
                    if (z.aktiv === kal.id) {
                        z.aktiv = null;
                    }
                }
                return fertig();
            }
            case 'effizienzHand': {
                const aktion = text(msg.aktion);
                if (aktion === 'leeren') {
                    z.hand = [];
                    return fertig();
                }
                if (aktion === 'entfernen') {
                    z.hand = z.hand.filter(p => p.zeit !== Number(msg.zeit));
                    return fertig();
                }
                if (aktion === 'uebernehmen') {
                    const kal = alsKalibrierung(z.hand, 'hand');
                    if (!kal) {
                        return fehler('keinePunkte');
                    }
                    z.kalibrierungen = [...z.kalibrierungen, kal];
                    z.aktiv = kal.id;
                    z.hand = [];
                    return fertig();
                }
                // 'suchen' und 'hinzufuegen': die uebrigen Groessen zum Zeitpunkt zusammentragen
                const zeit = Number(msg.zeit);
                const gefunden = await this.zumZeitpunkt(id, z, zeit);
                const eigen = msg.werte && typeof msg.werte === 'object' ? msg.werte : {};
                const punkt = { zeit, tAus: Number(msg.tAus), quelle: gefunden.quelle };
                for (const f of ['art', 'stufe', 'tEin', 'tRef', 'aussen', 'rpm', 'comp', 'pEl']) {
                    const v =
                        eigen[f] !== undefined && eigen[f] !== null && eigen[f] !== '' ? eigen[f] : gefunden.werte[f];
                    punkt[f] = ['art', 'stufe'].includes(f)
                        ? v || null
                        : v === undefined || v === null || v === ''
                          ? null
                          : Number(v);
                }
                const fehlt = ['art', 'tEin', 'tRef'].filter(f => punkt[f] === null || punkt[f] === undefined);
                if (aktion === 'suchen' || fehlt.length || !istZahl(punkt.tAus)) {
                    return { ok: true, gefunden: punkt, fehlt, quelle: gefunden.quelle };
                }
                const urteil = kalibrierung.pruefen(punkt);
                if (!urteil.ok) {
                    const grund = `grund${urteil.grund[0].toUpperCase()}${urteil.grund.slice(1)}`;
                    return fehler('handUnbrauchbar', {
                        grund: texte.t(texte.MELDUNGEN[grund], sprache, { k: kalibrierung.MIN_ABSTAND_K }),
                    });
                }
                z.hand = [...z.hand.filter(p => p.zeit !== zeit), punkt].sort((x, y) => x.zeit - y.zeit);
                return fertig();
            }
            default:
                return { error: `unknown command ${befehl}` };
        }
    }

    /**
     * Sucht die Werte der Anlage zu einem Zeitpunkt: erst im eigenen Verlauf (24 h), dann im History-Adapter.
     *
     * @param {string} id  Geraete-ID
     * @param {object} z  Zustand
     * @param {number} zeit  Zeitpunkt in ms
     * @returns {Promise<{quelle: 'verlauf'|'history'|'keine', werte: object}>} gefundene Werte
     */
    async zumZeitpunkt(id, z, zeit) {
        let beste = null;
        for (const p of z.ring) {
            if (
                Math.abs(p.zeit - zeit) <= HAND_FENSTER_MS &&
                (!beste || Math.abs(p.zeit - zeit) < Math.abs(beste.zeit - zeit))
            ) {
                beste = p;
            }
        }
        if (beste) {
            const art = ['heizen', 'kuehlen', 'abtauen'].includes(beste.art)
                ? beste.art === 'abtauen'
                    ? 'heizen'
                    : beste.art
                : null;
            return { quelle: 'verlauf', werte: { ...beste, art } };
        }
        const a = this.adapter;
        const instanz = aufzeichnung.instanzVon(a);
        if (!instanz || typeof a.sendToAsync !== 'function') {
            return { quelle: 'keine', werte: {} };
        }
        // history, influxdb und sql: nur aufgezeichnete Datenpunkte, juengster Wert vor dem Zeitpunkt (lib/aufzeichnung.js)
        const rels = [
            'control.mode',
            'status.achome',
            'status.home',
            'status.liquid',
            'control.fan',
            'status.outside',
            'status.fanfreq',
            'status.comp',
            'status.consumption',
        ];
        const gelesen = Object.fromEntries(
            await Promise.all(
                rels.map(async rel => [rel, await aufzeichnung.wertLesen(a, instanz, `${id}.${rel}`, zeit)]),
            ),
        );
        const lies = async rel => gelesen[rel] ?? null;
        const einheiten = (a.einheiten && a.einheiten.get(id)) || {};
        const mode = await lies('control.mode');
        const tEin = (await lies('status.achome')) ?? (await lies('status.home'));
        const tRef = await lies('status.liquid');
        const werte = {
            art: mode === 'heat' ? 'heizen' : mode === 'cool' || mode === 'dry' ? 'kuehlen' : null,
            stufe: luftstrom.stufeVon(await lies('control.fan')),
            tEin,
            tRef,
            aussen: await lies('status.outside'),
            rpm: drehzahl(await lies('status.fanfreq'), einheiten.fanfreq),
            comp: await lies('status.comp'),
            pEl: await lies('status.consumption'),
        };
        const etwas = Object.values(werte).some(v => v !== null && v !== undefined);
        return { quelle: etwas ? 'history' : 'keine', werte };
    }
}

/** Befehle, die befehl() beantwortet. */
const BEFEHLE = ['effizienzStand', 'effizienzMessung', 'effizienzKalibrierung', 'effizienzHand'];

module.exports = {
    Effizienz,
    BEFEHLE,
    KANAL,
    MENGEN,
    FELDER,
    MENGEN_FELDER,
    ZUSTAND,
    neuerZustand,
    zuSichern,
    drehzahl,
    aufloesen,
    geltendesEps,
    schritt,
    reihen,
    zusammenfassung,
};
