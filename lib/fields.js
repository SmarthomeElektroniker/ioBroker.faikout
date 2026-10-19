'use strict';

/** Die elf Sprachen, die ioBroker fuer Objektnamen erwartet. */
const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

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

/** Taetigkeit der Anlage, Reihenfolge wie hvac_action[] in Faikout.c. */
const HVAC_ACTIONS = ['off', 'preheating', 'heating', 'cooling', 'drying', 'fan', 'idle', 'defrosting'];

/** Luefterstufen in der Reihenfolge der Originaloberflaeche. */
const FAN_MODES = ['auto', 'night', 'low', 'lowMedium', 'medium', 'mediumHigh', 'high'];

function liste(werte) {
    const s = {};
    for (const w of werte) {
        s[w] = w;
    }
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
        kanal: 'control',
        type: 'string',
        role: 'state',
        w: true,
        states: liste(MODES),
        name: { en: 'Operating mode', de: 'Betriebsart' },
    },
    // ACHTUNG, Asymmetrie: Gelesen wird der Sollwert als `target`, geschrieben aber auf
    // command/<Name>/temp. Belegt durch die HA-Discovery des Geraets selbst
    // (temp_stat_tpl = {{value_json.target}}, temp_cmd_t = ~/temp) und durch die Anlage im
    // Wohnzimmer: temp 23 bei target 18 - 23 war die Raumtemperatur, 18 der Sollwert.
    target: {
        kanal: 'control',
        type: 'number',
        role: 'level.temperature',
        unit: '°C',
        w: true,
        cmd: 'temp',
        min: 16,
        max: 29,
        name: { en: 'Target temperature', de: 'Solltemperatur' },
    },
    fan: {
        kanal: 'control',
        type: 'string',
        role: 'state',
        w: true,
        states: liste(FAN_MODES),
        name: { en: 'Fan speed', de: 'Lüfterstufe' },
    },
    // ACHTUNG: `swing` kennt sechs Werte, nicht nur off/on. Die HA-Discovery meldet zwar nur
    // off|on, das Geraet selbst sendet aber H, V, H+V (beide Achsen) und C (Komfortbetrieb) -
    // siehe SWING_* in Faikout.c. Am Wohnzimmer-Geraet stand live "V"; mit einer Liste aus
    // nur off/on waere das im VIS ein unbekannter Zustand gewesen.
    swing: {
        kanal: 'control',
        type: 'string',
        role: 'state',
        w: true,
        states: {
            off: 'off',
            on: 'on',
            V: 'vertical',
            H: 'horizontal',
            'H+V': 'both',
            C: 'comfort',
        },
        name: { en: 'Swing', de: 'Luftverteilung' },
    },
    swingv: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Swing vertical', de: 'Lamellen senkrecht' },
    },
    swingh: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Swing horizontal', de: 'Lamellen waagerecht' },
    },
    preset: {
        kanal: 'control',
        type: 'string',
        role: 'state',
        w: true,
        states: liste(['home', 'eco', 'boost']),
        name: { en: 'Preset', de: 'Voreinstellung' },
    },
    // Kein `states`: Das Geraet fuehrt demand als Schieber 30..100 in 5er-Schritten
    // (addslider(NULL, "Demand", "demand", 30, 100, "5") in Faikout.c). Eine Zustandsliste
    // machte daraus eine Auswahlliste - und weil ihre Texte "30 %" lauteten, haengte ioBroker
    // die Einheit ein zweites Mal an ("100 % %"). `step` sagt dasselbe ohne beide Nachteile.
    demand: {
        kanal: 'control',
        type: 'number',
        role: 'level',
        unit: '%',
        w: true,
        min: 30,
        max: 100,
        step: 5,
        name: { en: 'Demand control', de: 'Leistungsbegrenzung' },
    },
    econo: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Econo mode', de: 'Sparbetrieb' },
    },
    powerful: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'Powerful', de: 'Turbo' } },
    comfort: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Comfort mode', de: 'Komfortbetrieb' },
    },
    streamer: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Streamer', de: 'Luftreinigung' },
    },
    sensor: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Sensor mode', de: 'Anwesenheitssensor' },
    },
    led: { kanal: 'control', type: 'boolean', role: 'switch', w: true, name: { en: 'LED', de: 'Anzeige-LED' } },
    quiet: {
        kanal: 'control',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: { en: 'Quiet outdoor', de: 'Leiser Aussenbetrieb' },
    },
    humidify: {
        kanal: 'control',
        type: 'string',
        role: 'state',
        w: true,
        name: { en: 'Humidify', de: 'Befeuchtung' },
    },

    // ---------------------------------------------------------------- Messwerte
    // Zwei Raumtemperaturen, die man nicht verwechseln darf:
    //   `temp`   = der Wert, mit dem das Modul REGELT. Reihenfolge im Quellcode
    //              (revk_state_extra): env (externer Referenzsensor), sonst home (Sensor der
    //              Anlage), sonst inlet (Ansaugtemperatur). Ohne externen Sensor ist er
    //              deckungsgleich mit achome - sobald einer eingebunden ist, laufen sie
    //              auseinander.
    //   `achome` = IMMER der Sensor in der Klimaanlage selbst, ohne Ersatz.
    temp: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: {
            en: 'Room temperature (external sensor if present)',
            de: 'Raumtemperatur (externer Sensor falls vorhanden)',
        },
    },
    achome: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: {
            en: "Room temperature (unit's own sensor)",
            de: 'Raumtemperatur (Sensor in der Klimaanlage)',
        },
    },
    inlet: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Inlet temperature', de: 'Ansaugtemperatur' },
    },
    outside: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Outside temperature', de: 'Aussentemperatur' },
    },
    liquid: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Refrigerant temperature', de: 'Kältemitteltemperatur' },
    },
    env: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'External reference temperature', de: 'Externe Referenztemperatur' },
    },
    hum: {
        kanal: 'status',
        type: 'number',
        role: 'value.humidity',
        unit: '%',
        name: { en: 'Indoor humidity', de: 'Luftfeuchte innen' },
    },
    // Der Sollwert, wie ihn die Anlage selbst fuehrt. Deckt sich normalerweise mit `target`;
    // im Faikout-Automatikbetrieb weicht er ab, weil dann ein Regelziel vorgegeben wird.
    actarget: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Unit setpoint', de: 'Sollwert der Anlage' },
    },
    // EINHEIT JE MODUL VERSCHIEDEN: Ab Werk sendet das Modul `comp` in Hz und `fanfreq` in Hz
    // (fanrpm / 60, eine Nachkommastelle). Erst die Moduleinstellungen ha.comprpm bzw. ha.fanrpm
    // schalten auf rpm um (revk_state_extra in Faikout.c). `unit` ist deshalb nur der
    // Werksstand; die tatsaechliche Einheit liest der Adapter aus der HA-Discovery des Moduls
    // (homeassistant/sensor/<id>comp/config, Feld unit_of_meas) - siehe haSensorAuswerten().
    comp: {
        kanal: 'status',
        type: 'number',
        role: 'value',
        unit: 'Hz',
        einheiten: ['Hz', 'rpm'],
        name: { en: 'Compressor speed', de: 'Verdichterdrehzahl' },
    },
    fanfreq: {
        kanal: 'status',
        type: 'number',
        role: 'value',
        unit: 'Hz',
        einheiten: ['Hz', 'rpm'],
        name: { en: 'Fan speed', de: 'Lüfterdrehzahl' },
    },
    fanrpm: {
        kanal: 'status',
        type: 'number',
        role: 'value',
        unit: 'rpm',
        name: { en: 'Fan speed', de: 'Lüfterdrehzahl' },
    },
    anglev: {
        kanal: 'status',
        type: 'number',
        role: 'value',
        unit: '°',
        name: { en: 'Louvre angle', de: 'Lamellenwinkel' },
    },
    consumption: {
        kanal: 'status',
        type: 'number',
        role: 'value.power',
        unit: 'W',
        name: { en: 'Power consumption', de: 'Momentanleistung' },
    },
    // Das Geraet zaehlt in Wh; der Adapter rechnet in kWh um (siehe umrechnen()).
    energy: {
        kanal: 'status',
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
        wh: true,
        name: { en: 'Lifetime energy', de: 'Energie gesamt' },
    },
    energyheat: {
        kanal: 'status',
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
        wh: true,
        name: { en: 'Lifetime heating energy', de: 'Energie Heizen' },
    },
    energycool: {
        kanal: 'status',
        type: 'number',
        role: 'value.energy',
        unit: 'kWh',
        wh: true,
        name: { en: 'Lifetime cooling energy', de: 'Energie Kühlen' },
    },
    heat: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Heating', de: 'Heizt' } },
    slave: {
        kanal: 'status',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Controlled by other unit', de: 'Von anderer Einheit gesteuert' },
    },
    antifreeze: {
        kanal: 'status',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Anti-freeze active', de: 'Frostschutz aktiv' },
    },
    flap: { kanal: 'status', type: 'boolean', role: 'indicator', name: { en: 'Flap', de: 'Klappe' } },
    control: {
        kanal: 'status',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Automatic control', de: 'Automatiksteuerung' },
    },
    model: { kanal: 'status', type: 'string', role: 'info.name', name: { en: 'Model', de: 'Modell' } },
    protocol: { kanal: 'status', type: 'string', role: 'text', name: { en: 'Protocol', de: 'Protokoll' } },
    // Was die Anlage gerade tut (hvac_action in Faikout.c). Nur mit no.hvacaction = aus, das ab
    // Werk an ist - deshalb fehlt der Punkt bei den meisten Modulen.
    action: {
        kanal: 'status',
        type: 'string',
        role: 'state',
        states: liste(HVAC_ACTIONS),
        name: { en: 'Current action', de: 'Aktuelle Tätigkeit' },
    },
    // Nur gesetzt, wenn das Modul im Prueflauf ohne Klimaanlage arbeitet (Rx/Tx gebrueckt).
    loopback: {
        kanal: 'status',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Loopback test mode', de: 'Prüfmodus ohne Anlage' },
    },
    // Externer BLE-Fuehler (Einstellung ble.enable und auto.b); kommt nur, solange er verbunden ist.
    bletemp: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'BLE sensor temperature', de: 'Temperatur BLE-Fühler' },
    },
    blehum: {
        kanal: 'status',
        type: 'number',
        role: 'value.humidity',
        unit: '%',
        name: { en: 'BLE sensor humidity', de: 'Luftfeuchte BLE-Fühler' },
    },
    blebat: {
        kanal: 'status',
        type: 'number',
        role: 'value.battery',
        unit: '%',
        name: { en: 'BLE sensor battery', de: 'Batterie BLE-Fühler' },
    },

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
        kanal: 'status',
        type: 'boolean',
        role: 'switch',
        w: true,
        name: {
            en: 'Faikout automation (timed and temperature switching)',
            de: 'Faikout-Automatik (Zeit- und Temperaturschaltung)',
        },
    },
    autop: {
        kanal: 'status',
        type: 'boolean',
        role: 'indicator',
        name: {
            en: 'Automation: switch by temperature',
            de: 'Automatik: Schalten nach Temperatur',
        },
    },
    autor: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: {
            en: 'Automation: tolerance around target (0 = module does not control)',
            de: 'Automatik: Toleranz um das Ziel (0 = Modul regelt nicht)',
        },
    },
    autot: {
        kanal: 'status',
        type: 'number',
        role: 'value.temperature',
        unit: '°C',
        name: { en: 'Automation: target temperature', de: 'Automatik: Zieltemperatur' },
    },
    auto0: {
        kanal: 'status',
        type: 'string',
        role: 'text',
        name: { en: 'Automation: switch-off time (HHMM)', de: 'Automatik: Ausschaltzeit (HHMM)' },
    },
    auto1: {
        kanal: 'status',
        type: 'string',
        role: 'text',
        name: { en: 'Automation: switch-on time (HHMM)', de: 'Automatik: Einschaltzeit (HHMM)' },
    },

    // ---------------------------------------------------------------- Geraetediagnose
    online: {
        kanal: 'info',
        type: 'boolean',
        role: 'indicator.reachable',
        name: { en: 'Air conditioner online', de: 'Klimaanlage erreichbar' },
    },
    ipv4: { kanal: 'info', type: 'string', role: 'info.ip', name: { en: 'IP address', de: 'IP-Adresse' } },
    rssi: {
        kanal: 'info',
        type: 'number',
        role: 'value.rssi',
        unit: 'dBm',
        name: { en: 'WiFi signal', de: 'WLAN-Signal' },
    },
    ssid: { kanal: 'info', type: 'string', role: 'info.name', name: { en: 'WiFi network', de: 'WLAN-Netz' } },
    bssid: { kanal: 'info', type: 'string', role: 'info.address', name: { en: 'WiFi BSSID', de: 'WLAN-BSSID' } },
    chan: { kanal: 'info', type: 'number', role: 'value', name: { en: 'WiFi channel', de: 'WLAN-Kanal' } },
    uptime: { kanal: 'info', type: 'number', role: 'value', unit: 's', name: { en: 'Uptime', de: 'Laufzeit' } },
    'mqtt-up': {
        kanal: 'info',
        type: 'number',
        role: 'value',
        unit: 's',
        id: 'mqttUp',
        name: { en: 'MQTT uptime', de: 'MQTT-Laufzeit' },
    },
    version: {
        kanal: 'info',
        type: 'string',
        role: 'info.firmware',
        name: { en: 'Firmware version', de: 'Firmware-Version' },
    },
    build: { kanal: 'info', type: 'string', role: 'text', name: { en: 'Firmware build', de: 'Firmware-Stand' } },
    'build-suffix': {
        kanal: 'info',
        type: 'string',
        role: 'text',
        id: 'buildSuffix',
        name: { en: 'Hardware variant', de: 'Hardware-Variante' },
    },
    app: { kanal: 'info', type: 'string', role: 'info.name', name: { en: 'Application', de: 'Anwendung' } },
    id: { kanal: 'info', type: 'string', role: 'info.mac', name: { en: 'Device ID', de: 'Geräte-ID' } },
    mem: {
        kanal: 'info',
        type: 'number',
        role: 'value',
        unit: 'B',
        name: { en: 'Free memory', de: 'Freier Speicher' },
    },
    spi: {
        kanal: 'info',
        type: 'number',
        role: 'value',
        unit: 'B',
        name: { en: 'Free SPI RAM', de: 'Freier SPI-Speicher' },
    },
    flash: { kanal: 'info', type: 'number', role: 'value', unit: 'B', name: { en: 'Flash size', de: 'Flash-Größe' } },
    rst: { kanal: 'info', type: 'number', role: 'value', name: { en: 'Reset reason', de: 'Neustartgrund' } },
    // Die folgenden kommen aus der Statusmeldung der RevK-Bibliothek (revk.c), nicht aus Faikout.c.
    dma: {
        kanal: 'info',
        type: 'number',
        role: 'value',
        unit: 'B',
        name: { en: 'Free DMA memory', de: 'Freier DMA-Speicher' },
    },
    // Nur waehrend eines angekuendigten Neustarts (z. B. nach einem Update): Sekunden bis dahin,
    // dazu kommt `reason` mit dem Grund.
    restart: {
        kanal: 'info',
        type: 'number',
        role: 'value',
        unit: 's',
        name: { en: 'Restart in', de: 'Neustart in' },
    },
    ipv6: { kanal: 'info', type: 'string', role: 'info.ip', name: { en: 'IPv6 address', de: 'IPv6-Adresse' } },
    secureboot: {
        kanal: 'info',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Secure boot', de: 'Sicherer Start' },
    },
    nvsecryption: {
        kanal: 'info',
        type: 'boolean',
        role: 'indicator',
        name: { en: 'Settings memory encrypted', de: 'Einstellungsspeicher verschlüsselt' },
    },
    // Kommt mit der "Last Will"-Nachricht, wenn die Verbindung des Moduls abreisst (Wert "LWT"),
    // und vor einem angekuendigten Neustart zusammen mit `restart` (dann der Neustartgrund).
    reason: {
        kanal: 'status',
        type: 'string',
        role: 'text',
        name: { en: 'Disconnect or restart reason', de: 'Grund der Trennung oder des Neustarts' },
    },
    up: {
        kanal: 'info',
        type: 'boolean',
        role: 'indicator.reachable',
        name: { en: 'Module online', de: 'Modul erreichbar' },
    },
    ts: { kanal: 'info', type: 'string', role: 'date', name: { en: 'Last message', de: 'Letzte Meldung' } },
};

