'use strict';

/*
 * Multisplit: mehrere Innengeraete an EINEM Aussengeraet - reine Rechenbibliothek ohne ioBroker.
 *
 * Jedes Faikout-Modul sitzt an einem Innengeraet. Was das Aussengeraet betrifft, meldet bei Multisplit
 * jedes Modul gleich: den Zaehler `energy` (S21 "M", Zaehler des Aussengeraets), die Verdichterfrequenz
 * `comp` und die Aussentemperatur `outside`. Je Innengeraet eigen sind `energyheat`/`energycool` (S21 "U").
 *
 * Die Zuordnung steht in der Konfiguration (native.aussengeraete) und wird NIE automatisch gesetzt - der
 * Adapter macht nur einen Vorschlag aus den Daten, der Nutzer uebernimmt ihn mit einem Klick:
 *   [{ id: 'a1', name: 'Garten', weitere: 0, innen: [{ geraet: '<Objekt-ID>', modulId: '<MAC>'|null }],
 *      vortagReferenzW?: 2000 }]   (Bezugsleistung der Gruppenregelung, Strategie "Auto"; ohne = Summe)
 * Ohne Eintrag gilt jedes Geraet als Single-Split (ein Innen-, ein Aussengeraet) - es ist nichts zu tun.
 */

const verbrauch = require('./verbrauch');

/** Minuten, die der Verlauf (comp, outside) je Geraet zurueckreicht. */
const VERLAUF_MIN = 180;
/** Gemeinsame Minuten mit laufendem Verdichter, ab denen der Gleichlauf etwas aussagt. */
const GLEICHLAUF_MIN = 15;
/** Anteil gleicher Minuten, ab dem zwei Geraete als "Verdichter laeuft gleich" gelten. */
const GLEICHLAUF_ANTEIL = 0.9;
/** Verschiedene Verdichterwerte, die in der gemeinsamen Zeit mindestens vorkommen muessen. */
const GLEICHLAUF_STUFEN = 3;
/** Hoechste Zahl weiterer Innengeraete ohne Modul an einem Aussengeraet. */
const WEITERE_MAX = 8;

const istZahl = x => typeof x === 'number' && Number.isFinite(x);
const runden = (x, stellen = 2) => Math.round(x * 10 ** stellen) / 10 ** stellen;

/**
 * Kleinste freie Kennung a1, a2, ...
 *
 * @param {Array<{id: string}>} liste  vorhandene Aussengeraete
 * @returns {string} Kennung
 */
function kennungNeu(liste) {
    const belegt = new Set((liste || []).map(a => a && a.id));
    let n = 1;
    while (belegt.has(`a${n}`)) {
        n++;
    }
    return `a${n}`;
}

/**
 * Konfiguration saeubern: nur gueltige Eintraege, jede Kennung einmal, jedes Innengeraet hoechstens an
 * EINEM Aussengeraet (das erste gewinnt).
 *
 * @param {unknown} roh  native.aussengeraete
 * @returns {Array<{id: string, name: string, weitere: number, innen: Array<{geraet: string, modulId: string|null}>}>} Liste
 */
function normalisieren(roh) {
    const aus = [];
    const vergeben = new Set();
    for (const e of Array.isArray(roh) ? roh : []) {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
            continue;
        }
        let id = String(e.id || '').replace(/[^A-Za-z0-9_-]/g, '');
        if (!id || aus.some(a => a.id === id)) {
            id = kennungNeu(aus);
        }
        const innen = [];
        for (const i of Array.isArray(e.innen) ? e.innen : []) {
            const z = typeof i === 'string' ? { geraet: i } : i;
            if (!z || typeof z.geraet !== 'string' || !z.geraet || vergeben.has(z.geraet)) {
                continue;
            }
            vergeben.add(z.geraet);
            innen.push({ geraet: z.geraet, modulId: typeof z.modulId === 'string' && z.modulId ? z.modulId : null });
        }
        const weitere = Math.round(Number(e.weitere));
        // Bezugsleistung der Strategie "Auto" (Vortag) fuer die Gruppenregelung (lib/regel): nur, wenn gesetzt
        const bezug = Math.round(Number(e.vortagReferenzW));
        aus.push({
            id,
            name: String(e.name || '')
                .trim()
                .slice(0, 60),
            weitere: Number.isFinite(weitere) ? Math.min(WEITERE_MAX, Math.max(0, weitere)) : 0,
            innen,
            ...(Number.isFinite(bezug) && bezug > 0 ? { vortagReferenzW: bezug } : {}),
        });
    }
    return aus;
}

