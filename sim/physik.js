'use strict';

/*
 * Physik des Simulators: Raum, Aussenluft und Waermepumpe einer Split-Klimaanlage.
 *
 * REIN: keine Uhr, keine Timer, kein Zufall ausser der Quelle aus dem Seed. Die Zeit kommt mit
 * schritt(dtSek) herein und wird intern in feste Takte von 1 s zerlegt - das Ergebnis haengt damit
 * nicht davon ab, in welchen Portionen der Aufrufer die Zeit liefert (Dienst und Offline-Vergleich
 * rechnen identisch).
 *
 * Modell (alles Annahmen, keine Messung einer bestimmten Anlage):
 *  - Raum mit zwei Knoten: Luft (schnell) und Speichermasse (traege), beide verlieren nach aussen.
 *  - Feuchte als Wassergehalt (g/kg) mit Luftwechsel, Eintrag und Entfeuchtung am kalten Register.
 *  - Aussenluft: Tagesgang (Maximum 15 Uhr) plus langsames Rauschen aus dem Seed.
 *  - Verdichter: PI-Regler der Anlage auf Ziel minus Anlagenfuehler, Mindestfrequenz, Takten mit
 *    Mindestlauf- und Sperrzeit, Rampen; `demand` begrenzt die elektrische Aufnahme.
 *  - COP faellt mit der Aussentemperatur und mit der Frequenz; Abtauen nach aufgelaufener Laufzeit
 *    unter 5 Grad aussen.
 */

const TAKT = 1;

/**
 * Zufallsquelle (mulberry32) - gleicher Seed, gleiche Folge.
 *
 * @param {number} seed Startwert
 * @returns {() => number} Zahl in [0, 1)
 */
