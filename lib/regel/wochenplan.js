'use strict';

/**
 * Wochenplan mit Szenen. Rein: die Uhr kommt herein, gerechnet wird in ORTSZEIT (Wanduhr) -
 * ein Schaltpunkt "06:00" gilt um 06:00 Ortszeit, auch am Tag der Zeitumstellung. Eine Uhrzeit, die
 * es an dem Tag nicht gibt (02:30 im Maerz), faellt auf die naechste gueltige Minute; eine doppelte
 * (02:30 im Oktober) schaltet beim ersten Durchlauf.
 *
 * Plan: sieben Tage (Index 0 = Montag), je Tag eine Liste {t: Minute des Tages, s: Szenen-ID},
 * aufsteigend. Fehlt der Eintrag um 00:00, gilt die letzte Szene des Vortags weiter.
 */

const texte = require('./texte');
const nutzlast = require('./nutzlast');

const TAG_MS = 24 * 3600000;

/** Vorgabe-Szenen (Nutzerentwurf 20.11.2026). `deckel` begrenzt die Leistungsgrenze zusaetzlich. */
const VORGABE_SZENEN = [
    {
        id: 'komfort',
        name: 'Komfort',
        power: true,
        mode: 'heat',
        soll: 21,
        fan: 'auto',
        bedarf: true,
        feuchte: true,
        deckel: 95,
    },
    {
        id: 'absenken',
        name: 'Absenken',
        power: true,
        mode: 'heat',
        soll: 19,
        fan: 'night',
        bedarf: true,
        feuchte: true,
        deckel: 60,
    },
    {
        id: 'abwesend',
        name: 'Abwesend',
        power: true,
        mode: 'heat',
        soll: 17,
        fan: 'auto',
        bedarf: true,
        feuchte: false,
        deckel: 50,
    },
    {
        id: 'aus',
        name: 'Aus',
        power: false,
        mode: 'heat',
        soll: 17,
        fan: 'auto',
        bedarf: false,
        feuchte: false,
        deckel: 95,
    },
];

const MODI = ['heat', 'cool', 'heat_cool', 'dry', 'fan_only'];
const LUEFTER = ['auto', 'night', 'low', 'lowMedium', 'medium', 'mediumHigh', 'high'];

/**
 * Die Vorgabe-Szenen mit Namen in der geltenden Sprache (die IDs bleiben, an ihnen haengt der Plan).
 *
 * @returns {Array<object>} Szenen
 */
function vorgabeSzenen() {
    const namen = {
        komfort: texte.t('szene.komfort'),
        absenken: texte.t('szene.absenken'),
        abwesend: texte.t('szene.abwesend'),
        aus: texte.t('szene.aus'),
    };
    return VORGABE_SZENEN.map(s => ({ ...s, name: namen[s.id] || s.name }));
}

/**
 * Prueft und normalisiert die Szenenliste.
 *
 * @param {unknown} roh  Liste aus der Konfiguration
 * @returns {{szenen: Map<string, object>, fehler: string|null}} Szenen nach ID
 */
function szenenLesen(roh) {
    const liste = Array.isArray(roh) && roh.length ? roh : vorgabeSzenen();
    const szenen = new Map();
    for (const [i, s] of liste.entries()) {
        if (!s || typeof s !== 'object') {
            return { szenen, fehler: texte.t('plan.szeneKeinObjekt', { nr: i + 1 }) };
        }
        const name = String(s.name || s.id || '').trim();
        const id = String(s.id || name)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_');
        if (!id) {
            return { szenen, fehler: texte.t('plan.szeneOhneName', { nr: i + 1 }) };
        }
        if (szenen.has(id)) {
            return { szenen, fehler: texte.t('plan.szeneDoppelt', { id }) };
        }
        const power = s.power !== false && s.power !== 'false';
        const mode = MODI.includes(s.mode) ? s.mode : 'heat';
        const soll = Number(s.soll);
        if (power && !(soll >= 10 && soll <= 32)) {
            return { szenen, fehler: texte.t('plan.szeneZiel', { name, wert: s.soll }) };
        }
        const deckel = s.deckel === undefined || s.deckel === null || s.deckel === '' ? 100 : Number(s.deckel);
        if (!(deckel >= 30 && deckel <= 100)) {
            return { szenen, fehler: texte.t('plan.szeneDeckel', { name, wert: s.deckel }) };
        }
        szenen.set(id, {
            id,
            name: name || id,
            power,
            mode,
            soll: Number.isFinite(soll) ? soll : 20,
            fan: LUEFTER.includes(s.fan) ? s.fan : 'auto',
            bedarf: s.bedarf !== false && s.bedarf !== 'false',
            feuchte: s.feuchte !== false && s.feuchte !== 'false',
            deckel,
        });
    }
    return { szenen, fehler: null };
}

/**
 * Prueft und normalisiert einen Wochenplan.
 *
 * @param {unknown} roh  Plan (Array mit 7 Tagen) oder JSON-Text
 * @param {Map<string, object>} szenen  bekannte Szenen
 * @returns {{plan: Array<Array<{t: number, s: string}>>|null, fehler: string|null}} Plan oder Fehler
 */
