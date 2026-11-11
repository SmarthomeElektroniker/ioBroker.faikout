'use strict';

/*
 * Geraeteverwaltung (ioBroker Device-Manager, @iobroker/dm-utils).
 *
 * VORGABE: Die Karten zeigen nur den laufenden Betrieb und bieten nur Alltagsbedienung an.
 * Es gibt bewusst KEINE Instanz- und KEINE Geraeteaktionen - kein Hinzufuegen oder Entfernen
 * von Geraeten, keine Broker- oder Moduleinstellungen. Geraete entstehen weiter von selbst,
 * sobald sich ein Modul am Broker meldet; konfiguriert wird im Admin bzw. am Modul.
 *
 * Bedient wird ausschliesslich ueber die vorhandenen Datenpunkte control.*: Ein Bedienelement
 * schreibt den Wert ohne ack in den Datenpunkt, als haette man ihn im Objektbaum gesetzt. Den
 * MQTT-Befehl schickt danach der bestehende Weg in main.js (onStateChange). Damit gibt es nur
 * eine einzige Stelle, die Befehle an die Module sendet.
 */

const { DeviceManagement } = require('@iobroker/dm-utils');
const felder = require('./fields');
const namen = require('./namen');

/**
 * Wartezeit fuer den Sollwert-Schieber. Die Oberflaeche meldet jede Zwischenstellung beim
 * Ziehen; ohne Beruhigung bekaeme das Modul eine Kette von Befehlen. Erst wenn der Schieber
 * so lange stillsteht, wird der Wert geschrieben.
 */
const SCHIEBER_RUHE_MS = 1000;

/** Texte der Karten, die es nicht schon als Datenpunktnamen gibt - alle elf Sprachen. */
const TEXTE = {
    roomTemp: {
        en: 'Room temperature',
        de: 'Raumtemperatur',
        ru: 'Температура в помещении',
        pt: 'Temperatura ambiente',
        nl: 'Kamertemperatuur',
        fr: 'Température ambiante',
        it: 'Temperatura ambiente',
        es: 'Temperatura ambiente',
        pl: 'Temperatura w pomieszczeniu',
        uk: 'Температура в приміщенні',
        'zh-cn': '室内温度',
    },
    energyToday: {
        en: 'Energy today',
        de: 'Energie heute',
        ru: 'Энергия сегодня',
        pt: 'Energia hoje',
        nl: 'Energie vandaag',
        fr: 'Énergie aujourd’hui',
        it: 'Energia oggi',
        es: 'Energía hoy',
        pl: 'Energia dziś',
        uk: 'Енергія сьогодні',
        'zh-cn': '今日能耗',
    },
    nichtErreichbar: {
        en: 'Air conditioner not reachable',
        de: 'Klimaanlage nicht erreichbar',
        ru: 'Кондиционер недоступен',
        pt: 'Ar condicionado inacessível',
        nl: 'Airco niet bereikbaar',
        fr: 'Climatiseur injoignable',
        it: 'Condizionatore non raggiungibile',
        es: 'Aire acondicionado no accesible',
        pl: 'Klimatyzator nieosiągalny',
        uk: 'Кондиціонер недоступний',
        'zh-cn': '空调无法连接',
    },
    an: {
        en: 'On',
        de: 'Ein',
        ru: 'Вкл.',
        pt: 'Ligado',
        nl: 'Aan',
        fr: 'Marche',
        it: 'Acceso',
        es: 'Encendido',
        pl: 'Włączony',
        uk: 'Увімк.',
        'zh-cn': '开',
    },
    aus: {
        en: 'Off',
        de: 'Aus',
        ru: 'Выкл.',
        pt: 'Desligado',
        nl: 'Uit',
        fr: 'Arrêt',
        it: 'Spento',
        es: 'Apagado',
        pl: 'Wyłączony',
        uk: 'Вимк.',
        'zh-cn': '关',
    },
};

