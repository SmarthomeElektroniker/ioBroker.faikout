'use strict';

/*
 * Feldkunde der faikout-Module.
 *
 * Grundlage sind die Makrolisten des Originals (ESP/main/acfields.m, accontrols.m,
 * acextras.m) und die Funktion revk_state_extra() in Faikout.c. Wichtig: Ein Modul sendet
 * ein Feld nur, wenn es die angeschlossene Klimaanlage tatsaechlich kann
 * (`daikin.status_known & CONTROL_<name>`), zusaetzlich blenden die no*-Einstellungen aus.
 * Es gibt deshalb KEINE feste Feldliste je Geraet - der Adapter legt an, was ankommt, und
 * benutzt diese Tabelle nur, um bekannten Feldern Rolle, Einheit und Schreibbarkeit zu geben.
 * Unbekannte Felder landen ueber ableiten() trotzdem im Objektbaum.
 *
 * Als Grundlage dient das `state/<Name>`-Topic, nicht `Faikout/<Name>`: Ersteres liefert
 * Klartext (mode "cool", fan "medium") und passt damit zu den Kommandotopics; letzteres das
 * native Format mit Kuerzeln (mode "C", fan "3") und Energie als Whoutside/Whheating.
 */

/** Betriebsarten, wie sie state/ meldet und command/<Name>/mode entgegennimmt. */
const MODES = ['off', 'heat_cool', 'cool', 'heat', 'dry', 'fan_only'];

/** Luefterstufen in der Reihenfolge der Originaloberflaeche. */
const FAN_MODES = ['auto', 'night', 'low', 'lowMedium', 'medium', 'mediumHigh', 'high'];

function liste(werte) {
    const s = {};
    for (const w of werte) s[w] = w;
    return s;
}

/**
 * Bekannte Felder. `w: true` heisst: es gibt ein Kommandotopic command/<Name>/<Feld>.
 * `kanal` sortiert den Datenpunkt in den Objektbaum ein.
 */
