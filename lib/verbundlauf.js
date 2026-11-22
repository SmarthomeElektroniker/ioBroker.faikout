'use strict';

/*
 * Multisplit am Adapter: Datenpunkte der Aussengeraete, Vorschlag aus den Daten, Antwort fuer die
 * Einstellungsseite (sendTo verbundStand). Gerechnet wird in lib/verbund.js.
 *
 * Datenpunkte je zugeordnetem Aussengeraet (Kennung aus der Konfiguration):
 *   outdoorUnits.<Kennung>.power            Leistung des Aussengeraets (W) - EINMAL, nicht je Innengeraet
 *   outdoorUnits.<Kennung>.energyToday      Verbrauch heute (kWh), Zaehler des Aussengeraets
 *   outdoorUnits.<Kennung>.energyThisMonth  Verbrauch diesen Monat (kWh)
 *   outdoorUnits.<Kennung>.otherToday       heute nicht von einem Innengeraet gezaehlt (Bereitschaft, Abtauen ...)
 *   outdoorUnits.<Kennung>.copToday         Arbeitszahl des Systems heute (nur mit Effizienzwerten aller Innengeraete)
 *   outdoorUnits.<Kennung>.indoorUnits      Namen der Innengeraete
 *   outdoorUnits.<Kennung>.sharesJson       [{id, name, today, share}] Anteile heute
 * Die Aussengeraete sind bewusst KEINE Geraeteobjekte (type device): alles, was ueber die Geraete laeuft
 * (Regelung, Umbenennen, Aufraeumen), haelt ein Geraet fuer ein Faikout-Modul.
 */

const verbund = require('./verbund');
const verbrauch = require('./verbrauch');

const WURZEL = 'outdoorUnits';
const L = (en, de, ru, pt, nl, fr, it, es, pl, uk, zh) => ({ en, de, ru, pt, nl, fr, it, es, pl, uk, 'zh-cn': zh });