/** Betriebsarten (Werte wie in fields.MODES). */
const MODUS_TEXTE = {
    off: TEXTE.aus,
    heat_cool: {
        en: 'Auto',
        de: 'Automatik',
        ru: 'Авто',
        pt: 'Automático',
        nl: 'Automatisch',
        fr: 'Auto',
        it: 'Automatico',
        es: 'Automático',
        pl: 'Automatyczny',
        uk: 'Авто',
        'zh-cn': '自动',
    },
    cool: {
        en: 'Cool',
        de: 'Kühlen',
        ru: 'Охлаждение',
        pt: 'Arrefecer',
        nl: 'Koelen',
        fr: 'Froid',
        it: 'Raffreddamento',
        es: 'Frío',
        pl: 'Chłodzenie',
        uk: 'Охолодження',
        'zh-cn': '制冷',
    },
    heat: {
        en: 'Heat',
        de: 'Heizen',
        ru: 'Обогрев',
        pt: 'Aquecer',
        nl: 'Verwarmen',
        fr: 'Chauffage',
        it: 'Riscaldamento',
        es: 'Calor',
        pl: 'Grzanie',
        uk: 'Обігрів',
        'zh-cn': '制热',
    },
    dry: {
        en: 'Dry',
        de: 'Entfeuchten',
        ru: 'Осушение',
        pt: 'Desumidificar',
        nl: 'Drogen',
        fr: 'Déshumidification',
        it: 'Deumidificazione',
        es: 'Deshumidificación',
        pl: 'Osuszanie',
        uk: 'Осушення',
        'zh-cn': '除湿',
    },
    fan_only: {
        en: 'Fan only',
        de: 'Nur Lüfter',
        ru: 'Только вентилятор',
        pt: 'Só ventilação',
        nl: 'Alleen ventilator',
        fr: 'Ventilation seule',
        it: 'Solo ventilazione',
        es: 'Solo ventilador',
        pl: 'Tylko wentylator',
        uk: 'Лише вентилятор',
        'zh-cn': '仅送风',
    },
};

/** Luefterstufen (Werte wie in fields.FAN_MODES). */
const LUEFTER_TEXTE = {
    auto: MODUS_TEXTE.heat_cool,
    night: {
        en: 'Night (quiet)',
        de: 'Nacht (leise)',
        ru: 'Ночной (тихий)',
        pt: 'Noturno (silencioso)',
        nl: 'Nacht (stil)',
        fr: 'Nuit (silencieux)',
        it: 'Notte (silenzioso)',
        es: 'Noche (silencioso)',
        pl: 'Nocny (cichy)',
        uk: 'Нічний (тихий)',
        'zh-cn': '夜间（静音）',
    },
    low: {
        en: 'Low',
        de: 'Niedrig',
        ru: 'Низкая',
        pt: 'Baixa',
        nl: 'Laag',
        fr: 'Faible',
        it: 'Bassa',
        es: 'Baja',
        pl: 'Niska',
        uk: 'Низька',
        'zh-cn': '低',
    },
    lowMedium: {
        en: 'Low–medium',
        de: 'Niedrig–mittel',
        ru: 'Низкая–средняя',
        pt: 'Baixa–média',
        nl: 'Laag–middel',
        fr: 'Faible–moyenne',
        it: 'Bassa–media',
        es: 'Baja–media',
        pl: 'Niska–średnia',
        uk: 'Низька–середня',
        'zh-cn': '中低',
    },
    medium: {
        en: 'Medium',
        de: 'Mittel',
        ru: 'Средняя',
        pt: 'Média',
        nl: 'Middel',
        fr: 'Moyenne',
        it: 'Media',
        es: 'Media',
        pl: 'Średnia',
        uk: 'Середня',
        'zh-cn': '中',
    },
    mediumHigh: {
        en: 'Medium–high',
        de: 'Mittel–hoch',
        ru: 'Средняя–высокая',
        pt: 'Média–alta',
        nl: 'Middel–hoog',
        fr: 'Moyenne–élevée',
        it: 'Media–alta',
        es: 'Media–alta',
        pl: 'Średnia–wysoka',
        uk: 'Середня–висока',
        'zh-cn': '中高',
    },
    high: {
        en: 'High',
        de: 'Hoch',
        ru: 'Высокая',
        pt: 'Alta',
        nl: 'Hoog',
        fr: 'Élevée',
        it: 'Alta',
        es: 'Alta',
        pl: 'Wysoka',
        uk: 'Висока',
        'zh-cn': '高',
    },
};