/**
 * Konfiguration gegen die bekannten Geraete aufloesen.
 *
 * Ein Innengeraet wird zuerst ueber die Hardware-ID seines Moduls gesucht (uebersteht das Umbenennen), dann
 * ueber die Objekt-ID. Gleiche Objekt-ID mit anderer Hardware-ID heisst "Modul getauscht" - der Raum ist
 * derselbe, die Zuordnung bleibt. Nicht (mehr) bekannte Geraete bleiben mit `fehlt` in der Gruppe stehen.
 *
 * @param {unknown} konfig  native.aussengeraete
 * @param {Map<string, {name?: string, modulId?: string|null}>} geraete  bekannte Geraete (Objekt-ID -> Angaben)
 * @returns {{gruppen: Array<object>, vonGeraet: Map<string, string>, konfig: Array<object>, geaendert: boolean}}
 *   aufgeloeste Gruppen, Geraet -> Kennung des Aussengeraets, nachgefuehrte Konfiguration und ob sie abweicht
 */
function aufloesen(konfig, geraete) {
    const bekannt = geraete || new Map();
    const nachModul = new Map();
    for (const [id, g] of bekannt) {
        if (g && g.modulId) {
            nachModul.set(g.modulId, id);
        }
    }
    const vonGeraet = new Map();
    let geaendert = false;
    const gruppen = normalisieren(konfig).map(a => {
        const innen = [];
        for (const i of a.innen) {
            let id = i.geraet;
            let umbenannt = false;
            if (i.modulId && nachModul.has(i.modulId) && nachModul.get(i.modulId) !== id) {
                id = nachModul.get(i.modulId);
                umbenannt = true;
            }
            if (vonGeraet.has(id)) {
                geaendert = true; // nach dem Umbenennen doppelt: der zweite Eintrag entfaellt
                continue;
            }
            const g = bekannt.get(id);
            const modulId = (g && g.modulId) || i.modulId || null;
            if (umbenannt || modulId !== i.modulId) {
                geaendert = true;
            }
            if (g) {
                vonGeraet.set(id, a.id);
            }
            innen.push({
                id,
                name: (g && g.name) || id,
                modulId,
                fehlt: !g,
                umbenannt,
                getauscht: !!(g && g.modulId && i.modulId && g.modulId !== i.modulId && !umbenannt),
            });
        }
        return {
            id: a.id,
            name: a.name,
            weitere: a.weitere,
            innen,
            ...(a.vortagReferenzW ? { vortagReferenzW: a.vortagReferenzW } : {}),
        };
    });
    return {
        gruppen,
        vonGeraet,
        geaendert,
        konfig: gruppen.map(a => ({
            id: a.id,
            name: a.name,
            weitere: a.weitere,
            innen: a.innen.map(i => ({ geraet: i.id, modulId: i.modulId })),
            ...(a.vortagReferenzW ? { vortagReferenzW: a.vortagReferenzW } : {}),
        })),
    };
}

/**
 * Einen Messpunkt in den Verlauf eines Geraets legen (ein Wert je Minute, der letzte gewinnt).
 *
 * @param {Map<string, Array<{t: number, comp: number|null, outside: number|null}>>} verlauf  Verlauf je Geraet
 * @param {string} id  Geraet
 * @param {{comp?: unknown, outside?: unknown}} daten  gemeldete Werte (Teilmeldungen erlaubt)
 * @param {number} jetzt  Zeit in ms
 */
function merken(verlauf, id, daten, jetzt) {
    if (!daten || (!istZahl(daten.comp) && !istZahl(daten.outside))) {
        return;
    }
    const t = Math.floor(jetzt / 60000);
    const reihe = verlauf.get(id) || [];
    const letzter = reihe[reihe.length - 1];
    const vorher = letzter || { comp: null, outside: null };
    const punkt = {
        t,
        comp: istZahl(daten.comp) ? daten.comp : vorher.comp,
        outside: istZahl(daten.outside) ? daten.outside : vorher.outside,
    };
    if (letzter && letzter.t === t) {
        reihe[reihe.length - 1] = punkt;
    } else {
        reihe.push(punkt);
    }
    while (reihe.length && reihe[0].t < t - VERLAUF_MIN) {
        reihe.shift();
    }
    verlauf.set(id, reihe);
}