/** Namen der Datenpunkte in allen 11 Sprachen. */
const NAMEN = {
    wurzel: L(
        'Outdoor units (multi split)',
        'Außengeräte (Multisplit)',
        'Наружные блоки (мультисплит)',
        'Unidades exteriores (multi-split)',
        'Buitenunits (multisplit)',
        'Unités extérieures (multisplit)',
        'Unità esterne (multisplit)',
        'Unidades exteriores (multisplit)',
        'Jednostki zewnętrzne (multisplit)',
        'Зовнішні блоки (мультиспліт)',
        '室外机（一拖多）',
    ),
    power: L(
        'Power of the outdoor unit',
        'Leistung des Außengeräts',
        'Мощность наружного блока',
        'Potência da unidade exterior',
        'Vermogen van de buitenunit',
        'Puissance de l’unité extérieure',
        'Potenza dell’unità esterna',
        'Potencia de la unidad exterior',
        'Moc jednostki zewnętrznej',
        'Потужність зовнішнього блока',
        '室外机功率',
    ),
    energyToday: L(
        'Energy today',
        'Energie heute',
        'Энергия сегодня',
        'Energia hoje',
        'Energie vandaag',
        'Énergie aujourd’hui',
        'Energia oggi',
        'Energía hoy',
        'Energia dzisiaj',
        'Енергія сьогодні',
        '今日用电量',
    ),
    energyThisMonth: L(
        'Energy this month',
        'Energie diesen Monat',
        'Энергия в этом месяце',
        'Energia este mês',
        'Energie deze maand',
        'Énergie ce mois-ci',
        'Energia questo mese',
        'Energía este mes',
        'Energia w tym miesiącu',
        'Енергія цього місяця',
        '本月用电量',
    ),
    otherToday: L(
        'Today not counted by an indoor unit (standby, defrosting)',
        'Heute von keinem Innengerät gezählt (Bereitschaft, Abtauen)',
        'Сегодня не учтено внутренними блоками (ожидание, оттаивание)',
        'Hoje não contado por nenhuma unidade interior (espera, descongelação)',
        'Vandaag door geen binnenunit geteld (stand-by, ontdooien)',
        'Aujourd’hui non compté par une unité intérieure (veille, dégivrage)',
        'Oggi non conteggiato da alcuna unità interna (standby, sbrinamento)',
        'Hoy no contado por ninguna unidad interior (espera, descongelación)',
        'Dzisiaj nie zliczone przez jednostkę wewnętrzną (czuwanie, odszranianie)',
        'Сьогодні не враховано внутрішніми блоками (очікування, відтавання)',
        '今日未由室内机计量（待机、除霜）',
    ),
    otherTodayKurz: L(
        'Remainder today',
        'Rest heute',
        'Остаток сегодня',
        'Restante hoje',
        'Overig vandaag',
        'Reste aujourd’hui',
        'Resto oggi',
        'Resto hoy',
        'Reszta dzisiaj',
        'Залишок сьогодні',
        '今日其余',
    ),
    copToday: L(
        'System COP today (estimated)',
        'System-COP heute (geschätzt)',
        'COP системы сегодня (оценка)',
        'COP do sistema hoje (estimado)',
        'Systeem-COP vandaag (geschat)',
        'COP du système aujourd’hui (estimé)',
        'COP del sistema oggi (stimato)',
        'COP del sistema hoy (estimado)',
        'COP systemu dzisiaj (szacowany)',
        'COP системи сьогодні (оцінка)',
        '今日系统 COP（估算）',
    ),
    indoorUnits: L(
        'Indoor units',
        'Innengeräte',
        'Внутренние блоки',
        'Unidades interiores',
        'Binnenunits',
        'Unités intérieures',
        'Unità interne',
        'Unidades interiores',
        'Jednostki wewnętrzne',
        'Внутрішні блоки',
        '室内机',
    ),
    sharesJson: L(
        'Shares of the indoor units today (JSON)',
        'Anteile der Innengeräte heute (JSON)',
        'Доли внутренних блоков сегодня (JSON)',
        'Quotas das unidades interiores hoje (JSON)',
        'Aandelen van de binnenunits vandaag (JSON)',
        'Parts des unités intérieures aujourd’hui (JSON)',
        'Quote delle unità interne oggi (JSON)',
        'Cuotas de las unidades interiores hoy (JSON)',
        'Udziały jednostek wewnętrznych dzisiaj (JSON)',
        'Частки внутрішніх блоків сьогодні (JSON)',
        '今日各室内机占比 (JSON)',
    ),
    demand: L(
        'Power limit',
        'Leistungsgrenze',
        'Ограничение мощности',
        'Limite de potência',
        'Vermogensgrens',
        'Limite de puissance',
        'Limite di potenza',
        'Límite de potencia',
        'Limit mocy',
        'Обмеження потужності',
        '功率上限',
    ),
    leader: L(
        'Lead unit',
        'Leitgerät',
        'Ведущий блок',
        'Unidade principal',
        'Leidende unit',
        'Unité pilote',
        'Unità guida',
        'Unidad guía',
        'Jednostka wiodąca',
        'Ведучий блок',
        '主导室内机',
    ),
    ohneName: L(
        'Outdoor unit',
        'Außengerät',
        'Наружный блок',
        'Unidade exterior',
        'Buitenunit',
        'Unité extérieure',
        'Unità esterna',
        'Unidad exterior',
        'Jednostka zewnętrzna',
        'Зовнішній блок',
        '室外机',
    ),
};

const FELDER = [
    { id: 'power', type: 'number', role: 'value.power', unit: 'W' },
    { id: 'energyToday', type: 'number', role: 'value.energy', unit: 'kWh' },
    { id: 'energyThisMonth', type: 'number', role: 'value.energy', unit: 'kWh' },
    { id: 'otherToday', type: 'number', role: 'value.energy', unit: 'kWh' },
    { id: 'copToday', type: 'number', role: 'value' },
    { id: 'indoorUnits', type: 'string', role: 'text' },
    { id: 'sharesJson', type: 'string', role: 'json' },
];

const istZahl = x => typeof x === 'number' && Number.isFinite(x);

/** Laufzeit der Aussengeraete am Adapter. */
class Verbund {
    /**
     * @param {object} adapter  Adapter (config, geraete, getStateAsync, extendObject, wertSchreiben, log, ...)
     */
    constructor(adapter) {
        this.adapter = adapter;
        /** Verlauf comp/outside je Geraet (lib/verbund.merken) */
        this.verlauf = new Map();
        /** letzte Leistung (W) und Zeit je Geraet */
        this.letzte = new Map();
        /** letzter GEMELDETER Aussengeraete-Zaehler (Wh) mit Zeit je Geraet - fuer "Automatisch zuordnen" */
        this.zaehlerStand = new Map();
        /** Beobachtungen je Geraetepaar (lib/verbund.paarMerken) */
        this.paare = new Map();
        /** angelegte Kanaele outdoorUnits.<Kennung> -> Name */
        this.angelegt = new Map();
        /** Schluessel der Vorschlaege, die schon im Log standen */
        this.gemeldet = new Set();
        this.aufgeraeumt = false;
    }