/** Felder, die der Adapter nie als Datenpunkt anlegt (Struktur statt Wert). */
const UEBERSPRINGEN = new Set(['ble']);

/**
 * Beschreibung eines Feldes - bekannt aus [FELDER], sonst aus dem Wert abgeleitet.
 * Damit landet auch ein Feld im Baum, das eine kuenftige Firmware neu einfuehrt.
 *
 * @param {string} feld   Feldname aus der Modulnachricht
 * @param {string|number|boolean} wert  gemeldeter Wert, wenn das Feld unbekannt ist
 * @returns {object} Beschreibung des Datenpunkts
 */
function beschreibe(feld, wert) {
    const bekannt = FELDER[feld];
    if (bekannt) {
        return bekannt;
    }
    const type = typeof wert === 'boolean' ? 'boolean' : typeof wert === 'number' ? 'number' : 'string';
    return {
        kanal: 'status',
        type,
        role: type === 'boolean' ? 'indicator' : type === 'number' ? 'value' : 'text',
        // Ein unbekanntes Feld hat keinen beschreibenden Namen - der Feldname selbst steht in
        // allen elf Sprachen, damit die Objektpruefung keinen unvollstaendigen Namen meldet.
        name: Object.fromEntries(SPRACHEN.map(l => [l, feld])),
        unbekannt: true,
    };
}

