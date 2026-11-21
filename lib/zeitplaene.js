'use strict';

/**
 * Zeitplaene: die Mechanik hinter dem Wochenplan-Editor (admin/wochenplan.html) und die Befehle der
 * Einstellungsseite (Reiter "Zeitplaene"). Karten-Dialog (lib/devicemanager.js) und sendTo-Befehle
 * (lib/oberflaeche.js) benutzen dieselbe Logik:
 *
 *   - Ein ENTWURF gehoert zu einer Kennung (Token) und einem Geraet. Die Seite liest ihn
 *     (wochenplanInfo), schickt jede Aenderung (wochenplanEntwurf) und kann den Vorgabeplan laden
 *     (wochenplanVorgabe). Geschrieben wird erst beim Uebernehmen (`entwurfSpeichern`).
 *   - Geschrieben wird OHNE ack nach `regulation.schedule.weekJson` / `absenceJson`; uebernommen wird
 *     in lib/regel (dort wird geprueft und bestaetigt). Der Plan wirkt sofort - er ist ein Datenpunkt,
 *     kein Wert der Instanzeinstellungen.
 *   - Das Pseudo-Geraet `vorlage` steht fuer den Plan der Vorlage (`regelPlanVorlage`). Der ist ein
 *     Formularwert der Einstellungsseite: ein Entwurf dafuer wird nie geschrieben, `entwurfSpeichern`
 *     gibt den geprueften Plan als Text zurueck und die Seite legt ihn ins Formular.
 *
 * Antworten der Befehle: das genannte Objekt, bei Fehlern `{error: 'Text in Systemsprache'}`;
 * Listen sind immer Arrays.
 */

const { randomBytes } = require('node:crypto');
const wochenplan = require('./regel/wochenplan');
const nutzlast = require('./regel/nutzlast');
const fields = require('./fields');

/** Entwuerfe nie geschlossener Editoren verfallen nach dieser Zeit. */
const ENTWURF_ALTER_MS = 6 * 3600 * 1000;

/** Kennung des Plans der Vorlage (kein Geraet). */
const VORLAGE = 'vorlage';

const TAG_MIN = 1440;

/** Lazy: lib/oberflaeche.js bindet diese Datei ein. */
const ob = () => require('./oberflaeche');

/** Entwuerfe je Adapter: Kennung -> {id, programm, abwesenheit, abwesenheitRoh, geaendert, fehler, fehlerSchluessel, zeit} */
const ENTWUERFE = new WeakMap();

/**
 * @param {object} adapter  Adapter
 * @returns {Map<string, object>} Entwuerfe dieses Adapters
 */
function entwuerfe(adapter) {
    if (!ENTWUERFE.has(adapter)) {
        ENTWUERFE.set(adapter, new Map());
    }
    return ENTWUERFE.get(adapter);
}

/**
 * Temperaturstufen fuer einen Entwurf: die des Geraets - beim Plan der Vorlage die der Vorlage
 * (bzw. die ungespeicherte Liste aus dem Formular, die beim Oeffnen mitkam).
 *
 * @param {object} adapter  Adapter
 * @param {{id: string, stufen?: unknown}} entwurf  Entwurf
 * @returns {Map<string, object>} Temperaturstufen
 */
function stufenVon(adapter, entwurf) {
    if (entwurf.id !== VORLAGE) {
        return ob().szenen(adapter, entwurf.id);
    }
    if (Array.isArray(entwurf.stufen) && entwurf.stufen.length) {
        const gelesen = wochenplan.szenenLesen(entwurf.stufen);
        if (!gelesen.fehler && gelesen.szenen.size) {
            return gelesen.szenen;
        }
    }
    return ob().szenen(adapter, '');
}

/**
 * Der Plan, den "Vorgabeplan laden" einsetzt: der Plan der Vorlage (`regelPlanVorlage`), wenn er
 * gesetzt ist und zu den Temperaturstufen passt - sonst der Werksplan.
 *
 * @param {object} adapter  Adapter
 * @param {Map<string, object>} sz  Temperaturstufen des Ziels
 * @param {boolean} [nurWerk]  true: immer der Werksplan (fuer die Vorlage selbst)
 * @returns {{plan: Array<Array<{t: number, s: string}>>, werk: boolean}} Plan und ob es der Werksplan ist
 */