/**
 * Laufen die Verdichter zweier Geraete gleich (derselbe Verdichter)?
 *
 * Gezaehlt werden gemeinsame Minuten, in denen mindestens einer laeuft. "Gleich" heisst: Frequenz bis auf
 * 1 Hz bzw. 2 % und Aussentemperatur bis auf 0,5 K. Zwei getrennte Anlagen laufen nie ueber laengere Zeit
 * und ueber mehrere Frequenzen hinweg genau gleich.
 *
 * @param {Array<{t: number, comp: number|null, outside: number|null}>} a  Verlauf Geraet A
 * @param {Array<{t: number, comp: number|null, outside: number|null}>} b  Verlauf Geraet B
 * @returns {{minuten: number, gleich: number, anteil: number, stufen: number, sicher: boolean}} Ergebnis
 */
function gleichlauf(a, b) {
    const vonB = new Map((b || []).map(p => [p.t, p]));
    let minuten = 0;
    let gleich = 0;
    const stufen = new Set();
    for (const pa of a || []) {
        const pb = vonB.get(pa.t);
        if (!pb || !istZahl(pa.comp) || !istZahl(pb.comp) || (pa.comp <= 0 && pb.comp <= 0)) {
            continue;
        }
        minuten++;
        const grenze = Math.max(1, 0.02 * Math.max(pa.comp, pb.comp));
        const aussenGleich = !istZahl(pa.outside) || !istZahl(pb.outside) || Math.abs(pa.outside - pb.outside) <= 0.5;
        if (Math.abs(pa.comp - pb.comp) <= grenze && aussenGleich) {
            gleich++;
            stufen.add(Math.round(pa.comp));
        }
    }
    const anteil = minuten ? gleich / minuten : 0;
    return {
        minuten,
        gleich,
        anteil: runden(anteil, 3),
        stufen: stufen.size,
        sicher: minuten >= GLEICHLAUF_MIN && anteil >= GLEICHLAUF_ANTEIL && stufen.size >= GLEICHLAUF_STUFEN,
    };
}

/**
 * Schluessel eines Vorschlags (fuer "nicht mehr vorschlagen").
 *
 * @param {string[]} ids  Geraete des Vorschlags
 * @returns {string} Schluessel
 */
function schluessel(ids) {
    return [...ids].sort().join('|');
}

/**
 * Vorschlaege aus den Daten: welche Geraete haengen vermutlich an einem gemeinsamen Aussengeraet?
 *
 * Hinweise, nach Staerke:
 *   zaehler     gleicher Lebensdauer-Zaehler `energy` (ueber 10 kWh, auf 100 Wh gleich) - praktisch eindeutig
 *   verdichter  Verdichter und Aussentemperatur laufen ueber laengere Zeit gleich
 * Zwei Geraete mit bekannten, VERSCHIEDENEN Zaehlern gehoeren sicher nicht zusammen - auch wenn ihre
 * Verdichter zufaellig gleich laufen.
 *
 * @param {object} p  Eingang
 * @param {Map<string, number|null>} p.zaehler  Geraet -> letzter Rohwert `energy` in Wh
 * @param {Map<string, Array<object>>} [p.verlauf]  Verlauf je Geraet (merken())
 * @param {Map<string, string>} [p.vonGeraet]  bestehende Zuordnung Geraet -> Kennung des Aussengeraets
 * @param {string[]} [p.abgelehnt]  Schluessel abgelehnter Vorschlaege
 * @returns {Array<{art: 'neu'|'dazu'|'widerspruch', ids: string[], neu: string[], gruppe: string|null,
 *   gruende: string[], sicherheit: 'hoch'|'mittel', schluessel: string}>} Vorschlaege
 */