/** Taetigkeit der Anlage (Werte wie in fields.HVAC_ACTIONS). */
const TAETIGKEIT_TEXTE = {
    off: TEXTE.aus,
    preheating: {
        en: 'Preheating',
        de: 'Vorheizen',
        ru: 'Предварительный нагрев',
        pt: 'Pré-aquecimento',
        nl: 'Voorverwarmen',
        fr: 'Préchauffage',
        it: 'Preriscaldamento',
        es: 'Precalentamiento',
        pl: 'Podgrzewanie wstępne',
        uk: 'Попередній нагрів',
        'zh-cn': '预热',
    },
    heating: {
        en: 'Heating',
        de: 'Heizt',
        ru: 'Нагрев',
        pt: 'A aquecer',
        nl: 'Verwarmt',
        fr: 'Chauffe',
        it: 'Riscalda',
        es: 'Calentando',
        pl: 'Grzeje',
        uk: 'Нагрівання',
        'zh-cn': '制热中',
    },
    cooling: {
        en: 'Cooling',
        de: 'Kühlt',
        ru: 'Охлаждение',
        pt: 'A arrefecer',
        nl: 'Koelt',
        fr: 'Refroidit',
        it: 'Raffredda',
        es: 'Enfriando',
        pl: 'Chłodzi',
        uk: 'Охолодження',
        'zh-cn': '制冷中',
    },
    drying: {
        en: 'Drying',
        de: 'Entfeuchtet',
        ru: 'Осушение',
        pt: 'A desumidificar',
        nl: 'Ontvochtigt',
        fr: 'Déshumidifie',
        it: 'Deumidifica',
        es: 'Deshumidificando',
        pl: 'Osusza',
        uk: 'Осушення',
        'zh-cn': '除湿中',
    },
    fan: {
        en: 'Fan',
        de: 'Lüftet',
        ru: 'Вентиляция',
        pt: 'Ventilação',
        nl: 'Ventileert',
        fr: 'Ventile',
        it: 'Ventila',
        es: 'Ventilando',
        pl: 'Wentyluje',
        uk: 'Вентиляція',
        'zh-cn': '送风中',
    },
    idle: {
        en: 'Idle',
        de: 'Bereit',
        ru: 'Ожидание',
        pt: 'Em espera',
        nl: 'Inactief',
        fr: 'En veille',
        it: 'Inattivo',
        es: 'En reposo',
        pl: 'Bezczynny',
        uk: 'Очікування',
        'zh-cn': '待机',
    },
    defrosting: {
        en: 'Defrosting',
        de: 'Taut ab',
        ru: 'Оттаивание',
        pt: 'A descongelar',
        nl: 'Ontdooit',
        fr: 'Dégivrage',
        it: 'Sbrinamento',
        es: 'Descongelando',
        pl: 'Rozmrażanie',
        uk: 'Відтавання',
        'zh-cn': '除霜中',
    },
};

/**
 * Optionenliste einer Auswahl: zuerst die bekannten Werte in ihrer Reihenfolge, danach was das
 * Objekt sonst noch fuehrt (common.states), damit kein Wert des Geraets verloren geht.
 *
 * @param {Record<string, object>} texte  bekannte Werte mit Uebersetzung
 * @param {object} [states]               common.states des Datenpunkts
 * @returns {{label: object|string, value: string}[]} Optionen
 */
function optionen(texte, states) {
    const werte = Object.keys(texte);
    if (states && typeof states === 'object') {
        for (const w of Object.keys(states)) {
            if (!werte.includes(w)) {
                werte.push(w);
            }
        }
    }
    return werte.map(w => ({ label: texte[w] || String((states && states[w]) || w), value: w }));
}

/**
 * Name eines Feldes in allen Sprachen.
 *
 * @param {string} feld  Feldname
 * @returns {object} Name je Sprache
 */
function feldName(feld) {
    return namen.vollerName(felder.FELDER[feld].name);
}

/**
 * Relative Datenpunkt-ID eines Feldes unter einem Geraet.
 *
 * @param {string} geraetId  Geraete-ID
 * @param {string} feld      Feldname
 * @returns {string} ID ohne Namensraum
 */
function feldId(geraetId, feld) {
    return `${geraetId}.${felder.FELDER[feld].kanal}.${felder.objektId(feld)}`;
}

/**
 * Die Bedienelemente der Karte. Nur Felder, die es als beschreibbaren Datenpunkt gibt.
 * `art` legt fest, wie der eingehende Wert geprueft wird.
 */