function zufallsquelle(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Wassergehalt gesaettigter Luft (Magnus, 1013 hPa).
 *
 * @param {number} t Temperatur in Grad
 * @returns {number} g Wasser je kg Luft
 */
function saettigung(t) {
    const p = 6.112 * Math.exp((17.62 * t) / (243.12 + t));
    return (622 * p) / (1013.25 - p);
}

const grenze = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const VORGABE = {
    // Raum
    luftKapazitaet: 8.0e5, // J/K Luft samt leichter Einrichtung
    masseKapazitaet: 3.5e6, // J/K Waende, Moebel
    kopplung: 600, // W/K Luft <-> Masse
    verlustLuft: 70, // W/K Luft -> aussen (Lueftung, Fenster)
    verlustMasse: 25, // W/K Masse -> aussen (Waende)
    quelle: 150, // W innere Lasten
    luftMasse: 600, // kg wirksame Luftmasse fuer die Feuchte (mit Puffer der Einrichtung)
    luftwechselSek: 36000, // Zeitkonstante des Feuchteausgleichs mit aussen
    feuchteEintrag: 80, // g/h (Personen, Kochen)
    // Aussen
    aussenMittel: 5,
    aussenHub: 3,
    aussenFeuchte: 80, // % rF der Aussenluft
    rauschen: 0.4, // K Ausschlag des langsamen Rauschens
    // Anlage
    nennLeistung: 1300, // W elektrisch bei fMax
    fMax: 90, // Hz
    fMin: 16, // Hz
    grundLast: 25, // W eingeschaltet (Luefter, Elektronik)
    ruheLast: 3, // W ausgeschaltet
    mindestLauf: 180, // s
    sperrzeit: 180, // s
    ausSchwelle: 0.8, // K ueber Ziel (Heizen): Verdichter aus
    einSchwelle: 0.0, // K: Verdichter wieder ein
    // ANNAHME: Die Anlage schaltet nicht sofort ab, wenn der Sollwert unter den Raumwert faellt -
    // sie faehrt erst auf Mindestfrequenz und stoppt, wenn das so lange anhaelt.
    ausVerzoegerung: 120, // s
    abtauNach: 4800, // s aufgelaufene Heizlaufzeit unter abtauGrenze
    abtauGrenze: 5, // Grad aussen
    fuehlerEinfluss: 1.5, // K: laufende Anlage verfaelscht ihren eigenen Aussenfuehler
    // Schrittweite der Anlagenfuehler: S21 liefert home/outside/liquid ueber RH/Ra/RI in 0,1 K
    // (daikin_s21.h Z. 109-113); nur Anlagen ohne diese Abfragen fallen auf F9 mit 0,5 K zurueck
    // (Faikout.c Z. 688, 3843). Mit 0,5 laesst jeder Sprung die Vorhersage der Firmware
    // (Z. 4180-4195) um 1 K ausschlagen - das Faikout-Auto taktet dann die Anlage.
    fuehlerAufloesung: 0.1,
};

/** Raum, Aussenluft und Anlage. */
class Physik {
    /**
     * @param {object} [opt] Abweichungen von VORGABE, dazu:
     * @param {number} [opt.seed] Zufallsstartwert
     * @param {number} [opt.startMs] Startzeit (Epoche, ms) - bestimmt die Lage im Tagesgang
     * @param {number} [opt.raum] Starttemperatur Raum
     * @param {number} [opt.feuchte] Start-Raumfeuchte in % rF
     * @param {number} [opt.tagesStunde] Ortsstunde zu startMs (sonst UTC-Stunde + 1)
     */
    constructor(opt = {}) {
        this.p = { ...VORGABE };
        for (const k of Object.keys(VORGABE)) {
            if (typeof opt[k] === 'number') {
                this.p[k] = opt[k];
            }
        }
        this.zufall = zufallsquelle(opt.seed ?? 1);
        this.startMs = opt.startMs ?? 0;
        const d = new Date(this.startMs);
        this.startStunde = opt.tagesStunde ?? (d.getUTCHours() + 1 + d.getUTCMinutes() / 60) % 24;
        this.t = 0; // simulierte Sekunden seit Start
        this.rest = 0;
        this.luft = opt.raum ?? 20;
        this.masse = opt.raum ?? 20;
        this.x = (saettigung(this.luft) * (opt.feuchte ?? 45)) / 100;
        // Stellgroessen der Anlage (setzt das Modul bzw. die "Fernbedienung")
        this.stell = {
            power: false,
            mode: 'H',
            temp: 21,
            demand: 100,
            fan: 'A',
            econo: false,
            powerful: false,
            quiet: false,
        };
        // Eingriffe der Szenarien
        this.einfluss = { aussenVersatz: 0, fuehlerZusatz: 0 };
        this.fest = {}; // eingefrorene Fuehlerwerte: {outside|home|inlet|liquid: Wert}
        this.rausch = 0;
        this.comp = 0;
        this.laeuft = false;
        this.seitWechsel = 1e6;
        this.zuWarmSeit = 0;
        this.integral = 0;
        this.heizt = true;
        this.qWirksam = 0;
        this.abtauen = false;
        this.abtauRest = 0;
        this.abtauZaehler = 0;
        this.abtauungen = 0;
        this.starts = 0;
        this.watt = 0;
        this.wh = 0;
        this.whHeizen = 0;
        this.whKuehlen = 0;
        this.luefter = 0;
    }

    /** @returns {number} echte Aussentemperatur */
    aussen() {
        const stunde = this.startStunde + this.t / 3600;
        return (
            this.p.aussenMittel +
            this.p.aussenHub * Math.cos((2 * Math.PI * (stunde - 15)) / 24) +
            this.rausch +
            this.einfluss.aussenVersatz
        );
    }

    /** @returns {number} Raumfeuchte in % rF */
    feuchte() {
        return grenze((100 * this.x) / saettigung(this.luft), 0, 100);
    }

    /**
     * Elektrische Aufnahme des Verdichters bei Frequenz f.
     *
     * @param {number} f Hz
     * @param {number} aussen Aussentemperatur
     * @returns {number} W
     */
    verdichterLeistung(f, aussen) {
        const hub = this.heizt ? 1 + 0.01 * (7 - aussen) : 1 + 0.012 * (aussen - 27);
        return this.p.nennLeistung * Math.pow(f / this.p.fMax, 1.2) * grenze(hub, 0.7, 1.4);
    }

    /**
     * Hoechste Frequenz, die `demand` zulaesst (Grenze der elektrischen Aufnahme).
     *
     * @param {number} aussen Aussentemperatur
     * @returns {number} Hz
     */
    demandGrenze(aussen) {
        const d = grenze(Number(this.stell.demand) || 100, 30, 100);
        if (d >= 100) {
            return this.p.fMax * (this.stell.powerful ? 1.1 : 1);
        }
        const erlaubt = (d / 100) * this.p.nennLeistung;
        const beiMax = this.verdichterLeistung(this.p.fMax, aussen);
        return Math.max(this.p.fMin, this.p.fMax * Math.pow(erlaubt / beiMax, 1 / 1.2));
    }

    /**
     * Zeit vorruecken.
     *
     * @param {number} dtSek Sekunden (beliebig portioniert)
     */
    schritt(dtSek) {
        this.rest += dtSek;
        while (this.rest >= TAKT - 1e-9) {
            this.rest -= TAKT;
            this.takt();
        }
    }

    /** Abtauen sofort ausloesen (Szenario). */
    abtauenAusloesen() {
        this.abtauZaehler = this.p.abtauNach;
    }

    /** Ein Takt von 1 s. */
    takt() {
        const p = this.p;
        const s = this.stell;
        this.t += TAKT;
        this.seitWechsel += TAKT;
        // Langsames Rauschen der Aussenluft: gebremster Zufallsweg.
        this.rausch += (this.zufall() - 0.5) * 0.004 - this.rausch * 0.0002;
        this.rausch = grenze(this.rausch, -p.rauschen, p.rauschen);
        const aussen = this.aussen();

        const verdichterArt = s.power && ['H', 'C', 'A', 'D'].includes(s.mode);
        const fuehler = this.luft; // die Anlage regelt auf ihren eigenen Raumfuehler
        if (s.mode === 'H') {
            this.heizt = true;
        } else if (s.mode === 'C' || s.mode === 'D') {
            this.heizt = false;
        } else if (s.mode === 'A') {
            // Automatik der Anlage: Richtung mit 1 K Hysterese um das Ziel.
            if (fuehler < s.temp - 1) {
                this.heizt = true;
            } else if (fuehler > s.temp + 1) {
                this.heizt = false;
            }
        }
        // Regelabweichung: positiv = es fehlt Leistung.
        let abw = this.heizt ? s.temp - fuehler : fuehler - s.temp;
        if (s.mode === 'D') {
            // Entfeuchten: laeuft bei feuchter Luft, kuehlt aber hoechstens 1,5 K unter das Ziel.
            abw = this.feuchte() > 50 && fuehler > s.temp - 1.5 ? 0.3 : -2;
        }

        let fSoll = 0;
        if (!verdichterArt) {
            if (this.laeuft) {
                this.laeuft = false;
                this.seitWechsel = 0;
            }
            this.abtauen = false;
            this.abtauRest = 0;
            this.integral = 0;
        } else if (this.abtauen) {
            this.abtauRest -= TAKT;
            fSoll = 45;
            if (this.abtauRest <= 0) {
                this.abtauen = false;
                this.abtauZaehler = 0;
            }
        } else {
            this.zuWarmSeit = abw < -p.ausSchwelle ? this.zuWarmSeit + TAKT : 0;
            if (this.laeuft && this.zuWarmSeit >= p.ausVerzoegerung && this.seitWechsel >= p.mindestLauf) {
                this.laeuft = false;
                this.seitWechsel = 0;
                this.integral = 0;
            } else if (!this.laeuft && abw > p.einSchwelle && this.seitWechsel >= p.sperrzeit) {
                this.laeuft = true;
                this.seitWechsel = 0;
                this.starts++;
                this.integral = 0.1;
            }
            if (this.laeuft) {
                this.integral = grenze(this.integral + (abw * TAKT) / 900, 0, 1);
                const bedarf = grenze(0.5 * abw + this.integral, 0, 1);
                let fHoch = this.demandGrenze(aussen);
                if (s.quiet) {
                    fHoch = Math.min(fHoch, p.fMax * 0.7);
                }
                if (s.econo) {
                    fHoch = Math.min(fHoch, p.fMax * 0.75);
                }
                if (s.mode === 'D') {
                    fHoch = Math.min(fHoch, p.fMax * 0.25);
                }
                fSoll = grenze(p.fMin + bedarf * (p.fMax - p.fMin), p.fMin, Math.max(p.fMin, fHoch));
                // Abtauen: Laufzeit unter der Grenze zaehlt, um den Gefrierpunkt schneller.
                if (this.heizt && aussen < p.abtauGrenze) {
                    this.abtauZaehler += TAKT * (aussen > -5 && aussen < 2 ? 1.5 : 1);
                    if (this.abtauZaehler >= p.abtauNach) {
                        this.abtauen = true;
                        this.abtauungen++;
                        this.abtauRest = 240 + Math.floor(this.zufall() * 240);
                    }
                }
            }
        }
        // Rampe: 1 Hz/s hoch, 2 Hz/s herunter.
        if (this.comp < fSoll) {
            this.comp = Math.min(fSoll, this.comp + 1 * TAKT);
        } else {
            this.comp = Math.max(fSoll, this.comp - 2 * TAKT);
        }

        // Leistung und Waerme
        let pVerd = 0;
        let q = 0; // W in die Raumluft (negativ = Kuehlen)
        let latent = 0; // W Entfeuchtung
        if (this.comp > 0) {
            pVerd = this.verdichterLeistung(this.comp, aussen);
            const last = 1.2 - (0.35 * this.comp) / p.fMax;
            if (this.abtauen) {
                q = -200; // Kreis laeuft rueckwaerts, das Register ist kalt
            } else if (this.heizt) {
                q = pVerd * grenze(2.0 + 0.085 * (aussen + 15), 1.6, 5.5) * last;
            } else {
                const gesamt = pVerd * grenze(6.0 - 0.12 * (aussen - 20), 2.0, 6.5) * last;
                const rf = this.feuchte();
                const anteil = s.mode === 'D' ? 0.6 : grenze((rf - 40) / 100, 0, 0.35);
                latent = gesamt * anteil;
                q = -(gesamt - latent);
            }
        }
        // Das Register braucht etwa eine Minute, bis die Leistung im Raum ankommt.
        this.qWirksam += ((q - this.qWirksam) * TAKT) / 60;
        this.luefter = s.power ? (this.abtauen ? 0 : 600 + 6 * this.comp) : 0;
        this.watt = s.power ? p.grundLast + pVerd : p.ruheLast;
        const wh = (this.watt * TAKT) / 3600;
        this.wh += wh;
        if (s.power && this.comp > 0) {
            if (this.heizt) {
                this.whHeizen += wh;
            } else {
                this.whKuehlen += wh;
            }
        }

        // Raum
        const zurLuft =
            this.qWirksam + p.quelle + p.verlustLuft * (aussen - this.luft) + p.kopplung * (this.masse - this.luft);
        const zurMasse = p.kopplung * (this.luft - this.masse) + p.verlustMasse * (aussen - this.masse);
        this.luft += (zurLuft * TAKT) / p.luftKapazitaet;
        this.masse += (zurMasse * TAKT) / p.masseKapazitaet;
        // Feuchte: Luftwechsel, Eintrag, Kondensat (2450 J/g).
        const xAussen = (saettigung(aussen) * p.aussenFeuchte) / 100;
        this.x += ((xAussen - this.x) * TAKT) / p.luftwechselSek;
        this.x += (p.feuchteEintrag / 3600 / p.luftMasse) * TAKT;
        this.x -= ((latent / 2450) * TAKT) / p.luftMasse;
        this.x = grenze(this.x, 0.5, saettigung(this.luft));
    }

    /**
     * Was die Anlage ueber ihre Fuehler meldet (Schrittweite `fuehlerAufloesung`) - samt Szenario-Eingriffen.
     *
     * @returns {{home: number, inlet: number, outside: number, liquid: number, comp: number, fanrpm: number,
     *   consumption: number, Whoutside: number, Whheating: number, Whcooling: number, hum: number, antifreeze: boolean}}
     *   Messwerte
     */
    messwerte() {
        const p = this.p;
        const anteil = this.comp / p.fMax;
        const stufe = x => Math.round(Math.round(x / p.fuehlerAufloesung) * p.fuehlerAufloesung * 100) / 100;
        let eigen = 0;
        if (this.comp > 0) {
            eigen = this.abtauen ? 3 : this.heizt ? -p.fuehlerEinfluss * anteil : p.fuehlerEinfluss * 1.5 * anteil;
        }
        let liquid = this.luft;
        if (this.comp > 0) {
            liquid = this.abtauen ? 2 : this.heizt ? 28 + 18 * anteil : 14 - 8 * anteil;
        }
        const w = {
            home: stufe(this.luft),
            inlet: stufe(this.luft + (this.comp > 0 && this.heizt && !this.abtauen ? 1 : 0)),
            outside: stufe(this.aussen() + this.einfluss.fuehlerZusatz + eigen),
            liquid: stufe(liquid),
            comp: Math.round(this.comp),
            fanrpm: Math.round(this.luefter / 10) * 10,
            consumption: Math.round(this.watt / 10) * 10, // S21 meldet in 10-W-Schritten (Faikout.c Z. 720)
            Whoutside: Math.floor(this.wh / 100) * 100, // 100-Wh-Schritte (Faikout.c Z. 705-715)
            Whheating: Math.floor(this.whHeizen / 100) * 100,
            Whcooling: Math.floor(this.whKuehlen / 100) * 100,
            hum: Math.round(this.feuchte()),
            antifreeze: this.abtauen,
        };
        for (const k of Object.keys(this.fest)) {
            if (k in w) {
                w[k] = this.fest[k];
            }
        }
        return w;
    }

    /**
     * Fuehler einfrieren oder wieder freigeben (Szenario "fuehlerFriertEin").
     *
     * @param {string} feld home|inlet|outside|liquid
     * @param {boolean} an einfrieren/freigeben
     */
    einfrieren(feld, an) {
        delete this.fest[feld];
        if (an) {
            this.fest[feld] = this.messwerte()[feld];
        }
    }

    /** @returns {object} wahrer Zustand fuer die Messdatei */
    zustand() {
        return {
            sek: this.t,
            aussen: Math.round(this.aussen() * 100) / 100,
            raum: Math.round(this.luft * 1000) / 1000,
            masse: Math.round(this.masse * 1000) / 1000,
            feuchte: Math.round(this.feuchte() * 10) / 10,
            comp: Math.round(this.comp * 10) / 10,
            watt: Math.round(this.watt),
            wh: Math.round(this.wh * 10) / 10,
            abtauen: this.abtauen,
            starts: this.starts,
            abtauungen: this.abtauungen,
        };
    }
}

module.exports = { Physik, zufallsquelle, saettigung, VORGABE };