function vorgabePlan(adapter, sz, nurWerk) {
    const roh = adapter.config && adapter.config.regelPlanVorlage;
    if (!nurWerk && roh && (typeof roh !== 'string' || roh.trim())) {
        const gelesen = wochenplan.planLesen(roh, sz);
        if (gelesen.plan) {
            return { plan: gelesen.plan, werk: false };
        }
    }
    return { plan: wochenplan.vorgabePlan(sz), werk: true };
}

/**
 * Legt einen Entwurf an und raeumt verfallene weg.
 *
 * @param {object} adapter  Adapter
 * @param {string} id  Geraete-ID oder 'vorlage'
 * @param {{week?: unknown, stufen?: unknown}} [start]  nur Vorlage: Plan und Stufen aus dem (ungespeicherten) Formular
 * @returns {{token: string, entwurf: object}} Kennung und Entwurf
 */
function entwurfAnlegen(adapter, id, start = {}) {
    const liste = entwuerfe(adapter);
    const token = randomBytes(12).toString('hex');
    const entwurf = {
        id,
        programm: null,
        abwesenheit: null,
        abwesenheitRoh: null,
        geaendert: false,
        fehler: null,
        fehlerSchluessel: null,
        zeit: Date.now(),
    };
    if (id === VORLAGE) {
        entwurf.stufen = Array.isArray(start.stufen) ? start.stufen : null;
        entwurf.startPlan = start.week === undefined ? null : start.week;
    }
    liste.set(token, entwurf);
    for (const [k, e] of liste) {
        if (Date.now() - e.zeit > ENTWURF_ALTER_MS) {
            liste.delete(k);
        }
    }
    return { token, entwurf };
}

/**
 * Adresse der Wochenplan-Seite. Relativ zur Wurzel des Admins - dort liegt die Einstellungsseite.
 *
 * @param {string} namespace  Namensraum des Adapters
 * @param {string} id  Geraete-ID oder 'vorlage'
 * @param {string} token  Kennung des Entwurfs
 * @param {string} [praefix]  Weg zur Wurzel des Admins (Device-Manager: '../../')
 * @returns {string} URL
 */
const seitenUrl = (namespace, id, token, praefix = '') =>
    `${praefix}adapter/faikout/wochenplan.html?instance=${encodeURIComponent(namespace)}&device=${encodeURIComponent(id)}&token=${token}`;

/**
 * Nachrichten der Wochenplan-Seite (sendTo aus dem iframe).
 *
 * wochenplanInfo {device, token}: Plan, Temperaturstufen, Farben und Texte fuer die Seite.
 * wochenplanEntwurf {device, token, program, abwesenheit}: der bearbeitete Plan - wird hier geprueft
 *   (wochenplan.planLesen) und bis zum Uebernehmen gehalten.
 * wochenplanVorgabe {device, token}: der Vorgabeplan (Plan der Vorlage, sonst Werksplan).
 *
 * @param {object} adapter  Adapter
 * @param {string} befehl  Befehl
 * @param {Record<string, unknown>} msg  Nachricht
 * @returns {Promise<object>} Antwort
 */