const BEDIENUNG = [
    { feld: 'power', art: 'schalter' },
    { feld: 'mode', art: 'auswahl', texte: MODUS_TEXTE },
    { feld: 'target', art: 'schieber' },
    { feld: 'fan', art: 'auswahl', texte: LUEFTER_TEXTE },
];

/** Karten der Klimaanlagen im Device-Manager: Betrieb anzeigen, Alltag bedienen, nichts konfigurieren. */
class FaikoutDeviceManagement extends DeviceManagement {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter  Adapterinstanz
     */
    constructor(adapter) {
        // Kein Kommunikations-Datenpunkt: Die Karten lesen ihre Werte direkt aus den
        // vorhandenen Datenpunkten. So entsteht kein zusaetzliches Objekt im Baum.
        super(adapter);
        /** Wartende Sollwerte des Schiebers: stateId -> Zeitgeber. */
        this.schieberWarten = new Map();
    }

    /**
     * Alle Datenpunkte der Instanz, gruppiert nach Geraet.
     *
     * @returns {Promise<Map<string, Map<string, ioBroker.StateObject>>>} geraetId -> (relative ID -> Objekt)
     */
    async datenpunkteLesen() {
        const ns = this.adapter.namespace;
        const sicht = await this.adapter.getObjectViewAsync('system', 'state', {
            startkey: `${ns}.`,
            endkey: `${ns}.香`,
        });
        const je = new Map();
        for (const zeile of sicht.rows || []) {
            const o = zeile.value;
            if (!o || !o._id) {
                continue;
            }
            const rel = o._id.slice(ns.length + 1);
            const geraet = rel.split('.')[0];
            if (!je.has(geraet)) {
                je.set(geraet, new Map());
            }
            je.get(geraet).set(rel, o);
        }
        return je;
    }

    /**
     * Liefert die Karten aller Geraete, die sich bisher gemeldet haben.
     *
     * @param {import('@iobroker/dm-utils').DeviceLoadContext<string>} context  Ladekontext
     */
    async loadDevices(context) {
        const ns = this.adapter.namespace;
        const geraete = await this.adapter.getDevicesAsync();
        const punkte = await this.datenpunkteLesen();
        context.setTotalDevices(geraete.length);
        for (const g of geraete) {
            const id = g._id.slice(ns.length + 1);
            context.addDevice(this.geraetInfo(id, g, punkte.get(id) || new Map()));
        }
    }

    /**
     * Beschreibung einer Karte.
     *
     * @param {string} id         Objekt-ID des Geraets (ohne Namensraum)
     * @param {ioBroker.Object} obj  Geraeteobjekt
     * @param {Map<string, ioBroker.StateObject>} punkte  vorhandene Datenpunkte des Geraets
     * @returns {object} DeviceInfo
     */
    geraetInfo(id, obj, punkte) {
        const ns = this.adapter.namespace;
        const voll = rel => `${ns}.${rel}`;
        const hat = feld => punkte.has(feldId(id, feld));
        const name = (obj.common && obj.common.name) || id;

        // Erreichbarkeit: `up` ist das Modul am Broker (faellt per Last Will auf false),
        // `online` die Klimaanlage hinter dem Modul. Verbindung zeigt das Modul; antwortet die
        // Anlage nicht, erscheint das als Warnung.
        const status = {};
        const verbindung = hat('up') ? 'up' : hat('online') ? 'online' : null;
        if (verbindung) {
            status.connection = {
                stateId: voll(feldId(id, verbindung)),
                mapping: { true: 'connected', false: 'disconnected' },
            };
        }
        if (verbindung === 'up' && hat('online')) {
            status.warning = {
                stateId: voll(feldId(id, 'online')),
                mapping: { true: false, false: TEXTE.nichtErreichbar },
            };
        }
        if (hat('rssi')) {
            status.rssi = { stateId: voll(feldId(id, 'rssi')) };
        }

        const info = {
            id,
            identifier: (obj.native && obj.native.faikoutName) || id,
            name,
            icon: 'airCondition',
            manufacturer: 'Daikin',
            connectionType: 'wifi',
            status,
            controls: this.bedienelemente(id, punkte),
            customInfo: { id, schema: this.kartenSchema(id, punkte) },
        };
        if (hat('model')) {
            info.model = { stateId: voll(feldId(id, 'model')) };
        }
        return info;
    }