function vorschlaege(p) {
    const zaehler = p.zaehler || new Map();
    const verlauf = p.verlauf || new Map();
    const vonGeraet = p.vonGeraet || new Map();
    const abgelehnt = new Set(p.abgelehnt || []);
    const ids = [...new Set([...zaehler.keys(), ...verlauf.keys()])].sort();
    const gleicherZaehler = verbrauch.gemeinsameZaehler(zaehler);
    const zaehlerBekannt = id => istZahl(zaehler.get(id)) && zaehler.get(id) >= verbrauch.GEMEINSAM_AB_WH;

    // Paare mit Hinweis sammeln und zu Gruppen verbinden
    const eltern = new Map(ids.map(id => [id, id]));
    const wurzel = id => {
        while (eltern.get(id) !== id) {
            eltern.set(id, eltern.get(eltern.get(id)));
            id = eltern.get(id);
        }
        return id;
    };
    const hinweise = new Map(); // Wurzel -> {gruende, nurZaehler}
    const paare = [];
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const [a, b] = [ids[i], ids[j]];
            const gruende = [];
            if (gleicherZaehler.has(a) && gleicherZaehler.get(a) === gleicherZaehler.get(b)) {
                gruende.push('zaehler');
            } else if (zaehlerBekannt(a) && zaehlerBekannt(b)) {
                continue; // verschiedene Zaehler: sicher getrennte Aussengeraete
            }
            if (gleichlauf(verlauf.get(a), verlauf.get(b)).sicher) {
                gruende.push('verdichter');
            }
            if (gruende.length) {
                paare.push({ a, b, gruende });
            }
        }
    }
    for (const { a, b } of paare) {
        eltern.set(wurzel(a), wurzel(b));
    }
    for (const { a, gruende } of paare) {
        const w = wurzel(a);
        const h = hinweise.get(w) || { gruende: new Set(), alleZaehler: true };
        gruende.forEach(g => h.gruende.add(g));
        h.alleZaehler = h.alleZaehler && gruende.includes('zaehler');
        hinweise.set(w, h);
    }

    const aus = [];
    for (const [w, h] of hinweise) {
        const mitglieder = ids.filter(id => wurzel(id) === w);
        const gruppen = [...new Set(mitglieder.map(id => vonGeraet.get(id)).filter(Boolean))];
        const frei = mitglieder.filter(id => !vonGeraet.has(id));
        let art;
        if (gruppen.length > 1) {
            art = 'widerspruch';
        } else if (!frei.length) {
            continue; // alle schon am selben Aussengeraet
        } else {
            art = gruppen.length ? 'dazu' : 'neu';
        }
        const s = schluessel(mitglieder);
        if (abgelehnt.has(s)) {
            continue;
        }
        aus.push({
            art,
            ids: mitglieder,
            neu: frei,
            gruppe: gruppen.length === 1 ? gruppen[0] : null,
            gruende: ['zaehler', 'verdichter'].filter(g => h.gruende.has(g)),
            sicherheit: h.alleZaehler ? 'hoch' : 'mittel',
            schluessel: s,
        });
    }
    return aus.sort((x, y) => (x.schluessel < y.schluessel ? -1 : 1));
}

/** Automatisch zuordnen: so lange muessen zwei Zaehler nebeneinander beobachtet sein (Minuten = Messungen). */
const AUTO_MINUTEN = 10;
/** Automatisch zuordnen: groesster Abstand zweier Zaehler desselben Aussengeraets (Wh) - zwei Zaehlerstufen. */
const AUTO_TOLERANZ_WH = 200;
/** Ein Zaehlerwert gilt als frisch, wenn ihn das Modul in den letzten Minuten gemeldet hat. */
const AUTO_FRISCH_MS = 5 * 60000;
/** Beobachtungen je Paar, die aufgehoben werden (eine je Minute). */
const AUTO_RING = 120;

/**
 * Schluessel eines Geraetepaars.
 *
 * @param {string} a  Geraet
 * @param {string} b  Geraet
 * @returns {string} Schluessel (sortiert)
 */
