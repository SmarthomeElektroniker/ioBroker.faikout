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
/* Zwei Monate Tageswerte reichen fuer jede Monatsansicht, auch am Monatsersten. */
const RING_TAGE = 62;
/* Zwei Jahre Monatswerte - so laesst sich das laufende Jahr mit dem Vorjahr vergleichen. */
const RING_MONATE = 24;

/** Wh -> kWh, auf 3 Stellen. */
function kwh(wh) {
    return Math.round(wh) / 1000;
}

/** Stundenschluessel wie 2026-08-17T14 (lokale Zeit, denn Tageswechsel ist lokal gemeint). */
function stundeVon(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

function monatVon(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
        monat: null,         // Schluessel des laufenden Monats
        basisMonat: null,    // Zaehlerstand zu Monatsbeginn
        letzterMonat: null,  // kWh des Vormonats
        ring: [],            // [{ stunde, kwh }] - kwh null = Luecke
        ringTage: [],        // [{ tag, kwh }] - Grundlage der Monatsansicht
        ringMonate: [],      // [{ monat, kwh }] - Grundlage der Jahresansicht
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
    // Ueber neuerStand() zusammenfuehren, nicht nur uebernehmen: ein Zustand aus einer aelteren
    // Fassung kennt spaeter ergaenzte Felder nicht, und ein fehlender Ring liess das Update von
    // 0.0.1 auf 0.0.2 bei jedem Zaehlerwert mit "reading 'push'" auflaufen.
    const s = stand
        ? {
            ...neuerStand(),
            ...stand,
            ring: (stand.ring || []).slice(),
            ringTage: (stand.ringTage || []).slice(),
            ringMonate: (stand.ringMonate || []).slice(),
        }
        : neuerStand();
    const stunde = stundeVon(jetzt);
    const tag = tagVon(jetzt);
    const monat = monatVon(jetzt);

    if (typeof wert !== 'number' || !isFinite(wert)) {
        return { stand: s, werte: ausgabe(s, s.letzterWert), hinweise };
    }

    // --- Erster Wert ueberhaupt -------------------------------------------------
    if (s.letzterWert === null || s.basisStunde === null || s.basisTag === null) {
        s.letzterWert = wert;
        s.basisStunde = wert;
        s.basisTag = wert;
        s.basisMonat = wert;
        s.stunde = stunde;
        s.tag = tag;
        s.monat = monat;
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
        s.basisMonat = wert;
        s.stunde = stunde;
        s.tag = tag;
        s.monat = monat;
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
        s.ringTage.push({ tag: s.tag, kwh: s.gestern });
        if (s.ringTage.length > RING_TAGE) s.ringTage = s.ringTage.slice(-RING_TAGE);
        s.basisTag = s.letzterWert;
        s.tag = tag;
    }

    // --- Monatswechsel ----------------------------------------------------------
    // Bewusst nach dem Tageswechsel: der letzte Tag des alten Monats gehoert noch dorthin.
    if (s.monat !== monat) {
        if (s.monat === null || s.basisMonat === null) {
            // Erster Monat, den dieser Zaehler sieht - er hat keinen Vorgaenger. Ohne diese
            // Ausnahme wurde bei einem Zustand aus 0.0.1 (kannte noch keinen Monat) der volle
            // Zaehlerstand als Vormonatsverbrauch gebucht: 3783 kWh statt der echten Differenz.
            s.basisMonat = s.letzterWert;
            s.monat = monat;
        } else {
            s.letzterMonat = kwh(s.letzterWert - s.basisMonat);
            s.ringMonate.push({ monat: s.monat, kwh: s.letzterMonat });
            if (s.ringMonate.length > RING_MONATE) s.ringMonate = s.ringMonate.slice(-RING_MONATE);
            s.basisMonat = s.letzterWert;
            s.monat = monat;
        }
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
    if (stand.stunde === stundeVon(jetzt) && stand.tag === tagVon(jetzt)
        && stand.monat === monatVon(jetzt)) {
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
        dieserMonat: s.basisMonat === null || wert === null ? null : kwh(wert - s.basisMonat),
        letzterMonat: s.letzterMonat,
        ring: s.ring,
        // Der laufende Tag bzw. Monat steht noch nicht im Ring - fuer die Anzeige gehoert er
        // aber ans Ende, sonst fehlt in der Monatsansicht immer der heutige Balken.
        ringTage: s.ringTage.concat(
            s.tag && wert !== null ? [{ tag: s.tag, kwh: kwh(wert - s.basisTag) }] : []),
        ringMonate: s.ringMonate.concat(
            s.monat && wert !== null ? [{ monat: s.monat, kwh: kwh(wert - s.basisMonat) }] : []),
    };
}

module.exports = {
    verarbeiten, pruefen, neuerStand, stundeVon, tagVon, monatVon, kwh,
    RING_STUNDEN, RING_TAGE, RING_MONATE,
};