async function seitenNachricht(adapter, befehl, msg) {
    const o = ob();
    const id = String((msg && msg.device) || '');
    const sprache = await o.sprache(adapter);
    const entwurf = entwuerfe(adapter).get(String((msg && msg.token) || ''));
    if (!entwurf || entwurf.id !== id) {
        return { error: o.t('zpKeinEntwurf', sprache) };
    }
    const vorlage = id === VORLAGE;
    const sz = stufenVon(adapter, entwurf);
    if (befehl === 'wochenplanVorgabe') {
        return { program: o.planZuProgramm(vorgabePlan(adapter, sz, vorlage).plan) };
    }
    if (befehl === 'wochenplanInfo') {
        const gelesen = wochenplan.planLesen(
            vorlage ? entwurf.startPlan || '' : (await o.lies(adapter, `${id}.regulation.schedule.weekJson`)) || '',
            sz,
        );
        const abw = vorlage
            ? null
            : wochenplan.abwesenheitLesen((await o.lies(adapter, `${id}.regulation.schedule.absenceJson`)) || '', sz);
        const heute = new Date();
        const frueh = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + 1).getTime();
        const cfg = adapter.config || {};
        return {
            program: entwurf.programm || o.planZuProgramm(gelesen.plan),
            types: o.planTypen(sz, sprache),
            farben: o.szenenFarben(sz),
            lang: sprache,
            max: 7 * 24,
            texts: o.planTexte(sprache),
            abwesenheit: entwurf.abwesenheitRoh || {
                aktiv: !!abw,
                von: o.ortszeitText(abw ? abw.von : frueh),
                bis: o.ortszeitText(abw ? abw.bis : frueh + 7 * wochenplan.TAG_MS),
                szene: abw ? abw.szene : sz.has('abwesend') ? 'abwesend' : [...sz.keys()][0],
            },
            // Plan der Vorlage: keine Abwesenheit (die gehoert zum Geraet) und kein Hinweis "Plan ist aus"
            ohneAbwesenheit: vorlage,
            feiertagSonntag: cfg.regelFeiertagSonntag === true,
            planAktiv: vorlage || (await o.lies(adapter, `${id}.regulation.schedule.active`)) === true,
            // Faikout-Auto speichert jede Zielaenderung im Modul - die Seite warnt bei vielen am Tag
            faikoutAuto: !vorlage && (await o.lies(adapter, `${id}.regulation.mode`)) === 'faikout',
            zielwechselWarnung: o.ZIELWECHSEL_WARNUNG,
        };
    }
    if (befehl === 'wochenplanEntwurf') {
        const zeilen = Array.isArray(msg.program) ? msg.program : [];
        if (zeilen.length) {
            // sofort pruefen, damit die Seite einen Fehler gleich zeigen kann
            const p = o.programmZuPlan(zeilen, sz, sprache);
            if (p.fehler) {
                entwurf.fehler = p.fehler;
                return { error: p.fehler };
            }
        }
        const a = msg.abwesenheit && typeof msg.abwesenheit === 'object' ? msg.abwesenheit : {};
        let abwesenheit = null;
        if (a.aktiv && !vorlage) {
            const von = o.ortszeitLesen(a.von);
            const bis = o.ortszeitLesen(a.bis);
            if (!(bis > von) || !sz.has(String(a.szene))) {
                // merken: "Plan uebernehmen" darf mit dieser Eingabe nicht still den letzten
                // gueltigen Stand speichern (die Abwesenheit fiel dabei wortlos weg)
                entwurf.fehler = o.t('pAbwFehler', sprache);
                entwurf.fehlerSchluessel = 'pAbwFehler';
                return { error: entwurf.fehler };
            }
            abwesenheit = { von, bis, szene: String(a.szene) };
        }
        entwurf.programm = zeilen;
        entwurf.abwesenheit = abwesenheit;
        entwurf.abwesenheitRoh = { aktiv: !!a.aktiv, von: a.von, bis: a.bis, szene: a.szene };
        entwurf.geaendert = true;
        entwurf.fehler = null;
        entwurf.fehlerSchluessel = null;
        return { ok: true, count: zeilen.length };
    }
    return { error: `unknown command ${befehl}` };
}

/**
 * Schreibt einen Datenpunkt der Regelung im Namen des Nutzers (ohne ack - lib/regel uebernimmt).
 *
 * @param {object} adapter  Adapter
 * @param {string} rel  ID ohne Namensraum
 * @param {unknown} val  Wert
 */
async function schreiben(adapter, rel, val) {
    adapter.log.debug(`Schedules: ${rel} = ${JSON.stringify(val)}`);
    await adapter.setState(rel, { val, ack: false });
}