const FELDER = {
    // ---------------------------------------------------------------- Steuerung
    power: { kanal: 'control', type: 'boolean', role: 'switch.power', w: true, name: { en: 'Power', de: 'Ein/Aus' } },
    mode: {
        kanal: 'control', type: 'string', role: 'level.mode.airconditioner', w: true,
        states: liste(MODES), name: { en: 'Operating mode', de: 'Betriebsart' },
    },
    // ACHTUNG, Asymmetrie: Gelesen wird der Sollwert als `target`, geschrieben aber auf
    // command/<Name>/temp. Belegt durch die HA-Discovery des Geraets selbst
    // (temp_stat_tpl = {{value_json.target}}, temp_cmd_t = ~/temp) und durch die Anlage im
    // Wohnzimmer: temp 23 bei target 18 - 23 war die Raumtemperatur, 18 der Sollwert.
    target: {
        kanal: 'control', type: 'number', role: 'level.temperature', unit: '°C', w: true,
        cmd: 'temp', min: 16, max: 29,
        name: { en: 'Target temperature', de: 'Solltemperatur' },
    },
    fan: {
        kanal: 'control', type: 'string', role: 'level.mode.fan', w: true,
        states: liste(FAN_MODES), name: { en: 'Fan speed', de: 'Lüfterstufe' },
    },
    // ACHTUNG: `swing` kennt sechs Werte, nicht nur off/on. Die HA-Discovery meldet zwar nur
    // off|on, das Geraet selbst sendet aber H, V, H+V (beide Achsen) und C (Komfortbetrieb) -
    // siehe SWING_* in Faikout.c. Am Wohnzimmer-Geraet stand live "V"; mit einer Liste aus
    // nur off/on waere das im VIS ein unbekannter Zustand gewesen.
    swing: {
        kanal: 'control', type: 'string', role: 'level.mode.swing', w: true,
        states: {
            off: 'aus', on: 'ein', V: 'senkrecht', H: 'waagerecht',
            'H+V': 'beide', C: 'Komfort',
        },
        name: { en: 'Swing', de: 'Luftverteilung' },
    },
    swingv: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Swing vertical', de: 'Lamellen senkrecht' } },
    swingh: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Swing horizontal', de: 'Lamellen waagerecht' } },
    preset: {
        kanal: 'control', type: 'string', role: 'level.mode.preset', w: true,
        states: liste(['home', 'eco', 'boost']), name: { en: 'Preset', de: 'Voreinstellung' },
    },
    // Kein `states`: Das Geraet fuehrt demand als Schieber 30..100 in 5er-Schritten
    // (addslider(NULL, "Demand", "demand", 30, 100, "5") in Faikout.c). Eine Zustandsliste
    // machte daraus eine Auswahlliste - und weil ihre Texte "30 %" lauteten, haengte ioBroker
    // die Einheit ein zweites Mal an ("100 % %"). `step` sagt dasselbe ohne beide Nachteile.
    demand: {
        kanal: 'control', type: 'number', role: 'level', unit: '%', w: true,
        min: 30, max: 100, step: 5,
        name: { en: 'Demand control', de: 'Leistungsbegrenzung' },
    },
    econo: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Econo mode', de: 'Sparbetrieb' } },
    powerful: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Powerful', de: 'Turbo' } },
    comfort: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Comfort mode', de: 'Komfortbetrieb' } },
    streamer: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Streamer', de: 'Luftreinigung' } },
    sensor: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Sensor mode', de: 'Anwesenheitssensor' } },
    led: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'LED', de: 'Anzeige-LED' } },
    quiet: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Quiet outdoor', de: 'Leiser Aussenbetrieb' } },
    humidify: { kanal: 'control', type: 'string', role: 'level.mode.humidity', w: true, name: { en: 'Humidify', de: 'Befeuchtung' } },

    // ---------------------------------------------------------------- Messwerte
    // Zwei Raumtemperaturen, die man nicht verwechseln darf:
    //   `temp`   = der Wert, mit dem das Modul REGELT. Reihenfolge im Quellcode
    //              (revk_state_extra): env (externer Referenzsensor), sonst home (Sensor der
    //              Anlage), sonst inlet (Ansaugtemperatur). Ohne externen Sensor ist er
    //              deckungsgleich mit achome - sobald einer eingebunden ist, laufen sie
    //              auseinander.
    //   `achome` = IMMER der Sensor in der Klimaanlage selbst, ohne Ersatz.
    temp: {
        kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C',
        name: {
            en: 'Room temperature (external sensor if present)',
            de: 'Raumtemperatur (externer Sensor falls vorhanden)',
        },
    },
    achome: {
        kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C',
        name: {
            en: "Room temperature (unit's own sensor)",
            de: 'Raumtemperatur (Sensor in der Klimaanlage)',
        },
    },
    inlet: { kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C', name: { en: 'Inlet temperature', de: 'Ansaugtemperatur' } },
    outside: { kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C', name: { en: 'Outside temperature', de: 'Aussentemperatur' } },
    liquid: { kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C', name: { en: 'Refrigerant temperature', de: 'Kältemitteltemperatur' } },
    env: { kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C', name: { en: 'External reference temperature', de: 'Externe Referenztemperatur' } },
    hum: { kanal: 'status', type: 'number', role: 'value.humidity', unit: '%', name: { en: 'Indoor humidity', de: 'Luftfeuchte innen' } },
    // Der Sollwert, wie ihn die Anlage selbst fuehrt. Deckt sich normalerweise mit `target`;
    // im Faikout-Automatikbetrieb weicht er ab, weil dann ein Regelziel vorgegeben wird.
    actarget: { kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C', name: { en: 'Unit setpoint', de: 'Sollwert der Anlage' } },
    comp: { kanal: 'status', type: 'number', role: 'value', unit: 'rpm', name: { en: 'Compressor speed', de: 'Verdichterdrehzahl' } },
    fanfreq: { kanal: 'status', type: 'number', role: 'value', unit: 'rpm', name: { en: 'Fan speed', de: 'Lüfterdrehzahl' } },
    fanrpm: { kanal: 'status', type: 'number', role: 'value', unit: 'rpm', name: { en: 'Fan speed', de: 'Lüfterdrehzahl' } },
    anglev: { kanal: 'status', type: 'number', role: 'value', unit: '°', name: { en: 'Louvre angle', de: 'Lamellenwinkel' } },
    consumption: { kanal: 'status', type: 'number', role: 'value.power', unit: 'W', name: { en: 'Power consumption', de: 'Momentanleistung' } },
    // Das Geraet zaehlt in Wh; der Adapter rechnet in kWh um (siehe umrechnen()).
    energy: { kanal: 'status', type: 'number', role: 'value.energy', unit: 'kWh', wh: true, name: { en: 'Lifetime energy', de: 'Energie gesamt' } },
    energyheat: { kanal: 'status', type: 'number', role: 'value.energy', unit: 'kWh', wh: true, name: { en: 'Lifetime heating energy', de: 'Energie Heizen' } },
    energycool: { kanal: 'status', type: 'number', role: 'value.energy', unit: 'kWh', wh: true, name: { en: 'Lifetime cooling energy', de: 'Energie Kühlen' } },
    heat: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Heating', de: 'Heizt' } },
    slave: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Controlled by other unit', de: 'Von anderer Einheit gesteuert' } },
    antifreeze: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Anti-freeze active', de: 'Frostschutz aktiv' } },
    flap: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Flap', de: 'Klappe' } },
    control: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Automatic control', de: 'Automatiksteuerung' } },
    model: { kanal: 'status', type: 'string', role: 'info.name', name: { en: 'Model', de: 'Modell' } },
    protocol: { kanal: 'status', type: 'string', role: 'info', name: { en: 'Protocol', de: 'Protokoll' } },

    // ---------------------------------------------------------------- Faikout-Automatik
    // Eine eigene Schaltautomatik IM MODUL, unabhaengig von der Klimaanlage. `autoe` ist der
    // Hauptschalter dafuer; er erlaubt zweierlei: Ein-/Ausschalten zu festen Uhrzeiten
    // (auto1/auto0) und Ein-/Ausschalten nach Temperatur (autop mit autot ± autor).
    //
    // ACHTUNG, Bedeutungswechsel: Sind `autoe` UND `autor` gesetzt (autor > 0), regelt das
    // Modul selbst. Dann meldet `target` nicht mehr den Sollwert der Anlage, sondern das
    // Regelziel des Moduls (autot) - und ein Schreibbefehl auf command/<Name>/temp setzt
    // ebenfalls autot statt des Anlagen-Sollwerts (siehe Faikout.c, Zeilen 1679 und 3197).
    // Solange autor = 0 ist, verhaelt sich alles wie gewohnt.
    autoe: {
        kanal: 'status', type: 'boolean', role: 'switch', w: true,
        name: {
            en: 'Faikout automation (timed and temperature switching)',
            de: 'Faikout-Automatik (Zeit- und Temperaturschaltung)',
        },
    },
    autop: {
        kanal: 'status', type: 'boolean', role: 'indicator',
        name: {
            en: 'Automation: switch by temperature',
            de: 'Automatik: Schalten nach Temperatur',
        },
    },
    autor: {
        kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C',
        name: {
            en: 'Automation: tolerance around target (0 = module does not control)',
            de: 'Automatik: Toleranz um das Ziel (0 = Modul regelt nicht)',
        },
    },
    autot: {
        kanal: 'status', type: 'number', role: 'value.temperature', unit: '°C',
        name: { en: 'Automation: target temperature', de: 'Automatik: Zieltemperatur' },
    },
    auto0: {
        kanal: 'status', type: 'string', role: 'text',
        name: { en: 'Automation: switch-off time (HHMM)', de: 'Automatik: Ausschaltzeit (HHMM)' },
    },
    auto1: {
        kanal: 'status', type: 'string', role: 'text',
        name: { en: 'Automation: switch-on time (HHMM)', de: 'Automatik: Einschaltzeit (HHMM)' },
    },

    // ---------------------------------------------------------------- Geraetediagnose
    online: { kanal: 'info', type: 'boolean', role: 'indicator.reachable', name: { en: 'Air conditioner online', de: 'Klimaanlage erreichbar' } },
    ipv4: { kanal: 'info', type: 'string', role: 'info.ip', name: { en: 'IP address', de: 'IP-Adresse' } },
    rssi: { kanal: 'info', type: 'number', role: 'value.rssi', unit: 'dBm', name: { en: 'WiFi signal', de: 'WLAN-Signal' } },
    ssid: { kanal: 'info', type: 'string', role: 'info', name: { en: 'WiFi network', de: 'WLAN-Netz' } },
    bssid: { kanal: 'info', type: 'string', role: 'info', name: { en: 'WiFi BSSID', de: 'WLAN-BSSID' } },
    chan: { kanal: 'info', type: 'number', role: 'value', name: { en: 'WiFi channel', de: 'WLAN-Kanal' } },
    uptime: { kanal: 'info', type: 'number', role: 'value', unit: 's', name: { en: 'Uptime', de: 'Laufzeit' } },
    'mqtt-up': { kanal: 'info', type: 'number', role: 'value', unit: 's', id: 'mqttUp', name: { en: 'MQTT uptime', de: 'MQTT-Laufzeit' } },
    version: { kanal: 'info', type: 'string', role: 'info.firmware', name: { en: 'Firmware version', de: 'Firmware-Version' } },
    build: { kanal: 'info', type: 'string', role: 'info', name: { en: 'Firmware build', de: 'Firmware-Stand' } },
    'build-suffix': { kanal: 'info', type: 'string', role: 'info', id: 'buildSuffix', name: { en: 'Hardware variant', de: 'Hardware-Variante' } },
    app: { kanal: 'info', type: 'string', role: 'info', name: { en: 'Application', de: 'Anwendung' } },
    id: { kanal: 'info', type: 'string', role: 'info.mac', name: { en: 'Device ID', de: 'Geräte-ID' } },
    mem: { kanal: 'info', type: 'number', role: 'value', unit: 'B', name: { en: 'Free memory', de: 'Freier Speicher' } },
    spi: { kanal: 'info', type: 'number', role: 'value', unit: 'B', name: { en: 'Free SPI RAM', de: 'Freier SPI-Speicher' } },
    flash: { kanal: 'info', type: 'number', role: 'value', unit: 'B', name: { en: 'Flash size', de: 'Flash-Größe' } },
    rst: { kanal: 'info', type: 'number', role: 'value', name: { en: 'Reset reason', de: 'Neustartgrund' } },
    up: { kanal: 'info', type: 'boolean', role: 'indicator.reachable', name: { en: 'Module online', de: 'Modul erreichbar' } },
    ts: { kanal: 'info', type: 'string', role: 'date', name: { en: 'Last message', de: 'Letzte Meldung' } },
};

/** Felder, die der Adapter nie als Datenpunkt anlegt (Struktur statt Wert). */
const UEBERSPRINGEN = new Set(['ble']);

/**
 * Beschreibung eines Feldes - bekannt aus [FELDER], sonst aus dem Wert abgeleitet.
 * Damit landet auch ein Feld im Baum, das eine kuenftige Firmware neu einfuehrt.
 */
function beschreibe(feld, wert) {
    const bekannt = FELDER[feld];
    if (bekannt) return bekannt;
    const type = typeof wert === 'boolean' ? 'boolean' : typeof wert === 'number' ? 'number' : 'string';
    return {
        kanal: 'status',
        type,
        role: type === 'boolean' ? 'indicator' : type === 'number' ? 'value' : 'text',
        name: { en: feld, de: feld },
        unbekannt: true,
    };
}

/** Wh -> kWh, wo die Beschreibung es verlangt. Alles andere unveraendert. */
function umrechnen(def, wert) {
    if (def && def.wh && typeof wert === 'number') return Math.round(wert / 10) / 100;
    return wert;
}

/**
 * Platzhalterwert der Luftfeuchte.
 *
 * Anlagen ohne Feuchtesensor melden dauerhaft `hum: 50` - das ist kein Messwert, sondern der
 * Ersatzwert. Ein blindes Uebernehmen taeuscht eine Messung vor, die es nicht gibt (am
 * Wohnzimmer-Geraet des Nutzers genau so aufgetreten).
 */
const FEUCHTE_PLATZHALTER = 50;

/**
 * Entscheidet, ob ein Feuchtewert echt ist.
 *
 * Solange nur 50 kommt, gilt er als Platzhalter und wird verworfen. Sobald das Geraet EINMAL
 * etwas anderes gemeldet hat, ist ein Sensor da - ab dann zaehlt auch die 50 als gueltiger
 * Messwert. Der Merker muss deshalb dauerhaft am Geraet haengen, nicht nur zur Laufzeit.
 *
 * @param {number} wert       gemeldete Luftfeuchte
 * @param {boolean} bekannt   hat dieses Geraet frueher schon einen anderen Wert als 50 gemeldet?
 * @returns {{nehmen: boolean, echtAbJetzt: boolean}}
 */
function feuchteBewerten(wert, bekannt) {
    if (bekannt) return { nehmen: true, echtAbJetzt: true };
    const echt = typeof wert === 'number' && wert !== FEUCHTE_PLATZHALTER;
    return { nehmen: echt, echtAbJetzt: echt };
}

/** Objekt-ID eines Feldes; Bindestriche taugen nicht als ioBroker-ID-Bestandteil. */
function objektId(feld) {
    const def = FELDER[feld];
    if (def && def.id) return def.id;
    return feld.replace(/-/g, '_');
}

module.exports = {
    FELDER, MODES, FAN_MODES, UEBERSPRINGEN, FEUCHTE_PLATZHALTER,
    beschreibe, umrechnen, objektId, feuchteBewerten,
};