function paarSchluessel(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Beobachtung fuer "Automatisch zuordnen": je Minute den Abstand der Aussengeraete-Zaehler jedes Geraetepaars
 * festhalten - aber nur, wenn BEIDE Module verbunden sind, beide ihren Zaehler gerade erst gemeldet haben und
 * beide ueber 10 kWh stehen. Ein Modul, das offline ist und einen alten Wert stehen hat, liefert so keine
 * Beobachtung; ein Schnappschuss allein genuegt nie.
 *
 * @param {Map<string, {proben: Array<{t: number, d: number, wh: number}>}>} paare  Beobachtungen je Paar (wird ergaenzt)
 * @param {Map<string, {wh: number, zeit: number, online: boolean}>} zaehler  letzter gemeldeter Zaehler je Geraet
 * @param {number} jetzt  Zeit in ms
 */
function paarMerken(paare, zaehler, jetzt) {
    const t = Math.floor(jetzt / 60000);
    const taugt = z =>
        z && z.online && istZahl(z.wh) && z.wh >= verbrauch.GEMEINSAM_AB_WH && jetzt - z.zeit <= AUTO_FRISCH_MS;
    const ids = [...zaehler.keys()].filter(id => taugt(zaehler.get(id))).sort();
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const [a, b] = [zaehler.get(ids[i]), zaehler.get(ids[j])];
            const k = paarSchluessel(ids[i], ids[j]);
            const p = paare.get(k) || { proben: [] };
            const probe = { t, d: Math.abs(a.wh - b.wh), wh: Math.max(a.wh, b.wh) };
            if (p.proben.length && p.proben[p.proben.length - 1].t === t) {
                p.proben[p.proben.length - 1] = probe;
            } else {
                p.proben.push(probe);
            }
            if (p.proben.length > AUTO_RING) {
                p.proben = p.proben.slice(-AUTO_RING);
            }
            paare.set(k, p);
        }
    }
}

/**
 * Urteil ueber ein Geraetepaar aus seinen Beobachtungen.
 *
 * @param {{proben: Array<{t: number, d: number, wh: number}>}|undefined} p  Beobachtungen
 * @returns {{gleich: boolean, sicher: boolean, minuten: number, gewandert: boolean}} gleich: ALLE Beobachtungen
 *   innerhalb der Toleranz; sicher: dazu mindestens AUTO_MINUTEN Beobachtungen ueber mindestens so viele Minuten;
 *   gewandert: der Zaehler ist dabei gestiegen (beide sind zusammen weitergelaufen - staerkster Beleg)
 */
function paarUrteil(p) {
    const proben = (p && p.proben) || [];
    if (!proben.length) {
        return { gleich: false, sicher: false, minuten: 0, gewandert: false };
    }
    const gleich = proben.every(x => x.d <= AUTO_TOLERANZ_WH);
    const spanne = proben[proben.length - 1].t - proben[0].t;
    return {
        gleich,
        sicher: gleich && proben.length >= AUTO_MINUTEN && spanne >= AUTO_MINUTEN - 1,
        minuten: Math.min(proben.length, spanne + 1),
        gewandert: gleich && proben[proben.length - 1].wh > proben[0].wh,
    };
}

/**
 * "Automatisch zuordnen": Gruppen aus den Paaren, deren Zaehler ueber den ganzen Beobachtungszeitraum gleich waren.
 *
 * Nur der Zaehler zaehlt (kein Gleichlauf des Verdichters - der bleibt ein Vorschlag). Bestehende Zuordnungen
 * bleiben unangetastet: freie Geraete kommen zu "ihrem" bestehenden Aussengeraet dazu oder bilden ein neues;
 * eine Gruppe, die ueber zwei bestehende Aussengeraete reicht, wird nicht angefasst.
 *
 * @param {object} p  Eingang
 * @param {Map<string, {proben: Array<object>}>} p.paare  Beobachtungen (paarMerken)
 * @param {Map<string, string>} [p.vonGeraet]  bestehende Zuordnung Geraet -> Kennung
 * @returns {{gruppen: Array<{ids: string[], neu: string[], gruppe: string|null, gewandert: boolean}>,
 *   wartend: Array<{ids: string[], minuten: number}>, noetig: number}} gruppen: sofort zuordenbar;
 *   wartend: Zaehler bisher gleich, aber noch nicht lange genug beobachtet
 */