function planLesen(roh, szenen) {
    let p = roh;
    if (typeof roh === 'string') {
        if (!roh.trim()) {
            return { plan: null, fehler: texte.t('plan.keiner') };
        }
        try {
            p = JSON.parse(roh);
        } catch {
            return { plan: null, fehler: texte.t('plan.keinJson') };
        }
    }
    if (!Array.isArray(p) || p.length !== 7) {
        return { plan: null, fehler: texte.t('plan.siebenTage') };
    }
    const plan = [];
    for (const [d, tag] of p.entries()) {
        if (!Array.isArray(tag)) {
            return { plan: null, fehler: texte.t('plan.tagKeineListe', { tag: d + 1 }) };
        }
        const punkte = [];
        for (const e of tag) {
            const t = Math.round(Number(e && e.t));
            const s = String((e && e.s) || '');
            if (!Number.isFinite(t) || t < 0 || t > 1439) {
                return { plan: null, fehler: texte.t('plan.schaltzeit', { tag: d + 1, zeit: e && e.t }) };
            }
            if (!szenen.has(s)) {
                return { plan: null, fehler: texte.t('plan.szeneFehlt', { tag: d + 1, szene: s }) };
            }
            punkte.push({ t, s });
        }
        punkte.sort((a, b) => a.t - b.t);
        // gleiche Minute doppelt: der letzte Eintrag gilt
        plan.push(punkte.filter((e, i) => i === punkte.length - 1 || punkte[i + 1].t !== e.t));
    }
    if (!plan.some(tag => tag.length)) {
        return { plan: null, fehler: texte.t('plan.leer') };
    }
    return { plan, fehler: null };
}

/**
 * Ostersonntag (Gauss/Butcher) als [Monat 1..12, Tag].
 *
 * @param {number} jahr  Jahr
 * @returns {number[]} [Monat, Tag]
 */
function ostern(jahr) {
    const a = jahr % 19;
    const b = Math.floor(jahr / 100);
    const c = jahr % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const monat = Math.floor((h + l - 7 * m + 114) / 31);
    const tag = ((h + l - 7 * m + 114) % 31) + 1;
    return [monat, tag];
}

const z2 = n => String(n).padStart(2, '0');
const tagText = d => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;

/**
 * Bundesweite gesetzliche Feiertage in Deutschland als Menge "YYYY-MM-DD".
 *
 * @param {number} jahr  Jahr
 * @returns {Set<string>} Feiertage
 */
function feiertageDE(jahr) {
    const [om, ot] = ostern(jahr);
    const rel = n => tagText(new Date(jahr, om - 1, ot + n, 12));
    return new Set([
        `${jahr}-01-01`,
        rel(-2),
        rel(1),
        `${jahr}-05-01`,
        rel(39),
        rel(50),
        `${jahr}-10-03`,
        `${jahr}-12-25`,
        `${jahr}-12-26`,
    ]);
}

/**
 * Liest eine Liste eigener Feiertage "2026-12-24, 24.12., 31.12.2026" (ohne Jahr = jedes Jahr).
 *
 * @param {unknown} text  Eingabe
 * @returns {{fest: Set<string>, jaehrlich: Set<string>}} Datumsmengen ("YYYY-MM-DD" und "MM-DD")
 */
function feiertageLesen(text) {
    const fest = new Set();
    const jaehrlich = new Set();
    for (const teil of String(text || '').split(/[,;\s]+/)) {
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(teil);
        if (m) {
            fest.add(`${m[1]}-${z2(m[2])}-${z2(m[3])}`);
            continue;
        }
        m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(teil);
        if (m && m[3]) {
            fest.add(`${m[3]}-${z2(m[2])}-${z2(m[1])}`);
        } else if (m) {
            jaehrlich.add(`${z2(m[2])}-${z2(m[1])}`);
        }
    }
    return { fest, jaehrlich };
}

/**
 * Ist der Tag ein Feiertag?
 *
 * @param {Date} d  Datum (Ortszeit)
 * @param {{deutschland?: boolean, eigene?: {fest: Set<string>, jaehrlich: Set<string>}}} [opt]  Feiertagsquellen
 * @returns {boolean} Feiertag
 */
function istFeiertag(d, opt = {}) {
    const t = tagText(d);
    if (opt.deutschland && feiertageDE(d.getFullYear()).has(t)) {
        return true;
    }
    return !!opt.eigene && (opt.eigene.fest.has(t) || opt.eigene.jaehrlich.has(t.slice(5)));
}

/**
 * Planindex (0 = Montag) fuer ein Datum; an Feiertagen der Sonntag.
 *
 * @param {Date} d  Datum
 * @param {object} [opt]  {feiertagSonntag, deutschland, eigene}
 * @returns {number} 0..6
 */
function planTag(d, opt = {}) {
    if (opt.feiertagSonntag && istFeiertag(d, opt)) {
        return 6;
    }
    return (d.getDay() + 6) % 7;
}

