'use strict';

/*
 * Simulierte Uhr fuer den Vergleichsrahmen: ersetzt Date, setTimeout, setInterval und ihre
 * Loeschfunktionen prozessweit. setImmediate, process.nextTick und Promises bleiben echt - damit
 * laufen asynchrone Ketten zwischen zwei Zeitschritten zu Ende.
 */

const echt = {
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
};

/** Simulierte Uhr. */
class Uhr {
    /**
     * @param {number} startMs Startzeit
     */
    constructor(startMs) {
        this.t = startMs;
        this.naechste = 1;
        this.timer = new Map();
    }

    /** Ersetzt die globalen Zeitfunktionen. */
    einbauen() {
        const uhr = this;
        class SimDate extends echt.Date {
            constructor(...a) {
                if (a.length === 0) {
                    super(uhr.t);
                } else {
                    super(...a);
                }
            }
            static now() {
                return uhr.t;
            }
        }
        global.Date = SimDate;
        const setzen = (fn, ms, wiederholt, args) => {
            const id = uhr.naechste++;
            const dauer = Math.max(wiederholt ? 1 : 0, Number(ms) || 0);
            uhr.timer.set(id, { fn, zeit: uhr.t + dauer, dauer, wiederholt, args });
            return { id, unref() {}, ref() {}, hasRef: () => true, refresh() {}, [Symbol.toPrimitive]: () => id };
        };
        const loeschen = h => {
            if (h !== undefined && h !== null) {
                uhr.timer.delete(typeof h === 'object' ? h.id : h);
            }
        };
        global.setTimeout = (fn, ms, ...args) => setzen(fn, ms, false, args);
        global.setInterval = (fn, ms, ...args) => setzen(fn, ms, true, args);
        global.clearTimeout = loeschen;
        global.clearInterval = loeschen;
    }

    /** Stellt die echten Zeitfunktionen wieder her. */
    ausbauen() {
        Object.assign(global, {
            Date: echt.Date,
            setTimeout: echt.setTimeout,
            clearTimeout: echt.clearTimeout,
            setInterval: echt.setInterval,
            clearInterval: echt.clearInterval,
        });
    }

    /**
     * Laesst anstehende Promise-Ketten und setImmediate-Aufrufe ablaufen.
     *
     * @param {number} [runden] Anzahl Durchlaeufe der Ereignisschleife
     */
    async ruhe(runden = 3) {
        for (let i = 0; i < runden; i++) {
            await new Promise(r => echt.setImmediate(r));
        }
    }

    /**
     * Stellt die Uhr um `ms` vor und fuehrt faellige Zeitgeber in zeitlicher Reihenfolge aus.
     *
     * @param {number} ms Schritt
     */
    async vor(ms) {
        const ziel = this.t + ms;
        for (;;) {
            let naechster = null;
            for (const [id, z] of this.timer) {
                if (z.zeit <= ziel && (!naechster || z.zeit < naechster.z.zeit)) {
                    naechster = { id, z };
                }
            }
            if (!naechster) {
                break;
            }
            const { id, z } = naechster;
            this.t = Math.max(this.t, z.zeit);
            if (z.wiederholt) {
                z.zeit += z.dauer;
            } else {
                this.timer.delete(id);
            }
            try {
                z.fn(...z.args);
            } catch (e) {
                console.error(`Zeitgeber: ${e && e.stack ? e.stack : e}`);
            }
            await this.ruhe(2);
        }
        this.t = ziel;
        await this.ruhe(2);
    }
}

module.exports = { Uhr, echt };