    /** @returns {Map<string, {name: string, modulId: string|null}>} bekannte Geraete */
    geraeteInfo() {
        const m = new Map();
        for (const [id, g] of this.adapter.geraete || new Map()) {
            m.set(id, { name: (g && g.name) || id, modulId: (g && g.modulId) || null });
        }
        return m;
    }

    /**
     * Zuordnung aufloesen.
     *
     * @param {unknown} [konfig]  Liste aus dem (ungespeicherten) Formular; ohne Angabe die gespeicherte
     * @returns {ReturnType<typeof verbund.aufloesen>} Gruppen und Geraet -> Kennung
     */
    stand(konfig) {
        return verbund.aufloesen(
            konfig === undefined ? (this.adapter.config || {}).aussengeraete : konfig,
            this.geraeteInfo(),
        );
    }

    /**
     * Kennung des Aussengeraets eines Geraets (gespeicherte Zuordnung).
     *
     * @param {string} id  Geraet
     * @returns {string|null} Kennung oder null (Single-Split)
     */
    aussengeraetVon(id) {
        return this.stand().vonGeraet.get(id) || null;
    }

    /**
     * Meldung eines Moduls: Verlauf fuer den Vorschlag und letzte Leistung merken.
     *
     * @param {string} id  Geraet
     * @param {Record<string, unknown>} daten  gemeldete Felder
     * @param {number} [jetzt]  Zeit in ms
     */
    melden(id, daten, jetzt = Date.now()) {
        verbund.merken(this.verlauf, id, daten, jetzt);
        if (daten && istZahl(daten.consumption)) {
            this.letzte.set(id, { leistung: daten.consumption, zeit: jetzt });
        }
        if (daten && istZahl(daten.energy)) {
            this.zaehlerStand.set(id, { wh: daten.energy, zeit: jetzt });
        }
    }

    /**
     * Zaehler aller Geraete nebeneinander festhalten (einmal je Takt; lib/verbund.paarMerken zaehlt je Minute).
     *
     * @param {number} [jetzt]  Zeit in ms
     */
    beobachten(jetzt = Date.now()) {
        const staende = new Map();
        for (const [id, z] of this.zaehlerStand) {
            const g = (this.adapter.geraete || new Map()).get(id);
            staende.set(id, { ...z, online: !!g && g.up !== false });
        }
        verbund.paarMerken(this.paare, staende, jetzt);
    }

    /**
     * Geraet ist weg (umbenannt, geloescht).
     *
     * @param {string} id  Geraet
     */
    vergessen(id) {
        this.verlauf.delete(id);
        this.letzte.delete(id);
        this.zaehlerStand.delete(id);
        for (const k of [...this.paare.keys()]) {
            if (k.split('|').includes(id)) {
                this.paare.delete(k);
            }
        }
    }

    /**
     * Wert eines eigenen Datenpunkts.
     *
     * @param {string} rel  ID ohne Namensraum
     * @returns {Promise<unknown>} Wert oder null
     */
    async lies(rel) {
        try {
            const s = await this.adapter.getStateAsync(rel);
            return s ? s.val : null;
        } catch {
            return null;
        }
    }

    /**
     * Vorschlaege aus den Daten.
     *
     * @param {Map<string, string>} vonGeraet  bestehende Zuordnung
     * @param {unknown} [abgelehnt]  abgelehnte Vorschlaege; ohne Angabe die gespeicherten
     * @returns {ReturnType<typeof verbund.vorschlaege>} Vorschlaege
     */
    vorschlaege(vonGeraet, abgelehnt) {
        const liste = abgelehnt === undefined ? (this.adapter.config || {}).aussengeraeteAbgelehnt : abgelehnt;
        return verbund.vorschlaege({
            zaehler: verbrauch.aussenZaehler(this.adapter.geraete),
            verlauf: this.verlauf,
            vonGeraet,
            abgelehnt: (Array.isArray(liste) ? liste : []).filter(x => typeof x === 'string'),
        });
    }