/**
 * Uebernimmt einen Entwurf: prueft ihn und schreibt Plan und Abwesenheit des Geraets. Der Entwurf
 * bleibt bei einem Fehler bestehen (die Seite ist noch offen), nach dem Schreiben ist er verbraucht.
 *
 * @param {object} adapter  Adapter
 * @param {string} token  Kennung
 * @param {string} [id]  erwartetes Geraet (Schutz gegen vertauschte Kennungen)
 * @returns {Promise<{ok: true, geschrieben: boolean, einschaltenNoetig: boolean, week?: string}|{fehler: (sprache: string) => string}>}
 *   Ergebnis; `fehler` liefert den Text in der gewuenschten Sprache
 */
async function entwurfSpeichern(adapter, token, id) {
    const o = ob();
    const liste = entwuerfe(adapter);
    const entwurf = liste.get(String(token || ''));
    if (!entwurf || (id !== undefined && entwurf.id !== id)) {
        return { fehler: l => o.t('zpKeinEntwurf', l) };
    }
    const planFehler = grund => l => o.t('planFehler', l, { grund: typeof grund === 'function' ? grund(l) : grund });
    if (entwurf.fehler) {
        // Die Seite zeigte zuletzt einen Fehler (z. B. Abwesenheit: Ende vor Beginn). Nichts speichern
        // und es sagen - sonst glaubt der Nutzer, sein Plan samt Abwesenheit sei uebernommen.
        const schluessel = entwurf.fehlerSchluessel;
        const text = entwurf.fehler;
        return { fehler: planFehler(l => (schluessel ? o.t(schluessel, l) : text)) };
    }
    const vorlage = entwurf.id === VORLAGE;
    if (!entwurf.geaendert) {
        liste.delete(String(token));
        return { ok: true, geschrieben: false, einschaltenNoetig: false };
    }
    const sz = stufenVon(adapter, entwurf);
    const p = o.programmZuPlan(entwurf.programm, sz, await o.sprache(adapter));
    if (p.fehler) {
        const leer = !entwurf.programm.length;
        return { fehler: planFehler(l => (leer ? o.t('planLeer', l) : p.fehler)) };
    }
    const week = JSON.stringify(p.plan);
    liste.delete(String(token));
    if (vorlage) {
        return { ok: true, geschrieben: false, einschaltenNoetig: false, week };
    }
    await schreiben(adapter, `${entwurf.id}.regulation.schedule.weekJson`, week);
    await schreiben(
        adapter,
        `${entwurf.id}.regulation.schedule.absenceJson`,
        entwurf.abwesenheit ? JSON.stringify(nutzlast.schreiben('abwesenheit', entwurf.abwesenheit)) : '',
    );
    return {
        ok: true,
        geschrieben: true,
        einschaltenNoetig: (await o.lies(adapter, `${entwurf.id}.regulation.schedule.active`)) !== true,
    };
}

/**
 * Geraet einer Nachricht: ID oder Name -> ID; prueft, dass es die Datenpunkte der Regelung gibt.
 *
 * @param {object} adapter  Adapter
 * @param {unknown} wert  ID oder Name
 * @param {string} s  Sprache
 * @returns {Promise<{id: string}|{error: string}>} ID oder Fehler
 */
async function geraetPruefen(adapter, wert, s) {
    const o = ob();
    const roh = String(wert === undefined || wert === null ? '' : wert).trim();
    if (roh === VORLAGE) {
        return { error: o.t('zpVorlageNicht', s) };
    }
    const id = o.geraetId(adapter, roh);
    if (!id || !adapter.geraete || !adapter.geraete.has(id)) {
        return { error: o.t('zpUnbekannt', s, { name: roh }) };
    }
    if (!(await adapter.getObjectAsync(`${id}.regulation.schedule.weekJson`))) {
        const g = adapter.geraete.get(id);
        return { error: o.t('zpKeinDatenpunkt', s, { name: (g && g.name) || id }) };
    }
    return { id };
}

