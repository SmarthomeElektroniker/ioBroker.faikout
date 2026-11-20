'use strict';

/**
 * Bedarfsregelung - Anbindung an den Adapter. Haelt je Geraet die Eingaenge, ruft die reinen
 * Rechenbausteine (bedarf, schreiber, faehigkeit) und schreibt die Datenpunkte
 * `<Geraet>.regel.bedarf.*` sowie `<Geraet>.info.demandFaehig`.
 *
 * SICHERHEIT: Im Probelauf geht nie ein Befehl hinaus. Gesendet wird nur, wenn
 *   - die Instanz-Einstellung "Probelauf" AUS ist UND
 *   - der Datenpunkt regel.bedarf.probelauf des Geraets false ist UND
 *   - regel.bedarf.aktiv true ist.
 * Der Schreiber liefert im Probelauf nur 'wuerde'; senden() prueft alle drei Bedingungen
 * unmittelbar vor dem Publish ein zweites Mal.
 */

const bedarf = require('./bedarf');
const schreiber = require('./schreiber');
const faehigkeit = require('./faehigkeit');
const zustandSpeicher = require('./zustand');

const ZWEIG = 'regel.bedarf';

const DATENPUNKTE = {
    aktiv: {
        type: 'boolean',
        role: 'switch.enable',
        write: true,
        def: false,
        name: { en: 'Demand control active', de: 'Bedarfsregelung aktiv' },
    },
    probelauf: {
        type: 'boolean',
        role: 'switch',
        write: true,
        def: true,
        name: { en: 'Dry run (calculate only, never send)', de: 'Probelauf (nur rechnen, nie senden)' },
    },
    sollwert: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Calculated demand', de: 'Berechnete Leistungsgrenze' },
    },
    rohwert: {
        type: 'number',
        role: 'value',
        unit: '%',
        name: { en: 'Raw value before limits', de: 'Rohwert vor Stufung und Grenzen' },
    },
    aussenMittel: {
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature (30 min mean)', de: 'Außentemperatur (Mittel 30 min)' },
    },
    grund: { type: 'string', role: 'text', name: { en: 'Reason', de: 'Begründung' } },
    zustand: {
        type: 'string',
        role: 'text',
        states: { ok: 'ok', gestört: 'gestört', 'nicht fähig': 'nicht fähig', neutral: 'neutral', aus: 'aus' },
        name: { en: 'State', de: 'Zustand' },
    },
    wuerdeSenden: {
        type: 'string',
        role: 'json',
        name: { en: 'Last command (or would-send in dry run)', de: 'Letzter Befehl (im Probelauf: würde senden)' },
    },
    befehleStunde: {
        type: 'number',
        role: 'value',
        name: { en: 'Commands in the last hour', de: 'Befehle in der letzten Stunde' },
    },
    strategie: { type: 'string', role: 'text', name: { en: 'Strategy', de: 'Strategie' } },
    zustandJson: {
        type: 'string',
        role: 'json',
        name: { en: 'Internal state (restart-safe)', de: 'Interner Zustand (neustartfest)' },
    },
};

/**
 * Datum "YYYY-MM-DD" in Ortszeit.
 *
 * @param {Date} d  Datum
 * @returns {string} Tag
 */
