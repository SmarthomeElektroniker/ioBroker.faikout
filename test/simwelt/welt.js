'use strict';

/*
 * Eine "Welt" = Satz Module + je Modul ein Raum mit Anlage (Physik) + Szenario + Uhr.
 *
 * Die Welt hat selbst keine Timer. Ein Aufruf von sekunde() ist eine Sekunde Modulzeit:
 * Ereignisse des Szenarios, Physik (um `zeitfaktor` Sekunden), Hauptschleife jedes Moduls,
 * Messzeile je voller simulierter Minute.
 *  (i)  ECHTZEIT: der Dienst ruft sekunde() im Sekundentakt; Protokollzeiten (Meldeabstand,
 *       tcontrol, failed-set) laufen in echter Zeit, nur die Physik und das Szenario laufen
 *       `zeitfaktor`-mal schneller.
 *  (ii) SCHRITTWEISE: der Vergleichsrahmen ruft vor(ms) mit seiner simulierten Uhr.
 * Zwei Welten mit gleichem Szenario, gleichem Seed und gleichen Modulen starten identisch und
 * bleiben es, solange sie dieselben Befehle bekommen.
 */

const { Physik } = require('./physik');
const { Modul } = require('./modul');
const { szenario: szenarioHolen } = require('./szenarien');

const STANDARD_MODULE = [{ typ: 's21' }, { typ: 'nodemand' }, { typ: 'tcl' }];
const berlin = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/**
 * 12 Hex-Zeichen aus dem Namen - stabil, damit Welten mit gleichen Namen gleiche IDs haben.
 *
 * @param {string} name Modulname
 * @returns {string} ID
 */