/**
 * Wochenplan als Balken je Tag: lueckenlos von 0 bis 1440 Minuten; was vor dem ersten Schaltpunkt
 * eines Tages gilt, kommt vom letzten Schaltpunkt davor (ueber die Wochengrenze hinweg).
 *
 * @param {Array<Array<{t: number, s: string}>>|null} plan  gepruefter Plan
 * @returns {Array<Array<{von: number, bis: number, stufe: string}>>} sieben Tage (Mo = 0); ohne Plan sieben leere Listen
 */
function balken(plan) {
    const leer = [[], [], [], [], [], [], []];
    if (!Array.isArray(plan) || plan.length !== 7) {
        return leer;
    }
    let davor = null;
    for (const tag of plan) {
        if (tag.length) {
            davor = tag[tag.length - 1].s;
        }
    }
    if (davor === null) {
        return leer;
    }
    return plan.map(tag => {
        const zeile = [];
        let von = 0;
        for (const e of tag) {
            if (e.t > von) {
                zeile.push({ von, bis: e.t, stufe: davor });
            }
            von = e.t;
            davor = e.s;
        }
        zeile.push({ von, bis: TAG_MIN, stufe: davor });
        // gleiche Stufe hintereinander (Schaltpunkt ohne Wechsel): ein Balken
        return zeile.reduce((aus, b) => {
            const letzter = aus[aus.length - 1];
            if (letzter && letzter.stufe === b.stufe) {
                letzter.bis = b.bis;
            } else {
                aus.push({ ...b });
            }
            return aus;
        }, []);
    });
}

/**
 * Temperaturstufen als Liste fuer die Oberflaeche.
 *
 * @param {Map<string, object>} sz  Temperaturstufen
 * @returns {Array<{id: string, name: string, farbe: {hell: string, dunkel: string}, soll: number, power: boolean, mode: string, fan: string, deckel: number}>} Liste
 */
function stufenListe(sz) {
    const farben = ob().szenenFarben(sz);
    return [...sz.values()].map(e => ({
        id: e.id,
        name: e.name,
        farbe: { hell: farben.hell[e.id], dunkel: farben.dunkel[e.id] },
        soll: e.soll,
        power: e.power,
        mode: e.mode,
        fan: e.fan,
        deckel: e.deckel,
    }));
}

/**
 * Antwort auf "zeitplaeneListe": Temperaturstufen (Vorlage und je Geraet) und je Geraet der Stand des
 * Wochenplans mit einer Wochenvorschau.
 *
 * @param {object} adapter  Adapter
 * @param {{jetzt?: number}} [opt]  nur fuer Tests: die Uhr
 * @returns {Promise<object>} {sprache, stufen, geraete, werksplan}
 */
async function liste(adapter, opt = {}) {
    const o = ob();
    const sprache = await o.sprache(adapter);
    const jetzt = Number.isFinite(opt.jetzt) ? opt.jetzt : Date.now();
    const c = adapter.config || {};
    const vorlage = o.szenen(adapter, '');
    const stufen = { [VORLAGE]: stufenListe(vorlage) };
    const feiertage = {
        feiertagSonntag: c.regelFeiertagSonntag === true,
        deutschland: c.regelFeiertageDE !== false,
        eigene: wochenplan.feiertageLesen(c.regelFeiertage),
    };
    const geraete = [];
    for (const [id, g] of adapter.geraete || []) {
        const sz = o.szenen(adapter, id);
        stufen[id] = stufenListe(sz);
        const roh = (await o.lies(adapter, `${id}.regulation.schedule.weekJson`)) || '';
        const gelesen = wochenplan.planLesen(roh, sz);
        const abwesenheit = wochenplan.abwesenheitLesen(
            (await o.lies(adapter, `${id}.regulation.schedule.absenceJson`)) || '',
            sz,
        );
        const stand = gelesen.plan ? wochenplan.stand(gelesen.plan, jetzt, { ...feiertage, abwesenheit }) : null;
        const name = stufe => (stufe && sz.get(stufe) ? sz.get(stufe).name : '');
        geraete.push({
            id,
            name: (g && g.name) || id,
            individuell: o.geraeteZeile(adapter, id).individuell === true,
            planAktiv: (await o.lies(adapter, `${id}.regulation.schedule.active`)) === true,
            planFehlt: !gelesen.plan,
            // Plan hinterlegt, aber nicht lesbar (z. B. eine Stufe gibt es nicht mehr): Text der Regelung
            planFehler: gelesen.plan || !String(roh).trim() ? '' : gelesen.fehler || '',
            naechster: stand && stand.naechster ? stand.naechster.zeit : null,
            // IDs der Temperaturstufen (wie in den Balken); die Namen dazu fuer die Anzeige
            naechsteStufe: stand && stand.naechster ? stand.naechster.szene || '' : '',
            naechsteStufeName: stand && stand.naechster ? name(stand.naechster.szene) : '',
            stufe: stand ? stand.szene || '' : '',
            stufeName: stand ? name(stand.szene) : '',
            woche: balken(gelesen.plan),
        });
    }
    const werk = wochenplan.vorgabePlan(vorlage);
    return {
        sprache,
        stufen,
        geraete,
        // Werksplan mit den Stufen der Vorlage: Vorschau und "Werksvorgabe", solange regelPlanVorlage leer ist
        werksplan: { week: JSON.stringify(werk), woche: balken(werk) },
    };
}

