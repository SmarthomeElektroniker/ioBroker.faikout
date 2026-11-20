'use strict';

/*
 * Benannte Szenarien: Startzeit, Dauer, Startzustand von Raum/Aussenluft/Anlage und eine
 * Ereignisliste ueber die simulierte Zeit (nachMin = Minuten seit Start).
 *
 * Ereignisarten (fuehrt welt.js aus):
 *   aussen        {mittel?, hub?, versatz?}           Wetter aendert sich
 *   sonne         {zusatz, dauerMin}                  Aussenfuehler zeigt `zusatz` K mehr als die Luft
 *   fuehlerFriert {feld, dauerMin}                    Anlagenfuehler (outside|home|inlet|liquid) bleibt stehen
 *   fuehlerUnsinn {feld, wert, dauerMin}              Statusfeld liefert `wert` ("n/a", null, Text)
 *   stumm         {dauerMin}                          Modul bleibt verbunden, meldet aber nichts
 *   handeingriff  {setze: {temp?, mode?, power?...}}  Fernbedienung
 *   verbindungsabriss {dauerSek}                      MQTT weg (Testament), danach Wiederkehr mit Discovery
 *   ble           {an, versatz?}                      BLE-Fuehler koppeln/entfernen
 *   abtauen       {}                                  Abtauen jetzt ausloesen
 *   demandAblehnen {an}                               Anlage uebernimmt demand nicht mehr / wieder
 *   soll          {wert}                              Wunschtemperatur des Bewohners (nur Messdatei, fuer Kennzahlen)
 *   marke         {name}                              Markierung fuer den Vergleichsrahmen (z. B. adapterNeustart)
 * Ohne `modul` gilt ein Ereignis fuer alle Module der Welt.
 */