    /**
     * Werte eines Aussengeraets aus den Datenpunkten seiner Innengeraete.
     *
     * @param {{id: string, name: string, weitere: number, innen: Array<{id: string, name: string, fehlt: boolean}>}} gruppe  aufgeloeste Gruppe
     * @param {number} [jetzt]  Zeit in ms
     * @returns {Promise<object>} {leistung, heute, monat, rest, cop, pruefung, innen: [{id, name, heute, monat, anteil, leistung}]}
     */
    async werte(gruppe, jetzt = Date.now()) {
        const da = gruppe.innen.filter(i => !i.fehlt);
        const summe = async (id, feld) => {
            const h = await this.lies(`${id}.consumption.heating.${feld}`);
            const c = await this.lies(`${id}.consumption.cooling.${feld}`);
            return istZahl(h) || istZahl(c) ? (istZahl(h) ? h : 0) + (istZahl(c) ? c : 0) : null;
        };
        const hoechster = async feld => {
            const w = [];
            for (const i of da) {
                w.push(await this.lies(`${i.id}.consumption.total.${feld}`));
            }
            const zahlen = w.filter(istZahl);
            return zahlen.length ? Math.max(...zahlen) : null;
        };
        const heute = await hoechster('today');
        const monat = await hoechster('thisMonth');
        const innenHeute = [];
        const innen = [];
        // System-COP: Waerme und Strom aus DENSELBEN Zeitabschnitten der Effizienzrechnung (lib/effizienz) - der
        // Strom der Innengeraete wird um den Rest des Aussengeraets (Bereitschaft, Abtauen) hochgerechnet
        const waerme = [];
        let strom = 0;
        let effizienzVollstaendig = da.length > 0 && !gruppe.weitere;
        const menge = (id, m) => {
            const z =
                this.adapter.effizienz && this.adapter.effizienz.zustand
                    ? this.adapter.effizienz.zustand.get(id)
                    : null;
            const w = z && z.werte && z.werte[m] ? z.werte[m].today : null;
            return istZahl(w) ? w : null;
        };
        for (const i of da) {
            const h = await summe(i.id, 'today');
            innenHeute.push({ id: i.id, kwh: h });
            const q = menge(i.id, 'waerme');
            const k = menge(i.id, 'kaelte');
            if (q === null && k === null) {
                effizienzVollstaendig = false;
            }
            waerme.push((q || 0) + (k || 0));
            strom += (menge(i.id, 'stromHeizen') || 0) + (menge(i.id, 'stromKuehlen') || 0);
            innen.push({
                id: i.id,
                name: i.name,
                heute: h,
                monat: await summe(i.id, 'thisMonth'),
                laeuft: (await this.lies(`${i.id}.control.power`)) === true,
            });
        }
        const teil = verbund.aufteilung(heute, innenHeute);
        innen.forEach((i, n) => (i.anteil = teil.innen[n].anteil));
        // Leistung: jedes Modul meldet die des Aussengeraets - der juengste Wert der letzten 5 Minuten
        const frisch = da
            .map(i => this.letzte.get(i.id))
            .filter(l => l && jetzt - l.zeit < 5 * 60000)
            .sort((a, b) => b.zeit - a.zeit);
        return {
            leistung: frisch.length ? frisch[0].leistung : null,
            heute,
            monat,
            rest: teil.rest,
            cop: effizienzVollstaendig
                ? verbund.systemCop(
                      waerme,
                      strom * (istZahl(heute) && teil.summeInnen > 0 ? Math.max(1, heute / teil.summeInnen) : 1),
                  )
                : null,
            pruefung: verbund.pruefung(
                da.map(i => i.id),
                verbrauch.aussenZaehler(this.adapter.geraete),
            ),
            innen,
        };
    }

    /**
     * Name eines Aussengeraets fuer Objekt und Karte.
     *
     * @param {{id: string, name: string}} gruppe  Gruppe
     * @returns {string|Record<string, string>} Name (ohne eigenen Namen "Aussengeraet" in allen Sprachen)
     */
    static name(gruppe) {
        return gruppe.name || NAMEN.ohneName;
    }