    /**
     * Anzeige des laufenden Betriebs auf der Karte - nur lesend.
     *
     * @param {string} id   Geraete-ID
     * @param {Map<string, ioBroker.StateObject>} punkte  vorhandene Datenpunkte
     * @returns {object} JSON-Config-Schema
     */
    kartenSchema(id, punkte) {
        const ns = this.adapter.namespace;
        const items = {};
        const zeile = (schluessel, rel, label, extra = {}) => {
            if (!punkte.has(rel)) {
                return;
            }
            items[schluessel] = {
                type: 'state',
                oid: `${ns}.${rel}`,
                foreign: true,
                label,
                readOnly: true,
                control: 'text',
                xs: 12,
                ...extra,
            };
        };
        const auswahl = texte => ({ control: 'select', options: optionen(texte) });

        zeile('power', feldId(id, 'power'), feldName('power'), { trueText: TEXTE.an, falseText: TEXTE.aus });
        zeile('mode', feldId(id, 'mode'), feldName('mode'), auswahl(MODUS_TEXTE));
        zeile('action', feldId(id, 'action'), feldName('action'), auswahl(TAETIGKEIT_TEXTE));
        zeile('temp', feldId(id, 'temp'), TEXTE.roomTemp, { unit: '°C', digits: 1 });
        zeile('target', feldId(id, 'target'), feldName('target'), { unit: '°C', digits: 1 });
        zeile('fan', feldId(id, 'fan'), feldName('fan'), auswahl(LUEFTER_TEXTE));
        zeile('outside', feldId(id, 'outside'), feldName('outside'), { unit: '°C', digits: 1 });
        zeile('hum', feldId(id, 'hum'), feldName('hum'), { unit: '%', digits: 0 });
        zeile('consumption', feldId(id, 'consumption'), feldName('consumption'), { unit: 'W', digits: 0 });
        zeile('energyToday', `${id}.consumption.total.today`, TEXTE.energyToday, { unit: 'kWh', digits: 2 });
        // Die abgelehnte Einstellung (JSON) und der Trennungsgrund stehen bewusst NICHT auf der Karte:
        // Beschriftung und Wert sind zu lang fuer eine Kartenzeile, der Wert lief rechts aus der Karte
        // und war unsichtbar (Admin 8.3.7). Beide bleiben als Datenpunkte im Objektbaum.
        return { type: 'panel', items };
    }

    /**
     * Bedienelemente fuer den Alltagsbetrieb - nur fuer vorhandene, beschreibbare Datenpunkte.
     *
     * @param {string} id   Geraete-ID
     * @param {Map<string, ioBroker.StateObject>} punkte  vorhandene Datenpunkte
     * @returns {object[]} DeviceControl-Liste
     */
    bedienelemente(id, punkte) {
        const ns = this.adapter.namespace;
        const liste = [];
        for (const b of BEDIENUNG) {
            const rel = feldId(id, b.feld);
            const obj = punkte.get(rel);
            if (!obj || !obj.common || !obj.common.write) {
                continue;
            }
            const control = {
                id: b.feld,
                label: feldName(b.feld),
                stateId: `${ns}.${rel}`,
                handler: (geraetId, controlId, wert) => this.bedienen(geraetId, controlId, wert),
            };
            if (b.art === 'schalter') {
                control.type = 'switch';
            } else if (b.art === 'auswahl') {
                control.type = 'select';
                control.options = optionen(b.texte, obj.common.states);
            } else {
                // Bereich und Schrittweite je Anlage aus der HA-Discovery (siehe klimaConfig).
                const c = obj.common;
                control.type = 'slider';
                control.min = typeof c.min === 'number' ? c.min : felder.FELDER.target.min;
                control.max = typeof c.max === 'number' ? c.max : felder.FELDER.target.max;
                control.step = typeof c.step === 'number' ? c.step : 0.5;
                control.unit = '°C';
            }
            liste.push(control);
        }
        return liste;
    }