/**
 * Antwort auf "regelUebersicht": je Geraet Kurzstand und Live-Werte der Fuehler.
 *
 * @param {object} adapter  Adapter
 * @returns {Promise<object>} {sprache, geraete}
 */
async function uebersicht(adapter) {
    const o = ob();
    const sprache = await o.sprache(adapter);
    const zahl = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const feld = (id, f) => `${id}.${fields.FELDER[f].kanal}.${fields.objektId(f)}`;
    const geraete = [];
    for (const [id, g] of adapter.geraete || []) {
        const zeile = o.geraeteZeile(adapter, id);
        const eintrag = Object.keys(zeile).length > 0;
        const an = (await o.lies(adapter, feld(id, 'power'))) === true;
        const modus = await o.lies(adapter, feld(id, 'mode'));
        const taetigkeit = await o.lies(adapter, feld(id, 'action'));
        const kuehlt = an && (modus === 'cool' || (modus === 'heat_cool' && taetigkeit === 'cooling'));
        const heizt = an && (modus === 'heat' || (modus === 'heat_cool' && taetigkeit !== 'cooling'));
        const lauf = adapter.regelung && adapter.regelung.geraete && adapter.regelung.geraete.get(id);
        const erreichbar = await o.lies(adapter, feld(id, 'up'));
        geraete.push({
            id,
            name: (g && g.name) || id,
            online:
                erreichbar === null || erreichbar === undefined
                    ? !!(lauf && lauf.letzteMeldung > 0)
                    : erreichbar === true,
            eintrag,
            individuell: zeile.individuell === true,
            betrieb: zeile.betrieb === 'faikout' ? 'faikout' : 'adapter',
            kuehlt,
            heizt,
            raum: zahl(await o.lies(adapter, `${id}.regulation.sensors.room`)),
            aussen: zahl(await o.lies(adapter, `${id}.regulation.sensors.outside`)),
            feuchte: zahl(await o.lies(adapter, `${id}.regulation.sensors.humidity`)),
            taupunkt: zahl(await o.lies(adapter, `${id}.regulation.humidity.dewPoint`)),
        });
    }
    return { sprache, geraete };
}

/**
 * Beantwortet die Befehle des Reiters "Zeitplaene" (und "regelUebersicht").
 *
 * @param {object} adapter  Adapter
 * @param {string} befehl  Befehl
 * @param {Record<string, unknown>} msg  Nachricht
 * @returns {Promise<object>} Antwort
 */