    /**
     * Kanal und Datenpunkte eines Aussengeraets anlegen (einmal je Lauf bzw. bei neuem Namen).
     *
     * @param {{id: string, name: string}} gruppe  Gruppe
     */
    async anlegen(gruppe) {
        const a = this.adapter;
        const name = JSON.stringify(Verbund.name(gruppe));
        if (this.angelegt.get(gruppe.id) === name) {
            return;
        }
        if (!this.angelegt.size) {
            await a.extendObject(WURZEL, { type: 'folder', common: { name: NAMEN.wurzel }, native: {} });
        }
        await a.extendObject(`${WURZEL}.${gruppe.id}`, {
            type: 'channel',
            common: { name: Verbund.name(gruppe) },
            native: { aussengeraet: gruppe.id },
        });
        for (const f of FELDER) {
            const common = { name: NAMEN[f.id], type: f.type, role: f.role, read: true, write: false };
            if (f.unit) {
                common.unit = f.unit;
            }
            await a.extendObject(`${WURZEL}.${gruppe.id}.${f.id}`, { type: 'state', common, native: {} });
        }
        this.angelegt.set(gruppe.id, name);
    }

    /** Kanaele von Aussengeraeten loeschen, die es in der Konfiguration nicht mehr gibt (einmal je Lauf). */
    async aufraeumen() {
        const a = this.adapter;
        if (this.aufgeraeumt || typeof a.getChannelsOfAsync !== 'function') {
            return;
        }
        this.aufgeraeumt = true;
        const gueltig = new Set(verbund.normalisieren((a.config || {}).aussengeraete).map(g => g.id));
        try {
            for (const k of (await a.getChannelsOfAsync(WURZEL)) || []) {
                const kennung = k._id.split('.').pop();
                if (k.native && k.native.aussengeraet && !gueltig.has(kennung)) {
                    await a.delObjectAsync(`${WURZEL}.${kennung}`, { recursive: true });
                    a.log.info(`Outdoor unit "${kennung}" is no longer configured - data points removed`);
                }
            }
        } catch (e) {
            a.log.debug(`Outdoor units cleanup skipped: ${e.message}`);
        }
    }

    /**
     * Minutentakt: Datenpunkte der Aussengeraete schreiben, einen neuen Vorschlag einmal ins Log.
     *
     * @param {number} [jetzt]  Zeit in ms
     */
    async takt(jetzt = Date.now()) {
        const a = this.adapter;
        await this.aufraeumen();
        this.beobachten(jetzt);
        const s = this.stand();
        for (const gruppe of s.gruppen) {
            if (!gruppe.innen.some(i => !i.fehlt)) {
                continue;
            }
            await this.anlegen(gruppe);
            const w = await this.werte(gruppe, jetzt);
            const basis = `${WURZEL}.${gruppe.id}`;
            const schreiben = async (feld, wert) => {
                if (wert !== null && wert !== undefined) {
                    await a.wertSchreiben(`${basis}.${feld}`, wert);
                }
            };
            await schreiben('power', w.leistung);
            await schreiben('energyToday', w.heute);
            await schreiben('energyThisMonth', w.monat);
            await schreiben('otherToday', istZahl(w.heute) ? w.rest : null);
            await schreiben('copToday', w.cop);
            await schreiben('indoorUnits', w.innen.map(i => i.name).join(', '));
            await schreiben(
                'sharesJson',
                JSON.stringify(w.innen.map(i => ({ id: i.id, name: i.name, today: i.heute, share: i.anteil }))),
            );
            if (w.pruefung === 'widerspricht' && !this.gemeldet.has(`w:${gruppe.id}`)) {
                this.gemeldet.add(`w:${gruppe.id}`);
                a.log.warn(
                    `Outdoor unit "${gruppe.name || gruppe.id}": the assigned indoor units report different outdoor meters - please check the assignment (settings, tab Consumption).`,
                );
            }
        }
        for (const v of this.vorschlaege(s.vonGeraet)) {
            if (this.gemeldet.has(v.schluessel)) {
                continue;
            }
            this.gemeldet.add(v.schluessel);
            const namen = v.ids.map(id => (a.geraete.get(id) || {}).name || id).join(', ');
            a.log.info(
                `${namen} appear to share one outdoor unit (multi split). Suggestion in the settings, tab Consumption, section "Outdoor units" - nothing is assigned automatically.`,
            );
        }
    }