/**
 * Wh -> kWh, wo die Beschreibung es verlangt. Alles andere unveraendert.
 *
 * @param {object} def   Feldbeschreibung aus [FELDER]
 * @param {string|number|boolean} wert  Rohwert des Moduls
 * @returns {string|number|boolean} umgerechneter Wert
 */
function umrechnen(def, wert) {
    if (def && def.wh && typeof wert === 'number') {
        return Math.round(wert / 10) / 100;
    }
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
 * @returns {{nehmen: boolean, echtAbJetzt: boolean}} ob der Wert zaehlt und ob der Sensor ab jetzt als vorhanden gilt
 */
function feuchteBewerten(wert, bekannt) {
    if (bekannt) {
        return { nehmen: true, echtAbJetzt: true };
    }
    const echt = typeof wert === 'number' && wert !== FEUCHTE_PLATZHALTER;
    return { nehmen: echt, echtAbJetzt: echt };
}

/**
 * Objekt-ID eines Feldes; Bindestriche taugen nicht als ioBroker-ID-Bestandteil.
 *
 * @param {string} feld   Feldname aus der Modulnachricht
 * @returns {string} ID-taugliche Schreibweise
 */
function objektId(feld) {
    const def = FELDER[feld];
    if (def && def.id) {
        return def.id;
    }
    return feld.replace(/-/g, '_');
}

/**
 * Wertet eine HA-Discovery-Nachricht fuer einen Sensor aus und liefert die Einheit eines Feldes,
 * dessen Einheit je Modul verschieden sein kann (`einheiten` in [FELDER]).
 *
 * Das Modul veroeffentlicht je Messwert `homeassistant/sensor/<id><feld>/config` mit
 * `stat_t` = "state/<Name>", `val_tpl` = "{{value_json.<feld>}}" und `unit_of_meas`. Fuer
 * `comp` und `fanfreq` steht dort "Hz" oder "rpm" - genau passend zu dem, was das Modul im
 * Statuswert sendet (beides haengt an derselben Einstellung ha.comprpm/ha.fanrpm).
 *
 * @param {string} topic  MQTT-Topic der Nachricht
 * @param {string} text   Nutzlast (JSON)
 * @returns {{geraet: string, feld: string, einheit: string}|null} erkannte Einheit oder null
 */
function haSensorAuswerten(topic, text) {
    if (!/^homeassistant\/sensor\/[^/]+\/config$/.test(topic)) {
        return null;
    }
    let c;
    try {
        c = JSON.parse(text);
    } catch {
        return null;
    }
    if (!c || typeof c !== 'object') {
        return null;
    }
    const m = /value_json\.([A-Za-z0-9_-]+)/.exec(String(c.val_tpl || ''));
    const feld = m && m[1];
    const def = feld && FELDER[feld];
    if (!def || !def.einheiten || !def.einheiten.includes(c.unit_of_meas)) {
        return null;
    }
    const geraet = String(c.stat_t || c.avty_t || '').replace(/^state\//, '');
    if (!geraet || geraet.includes('/')) {
        return null;
    }
    return { geraet, feld, einheit: c.unit_of_meas };
}

/**
 * Einheit, die sich aus dem Wert selbst ergibt - nur wo das eindeutig ist.
 *
 * In rpm sendet das Modul ganze Zahlen (jo_int), in Hz fuer den Luefter eine Nachkommastelle
 * ("%.1f"). Ein gebrochener Wert ist also sicher Hz; ein ganzer sagt nichts.
 *
 * @param {string} feld   Feldname
 * @param {string|number|boolean} wert  gemeldeter Wert
 * @returns {string|null} 'Hz' oder null
 */
function einheitAusWert(feld, wert) {
    const def = FELDER[feld];
    if (!def || !def.einheiten || typeof wert !== 'number' || Number.isInteger(wert)) {
        return null;
    }
    return 'Hz';
}

/**
 * Erkennt ein Modul, bei dem die Einstellung ha.enable aus ist.
 *
 * Die Statusmeldung `state/<Name>` stammt aus der RevK-Bibliothek (id, up, uptime, ...); die
 * Klimawerte haengt revk_state_extra() an - aber nur mit ha.enable. Mit ha.enable fehlt
 * `target` nie (es wird ohne Bedingung gesendet). Eine Meldung mit `up: true` ohne `target`
 * heisst deshalb: ha.enable ist aus. Die Last-Will-Nachricht ({"up":false,...}) zaehlt nicht.
 *
 * @param {object} daten  gemeldete Felder aus state/<Name>
 * @returns {boolean} true, wenn ha.enable erkennbar aus ist
 */
function ohneHaEnable(daten) {
    return !!daten && daten.up === true && !Object.prototype.hasOwnProperty.call(daten, 'target');
}

module.exports = {
    SPRACHEN,
    FELDER,
    MODES,
    FAN_MODES,
    HVAC_ACTIONS,
    UEBERSPRINGEN,
    FEUCHTE_PLATZHALTER,
    beschreibe,
    umrechnen,
    objektId,
    feuchteBewerten,
    haSensorAuswerten,
    einheitAusWert,
    ohneHaEnable,
};
