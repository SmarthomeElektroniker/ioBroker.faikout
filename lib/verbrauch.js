'use strict';

/*
 * Verbrauchsrechnung aus den Lebensdauer-Zaehlern der Anlage.
 *
 * Die Module liefern nur monoton steigende Gesamtzaehler in Wh (energy, energyheat,
 * energycool). Verbrauch je Stunde und Tag entsteht erst durch Differenzbildung - und dabei
 * gibt es vier Faelle, die man nicht naiv behandeln darf:
 *
 *   1. Der Zaehler springt zurueck (Modul-Neustart, Firmware-Reset). Eine negative Differenz
 *      darf NICHT als riesiger Verbrauch gebucht werden; stattdessen neu basieren.
 *   2. Der Adapter war Stunden offline. Die aufgelaufene Differenz gehoert nicht komplett in
 *      die letzte Stunde - die uebersprungenen Stunden werden als Luecke (null) vermerkt.
 *   3. Der Stundenwechsel passiert auch ohne eintreffende Nachricht. Deshalb muss der Aufrufer
 *      zusaetzlich zyklisch anstossen (siehe pruefen()).
 *   4. Nach einem Adapter-Neustart muessen die Basiswerte noch da sein, sonst faengt jede
 *      Zaehlung wieder bei null an. Der Zustand gehoert deshalb persistiert.
 *
 * Dieses Modul ist bewusst frei von ioBroker-Abhaengigkeiten: rein Zustand rein, Zustand raus.
 */

/** Wie viele abgeschlossene Stunden der Ringpuffer behaelt. */
const RING_STUNDEN = 48;

/** Wh -> kWh, auf 3 Stellen. */
function kwh(wh) {
    return Math.round(wh) / 1000;
}

/** Stundenschluessel wie 2026-08-17T14 (lokale Zeit, denn Tageswechsel ist lokal gemeint). */
function stundeVon(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

function tagVon(d) {
    return stundeVon(d).slice(0, 10);
}

/** Wie viele volle Stunden liegen zwischen zwei Stundenschluesseln? */
function stundenDazwischen(a, b) {
    const zeit = s => new Date(
        Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), Number(s.slice(11, 13))
    ).getTime();
    return Math.round((zeit(b) - zeit(a)) / 3600000);
}

/** Leerer Anfangszustand eines Zaehlers. */
function neuerStand() {
    return {
        letzterWert: null,   // zuletzt gesehener Gesamtzaehler in Wh
        basisStunde: null,   // Zaehlerstand zu Beginn der laufenden Stunde
        basisTag: null,      // Zaehlerstand zu Beginn des laufenden Tages
        stunde: null,        // Schluessel der laufenden Stunde
        tag: null,           // Schluessel des laufenden Tages
        letzteStunde: null,  // kWh der zuletzt abgeschlossenen Stunde
        gestern: null,       // kWh des Vortages
        ring: [],            // [{ stunde, kwh }] - kwh null = Luecke
    };
}

/**
 * Verarbeitet einen neuen Zaehlerstand.
 *
 * @param {object|null} stand  bisheriger Zustand (aus der Persistenz) oder null
 * @param {number} wert        aktueller Gesamtzaehler in Wh
 * @param {Date} [jetzt]       Zeitpunkt (fuer Tests setzbar)
 * @returns {{stand: object, werte: object, hinweise: string[]}}
 */
function verarbeiten(stand, wert, jetzt = new Date()) {
    const hinweise = [];
    const s = stand ? { ...stand, ring: (stand.ring || []).slice() } : neuerStand();
    const stunde = stundeVon(jetzt);
    const tag = tagVon(jetzt);

    if (typeof wert !== 'number' || !isFinite(wert)) {
        return { stand: s, werte: ausgabe(s, s.letzterWert), hinweise };
    }

    // --- Erster Wert ueberhaupt -------------------------------------------------
    if (s.letzterWert === null || s.basisStunde === null || s.basisTag === null) {
        s.letzterWert = wert;
        s.basisStunde = wert;
        s.basisTag = wert;
        s.stunde = stunde;
        s.tag = tag;
        return { stand: s, werte: ausgabe(s, wert), hinweise };
    }

    // --- Zaehler zurueckgesprungen ----------------------------------------------
    // Kommt beim Neustart des Moduls vor. Der Verbrauch dazwischen ist nicht mehr
    // ermittelbar; alles neu basieren, damit kein Fantasiewert entsteht.
    if (wert < s.letzterWert) {
        hinweise.push(`Zählerstand zurückgesprungen (${s.letzterWert} -> ${wert} Wh) - Zählung neu begonnen`);
        s.letzterWert = wert;
        s.basisStunde = wert;
        s.basisTag = wert;
        s.stunde = stunde;
        s.tag = tag;
        return { stand: s, werte: ausgabe(s, wert), hinweise };
    }

    // --- Stundenwechsel ---------------------------------------------------------
    if (s.stunde !== stunde) {
        const luecke = stundenDazwischen(s.stunde, stunde) - 1; // uebersprungene volle Stunden
        s.letzteStunde = kwh(s.letzterWert - s.basisStunde);
        s.ring.push({ stunde: s.stunde, kwh: s.letzteStunde });
        if (luecke > 0) {
            // Der Adapter war offline. Was in dieser Zeit verbraucht wurde, laesst sich nicht
            // auf die einzelnen Stunden aufteilen - als Luecke kennzeichnen statt zu erfinden.
            hinweise.push(`${luecke} Stunde(n) ohne Daten - als Lücke vermerkt`);
            for (let i = 1; i <= luecke; i++) s.ring.push({ stunde: null, kwh: null });
        }
        if (s.ring.length > RING_STUNDEN) s.ring = s.ring.slice(-RING_STUNDEN);
        s.basisStunde = s.letzterWert;
        s.stunde = stunde;
    }

    // --- Tageswechsel -----------------------------------------------------------
    if (s.tag !== tag) {
        s.gestern = kwh(s.letzterWert - s.basisTag);
        s.basisTag = s.letzterWert;
        s.tag = tag;
    }

    s.letzterWert = wert;
    return { stand: s, werte: ausgabe(s, wert), hinweise };
}

/**
 * Stossen ohne neuen Zaehlerstand - fuer den Timer auf die volle Stunde. Meldet einen
 * Stunden- bzw. Tageswechsel auch dann, wenn gerade keine Nachricht hereinkam.
 */
function pruefen(stand, jetzt = new Date()) {
    if (!stand || stand.letzterWert === null) return { stand, werte: null, hinweise: [] };
    if (stand.stunde === stundeVon(jetzt) && stand.tag === tagVon(jetzt)) {
        return { stand, werte: null, hinweise: [] };
    }
    return verarbeiten(stand, stand.letzterWert, jetzt);
}

function ausgabe(s, wert) {
    return {
        gesamt: wert === null ? null : kwh(wert),
        stunde: s.basisStunde === null || wert === null ? null : kwh(wert - s.basisStunde),
        letzteStunde: s.letzteStunde,
        heute: s.basisTag === null || wert === null ? null : kwh(wert - s.basisTag),
        gestern: s.gestern,
        ring: s.ring,
    };
}

module.exports = { verarbeiten, pruefen, neuerStand, stundeVon, tagVon, kwh, RING_STUNDEN };