async function befehl(adapter, befehl, msg) {
    const o = ob();
    const s = await o.sprache(adapter);
    switch (befehl) {
        case 'regelUebersicht':
            return uebersicht(adapter);
        case 'zeitplaeneListe':
            return liste(adapter);
        case 'wochenplanInfo':
        case 'wochenplanEntwurf':
        case 'wochenplanVorgabe':
            return seitenNachricht(adapter, befehl, msg);
        case 'wochenplanOeffnen': {
            let id = VORLAGE;
            if (String(msg.device || '').trim() !== VORLAGE) {
                const g = await geraetPruefen(adapter, msg.device, s);
                if (g.error) {
                    return g;
                }
                id = g.id;
            }
            const { token } = entwurfAnlegen(adapter, id, { week: msg.week, stufen: msg.stufen });
            return { url: seitenUrl(adapter.namespace, id, token), token };
        }
        case 'wochenplanSpeichern': {
            const roh = String(msg.device || '').trim();
            const id = roh === VORLAGE ? VORLAGE : o.geraetId(adapter, roh);
            const erg = await entwurfSpeichern(adapter, msg.token, id);
            if (erg.fehler) {
                return { error: erg.fehler(s) };
            }
            return {
                ok: true,
                einschaltenNoetig: erg.einschaltenNoetig,
                ...(erg.week === undefined ? {} : { week: erg.week }),
            };
        }
        case 'wochenplanSchalten': {
            const g = await geraetPruefen(adapter, msg.device, s);
            if (g.error) {
                return g;
            }
            const aktiv = msg.aktiv === true || msg.aktiv === 'true' || msg.aktiv === 1;
            await schreiben(adapter, `${g.id}.regulation.schedule.active`, aktiv);
            return { ok: true, aktiv };
        }
        case 'wochenplanKopie': {
            const g = await geraetPruefen(adapter, msg.device, s);
            if (g.error) {
                return g;
            }
            const week = await o.lies(adapter, `${g.id}.regulation.schedule.weekJson`);
            const absence = await o.lies(adapter, `${g.id}.regulation.schedule.absenceJson`);
            const abw = nutzlast.lesen('abwesenheit', absence);
            return {
                week: typeof week === 'string' ? week : '',
                absence: abw ? JSON.stringify(nutzlast.schreiben('abwesenheit', abw)) : '',
            };
        }
        case 'wochenplanEinfuegen': {
            const g = await geraetPruefen(adapter, msg.device, s);
            if (g.error) {
                return g;
            }
            if (typeof msg.week === 'string' && !msg.week.trim()) {
                // leerer Text: der Plan des Geraets wird geleert ("kein Wochenplan hinterlegt")
                await schreiben(adapter, `${g.id}.regulation.schedule.weekJson`, '');
                return { ok: true, einschaltenNoetig: false };
            }
            const gelesen = wochenplan.planLesen(
                typeof msg.week === 'string' || Array.isArray(msg.week) ? msg.week : '',
                o.szenen(adapter, g.id),
            );
            if (!gelesen.plan) {
                return { error: o.t('planFehler', s, { grund: gelesen.fehler }) };
            }
            await schreiben(adapter, `${g.id}.regulation.schedule.weekJson`, JSON.stringify(gelesen.plan));
            return {
                ok: true,
                einschaltenNoetig: (await o.lies(adapter, `${g.id}.regulation.schedule.active`)) !== true,
            };
        }
    }
    return { error: `unknown command ${befehl}` };
}

/** Befehle, die `befehl` beantwortet. */
const BEFEHLE = [
    'regelUebersicht',
    'zeitplaeneListe',
    'wochenplanInfo',
    'wochenplanEntwurf',
    'wochenplanVorgabe',
    'wochenplanOeffnen',
    'wochenplanSpeichern',
    'wochenplanSchalten',
    'wochenplanKopie',
    'wochenplanEinfuegen',
];

module.exports = {
    BEFEHLE,
    VORLAGE,
    ENTWURF_ALTER_MS,
    befehl,
    entwuerfe,
    entwurfAnlegen,
    entwurfSpeichern,
    seitenNachricht,
    seitenUrl,
    vorgabePlan,
    balken,
    stufenListe,
    liste,
    uebersicht,
};