function tagVon(d) {
    const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/**
 * Liest die Einstellungen der Instanz in die Regelkonfiguration um.
 *
 * @param {object} c  adapter.config
 * @returns {{konfig: object, fehler: string|null, probelaufGlobal: boolean, aktivVorgabe: boolean, quellen: Map<string, {aussen: string, raum: string}>}} Regelkonfiguration
 */
function konfigAusInstanz(c = {}) {
    const zahl = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    const roh = {
        strategie: c.regelStrategie || bedarf.VORGABEN.strategie,
        heizen: c.regelKennlinieHeizen || bedarf.VORGABEN.heizen,
        kuehlen: c.regelKennlinieKuehlen || bedarf.VORGABEN.kuehlen,
        untergrenze: zahl(c.regelUntergrenze, bedarf.VORGABEN.untergrenze),
        obergrenze: zahl(c.regelObergrenze, bedarf.VORGABEN.obergrenze),
        vortag: {
            bezug: c.regelVortagBezug || bedarf.VORGABEN.vortag.bezug,
            zuschlag: zahl(c.regelVortagZuschlag, bedarf.VORGABEN.vortag.zuschlag),
            referenzW: zahl(c.regelVortagReferenzW, bedarf.VORGABEN.vortag.referenzW),
            min: zahl(c.regelVortagMin, bedarf.VORGABEN.vortag.min),
            max: zahl(c.regelVortagMax, bedarf.VORGABEN.vortag.max),
        },
    };
    const { konfig, fehler } = bedarf.konfigPruefen(roh);
    const quellen = new Map();
    for (const q of Array.isArray(c.regelQuellen) ? c.regelQuellen : []) {
        if (q && q.geraet) {
            quellen.set(String(q.geraet).trim(), {
                aussen: String(q.aussen || '').trim(),
                raum: String(q.raum || '').trim(),
            });
        }
    }
    return {
        konfig,
        fehler,
        // Vorgabe: Probelauf AN. Nur ein ausdrueckliches false schaltet ihn ab.
        probelaufGlobal: c.regelProbelauf !== false,
        aktivVorgabe: c.regelAktiv === true,
        quellen,
    };
}

/** Bedarfsregelung aller Geraete einer Instanz. */
class Bedarfsregelung {
    /**
     * @param {object} adapter  Adapter (setObjectNotExistsAsync, getStateAsync, getForeignStateAsync, wertSchreiben, log, broker)
     * @param {object} [opt]    {jetzt: () => number} fuer Tests/Simulator
     */
    constructor(adapter, opt = {}) {
        this.adapter = adapter;
        this.jetzt = opt.jetzt || (() => Date.now());
        this.einstellung = konfigAusInstanz(adapter.config);
        /** je Geraete-ID: {name, eingang, zustand, aktiv, probelauf, angelegt, vortag} */
        this.geraete = new Map();
        if (this.einstellung.fehler) {
            adapter.log.warn(`Demand control: configuration error - ${this.einstellung.fehler}`);
        }
    }

    /**
     * Legt die Datenpunkte an und liest Schalter und Zustand. Einmal je Geraet.
     *
     * @param {string} id    Geraete-ID
     * @param {string} name  echter Geraetename
     * @returns {Promise<object>} Geraeteeintrag
     */
    async geraet(id, name) {
        let r = this.geraete.get(id);
        if (r) {
            r.name = name;
            return r;
        }
        r = {
            name,
            eingang: {},
            zustand: zustandSpeicher.leer(),
            aktiv: false,
            probelauf: true,
            laeuft: false,
            vortag: null,
        };
        this.geraete.set(id, r);
        const a = this.adapter;
        await a.setObjectNotExistsAsync(`${id}.regel`, {
            type: 'channel',
            common: { name: { en: 'Control', de: 'Regelung' } },
            native: {},
        });
        await a.setObjectNotExistsAsync(`${id}.${ZWEIG}`, {
            type: 'channel',
            common: { name: { en: 'Demand control', de: 'Bedarfsregelung' } },
            native: {},
        });
        for (const [feld, d] of Object.entries(DATENPUNKTE)) {
            const common = { name: d.name, type: d.type, role: d.role, read: true, write: !!d.write };
            if (d.unit) {
                common.unit = d.unit;
            }
            if (d.states) {
                common.states = d.states;
            }
            if (d.def !== undefined) {
                common.def = feld === 'aktiv' ? this.einstellung.aktivVorgabe : d.def;
            }
            await a.setObjectNotExistsAsync(`${id}.${ZWEIG}.${feld}`, {
                type: 'state',
                common,
                native: { regel: true },
            });
        }
        await a.setObjectNotExistsAsync(`${id}.info.demandFaehig`, {
            type: 'state',
            common: {
                name: { en: 'Demand control supported', de: 'Leistungsgrenze möglich' },
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                states: { unbekannt: 'unbekannt', ja: 'ja', nein: 'nein' },
            },
            native: {},
        });
        const lies = async feld => {
            const s = await a.getStateAsync(`${id}.${ZWEIG}.${feld}`);
            return s ? s.val : null;
        };
        const aktiv = await lies('aktiv');
        const probe = await lies('probelauf');
        r.aktiv = aktiv === null ? this.einstellung.aktivVorgabe : aktiv === true;
        r.probelauf = probe !== false; // alles ausser ausdruecklich false = Probelauf
        r.zustand = zustandSpeicher.lesen(await lies('zustandJson'));
        if (aktiv === null) {
            await a.setStateAsync(`${id}.${ZWEIG}.aktiv`, { val: r.aktiv, ack: true });
        }
        if (probe === null) {
            await a.setStateAsync(`${id}.${ZWEIG}.probelauf`, { val: true, ack: true });
        }
        return r;
    }

    /**
     * Statusmeldung state/<Name> eines Geraets.
     *
     * @param {string} id     Geraete-ID
     * @param {string} name   echter Name
     * @param {object} daten  gemeldete Felder (Klartextformat)
     */
    async meldung(id, name, daten) {
        const r = await this.geraet(id, name);
        const jetzt = this.jetzt();
        const e = r.eingang;
        for (const f of ['power', 'mode', 'heat', 'target', 'econo', 'action', 'antifreeze', 'demand']) {
            if (daten[f] !== undefined && daten[f] !== null) {
                e[f] = daten[f];
            }
        }
        if (daten.outside !== undefined && daten.outside !== null) {
            e.outside = { wert: daten.outside, zeit: jetzt };
        }
        if (daten.temp !== undefined && daten.temp !== null) {
            e.temp = { wert: daten.temp, zeit: jetzt };
        }
        // Faehigkeit aus der Meldung: vollstaendig ist eine Meldung mit power.
        const vorher = r.zustand.faehig;
        r.zustand.faehig = faehigkeit.bewerten(vorher, {
            art: 'status',
            vollstaendig: typeof daten.power === 'boolean',
            demand: typeof daten.demand === 'number' ? daten.demand : undefined,
        });
        const g = r.zustand.schreiber.letzter;
        if (g && typeof daten.demand === 'number' && daten.demand === g.wert && g.wert < 100 && !r.probelauf) {
            r.zustand.faehig = faehigkeit.bewerten(r.zustand.faehig, { art: 'angenommen', wert: g.wert });
        }
        await this.schritt(id);
    }

    /**
     * failed-set vom Modul.
     *
     * @param {string} id        Geraete-ID
     * @param {object} settings  abgelehnte Felder {demand: 80, ...}
     */
    async abgelehnt(id, settings) {
        const r = this.geraete.get(id);
        if (!r || !settings || settings.demand === undefined) {
            return;
        }
        r.zustand.faehig = faehigkeit.bewerten(r.zustand.faehig, {
            art: 'abgelehnt',
            power: r.eingang.power === true,
            wert: settings.demand,
        });
        await this.adapter.wertSchreiben(`${id}.info.demandFaehig`, r.zustand.faehig.wert);
    }

    /**
     * Schalter aktiv/probelauf vom Nutzer (ack=false).
     *
     * @param {string} id    Geraete-ID
     * @param {string} feld  'aktiv' | 'probelauf'
     * @param {unknown} val      neuer Wert
     * @returns {Promise<boolean>} true, wenn uebernommen
     */
    async schalter(id, feld, val) {
        const r = this.geraete.get(id);
        if (!r || !['aktiv', 'probelauf'].includes(feld)) {
            return false;
        }
        const b = val === true || val === 'true' || val === 1;
        if (feld === 'aktiv') {
            r.aktiv = b;
        } else {
            r.probelauf = b;
        }
        await this.adapter.setStateAsync(`${id}.${ZWEIG}.${feld}`, { val: b, ack: true });
        this.adapter.log.info(`${r.name}: demand control ${feld} = ${b}`);
        await this.schritt(id);
        return true;
    }

    /**
     * Ist fuer dieses Geraet das Senden erlaubt? (zweite, unabhaengige Pruefung)
     *
     * @param {object} r  Geraeteeintrag
     * @returns {boolean} true nur ausserhalb jedes Probelaufs
     */
    sendenErlaubt(r) {
        return r.aktiv === true && r.probelauf === false && this.einstellung.probelaufGlobal === false;
    }

    /**
     * Liest einen Fuehler aus einem fremden Datenpunkt.
     *
     * @param {string} quelle  Datenpunkt-ID
     * @returns {Promise<{wert: (number|string|null), zeit: number}|null>} Messung
     */
    async fremdFuehler(quelle) {
        try {
            const s = await this.adapter.getForeignStateAsync(quelle);
            return s ? { wert: s.val, zeit: s.ts } : null;
        } catch {
            return null;
        }
    }

    /**
     * Vortagswerte aus der eigenen Stundenreihe (einmal je Tag und Zweig gelesen).
     *
     * @param {string} id      Geraete-ID
     * @param {object} r       Geraeteeintrag
     * @param {string} zweig   'heating' | 'cooling'
     * @returns {Promise<object|null>} Vortagswerte
     */
    async vortag(id, r, zweig) {
        const gestern = new Date(this.jetzt());
        gestern.setDate(gestern.getDate() - 1);
        const tag = tagVon(gestern);
        if (r.vortag && r.vortag.tag === tag && r.vortag.zweig === zweig) {
            return r.vortag.werte;
        }
        let werte = null;
        try {
            const s = await this.adapter.getStateAsync(`${id}.consumption.${zweig}.hoursJson`);
            werte = s && typeof s.val === 'string' ? bedarf.vortagAusStunden(JSON.parse(s.val), tag) : null;
        } catch {
            werte = null;
        }
        r.vortag = { tag, zweig, werte };
        return werte;
    }

    /**
     * Ein Regelschritt fuer ein Geraet.
     *
     * @param {string} id  Geraete-ID
     */
    async schritt(id) {
        const r = this.geraete.get(id);
        if (!r || r.laeuft) {
            return;
        }
        r.laeuft = true;
        try {
            await this.schrittIntern(id, r);
        } finally {
            r.laeuft = false;
        }
    }

    /**
     * Rechnet, entscheidet und schreibt die Datenpunkte (ohne Sperre - siehe schritt()).
     *
     * @param {string} id  Geraete-ID
     * @param {object} r   Geraeteeintrag
     */
    async schrittIntern(id, r) {
        const a = this.adapter;
        const jetzt = this.jetzt();
        const p = `${id}.${ZWEIG}`;
        const e = r.eingang;
        const probelauf = !this.sendenErlaubt(r);
        await a.wertSchreiben(`${p}.strategie`, this.einstellung.konfig.strategie);
        await a.wertSchreiben(`${id}.info.demandFaehig`, (r.zustand.faehig && r.zustand.faehig.wert) || 'unbekannt');

        if (this.einstellung.fehler) {
            await a.wertSchreiben(`${p}.zustand`, 'gestört');
            await a.wertSchreiben(`${p}.grund`, `Konfigurationsfehler: ${this.einstellung.fehler}`);
            return;
        }

        const q = this.einstellung.quellen.get(id) || this.einstellung.quellen.get(r.name) || { aussen: '', raum: '' };
        const aussen = q.aussen ? await this.fremdFuehler(q.aussen) : e.outside || null;
        const raum = q.raum ? await this.fremdFuehler(q.raum) : e.temp || null;
        const richtung = bedarf.richtung(e);
        const vortag =
            this.einstellung.konfig.strategie === 'vortag' && richtung
                ? await this.vortag(id, r, richtung === 'kuehlen' ? 'cooling' : 'heating')
                : null;

        const eingang = {
            power: e.power === true,
            mode: e.mode,
            heat: e.heat,
            aussen,
            raum,
            ziel: e.target,
            econo: e.econo === true,
            abtauen: e.action === 'defrosting' || e.antifreeze === true,
            faehig: (r.zustand.faehig && r.zustand.faehig.wert) || 'unbekannt',
            vortag,
        };
        const { ergebnis, zustand } = bedarf.berechnen(eingang, this.einstellung.konfig, r.zustand.bedarf, jetzt);
        r.zustand.bedarf = zustand;

        let zustandText = ergebnis.zustand;
        let grund = ergebnis.grund + (ergebnis.konflikt ? ` | ${ergebnis.konflikt}` : '');
        if (!r.aktiv) {
            zustandText = 'aus';
            grund = `Regelung aus | ${grund}`;
        } else {
            const ent = schreiber.entscheiden({
                sollwert: ergebnis.zustand === 'neutral' ? null : ergebnis.sollwert,
                istwert: e.demand,
                probelauf,
                faehig: eingang.faehig,
                jetzt,
                zustand: r.zustand.schreiber,
            });
            r.zustand.schreiber = ent.zustand;
            await a.wertSchreiben(`${p}.befehleStunde`, ent.befehleStunde);
            if (ent.aktion === 'wuerde' || ent.aktion === 'senden') {
                const eintrag = {
                    wert: ent.wert,
                    zeit: new Date(jetzt).toISOString(),
                    aktion: ent.aktion,
                    ist: e.demand ?? null,
                };
                await a.wertSchreiben(`${p}.wuerdeSenden`, JSON.stringify(eintrag));
                if (ent.aktion === 'senden') {
                    await this.senden(id, r, ent.wert);
                } else {
                    a.log.info(
                        `${r.name}: demand control (dry run) would send demand ${ent.wert} % (currently ${e.demand ?? '?'} %).`,
                    );
                }
            }
            grund = `${grund} | ${ent.grund}${probelauf ? ' [Probelauf]' : ''}`;
        }
        await a.wertSchreiben(`${p}.sollwert`, ergebnis.sollwert);
        await a.wertSchreiben(`${p}.rohwert`, ergebnis.rohwert);
        await a.wertSchreiben(`${p}.aussenMittel`, ergebnis.aussenMittel);
        await a.wertSchreiben(`${p}.zustand`, zustandText);
        await a.wertSchreiben(`${p}.grund`, grund.slice(0, 500));
        await a.wertSchreiben(`${p}.zustandJson`, zustandSpeicher.schreiben(r.zustand));
    }

    /**
     * Sendet demand an das Modul - nur ausserhalb des Probelaufs (zweite Pruefung hier).
     *
     * @param {string} id    Geraete-ID
     * @param {object} r     Geraeteeintrag
     * @param {number} wert  Geraetestufe
     */
    async senden(id, r, wert) {
        if (!this.sendenErlaubt(r)) {
            this.adapter.log.error(`${r.name}: demand control tried to send outside of live mode - blocked.`);
            return;
        }
        const stufe = schreiber.geraeteStufe(wert);
        const ok = this.adapter.broker
            ? await this.adapter.broker.publish(`command/${r.name}/demand`, String(stufe))
            : false;
        this.adapter.log.info(`${r.name}: demand control sends demand ${stufe} %${ok ? '' : ' (publish failed)'}.`);
    }
}

module.exports = { Bedarfsregelung, konfigAusInstanz, DATENPUNKTE, ZWEIG, tagVon };