    /**
     * Antwort fuer die Einstellungsseite (sendTo verbundStand): Geraete mit Live-Werten, die Gruppen des
     * (ungespeicherten) Formulars mit ihren Werten, Vorschlaege.
     *
     * @param {{aussengeraete?: unknown, abgelehnt?: unknown}} msg  Formularwerte
     * @param {number} [jetzt]  Zeit in ms
     * @returns {Promise<object>} {geraete, gruppen, vorschlaege, konfig, geaendert}
     */
    async befehl(msg, jetzt = Date.now()) {
        const m = msg && typeof msg === 'object' ? msg : {};
        const s = this.stand('aussengeraete' in m ? m.aussengeraete : undefined);
        const zaehler = verbrauch.aussenZaehler(this.adapter.geraete);
        const geraete = [];
        let sprache = 'en';
        try {
            sprache = (typeof this.adapter.sprache === 'function' && (await this.adapter.sprache())) || 'en';
        } catch {
            sprache = 'en';
        }
        // Betriebsart als Text wie auf der Geraetekarte (spaet geladen: devicemanager laedt diese Datei)
        const modusTexte = require('./devicemanager').MODUS_TEXTE || {};
        for (const [id, g] of this.adapter.geraete || new Map()) {
            const h = await this.lies(`${id}.consumption.heating.today`);
            const c = await this.lies(`${id}.consumption.cooling.today`);
            const total = await this.lies(`${id}.consumption.total.today`);
            const l = this.letzte.get(id);
            geraete.push({
                id,
                name: (g && g.name) || id,
                verbunden: !!(g && g.up !== false),
                laeuft: (await this.lies(`${id}.control.power`)) === true,
                modell: await this.lies(`${id}.info.model`),
                modus: await this.lies(`${id}.control.mode`),
                raum: await this.lies(`${id}.status.temp`),
                leistung: l && jetzt - l.zeit < 5 * 60000 ? l.leistung : null,
                heute: istZahl(h) || istZahl(c) ? Math.round(((h || 0) + (c || 0)) * 100) / 100 : null,
                // ohne Heiz-/Kuehlzaehler (z. B. IR-Bruecke): der Zaehler des Moduls, wenn es einen gibt
                heuteGesamt: istZahl(total) ? total : null,
                zaehler: istZahl(zaehler.get(id)),
            });
        }
        for (const g of geraete) {
            const t = typeof g.modus === 'string' ? modusTexte[g.modus] : null;
            g.modusText = t ? t[sprache] || t.en : null;
            g.raum = istZahl(g.raum) ? g.raum : null;
        }
        geraete.sort((x, y) => x.name.localeCompare(y.name));
        // dieselbe Farbe wie im Verbrauchsdiagramm
        try {
            const bild = require('./verbrauchbild');
            const plaetze = await bild.farbplaetze(
                this.adapter,
                geraete.map(g => g.id),
            );
            geraete.forEach(g => (g.farbe = bild.PALETTE[plaetze.get(g.id)] || null));
        } catch {
            // ohne Farbplatz nimmt die Seite ihre Ersatzfarben
        }
        const gruppen = [];
        const mitglieder = g =>
            g.innen
                .map(i => i.id)
                .sort()
                .join('|');
        const sicher = new Map(this.stand().gruppen.map(g => [g.id, mitglieder(g)]));
        const gespeichert = g => sicher.get(g.id) === mitglieder(g);
        for (const gruppe of s.gruppen) {
            const w = await this.werte(gruppe, jetzt);
            gruppen.push({
                ...gruppe,
                leistung: w.leistung,
                heute: w.heute,
                monat: w.monat,
                rest: w.rest,
                cop: w.cop,
                pruefung: w.pruefung,
                // Gruppenregelung (lib/regel): aktuelle Leistungsgrenze des Aussengeraets und ihr Leitgeraet
                // (nur wenn die Kennung im Formular noch dieselbe Gruppe meint wie gespeichert - eine eben erst
                // angelegte Gruppe kann die Kennung einer aufgeloesten tragen)
                grenze: gespeichert(gruppe) ? await this.lies(`${WURZEL}.${gruppe.id}.demand`) : null,
                leitgeraet: gespeichert(gruppe) ? (await this.lies(`${WURZEL}.${gruppe.id}.leader`)) || null : null,
                anteile: Object.fromEntries(w.innen.map(i => [i.id, { heute: i.heute, anteil: i.anteil }])),
            });
        }
        return {
            geraete,
            gruppen,
            // Vorschlaege mit Einstufung: "sicher" nur, wenn die Zaehler ueber den Beobachtungszeitraum gleich waren
            vorschlaege: verbund.einstufen(
                this.vorschlaege(s.vonGeraet, 'abgelehnt' in m ? m.abgelehnt : undefined),
                verbund.automatisch({ paare: this.paare, vonGeraet: s.vonGeraet }),
            ),
            konfig: s.konfig,
            geaendert: s.geaendert,
        };
    }
}

module.exports = { Verbund, NAMEN, FELDER, WURZEL, BEFEHLE: ['verbundStand'] };