const SZENARIEN = {
    heizenKalterTag: {
        beschreibung: 'Frosttag, Heizen von 18 auf 21 Grad, spaeter Sollwertsprung auf 22',
        start: '2027-01-15T05:00:00Z',
        dauerMin: 720,
        raum: { temp: 18, feuchte: 40 },
        aussen: { mittel: -3, hub: 3, feuchte: 85 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [{ nachMin: 360, art: 'soll', wert: 22 }],
    },
    uebergang: {
        beschreibung: 'Uebergangszeit, 12-17 Grad aussen: Schwachlast, die Anlage taktet',
        start: '2026-10-10T04:00:00Z',
        dauerMin: 720,
        raum: { temp: 20.5, feuchte: 50 },
        aussen: { mittel: 14, hub: 3, feuchte: 75 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [],
    },
    sonneAufAussenfuehler: {
        beschreibung: 'Kalter Tag, mittags Sonne auf dem Aussenfuehler (+8 bis +15 K gegenueber der Luft)',
        start: '2027-01-20T07:00:00Z',
        dauerMin: 480,
        raum: { temp: 20, feuchte: 40 },
        aussen: { mittel: 0, hub: 2, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 120, art: 'sonne', zusatz: 8, dauerMin: 30 },
            { nachMin: 150, art: 'sonne', zusatz: 15, dauerMin: 60 },
            { nachMin: 210, art: 'sonne', zusatz: 10, dauerMin: 40 },
        ],
    },
    fuehlerFriertEin: {
        beschreibung: 'Aussenwert bleibt stehen, spaeter bleibt der Raumwert stehen, dann bleiben Meldungen ganz aus',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 360,
        raum: { temp: 20, feuchte: 40 },
        aussen: { mittel: 0, hub: 5, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 30, art: 'fuehlerFriert', feld: 'outside', dauerMin: 120 },
            { nachMin: 180, art: 'fuehlerFriert', feld: 'home', dauerMin: 60 },
            { nachMin: 270, art: 'stumm', dauerMin: 45 },
        ],
    },
    fuehlerNichtNumerisch: {
        beschreibung: 'outside und temp liefern zeitweise "n/a", null oder Text',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 240,
        raum: { temp: 20, feuchte: 40 },
        aussen: { mittel: 2, hub: 3, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 20, art: 'fuehlerUnsinn', feld: 'outside', wert: 'n/a', dauerMin: 30 },
            { nachMin: 70, art: 'fuehlerUnsinn', feld: 'outside', wert: null, dauerMin: 30 },
            { nachMin: 120, art: 'fuehlerUnsinn', feld: 'temp', wert: 'Fehler', dauerMin: 20 },
            { nachMin: 160, art: 'fuehlerUnsinn', feld: 'demand', wert: '', dauerMin: 20 },
        ],
    },
    abtauen: {
        beschreibung: 'Feuchtkalt um den Gefrierpunkt: regelmaessiges Abtauen, einmal erzwungen',
        start: '2027-01-10T04:00:00Z',
        dauerMin: 480,
        raum: { temp: 19, feuchte: 45 },
        aussen: { mittel: 0, hub: 1.5, feuchte: 95 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [{ nachMin: 20, art: 'abtauen' }],
    },
    geraetLehntDemandAb: {
        beschreibung: 'Die Anlage uebernimmt demand erst, dann 3 Stunden lang nicht (failed-set), dann wieder',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 480,
        raum: { temp: 19.5, feuchte: 40 },
        aussen: { mittel: 3, hub: 3, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 90, art: 'demandAblehnen', an: true },
            { nachMin: 270, art: 'demandAblehnen', an: false },
        ],
    },
    handeingriff: {
        beschreibung: 'Jemand stellt per Fernbedienung Ziel, Modus und Power um',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 360,
        raum: { temp: 20, feuchte: 40 },
        aussen: { mittel: 4, hub: 3, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 60, art: 'handeingriff', setze: { temp: 23 } },
            { nachMin: 60, art: 'soll', wert: 23 },
            { nachMin: 150, art: 'handeingriff', setze: { mode: 'F' } },
            { nachMin: 180, art: 'handeingriff', setze: { mode: 'H', temp: 21 } },
            { nachMin: 180, art: 'soll', wert: 21 },
            { nachMin: 240, art: 'handeingriff', setze: { power: false } },
            { nachMin: 300, art: 'handeingriff', setze: { power: true } },
        ],
    },
    neustartImEntfeuchten: {
        beschreibung: 'Schwuel, Anlage entfeuchtet (dry); bei Minute 45 startet der Vergleichsrahmen den Adapter neu',
        start: '2026-07-20T12:00:00Z',
        dauerMin: 180,
        raum: { temp: 24, feuchte: 72 },
        aussen: { mittel: 23, hub: 4, feuchte: 80 },
        anlage: { power: true, mode: 'D', temp: 23 },
        soll: 23,
        ereignisse: [{ nachMin: 45, art: 'marke', name: 'adapterNeustart' }],
    },
    wochenplanZeitumstellung: {
        beschreibung: 'Start 01:30 MEZ kurz vor der Umstellung auf Sommerzeit (28.03.2027, 02:00 -> 03:00)',
        start: '2027-03-28T00:30:00Z',
        dauerMin: 240,
        raum: { temp: 19, feuchte: 45 },
        aussen: { mittel: 6, hub: 4, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 19 },
        soll: 19,
        ereignisse: [{ nachMin: 30, art: 'marke', name: 'zeitumstellung' }],
    },
    wochenplanZeitumstellungHerbst: {
        beschreibung: 'Start 02:30 MESZ kurz vor der Umstellung auf Winterzeit (25.10.2026, 03:00 -> 02:00)',
        start: '2026-10-25T00:30:00Z',
        dauerMin: 240,
        raum: { temp: 19, feuchte: 50 },
        aussen: { mittel: 8, hub: 3, feuchte: 85 },
        anlage: { power: true, mode: 'H', temp: 19 },
        soll: 19,
        ereignisse: [{ nachMin: 30, art: 'marke', name: 'zeitumstellung' }],
    },
    verbindungsabriss: {
        beschreibung: 'MQTT faellt zweimal aus (2 min und 20 min), dazwischen laeuft die Anlage weiter',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 240,
        raum: { temp: 20, feuchte: 40 },
        aussen: { mittel: 2, hub: 3, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 40, art: 'verbindungsabriss', dauerSek: 120 },
            { nachMin: 100, art: 'verbindungsabriss', dauerSek: 1200 },
        ],
    },
    bleAnAus: {
        beschreibung: 'BLE-Fuehler wird gekoppelt (zeigt 0,8 K weniger als die Anlage) und wieder entfernt',
        start: '2027-01-15T06:00:00Z',
        dauerMin: 300,
        raum: { temp: 20, feuchte: 45 },
        aussen: { mittel: 3, hub: 3, feuchte: 80 },
        anlage: { power: true, mode: 'H', temp: 21 },
        soll: 21,
        ereignisse: [
            { nachMin: 45, art: 'ble', an: true, versatz: -0.8 },
            { nachMin: 180, art: 'ble', an: false },
        ],
    },
    sommerSchwuel: {
        beschreibung: 'Heisser, feuchter Tag: Kuehlen auf 24 Grad bei hoher Feuchte',
        start: '2026-07-20T08:00:00Z',
        dauerMin: 600,
        raum: { temp: 26.5, feuchte: 70, feuchteEintrag: 200 },
        aussen: { mittel: 28, hub: 5, feuchte: 70 },
        anlage: { power: true, mode: 'C', temp: 24 },
        soll: 24,
        ereignisse: [{ nachMin: 300, art: 'soll', wert: 23 }],
    },
};

/**
 * Szenario holen (Kopie, damit Aufrufer es anpassen duerfen).
 *
 * @param {string} name Name
 * @returns {object} Szenario mit `name`
 */
function szenario(name) {
    const s = SZENARIEN[name];
    if (!s) {
        throw new Error(`unknown scenario "${name}" (known: ${Object.keys(SZENARIEN).join(', ')})`);
    }
    return { name, ...JSON.parse(JSON.stringify(s)) };
}

module.exports = { SZENARIEN, szenario, namen: () => Object.keys(SZENARIEN) };