/**
 * Alle Schaltpunkte eines Kalendertags als Zeitstempel.
 *
 * @param {Array<Array<{t: number, s: string}>>} plan  Plan
 * @param {Date} tag  beliebiger Zeitpunkt an diesem Tag
 * @param {object} opt  Feiertagsoptionen
 * @returns {Array<{zeit: number, s: string}>} Schaltpunkte
 */
function punkteAm(plan, tag, opt) {
    const mittag = new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), 12);
    return plan[planTag(mittag, opt)].map(e => ({
        zeit: new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), Math.floor(e.t / 60), e.t % 60).getTime(),
        s: e.s,
    }));
}

/**
 * Liest eine Abwesenheit {from, to, scene} - oder {von, bis, szene} im Format des Vorabstands
 * (Zeitstempel in ms oder ISO-Text).
 *
 * @param {unknown} roh  Objekt oder JSON-Text
 * @param {Map<string, object>} szenen  Szenen
 * @returns {{von: number, bis: number, szene: string}|null} Abwesenheit oder null
 */
function abwesenheitLesen(roh, szenen) {
    const a = nutzlast.lesen('abwesenheit', roh);
    if (!a) {
        return null;
    }
    const zeit = v => (typeof v === 'number' ? v : Date.parse(String(v)));
    const von = zeit(a.von);
    const bis = zeit(a.bis);
    if (!Number.isFinite(von) || !Number.isFinite(bis) || bis <= von || !szenen.has(String(a.szene))) {
        return null;
    }
    return { von, bis, szene: String(a.szene) };
}

/**
 * Welche Szene gilt jetzt und wann wird das naechste Mal umgeschaltet?
 *
 * @param {Array<Array<{t: number, s: string}>>} plan  gepruefter Plan
 * @param {number} jetzt  Uhr (ms)
 * @param {object} [opt]  {feiertagSonntag, deutschland, eigene, abwesenheit}
 * @returns {{szene: string|null, quelle: string, seit: number|null, naechster: {zeit: number, szene: string}|null}} Stand
 */
function stand(plan, jetzt, opt = {}) {
    const heute = new Date(jetzt);
    // Schaltpunkte von vor 8 Tagen bis in 8 Tagen - der letzte vor "jetzt" gilt.
    const punkte = [];
    for (let k = -8; k <= 8; k++) {
        const tag = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + k, 12);
        punkte.push(...punkteAm(plan, tag, opt));
    }
    punkte.sort((a, b) => a.zeit - b.zeit);
    let aktuell = null;
    for (const p of punkte) {
        if (p.zeit <= jetzt) {
            aktuell = p;
        }
    }
    const planSzene = aktuell ? aktuell.s : null;
    const naechsterPlan = punkte.find(p => p.zeit > jetzt && p.s !== planSzene) || null;

    const abw = opt.abwesenheit;
    if (abw && jetzt >= abw.von && jetzt < abw.bis) {
        // Nach der Abwesenheit gilt, was der Plan dann vorsieht.
        return {
            szene: abw.szene,
            quelle: 'abwesenheit',
            seit: abw.von,
            naechster: { zeit: abw.bis, szene: stand(plan, abw.bis, { ...opt, abwesenheit: null }).szene },
        };
    }
    let naechster = naechsterPlan ? { zeit: naechsterPlan.zeit, szene: naechsterPlan.s } : null;
    if (abw && abw.von > jetzt && (!naechster || abw.von < naechster.zeit) && abw.szene !== planSzene) {
        naechster = { zeit: abw.von, szene: abw.szene };
    }
    const feiertag = opt.feiertagSonntag && istFeiertag(heute, opt);
    return { szene: planSzene, quelle: feiertag ? 'feiertag' : 'plan', seit: aktuell ? aktuell.zeit : null, naechster };
}

/**
 * Ein einfacher Vorgabeplan: werktags 06:00-08:30 und 16:30-22:00 Komfort, am Wochenende
 * 07:30-23:00, sonst Absenken. Nur wenn beide Szenen existieren.
 *
 * @param {Map<string, object>} szenen  Szenen
 * @returns {Array<Array<{t: number, s: string}>>} Plan
 */
function vorgabePlan(szenen) {
    const ids = [...szenen.keys()];
    const k = szenen.has('komfort') ? 'komfort' : ids[0];
    const a = szenen.has('absenken') ? 'absenken' : ids[Math.min(1, ids.length - 1)];
    const wt = () => [
        { t: 0, s: a },
        { t: 360, s: k },
        { t: 510, s: a },
        { t: 990, s: k },
        { t: 1320, s: a },
    ];
    const we = () => [
        { t: 0, s: a },
        { t: 450, s: k },
        { t: 1380, s: a },
    ];
    return [wt(), wt(), wt(), wt(), wt(), we(), we()];
}

module.exports = {
    VORGABE_SZENEN,
    MODI,
    LUEFTER,
    TAG_MS,
    szenenLesen,
    planLesen,
    ostern,
    feiertageDE,
    feiertageLesen,
    istFeiertag,
    planTag,
    abwesenheitLesen,
    stand,
    vorgabePlan,
};