function idAus(name) {
    let h = 0x811c9dc5;
    for (const c of String(name)) {
        h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    }
    return `0A51${h.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Welt aus Modulen, Physik und Szenario. */
class Welt {
    /**
     * @param {object} opt Aufbau
     * @param {string} [opt.name] Name der Welt (Messdatei)
     * @param {string|object} [opt.szenario] Name oder Szenario-Objekt (Vorgabe heizenKalterTag)
     * @param {number} [opt.seed] Zufallsstartwert
     * @param {string} [opt.praefix] Vorsatz der Modulnamen (Vorgabe "sim-")
     * @param {Array<object>} [opt.module] je Modul {typ, name?, id?, einstellungen?, anlage?, physik?, nimmtDemand?, abtauMeldung?, feuchteFuehler?, austrittSensor?,
     *   aussengeraet?, zaehler?} - `aussengeraet`: Name eines gemeinsamen Aussengeraets (Multisplit, siehe verbundAnlegen);
     *   `zaehler`: Startwerte der Lebensdauer-Zaehler in Wh {heizen, kuehlen, aussen} (aussen: Stand des Aussengeraets,
     *   bei Multisplit zaehlt der groesste Wert der Gruppe)
     * @param {number} [opt.zeitfaktor] simulierte Sekunden Physik je Modulsekunde
     * @param {(modul: string, topic: string, payload: string, o: {retain: boolean}) => void} opt.senden Ausgang
     * @param {() => number} [opt.uhr] Wanduhr der Module; ohne Angabe Startzeit des Szenarios + Modulzeit
     * @param {(zeile: object) => void} [opt.messung] bekommt je simulierter Minute und Modul eine Zeile
     * @param {(modul: Modul) => void} [opt.abriss] Verbindung wirklich kappen (Dienst); sonst sendet die Welt das Testament selbst
     * @param {(modul: Modul) => void} [opt.wiederkehr] Verbindung wieder aufbauen (Dienst)
     * @param {(marke: {name: string, sek: number}) => void} [opt.beiMarke] Markierung des Szenarios erreicht
     */
    constructor(opt) {
        this.name = opt.name || 'welt';
        this.seed = opt.seed ?? 1;
        this.praefix = opt.praefix ?? 'sim-';
        this.zeitfaktor = opt.zeitfaktor || 1;
        this.senden = opt.senden;
        this.fremdUhr = opt.uhr || null;
        this.messung = opt.messung || null;
        this.haken = { abriss: opt.abriss, wiederkehr: opt.wiederkehr, beiMarke: opt.beiMarke };
        this.modulSek = 0; // Modulzeit seit Erzeugen der Welt
        this.rest = 0;
        this.marken = [];
        this.module = [];
        this.szenarioLaden(opt.szenario || 'heizenKalterTag');
        const liste = opt.module && opt.module.length ? opt.module : STANDARD_MODULE;
        liste.forEach((m, i) => {
            const name = m.name || `${this.praefix}${m.typ || 's21'}`;
            const modul = new Modul({
                ...m,
                name,
                id: m.id || idAus(name),
                physik: this.neuePhysik(i, m.physik),
                transport: { publish: (topic, payload, o) => this.senden(name, topic, payload, o) },
                uhr: () => this.jetzt(),
                anlage: { ...this.szenario.anlage, ...(m.anlage || {}) },
            });
            modul.physikOpt = m.physik;
            modul.aussengeraet = typeof m.aussengeraet === 'string' && m.aussengeraet ? m.aussengeraet : null;
            modul.zaehlerStart = m.zaehler || null;
            this.module.push(modul);
        });
        this.module.forEach(m => this.verbundAnlegen(m));
    }

    /**
     * Zaehlerstaende und Multisplit an der Physik eines Moduls einrichten (nach jedem Neubau der Physik).
     *
     * MULTISPLIT: Module mit demselben `aussengeraet` haengen an EINEM Aussengeraet. Jedes Innengeraet hat
     * weiter seinen eigenen Raum und seine eigenen Zaehler `energyheat`/`energycool` (S21 "U"). Was das
     * Aussengeraet betrifft, melden alle Module der Gruppe gleich - wie an der echten Anlage (Issue #8):
     *   energy       EIN gemeinsamer Zaehler: Startwert + Summe des Verbrauchs aller Innengeraete (100-Wh-Schritte)
     *   consumption  Leistung des Aussengeraets = Summe der Gruppe (10-W-Schritte)
     *   comp         der eine gemeinsame Verdichter: der groesste Bedarf plus 60 % der uebrigen
     *   outside      der eine Aussenfuehler (der des ersten Moduls der Gruppe)
     *
     * @param {Modul} m Modul
     */
    verbundAnlegen(m) {
        const p = m.physik;
        const start = m.zaehlerStart || {};
        const zahl = x => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
        p.whHeizen += zahl(start.heizen);
        p.whKuehlen += zahl(start.kuehlen);
        const gruppe = () => (m.aussengeraet ? this.module.filter(x => x.aussengeraet === m.aussengeraet) : [m]);
        // Stand des Aussengeraets beim Start: mindestens die Summe der Innengeraete-Zaehler
        const sockel = () => {
            const g = gruppe();
            const innen = g.reduce(
                (s, x) => s + zahl((x.zaehlerStart || {}).heizen) + zahl((x.zaehlerStart || {}).kuehlen),
                0,
            );
            return Math.max(innen, ...g.map(x => zahl((x.zaehlerStart || {}).aussen)));
        };
        if (!m.aussengeraet && !m.zaehlerStart) {
            return;
        }
        const eigen = p.messwerte.bind(p);
        p.messwerte = () => {
            const w = eigen();
            const g = gruppe();
            // physik.wh zaehlt seit dem Start alles (auch Bereitschaft) - das ist der Zuwachs am Aussengeraet
            const wh = sockel() + g.reduce((s, x) => s + x.physik.wh, 0);
            w.Whoutside = Math.floor(wh / 100) * 100;
            if (g.length > 1) {
                const comps = g.map(x => x.physik.comp).sort((a, b) => b - a);
                const gemeinsam = comps[0] + 0.6 * comps.slice(1).reduce((s, c) => s + c, 0);
                w.comp = Math.round(Math.min(120, gemeinsam));
                w.consumption = Math.round(g.reduce((s, x) => s + x.physik.watt, 0) / 10) * 10;
                if (g[0] !== m) {
                    w.outside = g[0].physik.messwerte().outside;
                }
            }
            return w;
        };
    }

    /** @returns {number} Wanduhr der Module (ms) */
    jetzt() {
        return this.fremdUhr ? this.fremdUhr() : this.startMs + this.modulSek * 1000;
    }

    /** @returns {number} simulierte Zeit des Szenarios (ms) */
    simZeit() {
        return this.startMs + this.simSek * 1000;
    }

    /**
     * Szenario uebernehmen und die Szenario-Uhr auf null stellen.
     *
     * @param {string|object} sz Name oder Objekt
     */
    szenarioLaden(sz) {
        this.szenario = typeof sz === 'string' ? szenarioHolen(sz) : { name: 'eigenes', ereignisse: [], ...sz };
        this.startMs = Date.parse(this.szenario.start || '2027-01-15T06:00:00Z');
        this.simSek = 0;
        this.minute = 0;
        this.fertig = false;
        this.soll = this.szenario.soll ?? null;
        this.offen = [...(this.szenario.ereignisse || [])]
            .map((e, i) => ({ ...e, beiSek: (e.nachMin || 0) * 60, nr: i }))
            .sort((a, b) => a.beiSek - b.beiSek || a.nr - b.nr);
    }

    /**
     * Raum und Anlage fuer ein Modul aus dem Szenario bauen.
     *
     * @param {number} index Nummer des Moduls (geht in den Seed ein)
     * @param {object} [eigen] Abweichungen dieses Moduls
     * @returns {Physik} Physik
     */
    neuePhysik(index, eigen) {
        const sz = this.szenario;
        const raum = sz.raum || {};
        const aussen = sz.aussen || {};
        const [h, min] = berlin.format(new Date(this.startMs)).split(':').map(Number);
        const { temp, feuchte, ...raumRest } = raum;
        return new Physik({
            seed: this.seed * 1000 + index,
            startMs: this.startMs,
            tagesStunde: (h % 24) + min / 60,
            raum: temp,
            feuchte,
            ...raumRest,
            ...(aussen.mittel !== undefined ? { aussenMittel: aussen.mittel } : {}),
            ...(aussen.hub !== undefined ? { aussenHub: aussen.hub } : {}),
            ...(aussen.feuchte !== undefined ? { aussenFeuchte: aussen.feuchte } : {}),
            ...(eigen || {}),
        });
    }

    /**
     * Szenario wechseln: Raum und Anlage neu, Module und ihre Zaehler bleiben.
     *
     * @param {string|object} sz Name oder Objekt
     */
    szenarioSetzen(sz) {
        this.szenarioLaden(sz);
        this.module.forEach((m, i) => {
            m.physik = this.neuePhysik(i, m.physikOpt);
            this.verbundAnlegen(m);
            m.unsinn = {};
            m.stumm = false;
            m.handeingriff({ ...this.szenario.anlage });
        });
    }

    /**
     * Modul suchen.
     *
     * @param {string} name Name oder ID
     * @returns {Modul|null} Modul
     */
    modul(name) {
        return this.module.find(m => m.name === name || m.id === name) || null;
    }

    /**
     * Nachricht vom Broker an die Module.
     *
     * @param {string} topic Topic
     * @param {Buffer|string} payload Nutzlast
     */
    empfangen(topic, payload) {
        for (const m of this.module) {
            m.empfangen(topic, payload);
        }
    }

    /** Alle Module melden sich am Broker an (schrittweise Betriebsart; der Dienst macht das je Client). */
    verbinden() {
        for (const m of this.module) {
            m.verbinden();
        }
    }

    /**
     * Ereignis ausfuehren (Szenario oder Steuerung).
     *
     * @param {object} e {art, modul?, ...} - siehe szenarien.js
     */
    ereignis(e) {
        const ziele = e.modul ? [this.modul(e.modul)].filter(Boolean) : this.module;
        const spaeter = (sek, fn) =>
            this.offen.push({ beiSek: this.simSek + sek, fn, nr: 1e9 }) &&
            this.offen.sort((a, b) => a.beiSek - b.beiSek);
        const dauer = (e.dauerMin || 0) * 60 + (e.dauerSek || 0);
        if (e.art === 'soll') {
            this.soll = e.wert;
            return;
        }
        if (e.art === 'marke') {
            const marke = { name: e.name, sek: this.simSek, zeit: new Date(this.simZeit()).toISOString() };
            this.marken.push(marke);
            if (this.messung) {
                this.messung({
                    welt: this.name,
                    szenario: this.szenario.name,
                    marke: e.name,
                    sek: this.simSek,
                    zeit: marke.zeit,
                });
            }
            if (this.haken.beiMarke) {
                this.haken.beiMarke(marke);
            }
            return;
        }
        for (const m of ziele) {
            const p = m.physik;
            switch (e.art) {
                case 'aussen':
                    if (e.mittel !== undefined) {
                        p.p.aussenMittel = e.mittel;
                    }
                    if (e.hub !== undefined) {
                        p.p.aussenHub = e.hub;
                    }
                    if (e.versatz !== undefined) {
                        p.einfluss.aussenVersatz = e.versatz;
                    }
                    break;
                case 'sonne':
                    p.einfluss.fuehlerZusatz = e.zusatz ?? 10;
                    if (dauer) {
                        spaeter(dauer, () => (m.physik.einfluss.fuehlerZusatz = 0));
                    }
                    break;
                case 'fuehlerFriert':
                    p.einfrieren(e.feld || 'outside', e.an !== false);
                    if (dauer) {
                        spaeter(dauer, () => m.physik.einfrieren(e.feld || 'outside', false));
                    }
                    break;
                case 'fuehlerUnsinn':
                    if (e.an === false) {
                        delete m.unsinn[e.feld];
                    } else {
                        m.unsinn[e.feld] = e.wert ?? null;
                        m.haStatus(); // die naechste Meldung traegt den Wert
                    }
                    if (dauer) {
                        spaeter(dauer, () => delete m.unsinn[e.feld]);
                    }
                    break;
                case 'stumm':
                    m.stumm = e.an !== false;
                    if (dauer) {
                        spaeter(dauer, () => (m.stumm = false));
                    }
                    break;
                case 'handeingriff':
                    m.handeingriff(e.setze || {});
                    break;
                case 'verbindungsabriss':
                    this.abriss(m);
                    spaeter(dauer || 60, () => this.wiederkehr(m));
                    break;
                case 'wiederkehr':
                    this.wiederkehr(m);
                    break;
                case 'ble':
                    m.bleSetzen(!!e.an, e.versatz !== undefined ? { versatz: e.versatz } : {});
                    break;
                case 'abtauen':
                    p.abtauenAusloesen();
                    break;
                case 'demandAblehnen':
                    m.nimmtDemand = e.an === false ? m.art.nimmtDemand : 'nie';
                    break;
                default:
                    throw new Error(`unknown event "${e.art}"`);
            }
        }
    }

    /**
     * Verbindung eines Moduls kappen.
     *
     * @param {Modul} m Modul
     */
    abriss(m) {
        if (!m.verbunden) {
            return;
        }
        m.abriss();
        if (this.haken.abriss) {
            this.haken.abriss(m);
        } else {
            const t = m.lwt(); // der Broker verschickt das Testament
            this.senden(m.name, t.topic, t.payload, { retain: t.retain });
        }
    }

    /**
     * Verbindung eines Moduls wieder aufbauen.
     *
     * @param {Modul} m Modul
     */
    wiederkehr(m) {
        if (m.verbunden) {
            return;
        }
        if (this.haken.wiederkehr) {
            this.haken.wiederkehr(m);
        } else {
            m.verbinden();
        }
    }

    /** Eine Sekunde Modulzeit. */
    sekunde() {
        while (this.offen.length && this.offen[0].beiSek <= this.simSek) {
            const e = this.offen.shift();
            if (e.fn) {
                e.fn();
            } else {
                this.ereignis(e);
            }
        }
        this.modulSek++;
        this.simSek += this.zeitfaktor;
        for (const m of this.module) {
            m.physik.schritt(this.zeitfaktor);
            m.tick();
        }
        const minute = Math.floor(this.simSek / 60);
        if (minute !== this.minute) {
            this.minute = minute;
            if (this.messung) {
                for (const m of this.module) {
                    this.messung(this.zeile(m));
                }
            }
        }
        if (!this.fertig && this.szenario.dauerMin && this.simSek >= this.szenario.dauerMin * 60) {
            this.fertig = true;
        }
    }

    /**
     * Schrittweise Betriebsart: Uhr um `ms` vorruecken (ganze Sekunden, der Rest wird aufgehoben).
     *
     * @param {number} ms Millisekunden Modulzeit
     */
    vor(ms) {
        this.rest += ms;
        while (this.rest >= 1000) {
            this.rest -= 1000;
            this.sekunde();
        }
    }

    /**
     * Messzeile eines Moduls.
     *
     * @param {Modul} m Modul
     * @returns {object} Zeile fuer die JSONL-Datei
     */
    zeile(m) {
        const z = m.physik.zustand();
        const zaehler = m.zaehler;
        return {
            zeit: new Date(this.simZeit()).toISOString(),
            sek: this.simSek,
            welt: this.name,
            szenario: this.szenario.name,
            modul: m.name,
            typ: m.typ,
            aussen: z.aussen,
            aussenFuehler: m.physik.messwerte().outside,
            raum: z.raum,
            ziel: m.zielwert(),
            soll: this.soll,
            power: m.ac.power,
            mode: m.ac.mode,
            demand: m.ac.demand,
            comp: z.comp,
            watt: z.watt,
            wh: z.wh,
            feuchte: z.feuchte,
            abtauen: z.abtauen,
            starts: z.starts,
            abtauungen: z.abtauungen,
            verbunden: m.verbunden,
            befehle: { ...zaehler.befehle },
            flash: zaehler.flash,
            failedSet: zaehler.failedSet,
            neustarts: zaehler.neustarts,
        };
    }

    /** @returns {object} Stand fuer GET /stand */
    stand() {
        return {
            name: this.name,
            szenario: this.szenario.name,
            seed: this.seed,
            zeitfaktor: this.zeitfaktor,
            simSek: this.simSek,
            simZeit: new Date(this.simZeit()).toISOString(),
            fertig: this.fertig,
            soll: this.soll,
            marken: this.marken,
            module: this.module.map(m => ({ ...m.stand(), physik: m.physik.zustand() })),
        };
    }
}

module.exports = { Welt, idAus, STANDARD_MODULE };