function automatisch(p) {
    const vonGeraet = p.vonGeraet || new Map();
    const urteile = [...(p.paare || new Map())].map(([k, v]) => ({ ids: k.split('|'), ...paarUrteil(v) }));
    const sammeln = (paare, mitUrteil) => {
        const eltern = new Map();
        const wurzel = id => {
            if (!eltern.has(id)) {
                eltern.set(id, id);
            }
            while (eltern.get(id) !== id) {
                id = eltern.get(id);
            }
            return id;
        };
        paare.forEach(u => eltern.set(wurzel(u.ids[0]), wurzel(u.ids[1])));
        const gruppen = new Map();
        for (const id of [...eltern.keys()].sort()) {
            const w = wurzel(id);
            gruppen.set(w, [...(gruppen.get(w) || []), id]);
        }
        return [...gruppen.values()].map(ids => ({
            ids,
            ...mitUrteil(paare.filter(u => ids.includes(u.ids[0]))),
        }));
    };
    const gruppen = [];
    for (const g of sammeln(
        urteile.filter(u => u.sicher),
        teil => ({ gewandert: teil.some(u => u.gewandert) }),
    )) {
        const bestehend = [...new Set(g.ids.map(id => vonGeraet.get(id)).filter(Boolean))];
        const neu = g.ids.filter(id => !vonGeraet.has(id));
        if (bestehend.length > 1 || !neu.length) {
            continue;
        }
        gruppen.push({ ids: g.ids, neu, gruppe: bestehend[0] || null, gewandert: g.gewandert });
    }
    const fertig = new Set(gruppen.flatMap(g => g.ids));
    const wartend = sammeln(
        urteile.filter(u => u.gleich && !u.sicher),
        teil => ({ minuten: Math.min(...teil.map(u => u.minuten)) }),
    ).filter(g => g.ids.some(id => !vonGeraet.has(id) && !fertig.has(id)));
    return { gruppen, wartend, noetig: AUTO_MINUTEN };
}

/**
 * Vorschlaege einstufen - was darf bei "Alle uebernehmen" vorausgewaehlt sein?
 *   sicher     gleicher Zaehler UND ueber den Beobachtungszeitraum bestaetigt (automatisch())
 *   pruefung   gleicher Zaehler im Augenblick, Beobachtung laeuft noch (minuten von noetig)
 *   unsicher   nur Verdichter-Gleichlauf, kein Zaehler als Beleg
 *
 * @param {ReturnType<typeof vorschlaege>} liste  Vorschlaege
 * @param {ReturnType<typeof automatisch>} auto  Ergebnis der Beobachtung
 * @returns {Array<object>} Vorschlaege mit `stufe`, `minuten`, `noetig`
 */
function einstufen(liste, auto) {
    return (liste || []).map(v => {
        let stufe = 'unsicher';
        let minuten = 0;
        if (v.gruende.includes('zaehler') && v.sicherheit === 'hoch') {
            const bestaetigt = auto.gruppen.some(g => v.ids.every(id => g.ids.includes(id)));
            const wartet = auto.wartend.find(g => v.ids.some(id => g.ids.includes(id)));
            stufe = bestaetigt ? 'sicher' : 'pruefung';
            minuten = bestaetigt ? auto.noetig : wartet ? wartet.minuten : 0;
        }
        return { ...v, stufe, minuten, noetig: auto.noetig };
    });
}

/**
 * Passt eine bestehende Zuordnung zu den Daten?
 *
 * @param {string[]} ids  Innengeraete der Gruppe (nur bekannte)
 * @param {Map<string, number|null>} zaehler  Geraet -> letzter Rohwert `energy` in Wh
 * @returns {'bestaetigt'|'widerspricht'|'unbekannt'} bestaetigt: alle melden denselben Zaehler;
 *   widerspricht: mindestens zwei melden bekannte, verschiedene Zaehler
 */
function pruefung(ids, zaehler) {
    const bekannt = (ids || []).filter(id => istZahl(zaehler.get(id)) && zaehler.get(id) >= verbrauch.GEMEINSAM_AB_WH);
    if (bekannt.length < 2) {
        return 'unbekannt';
    }
    const gleich = verbrauch.gemeinsameZaehler(new Map(bekannt.map(id => [id, zaehler.get(id)])));
    const kennungen = new Set(bekannt.map(id => gleich.get(id) || `einzeln:${id}`));
    if (kennungen.size > 1) {
        return 'widerspricht';
    }
    return bekannt.length === ids.length ? 'bestaetigt' : 'unbekannt';
}