    /**
     * Ein Bedienelement wurde betaetigt: Wert pruefen und ohne ack in den Datenpunkt schreiben.
     * Den MQTT-Befehl sendet main.js (onStateChange), genau wie beim Schreiben im Objektbaum.
     *
     * @param {string} geraetId   Geraete-ID
     * @param {string} controlId  Feldname (power, mode, target, fan)
     * @param {string|number|boolean|null} wert  Wert aus der Oberflaeche
     * @returns {Promise<object>} neuer Zustand oder Fehler
     */
    async bedienen(geraetId, controlId, wert) {
        const b = BEDIENUNG.find(x => x.feld === controlId);
        if (!b) {
            return this.fehler(`Unknown control ${controlId}`);
        }
        const rel = feldId(String(geraetId), controlId);
        const obj = await this.adapter.getObjectAsync(rel);
        if (!obj || !obj.common || !obj.common.write) {
            return this.fehler(`${rel} does not exist or is not writable`);
        }
        const val = this.wertPruefen(b, obj.common, wert);
        if (val === undefined) {
            return this.fehler(`Invalid value for ${rel}: ${JSON.stringify(wert)}`);
        }

        if (b.art === 'schieber') {
            // Erst schreiben, wenn der Schieber zur Ruhe kommt - jeder neue Wert ersetzt den alten.
            const alt = this.schieberWarten.get(rel);
            if (alt) {
                this.adapter.clearTimeout(alt);
            }
            this.schieberWarten.set(
                rel,
                this.adapter.setTimeout(() => {
                    this.schieberWarten.delete(rel);
                    this.schreiben(rel, val).catch(e => this.adapter.log.warn(`Device manager: ${e.message}`));
                }, SCHIEBER_RUHE_MS),
            );
        } else {
            await this.schreiben(rel, val);
        }
        const jetzt = Date.now();
        return { val, ack: false, ts: jetzt, lc: jetzt, from: `system.adapter.${this.adapter.namespace}`, q: 0 };
    }

    /**
     * Schreibt einen Befehl ohne ack in den Datenpunkt.
     *
     * @param {string} rel  ID ohne Namensraum
     * @param {string|number|boolean} val  Wert
     */
    async schreiben(rel, val) {
        this.adapter.log.debug(`Device manager: ${rel} = ${JSON.stringify(val)}`);
        await this.adapter.setState(rel, { val, ack: false });
    }

    /**
     * Wandelt den Wert der Oberflaeche in den Datentyp des Datenpunkts und prueft ihn.
     *
     * @param {object} b       Eintrag aus BEDIENUNG
     * @param {object} common  common des Datenpunkts
     * @param {string|number|boolean|null} wert  Wert aus der Oberflaeche
     * @returns {string|number|boolean|undefined} gueltiger Wert oder undefined
     */
    wertPruefen(b, common, wert) {
        if (b.art === 'schalter') {
            if (typeof wert === 'boolean') {
                return wert;
            }
            if (wert === 'true' || wert === 1) {
                return true;
            }
            if (wert === 'false' || wert === 0) {
                return false;
            }
            return undefined;
        }
        if (b.art === 'auswahl') {
            const s = String(wert);
            const erlaubt = optionen(b.texte, common.states).map(o => o.value);
            return erlaubt.includes(s) ? s : undefined;
        }
        const zahl = typeof wert === 'number' ? wert : parseFloat(String(wert));
        if (!Number.isFinite(zahl)) {
            return undefined;
        }
        const min = typeof common.min === 'number' ? common.min : felder.FELDER.target.min;
        const max = typeof common.max === 'number' ? common.max : felder.FELDER.target.max;
        const step = typeof common.step === 'number' && common.step > 0 ? common.step : 0.5;
        const gerundet = Math.round((zahl - min) / step) * step + min;
        return Math.min(max, Math.max(min, Math.round(gerundet * 100) / 100));
    }

    /**
     * Fehlerantwort an die Oberflaeche, zugleich als Warnung im Log.
     *
     * @param {string} message  Fehlertext
     * @returns {{error: {code: number, message: string}}} Fehlerantwort
     */
    fehler(message) {
        this.adapter.log.warn(`Device manager: ${message}`);
        return { error: { code: 400, message } };
    }

    /** Wartende Schieberwerte verwerfen (beim Beenden). */
    beenden() {
        for (const t of this.schieberWarten.values()) {
            this.adapter.clearTimeout(t);
        }
        this.schieberWarten.clear();
    }
}

module.exports = { FaikoutDeviceManagement, MODUS_TEXTE, LUEFTER_TEXTE, TAETIGKEIT_TEXTE, TEXTE, BEDIENUNG };