/**
 * Verbrauch eines Aussengeraets auf seine Innengeraete aufteilen.
 *
 * Das Aussengeraet zaehlt EINMAL (sein eigener Zaehler). Die Innengeraete zeigen ihren Heiz- + Kuehlzaehler;
 * was dazwischen fehlt (Bereitschaft, Abtauen, Innengeraete ohne Modul, Zaehlerstufen), ist der "Rest".
 *
 * @param {number|null} aussen  Verbrauch des Aussengeraets (kWh) oder null, wenn unbekannt
 * @param {Array<{id: string, kwh: number|null}>} innen  Verbrauch je Innengeraet (Heizen + Kuehlen)
 * @returns {{aussen: number|null, summeInnen: number, rest: number, innen: Array<{id: string, kwh: number, anteil: number|null}>}}
 *   Anteile (0..1) am Verbrauch des Aussengeraets; ohne dessen Zaehler an der Summe der Innengeraete
 */
function aufteilung(aussen, innen) {
    const liste = (innen || []).map(i => ({ id: i.id, kwh: istZahl(i.kwh) && i.kwh > 0 ? i.kwh : 0 }));
    const summe = liste.reduce((s, i) => s + i.kwh, 0);
    const gesamt = istZahl(aussen) ? Math.max(aussen, summe) : summe;
    return {
        aussen: istZahl(aussen) ? runden(aussen) : null,
        summeInnen: runden(summe),
        rest: istZahl(aussen) ? runden(Math.max(0, aussen - summe)) : 0,
        innen: liste.map(i => ({
            id: i.id,
            kwh: runden(i.kwh),
            anteil: gesamt > 0 ? runden(i.kwh / gesamt, 3) : null,
        })),
    };
}

/**
 * Rest des Aussengeraets je Zeitabschnitt (fuer das Diagramm): Aussenzaehler minus Summe der Innengeraete.
 *
 * @param {Array<number|null>} aussen  Werte des Aussengeraets je Abschnitt
 * @param {Array<Array<number|null>>} innen  Werte der Innengeraete je Abschnitt
 * @returns {Array<number|null>} Rest je Abschnitt (nie negativ; null, wo das Aussengeraet keinen Wert hat)
 */
function restReihe(aussen, innen) {
    return (aussen || []).map((a, i) => {
        if (!istZahl(a)) {
            return null;
        }
        const s = (innen || []).reduce((sum, r) => sum + (istZahl(r[i]) ? r[i] : 0), 0);
        return runden(Math.max(0, a - s));
    });
}

/**
 * Je Abschnitt der groesste Wert mehrerer Reihen - der Zaehler des Aussengeraets kommt von jedem Modul;
 * ein Modul, das spaeter angeschlossen wurde oder eine Luecke hat, zeigt weniger.
 *
 * @param {Array<Array<number|null>>} reihen  Reihen gleicher Laenge
 * @returns {Array<number|null>} Reihe
 */
function hoechste(reihen) {
    const liste = (reihen || []).filter(Array.isArray);
    const n = liste.reduce((m, r) => Math.max(m, r.length), 0);
    return Array.from({ length: n }, (_, i) => {
        const werte = liste.map(r => r[i]).filter(istZahl);
        return werte.length ? Math.max(...werte) : null;
    });
}

/**
 * Arbeitszahl des ganzen Systems: abgegebene Waerme (bzw. entzogene beim Kuehlen) aller Innengeraete
 * durch den Strom des Aussengeraets. Bei Multisplit die einzige belastbare Arbeitszahl.
 *
 * @param {Array<number|null>} waerme  Waerme-/Kaeltemengen der Innengeraete (kWh)
 * @param {number|null} strom  Strom des Aussengeraets (kWh)
 * @returns {number|null} Arbeitszahl oder null (zu wenig Strom fuer eine Aussage: unter 0,3 kWh)
 */
function systemCop(waerme, strom) {
    const q = (waerme || []).filter(istZahl).reduce((s, x) => s + x, 0);
    if (!istZahl(strom) || strom < 0.3 || q <= 0) {
        return null;
    }
    return runden(q / strom, 1);
}

module.exports = {
    VERLAUF_MIN,
    GLEICHLAUF_MIN,
    WEITERE_MAX,
    kennungNeu,
    normalisieren,
    aufloesen,
    merken,
    gleichlauf,
    schluessel,
    vorschlaege,
    AUTO_MINUTEN,
    AUTO_TOLERANZ_WH,
    AUTO_RING,
    paarMerken,
    paarUrteil,
    automatisch,
    einstufen,
    pruefung,
    aufteilung,
    restReihe,
    hoechste,
    systemCop,
};
