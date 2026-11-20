'use strict';

/*
 * Geraeteverwaltung (ioBroker Device-Manager, @iobroker/dm-utils).
 *
 * VORGABE: Die Karten zeigen nur den laufenden Betrieb und bieten nur Alltagsbedienung an -
 * alles direkt auf der Karte (Ein/Aus-Umschalter mit Rueckfrage, Betriebsart, Sollwert-Schieber,
 * Luefterstufen). Einen Bedien-Dialog (DeviceInfo.controls) gibt es bewusst nicht mehr.
 * Es gibt bewusst KEINE Instanz- und KEINE weiteren Geraeteaktionen - kein Hinzufuegen oder Entfernen
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
const { randomBytes } = require('node:crypto');
const oberflaeche = require('./oberflaeche');
const kennlinienbild = require('./kennlinienbild');
const wochenplan = require('./regel/wochenplan');

/**
 * Wartezeit fuer den Sollwert-Schieber (controlDelay des Admins). Die Oberflaeche meldet jede
 * Zwischenstellung beim Ziehen; ohne Beruhigung bekaeme das Modul eine Kette von Befehlen. Erst
 * wenn der Schieber so lange stillsteht, wird der Wert geschrieben.
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
    // Kartenbeschriftung der Momentanleistung (kurz; der Datenpunktname bleibt unveraendert)
    leistung: {
        en: 'Power',
        de: 'Leistung',
        ru: 'Мощность',
        pt: 'Potência',
        nl: 'Vermogen',
        fr: 'Puissance',
        it: 'Potenza',
        es: 'Potencia',
        pl: 'Moc',
        uk: 'Потужність',
        'zh-cn': '功率',
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
    // Tooltip des Ein/Aus-Umschalters: sagt, was ein Klick tut.
    tipEinschalten: {
        en: 'Switch on',
        de: 'Einschalten',
        ru: 'Включить',
        pt: 'Ligar',
        nl: 'Inschakelen',
        fr: 'Mettre en marche',
        it: 'Accendi',
        es: 'Encender',
        pl: 'Włącz',
        uk: 'Увімкнути',
        'zh-cn': '开机',
    },
    tipAusschalten: {
        en: 'Switch off',
        de: 'Ausschalten',
        ru: 'Выключить',
        pt: 'Desligar',
        nl: 'Uitschakelen',
        fr: 'Arrêter',
        it: 'Spegni',
        es: 'Apagar',
        pl: 'Wyłącz',
        uk: 'Вимкнути',
        'zh-cn': '关机',
    },
    // Rueckfrage vor dem Umschalten; {name} ist der Name der Klimaanlage.
    frageEinschalten: {
        en: 'Switch on the air conditioner "{name}"?',
        de: 'Klimaanlage „{name}“ einschalten?',
        ru: 'Включить кондиционер «{name}»?',
        pt: 'Ligar o ar condicionado "{name}"?',
        nl: 'Airco "{name}" inschakelen?',
        fr: 'Mettre en marche le climatiseur « {name} » ?',
        it: 'Accendere il condizionatore "{name}"?',
        es: '¿Encender el aire acondicionado "{name}"?',
        pl: 'Włączyć klimatyzator „{name}”?',
        uk: 'Увімкнути кондиціонер «{name}»?',
        'zh-cn': '打开空调“{name}”？',
    },
    frageAusschalten: {
        en: 'Switch off the air conditioner "{name}"?',
        de: 'Klimaanlage „{name}“ ausschalten?',
        ru: 'Выключить кондиционер «{name}»?',
        pt: 'Desligar o ar condicionado "{name}"?',
        nl: 'Airco "{name}" uitschakelen?',
        fr: 'Arrêter le climatiseur « {name} » ?',
        it: 'Spegnere il condizionatore "{name}"?',
        es: '¿Apagar el aire acondicionado "{name}"?',
        pl: 'Wyłączyć klimatyzator „{name}”?',
        uk: 'Вимкнути кондиціонер «{name}»?',
        'zh-cn': '关闭空调“{name}”？',
    },
};

/** Tooltips und Text des WLAN-Symbols je Stufe (fields.wlanStufe). */
const WLAN_TEXTE = {
    s4: {
        en: 'Wi-Fi signal very good (−55 dBm or better)',
        de: 'WLAN-Signal sehr gut (ab −55 dBm)',
        ru: 'Сигнал Wi-Fi отличный (−55 дБм и лучше)',
        pt: 'Sinal Wi-Fi muito bom (−55 dBm ou melhor)',
        nl: 'Wifi-signaal zeer goed (−55 dBm of beter)',
        fr: 'Signal Wi-Fi très bon (−55 dBm ou mieux)',
        it: 'Segnale Wi-Fi ottimo (−55 dBm o migliore)',
        es: 'Señal Wi-Fi muy buena (−55 dBm o mejor)',
        pl: 'Sygnał Wi-Fi bardzo dobry (−55 dBm lub lepiej)',
        uk: 'Сигнал Wi-Fi відмінний (−55 дБм і краще)',
        'zh-cn': 'Wi-Fi 信号很好（−55 dBm 或更强）',
    },
    s3: {
        en: 'Wi-Fi signal good (−56 to −65 dBm)',
        de: 'WLAN-Signal gut (−56 bis −65 dBm)',
        ru: 'Сигнал Wi-Fi хороший (от −56 до −65 дБм)',
        pt: 'Sinal Wi-Fi bom (−56 a −65 dBm)',
        nl: 'Wifi-signaal goed (−56 tot −65 dBm)',
        fr: 'Signal Wi-Fi bon (−56 à −65 dBm)',
        it: 'Segnale Wi-Fi buono (da −56 a −65 dBm)',
        es: 'Señal Wi-Fi buena (−56 a −65 dBm)',
        pl: 'Sygnał Wi-Fi dobry (od −56 do −65 dBm)',
        uk: 'Сигнал Wi-Fi добрий (від −56 до −65 дБм)',
        'zh-cn': 'Wi-Fi 信号良好（−56 至 −65 dBm）',
    },
    s2: {
        en: 'Wi-Fi signal fair (−66 to −75 dBm)',
        de: 'WLAN-Signal mäßig (−66 bis −75 dBm)',
        ru: 'Сигнал Wi-Fi средний (от −66 до −75 дБм)',
        pt: 'Sinal Wi-Fi razoável (−66 a −75 dBm)',
        nl: 'Wifi-signaal matig (−66 tot −75 dBm)',
        fr: 'Signal Wi-Fi moyen (−66 à −75 dBm)',
        it: 'Segnale Wi-Fi discreto (da −66 a −75 dBm)',
        es: 'Señal Wi-Fi regular (−66 a −75 dBm)',
        pl: 'Sygnał Wi-Fi średni (od −66 do −75 dBm)',
        uk: 'Сигнал Wi-Fi середній (від −66 до −75 дБм)',
        'zh-cn': 'Wi-Fi 信号一般（−66 至 −75 dBm）',
    },
    s1: {
        en: 'Wi-Fi signal weak (below −75 dBm)',
        de: 'WLAN-Signal schwach (unter −75 dBm)',
        ru: 'Сигнал Wi-Fi слабый (ниже −75 дБм)',
        pt: 'Sinal Wi-Fi fraco (abaixo de −75 dBm)',
        nl: 'Wifi-signaal zwak (onder −75 dBm)',
        fr: 'Signal Wi-Fi faible (inférieur à −75 dBm)',
        it: 'Segnale Wi-Fi debole (sotto −75 dBm)',
        es: 'Señal Wi-Fi débil (por debajo de −75 dBm)',
        pl: 'Sygnał Wi-Fi słaby (poniżej −75 dBm)',
        uk: 'Сигнал Wi-Fi слабкий (нижче −75 дБм)',
        'zh-cn': 'Wi-Fi 信号弱（低于 −75 dBm）',
    },
    off: {
        en: 'Module not connected to the broker',
        de: 'Modul nicht mit dem Broker verbunden',
        ru: 'Модуль не подключён к брокеру',
        pt: 'Módulo não ligado ao broker',
        nl: 'Module niet verbonden met de broker',
        fr: 'Module non connecté au broker',
        it: 'Modulo non connesso al broker',
        es: 'Módulo no conectado al bróker',
        pl: 'Moduł nie jest połączony z brokerem',
        uk: 'Модуль не під’єднано до брокера',
        'zh-cn': '模块未连接到代理',
    },
    getrennt: {
        en: 'Disconnected',
        de: 'Getrennt',
        ru: 'Нет связи',
        pt: 'Desconectado',
        nl: 'Verbroken',
        fr: 'Déconnecté',
        it: 'Disconnesso',
        es: 'Desconectado',
        pl: 'Rozłączono',
        uk: 'Немає зв’язку',
        'zh-cn': '已断开',
    },
};

/**
 * WLAN-Symbol mit gefuellten Boegen je Stufe (0 = nur Punkt ... 3 = alle Boegen), oder
 * durchgestrichen und grau, wenn das Modul getrennt ist.
 *
 * @param {number} boegen  Anzahl gefuellter Boegen (0..3), -1 = getrennt
 * @returns {string} data:-URL
 */
function wlanSymbol(boegen) {
    const voll = '#2196f3';
    const leer = 'rgba(138,138,138,0.45)';
    const grau = '#8a8a8a';
    const aus = boegen < 0;
    const farbe = n => (aus ? grau : n <= boegen ? voll : leer);
    const bogen = (d, n) =>
        `<path d="${d}" fill="none" stroke="${farbe(n)}" stroke-width="2.4" stroke-linecap="round"/>`;
    const teile = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
        bogen('M8.5 15.6a5 5 0 0 1 7 0', 1),
        bogen('M5.2 12.3a9.6 9.6 0 0 1 13.6 0', 2),
        bogen('M1.9 9a14.2 14.2 0 0 1 20.2 0', 3),
        `<circle cx="12" cy="19.2" r="1.9" fill="${aus ? grau : voll}"/>`,
        aus ? `<path d="M4 3.5 20 20.5" stroke="${grau}" stroke-width="2.4" stroke-linecap="round"/>` : '',
        '</svg>',
    ];
    const svg = teile.join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Aktion des Ein/Aus-Umschalters in der Statuszeile. */
const UMSCHALTEN = 'powerToggle';

/**
 * Symbol als Daten-URL (SVG), damit es ohne Datei im Adapter auskommt.
 *
 * @param {string} farbe  Fuellfarbe
 * @returns {string} data:-URL
 */
function einAusSymbol(farbe) {
    // Netzschalter-Symbol (Material Design Icons "power", Apache 2.0)
    const pfad =
        'M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 ' +
        '8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 ' +
        '16.56,5.44M13,3H11V13H13';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${farbe}" d="${pfad}"/></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Ein: gruen, Aus: grau - auf hellem und dunklem Kartengrund gut zu sehen. */
const SYMBOL_EIN = einAusSymbol('#43a047');
const SYMBOL_AUS = einAusSymbol('#8a8a8a');

/**
 * Text mit eingesetztem Namen in allen Sprachen.
 *
 * @param {Record<string, string>} texte  Text je Sprache mit Platzhalter {name}
 * @param {string} name  Name der Klimaanlage
 * @returns {Record<string, string>} Text je Sprache
 */
function mitName(texte, name) {
    return Object.fromEntries(Object.entries(texte).map(([l, t]) => [l, t.replace('{name}', name)]));
}

/**
 * Zeile "Beschriftung ... Zahl Einheit" als HTML-Muster fuer ein staticText-Element.
 *
 * WARUM NICHT als gewoehnliche Datenpunktzeile: Der Admin (json-config, ConfigState) zeichnet
 * jede nur lesbare Zahl mit Einheit "%" oder mit `max` als Fortschrittsbalken, die Zahl
 * abgesetzt darunter - auch mit control:'text'. Die Luftfeuchte ist aber kein Fortschritt.
 * Das Muster bildet die Optik der uebrigen Zeilen nach (Wert rechts, Einheit kleiner und blass).
 * `_states.v` ist der Datenpunkt aus dependsOnStates. Im Ausdruck keine geschweiften Klammern:
 * die Musterauswertung des Admins bricht daran ab.
 *
 * @param {Record<string, string>} label  Beschriftung je Sprache
 * @param {string} einheit  Einheit
 * @returns {Record<string, string>} HTML je Sprache
 */
function zahlZeileHtml(label, einheit) {
    const html = l =>
        '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;font-size:1rem">' +
        `<div style="white-space:nowrap">${l}</div>` +
        '<div style="display:flex;align-items:baseline;gap:4px">' +
        '<span>${Math.round(Number(_states.v?.val))}</span>' +
        `<span style="opacity:0.7;font-size:smaller">${einheit}</span></div></div>`;
    return Object.fromEntries(Object.entries(label).map(([l, t]) => [l, html(t)]));
}

/** Betriebsarten (Werte wie in fields.MODES). */
const MODUS_TEXTE = {
    off: TEXTE.aus,
    heat_cool: {
        en: 'Auto',
        de: 'Automatik',
        ru: 'Авто',
        pt: 'Automático',
        nl: 'Automatisch',
        fr: 'Automatique',
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

/** Betriebsarten zum Waehlen - ohne "Aus": Ausschalten geht nur ueber den Ein/Aus-Umschalter. */
const BETRIEBSART_TEXTE = Object.fromEntries(Object.entries(MODUS_TEXTE).filter(([w]) => w !== 'off'));

/** Tooltips der Sonderstufen (Symbolknoepfe Auto und Leise). */
const STUFEN_TOOLTIP = {
    auto: {
        en: 'Automatic',
        de: 'Automatisch',
        ru: 'Автоматически',
        pt: 'Automático',
        nl: 'Automatisch',
        fr: 'Automatique',
        it: 'Automatico',
        es: 'Automático',
        pl: 'Automatycznie',
        uk: 'Автоматично',
        'zh-cn': '自动',
    },
    night: {
        en: 'Quiet',
        de: 'Leise',
        ru: 'Тихий режим',
        pt: 'Silencioso',
        nl: 'Stil',
        fr: 'Silencieux',
        it: 'Silenzioso',
        es: 'Silencioso',
        pl: 'Cichy',
        uk: 'Тихий режим',
        'zh-cn': '静音',
    },
};

/**
 * Symbole der Sonderstufen als SVG (Linien, 24x24): Auto = "A" im Kreis, Leise = Mondsichel.
 * Als Hintergrundbild des Knopfs - der Admin kennt fuer Knoepfe nur eine Handvoll eingebauter
 * Symbolnamen, keine eigenen Bilder.
 */
const STUFEN_SYMBOL = {
    auto: '<circle cx="12" cy="12" r="9.5"/><path d="M8.3 16.5 12 7.5 15.7 16.5M9.6 13.4h4.8"/>',
    night: '<path d="M20 14.2A8.5 8.5 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z"/>',
};

/**
 * Symbol als CSS-Hintergrund.
 *
 * @param {string} inhalt  SVG-Inhalt aus STUFEN_SYMBOL
 * @param {string} farbe   Linienfarbe
 * @returns {string} CSS url(...)
 */
function symbolUrl(inhalt, farbe) {
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${farbe}" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inhalt}</svg>`;
    return `url("data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}")`;
}

/** Die fuenf festen Luefterstufen von schwach nach stark (Balken 1..5). */
const BALKEN_STUFEN = ['low', 'lowMedium', 'medium', 'mediumHigh', 'high'];

/** Farbe der Balken: gefuellt / leer (auf hellem und dunklem Kartengrund). */
const BALKEN_VOLL = '#2196f3';
const BALKEN_LEER = 'rgba(33,150,243,0.25)';

/**
 * Luefterstufe als Stufenregler: zwei Knoepfe fuer die Sonderstufen (Auto, Leise) und fuenf
 * Balken steigender Hoehe fuer die festen Stufen. Ein Klick schreibt die Stufe ohne ack in
 * control.fan (main.js sendet den Befehl).
 *
 * WARUM KNOEPFE und kein Schieber: Der Schieber des Admins (json-config) arbeitet nur mit
 * Zahlen, die Stufe ist Text, und Auto/Leise haben keinen Platz auf einer Zahlenskala.
 * Jeder Knopf ist ein Datenpunkt-Element mit control:'button' und buttonValue. Dessen Aussehen
 * ist fest - deshalb gibt es jeden Knopf zweimal (gefuellt/leer bzw. aktiv/inaktiv), und
 * `hidden` blendet je nach Wert von control.fan den passenden ein. Bis zur gewaehlten Stufe sind
 * die Balken gefuellt (wie eine Signalanzeige); bei Auto und Leise ist keiner gefuellt.
 *
 * AUFBAU wie die uebrigen Zeilen: Beschriftung links, Knoepfe rechtsbuendig an der Wertespalte.
 * Die Beschriftung nimmt den freien Platz (Grid-Groesse 'grow'), die Knoepfe nur ihre eigene
 * Breite ('auto'); die Spalten stehen enger als ueblich. Passt eine lange Beschriftung (andere
 * Sprache) nicht daneben, rutschen die Knoepfe in die naechste Zeile - weiter rechtsbuendig.
 *
 * @param {string} oid  volle ID von control.fan
 * @param {Record<string, string>} label  Beschriftung je Sprache
 * @returns {object} JSON-Config-Panel
 */
function luefterStufen(oid, label) {
    const items = {
        label: {
            type: 'staticText',
            text: label,
            xs: 'grow',
            // nie schmaler als der Text (sonst laeuft er unter die Knoepfe), mittig zu den Knoepfen
            style: {
                display: 'flex',
                alignItems: 'flex-end',
                height: 36,
                paddingBottom: 5,
                fontSize: '1rem',
                whiteSpace: 'nowrap',
                minWidth: 'max-content',
            },
        },
    };
    const knopf = (schluessel, wert, aktiv, weiteres) => {
        items[schluessel] = {
            type: 'state',
            oid,
            foreign: true,
            label: '',
            control: 'button',
            buttonValue: wert,
            tooltip: LUEFTER_TEXTE[wert],
            dependsOnStates: { v: oid },
            hidden: aktiv,
            ...weiteres,
        };
    };
    // Auto und Leise als Symbolknoepfe im Stil der Balken: so hoch wie der hoechste Balken,
    // aktiv gefuellt (weisses Symbol), sonst blass (blaues Symbol).
    for (const wert of ['auto', 'night']) {
        const ist = `_states.v?.val === '${wert}'`;
        const stil = (grund, linie) => ({
            minWidth: 0,
            width: 30,
            height: 30,
            padding: 0,
            borderRadius: 3,
            boxShadow: 'none',
            backgroundColor: grund,
            backgroundImage: symbolUrl(STUFEN_SYMBOL[wert], linie),
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
            backgroundSize: '22px 22px',
        });
        const gemeinsam = {
            falseText: '\u200b',
            noTranslation: true,
            variant: 'contained',
            tooltip: STUFEN_TOOLTIP[wert],
            xs: 'auto',
            // unten buendig mit den Balken; nach "Leise" ein deutlicher Abstand zur Balkengruppe
            style: { display: 'flex', alignItems: 'flex-end', height: 36, marginRight: wert === 'night' ? 12 : 0 },
        };
        knopf(`${wert}On`, wert, `!(${ist})`, { ...gemeinsam, falseTextStyle: stil(BALKEN_VOLL, '#ffffff') });
        knopf(`${wert}Off`, wert, ist, { ...gemeinsam, falseTextStyle: stil(BALKEN_LEER, BALKEN_VOLL) });
    }
    const liste = JSON.stringify(BALKEN_STUFEN).replace(/"/g, "'");
    BALKEN_STUFEN.forEach((wert, i) => {
        // gefuellt, wenn die eingestellte Stufe mindestens diese ist
        const voll = `${liste}.indexOf(_states.v?.val) >= ${i}`;
        const stil = farbe => ({
            minWidth: 0,
            width: 10,
            height: 10 + i * 5,
            padding: 0,
            borderRadius: 3,
            boxShadow: 'none',
            backgroundColor: farbe,
        });
        const gemeinsam = {
            // ein unsichtbares Zeichen: ohne Text zeigte der Knopf den Datenpunktnamen
            falseText: '\u200b',
            noTranslation: true,
            variant: 'contained',
            xs: 'auto',
            style: { display: 'flex', alignItems: 'flex-end', height: 36 },
        };
        knopf(`step${i + 1}On`, wert, `!(${voll})`, { ...gemeinsam, falseTextStyle: stil(BALKEN_VOLL) });
        knopf(`step${i + 1}Off`, wert, voll, { ...gemeinsam, falseTextStyle: stil(BALKEN_LEER) });
    });
    return {
        type: 'panel',
        xs: 12,
        innerStyle: { '--Grid-columnSpacing': '4px', justifyContent: 'flex-end' },
        items,
    };
}

// ---------------------------------------------------------------- Regelung auf der Karte

/** Aktionen der Regelung: Wochenplan-Dialog und Details-Dialog. */
const WOCHENPLAN = 'regelWochenplan';
const DETAILS = 'regelDetails';

/** Entwuerfe nie geschlossener Wochenplan-Dialoge verfallen nach dieser Zeit. */
const ENTWURF_ALTER_MS = 6 * 3600 * 1000;

/** Hoehe der Wochenplan-Seite im Dialog (px). */
const PLAN_HOEHE = 560;

/** Symbole der drei Schalter (Linien, 24x24): Tacho = Bedarf, Tropfen = Feuchte, Uhr = Wochenplan. */
const REGEL_SYMBOL = {
    bedarf: '<path d="M4.6 17.2a9 9 0 1 1 14.8 0"/><path d="M12 13.6 16.2 8.2"/><circle cx="12" cy="14.2" r="1.3"/>',
    feuchte: '<path d="M12 3.2c3 3.6 5.6 6.8 5.6 10.1a5.6 5.6 0 0 1-11.2 0C6.4 10 9 6.8 12 3.2z"/>',
    plan: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
    details: '<path d="M4 4.5V19.5H20"/><path d="M7.2 15.2 11 10.4l3 2.8 5-6.4"/>',
};

/** Die drei Schalter: Datenpunkt unter regel.* und die Tooltips fuer an/aus. */
const REGEL_SCHALTER = [
    { name: 'bedarf', rel: 'regel.bedarf.aktiv', an: 'tipBedarfAn', aus: 'tipBedarfAus' },
    { name: 'feuchte', rel: 'regel.feuchte.aktiv', an: 'tipFeuchteAn', aus: 'tipFeuchteAus' },
    { name: 'plan', rel: 'regel.plan.aktiv', an: 'tipPlanAn', aus: 'tipPlanAus' },
];

/**
 * Symbol als Daten-URL fuer eine Aktion der Karte.
 *
 * @param {string} inhalt  SVG-Inhalt aus REGEL_SYMBOL
 * @returns {string} data:-URL
 */
function aktionsSymbol(inhalt) {
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${BALKEN_VOLL}" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inhalt}</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Text als JavaScript-Zeichenkette fuer einen Ausdruck in einem Muster des Admins.
 *
 * @param {string} text  Text
 * @returns {string} Literal in einfachen Anfuehrungszeichen
 */
const js = text => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Ausdruck, der einen Datenpunktwert HTML-sicher als Text liefert.
 *
 * @param {string} alias  Kurzname des Datenpunkts in dependsOnStates
 */
const sicher = alias =>
    `String(_states.${alias}?.val ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')`;

/**
 * Kleines Etikett (Chip) als HTML; `farbe` und `text` sind Ausdruecke oder feste Werte.
 *
 * @param {string} farbe  Farbe
 * @param {string} text  Inhalt
 * @param {string} [titel]  Tooltip
 */
const chip = (farbe, text, titel = '') =>
    `<span${titel ? ` title="${titel}"` : ''} style="display:inline-flex;align-items:center;gap:5px;padding:1px 9px;border-radius:10px;` +
    `font-size:0.8rem;line-height:1.5;white-space:nowrap;border:1px solid ${farbe};color:${farbe}">` +
    `<span style="width:7px;height:7px;border-radius:50%;background:${farbe}"></span>${text}</span>`;

const ZEILE = 'display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;font-size:1rem';
const BLASS = 'opacity:0.75;font-size:0.85rem;line-height:1.35';

/**
 * Kopf der Regelung: Zustand als Etikett, darunter die Begruendung (hoechstens zwei Zeilen, ganz im
 * Tooltip). Muster je Sprache; im Ausdruck keine geschweiften Klammern (siehe zahlZeileHtml).
 *
 * @param {boolean} probeGlobal  Probelauf in den Instanzeinstellungen
 * @returns {Record<string, string>} HTML-Muster je Sprache
 */
function regelKopfHtml(probeGlobal) {
    const T = oberflaeche.TEXTE;
    const A = oberflaeche.AMPEL;
    const z = '_states.z?.val';
    const farbe = `\${${z}==='ok'?'${A.gut}':${z}==='hand'?'${A.warn}':${z}==='gestört'?'${A.fehler}':'${A.aus}'}`;
    return Object.fromEntries(
        oberflaeche.SPRACHEN.map(l => {
            const text =
                `\${${z}==='ok'?${js(T.zOk[l])}:${z}==='hand'?${js(T.zHand[l])}:${z}==='gestört'?${js(T.zGestoert[l])}:` +
                `${z}==='offline'?${js(T.zOffline[l])}:${js(T.zAus[l])}}`;
            const probe =
                `\${(${z}&&${z}!=='aus'&&(${probeGlobal ? 'true' : 'false'}||_states.p?.val!==false))?` +
                `${js(chip(A.warn, T.probelauf[l]))}:''}`;
            return [
                l,
                `<div style="border-top:1px solid rgba(128,128,128,0.35);margin-top:4px;padding-top:10px;${ZEILE}">` +
                    `<div style="white-space:nowrap">${T.regelung[l]}</div>` +
                    `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${probe}${chip(farbe, text)}</div></div>` +
                    `<div title="\${${sicher('g')}}" style="${BLASS};margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;` +
                    `-webkit-box-orient:vertical;overflow:hidden">\${${sicher('g')}}</div>`,
            ];
        }),
    );
}

/**
 * Leistungsgrenze: Zahl, Stufenbalken (30..100 % in 5-%-Stufen) und ein Hinweis, wenn der Wert
 * nicht gesendet wird (Probelauf), die Anlage ihn nicht uebernimmt oder nicht begrenzt wird.
 *
 * @param {boolean} probeGlobal  Probelauf in den Instanzeinstellungen
 * @returns {Record<string, string>} HTML-Muster je Sprache
 */
function regelGrenzeHtml(probeGlobal) {
    const T = oberflaeche.TEXTE;
    const A = oberflaeche.AMPEL;
    // Faikout-Auto begrenzt nur mit der Strategie "Auto" (vortag) - sonst ruht die Bedarfsregelung
    const ruht = "(_states.b?.val==='faikout'&&_states.st?.val!=='vortag')";
    const an = `(_states.a?.val===true&&_states.f?.val!=='nein'&&!${ruht}&&typeof _states.s?.val==='number')`;
    const stufen = `(${an}?Math.min(${kennlinienbild.BALKEN_ANZAHL},Math.floor((_states.s.val-${kennlinienbild.BALKEN_VON})/${kennlinienbild.BALKEN_SCHRITT})+1):0)`;
    const nummern = JSON.stringify([...Array(kennlinienbild.BALKEN_ANZAHL).keys()]);
    const balken =
        `\${${nummern}.map(i=>'<span style="flex:1;height:'+(i+1===${stufen}?14:9)+'px;border-radius:2px;background:currentColor;opacity:'+` +
        `(i<${stufen}?1:0.16)+'"></span>').join('')}`;
    return Object.fromEntries(
        oberflaeche.SPRACHEN.map(l => {
            const hinweis =
                `\${_states.f?.val==='nein'?${js(chip(A.warn, T.nichtUnterstuetzt[l]))}:${ruht}?${js(chip(A.aus, T.ruht[l]))}:_states.a?.val!==true?` +
                `${js(`<span style="${BLASS}">${T.grenzeAus[l]}</span>`)}:` +
                `(${probeGlobal ? 'true' : 'false'}||_states.p?.val!==false)?${js(chip(A.warn, T.nichtGesendet[l]))}:''}`;
            return [
                l,
                `<div style="${ZEILE}"><div style="white-space:nowrap">${T.grenze[l]}</div>` +
                    `<div style="display:flex;align-items:baseline;gap:4px"><span style="font-weight:600">\${${an}?Math.round(_states.s.val):'–'}</span>` +
                    `<span style="opacity:0.7;font-size:smaller">%</span></div></div>` +
                    `<div style="display:flex;align-items:flex-end;gap:3px;height:14px;margin:4px 0 6px">${balken}</div>` +
                    `<div style="display:flex;justify-content:flex-end">${hinweis}</div>`,
            ];
        }),
    );
}

/** Wochentage kurz, Index wie Date.getDay() (0 = Sonntag). */
const WOCHENTAGE = {
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    pt: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'],
    nl: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
    fr: ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'],
    it: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
    es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    pl: ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'],
    uk: ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    'zh-cn': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
};

/**
 * Ausdruck: Zeitstempel im Datenpunkt `alias` als "HH:MM", an einem anderen Tag mit Wochentag davor.
 *
 * @param {string} alias  Kurzname des Datenpunkts in dependsOnStates
 * @param {string} l  Sprache
 */
const zeitAusdruck = (alias, l) =>
    `(new Date(_states.${alias}.val).toDateString()===new Date().toDateString()?'':` +
    `${JSON.stringify(WOCHENTAGE[l]).replace(/"/g, "'")}[new Date(_states.${alias}.val).getDay()]+' ')+` +
    `new Date(_states.${alias}.val).toTimeString().slice(0,5)`;

/**
 * Aktuelle Szene und naechster Schaltpunkt.
 *
 * @returns {Record<string, string>} HTML-Muster je Sprache
 */
function regelPlanHtml() {
    const T = oberflaeche.TEXTE;
    return Object.fromEntries(
        oberflaeche.SPRACHEN.map(l => [
            l,
            `<div style="${ZEILE}"><div style="white-space:nowrap">${T.szene[l]}</div>` +
                `<div style="text-align:right;font-weight:600">\${_states.s?.val?${sicher('s')}:${js(`<span style="${BLASS};font-weight:400">${T.keinPlan[l]}</span>`)}}</div></div>` +
                `\${typeof _states.n?.val==='number'&&_states.n.val>0?` +
                `'<div style="${ZEILE};margin-top:6px"><div style="white-space:nowrap">'+${js(T.naechste[l])}+'</div><div style="text-align:right">'+` +
                `${zeitAusdruck('n', l)}+' '+${sicher('ns')}+'</div></div>':''}`,
        ]),
    );
}

/**
 * Hinweis auf einen Handeingriff mit der Uhrzeit, bis zu der die Automatik wartet.
 *
 * @returns {Record<string, string>} HTML-Muster je Sprache
 */
function regelHandHtml() {
    const T = oberflaeche.TEXTE;
    const A = oberflaeche.AMPEL;
    return Object.fromEntries(
        oberflaeche.SPRACHEN.map(l => [
            l,
            `<div style="border:1px solid ${A.warn};border-radius:6px;padding:6px 10px;font-size:0.9rem;line-height:1.4;background:rgba(217,138,0,0.12)">` +
                `${T.handBis[l]} <b>\${typeof _states.b?.val==='number'&&_states.b.val>0?${zeitAusdruck('b', l)}:'–'}</b></div>`,
        ]),
    );
}

/**
 * Fuehlerzeile: je Messgroesse ein Etikett; gruen = gewaehlter Fuehler liefert, gelb = Rueckfall auf
 * einen anderen Fuehler oder kein Wert. Die Quelle steht im Tooltip. Die Feuchte erscheint nur,
 * wenn es einen Wert gibt oder die Feuchteregelung eingeschaltet ist.
 *
 * @returns {Record<string, string>} HTML-Muster je Sprache
 */
function regelFuehlerHtml() {
    const T = oberflaeche.TEXTE;
    const A = oberflaeche.AMPEL;
    const eins = (wert, quelle, name, l, einheit, nur) => {
        const fehlt = `(typeof _states.${wert}?.val!=='number')`;
        const rueck = `String(_states.${quelle}?.val||'').includes('Rückfall')`;
        const farbe = `'+(${fehlt}||${rueck}?'${A.warn}':'${A.gut}')+'`;
        const text =
            `${name}'+(${fehlt}?' '+${js(T.fFehlt[l])}:' '+String(Math.round(_states.${wert}.val*10)/10).replace('.',',')+' ${einheit}'+` +
            `(${rueck}?' · '+${js(T.fRueckfall[l])}:''))+'`;
        const html = `'${chip(farbe, text, `'+${sicher(quelle)}+'`)}'`;
        return nur ? `(${nur}?${html}:'')` : html;
    };
    return Object.fromEntries(
        oberflaeche.SPRACHEN.map(l => [
            l,
            `<div style="${ZEILE};align-items:flex-start"><div style="white-space:nowrap">${T.fuehler[l]}</div>` +
                `<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">\${` +
                `${eins('av', 'aq', T.fAussen[l], l, '°C')}+${eins('rv', 'rq', T.fRaum[l], l, '°C')}+` +
                `${eins('fv', 'fq', T.fFeuchte[l], l, '%', "(typeof _states.fv?.val==='number'||_states.fa?.val===true)")}}</div></div>`,
        ]),
    );
}

/**
 * Die drei Schalter Bedarf / Feuchte / Wochenplan als Symbolknoepfe (aktiv gefuellt) und, bei
 * Handeingriff, der Knopf "Automatik fortsetzen". Jeder Knopf schreibt ohne ack in seinen
 * Datenpunkt unter regel.* - geschaltet wird in lib/regel (schalter()), nie am Modul.
 *
 * @param {string} basis  volle ID des Geraets
 * @param {Map<string, object>} punkte  vorhandene Datenpunkte
 * @param {string} id  Geraete-ID
 * @returns {object} JSON-Config-Panel
 */
function regelKnoepfe(basis, punkte, id) {
    const T = oberflaeche.TEXTE;
    const items = {
        label: {
            type: 'staticText',
            text: T.automatik,
            xs: 'grow',
            style: {
                display: 'flex',
                alignItems: 'center',
                height: 36,
                fontSize: '1rem',
                whiteSpace: 'nowrap',
                minWidth: 'max-content',
            },
        },
    };
    const stil = (grund, linie, symbol) => ({
        minWidth: 0,
        width: 34,
        height: 30,
        padding: 0,
        borderRadius: 4,
        boxShadow: 'none',
        backgroundColor: grund,
        backgroundImage: symbolUrl(symbol, linie),
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
        backgroundSize: '20px 20px',
    });
    for (const s of REGEL_SCHALTER) {
        if (!punkte.has(`${id}.${s.rel}`)) {
            continue;
        }
        const oid = `${basis}.${s.rel}`;
        const knopf = (schluessel, wert, hidden, tooltip, falseTextStyle) => {
            items[schluessel] = {
                type: 'state',
                oid,
                foreign: true,
                label: '',
                control: 'button',
                buttonValue: wert,
                falseText: '​',
                noTranslation: true,
                variant: 'contained',
                tooltip,
                dependsOnStates: { v: oid },
                hidden,
                falseTextStyle,
                xs: 'auto',
                style: { display: 'flex', alignItems: 'center', height: 36 },
            };
        };
        // an: gefuellt mit weissem Symbol, ein Klick schaltet aus - und umgekehrt
        knopf(
            `${s.name}On`,
            false,
            '_states.v?.val !== true',
            T[s.an],
            stil(BALKEN_VOLL, '#ffffff', REGEL_SYMBOL[s.name]),
        );
        knopf(
            `${s.name}Off`,
            true,
            '_states.v?.val === true',
            T[s.aus],
            stil(BALKEN_LEER, BALKEN_VOLL, REGEL_SYMBOL[s.name]),
        );
    }
    return { type: 'panel', xs: 12, innerStyle: { '--Grid-columnSpacing': '6px', justifyContent: 'flex-end' }, items };
}

/**
 * Formular des Wochenplan-Dialogs: die Wochenplan-Seite (admin/wochenplan.html) als iframe. Die Seite
 * spricht selbst mit dem Adapter (sendTo wochenplanInfo / wochenplanEntwurf); der Dialog bestaetigt nur.
 *
 * @param {string} url  Adresse der Seite mit ihren Parametern
 * @returns {object} Formular
 */
function planFormular(url) {
    return {
        type: 'panel',
        items: {
            raster: {
                type: 'iframe',
                url,
                xs: 12,
                style: { height: PLAN_HOEHE + 10 },
                innerStyle: { height: `${PLAN_HOEHE}px` },
                lazyLoad: 'eager',
            },
        },
    };
}

/**
 * Adresse der Wochenplan-Seite fuer einen Dialog.
 *
 * @param {string} namespace  Namensraum des Adapters
 * @param {string} id  Geraete-ID
 * @param {string} token  Kennung des Dialogs (gehoert zu seinem Entwurf)
 * @returns {string} URL unterhalb des Admins
 */
const planUrl = (namespace, id, token) =>
    `../../adapter/faikout/wochenplan.html?instance=${encodeURIComponent(namespace)}&device=${encodeURIComponent(id)}&token=${token}`;

/**
 * Macht einen Text ungefaehrlich fuer ein staticText-Element: HTML-Zeichen maskiert, und nichts,
 * was der Admin als Muster auswerten wuerde (Backtick, Dollar-Klammer, Rueckstrich).
 *
 * @param {unknown} text  Text
 * @returns {string} sicherer Text
 */
const fest = text => kennlinienbild.esc(text).replace(/`/g, '&#96;').replace(/\$/g, '&#36;').replace(/\\/g, '&#92;');

/** Karten der Klimaanlagen im Device-Manager: Betrieb anzeigen, Alltag bedienen, nichts konfigurieren. */
class FaikoutDeviceManagement extends DeviceManagement {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter  Adapterinstanz
     */
    constructor(adapter) {
        // Kein Kommunikations-Datenpunkt: Die Karten lesen ihre Werte direkt aus den
        // vorhandenen Datenpunkten. So entsteht kein zusaetzliches Objekt im Baum.
        super(adapter);
        /** Entwuerfe der offenen Wochenplan-Dialoge nach Kennung: {id, programm, abwesenheit, geaendert, zeit} */
        this.planEntwuerfe = new Map();
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

        // Verbindung und Signal stehen zusammen in EINEM WLAN-Symbol (Statusanzeige unten): Boegen je
        // Signalstufe, durchgestrichen wenn das Modul getrennt ist. Die eingebaute Verbindungs- und
        // Signalanzeige des Admins (status.connection/rssi) entfaellt deshalb - sie zeichnete ein
        // zweites Symbol mit eigenem Balken. Antwortet die Klimaanlage hinter dem Modul nicht,
        // erscheint weiter die Warnung.
        const status = {};
        if (hat('up') && hat('online')) {
            status.warning = {
                stateId: voll(feldId(id, 'online')),
                mapping: { true: false, false: TEXTE.nichtErreichbar },
            };
        }

        // Kein Hersteller: Der Adapter kennt nur Daikin-Anlagen, die Zeile sagte nichts (Nutzerwunsch).
        const info = {
            id,
            name,
            icon: 'airCondition',
            // kein connectionType: der Admin zeichnete dafuer sonst ein eigenes (blasses) WLAN-Symbol
            status,
            customInfo: { id, schema: this.kartenSchema(id, punkte, (obj.native && obj.native.faikoutName) || id) },
        };
        if (hat('model')) {
            info.model = { stateId: voll(feldId(id, 'model')) };
        }

        // Ein/Aus als Umschalter in der Statuszeile: eine Statusanzeige an control.power, deren
        // Symbol, Text und Tooltip dem Wert live folgen, und die per Klick die Aktion ausloest.
        // Aktionen selbst laedt der Admin nur beim Oeffnen der Seite - deshalb EINE Aktion, die
        // erst beim Klick nachsieht, in welche Richtung sie schalten muss, und dann nachfragt.
        const power = punkte.get(feldId(id, 'power'));
        if (power && power.common && power.common.write) {
            const aus = { icon: SYMBOL_AUS, text: TEXTE.aus, tooltip: TEXTE.tipEinschalten };
            info.actions = [
                {
                    id: UMSCHALTEN,
                    icon: SYMBOL_AUS,
                    description: TEXTE.tipEinschalten,
                    handler: (geraetId, context) => this.umschalten(geraetId, context),
                },
            ];
            info.indicators = [
                {
                    id: 'power',
                    value: { stateId: voll(feldId(id, 'power')) },
                    // auch "aus" (false) bleibt sichtbar - dann zeigt der Knopf "Aus"
                    hideIfEmpty: false,
                    levels: [
                        { value: true, icon: SYMBOL_EIN, text: TEXTE.an, tooltip: TEXTE.tipAusschalten },
                        { value: false, ...aus },
                        aus,
                    ],
                    ...aus,
                    actionId: UMSCHALTEN,
                    order: 10,
                },
            ];
        }
        // Regelung: Wochenplan und Details als Aktionen - Zeitplaene und der Blick in den Rechenweg sind
        // laufender Betrieb, keine Konfiguration (Szenen, Kennlinie, Fuehler stehen in den Einstellungen).
        if (punkte.has(`${id}.regel.zustand`)) {
            info.actions = [
                ...(info.actions || []),
                {
                    id: WOCHENPLAN,
                    icon: aktionsSymbol(REGEL_SYMBOL.plan),
                    description: oberflaeche.TEXTE.aktWochenplan,
                    handler: (geraetId, context) => this.wochenplanDialog(geraetId, context),
                },
                {
                    id: DETAILS,
                    icon: aktionsSymbol(REGEL_SYMBOL.details),
                    description: oberflaeche.TEXTE.aktDetails,
                    handler: (geraetId, context) => this.detailsDialog(geraetId, context),
                },
            ];
        }
        if (hat('rssi') || hat('up')) {
            const stufe = (wert, boegen) => ({ value: wert, icon: wlanSymbol(boegen), tooltip: WLAN_TEXTE[wert] });
            const wlan = {
                id: 'wlan',
                // Stufe aus dem Geraeteobjekt (main.js: wlanStufeAktualisieren), Zahl aus info.rssi
                value: { objectId: voll(id), property: 'native.wlan' },
                text: { stateId: voll(feldId(id, 'rssi')) },
                unit: 'dBm',
                levels: [
                    stufe('s4', 3),
                    stufe('s3', 2),
                    stufe('s2', 1),
                    stufe('s1', 0),
                    { ...stufe('off', -1), text: WLAN_TEXTE.getrennt, color: 'error' },
                ],
                order: 5,
            };
            info.indicators = [wlan, ...(info.indicators || [])];
        }
        if (!Object.keys(status).length) {
            delete info.status;
        }
        return info;
    }

    /**
     * Ein/Aus-Umschalter: liest den jetzigen Zustand, fragt nach und schreibt das Gegenteil ohne
     * ack in control.power. Gesendet wird wie immer ueber main.js (onStateChange).
     *
     * @param {string} geraetId  Geraete-ID
     * @param {import('@iobroker/dm-utils').ActionContext} context  Kontext fuer die Rueckfrage
     * @returns {Promise<object>} Antwort an die Oberflaeche
     */
    async umschalten(geraetId, context) {
        const rel = feldId(String(geraetId), 'power');
        const obj = await this.adapter.getObjectAsync(rel);
        if (!obj || !obj.common || !obj.common.write) {
            return this.fehler(`${rel} does not exist or is not writable`);
        }
        const geraet = await this.adapter.getObjectAsync(String(geraetId));
        const name = String((geraet && geraet.common && geraet.common.name) || geraetId);
        const st = await this.adapter.getStateAsync(rel);
        const an = !!(st && st.val);
        const ja = await context.showConfirmation(mitName(an ? TEXTE.frageAusschalten : TEXTE.frageEinschalten, name));
        if (ja) {
            await this.schreiben(rel, !an);
        }
        // Die Statusanzeige folgt dem Datenpunkt von selbst, die Karte muss nicht neu geladen werden.
        return { refresh: false };
    }

    /**
     * Die Karte: laufender Betrieb und alle Bedienelemente des Alltags. Einen Bedien-Dialog gibt
     * es nicht (keine controls) - alles steht hier (Nutzerwunsch, wie mill-local).
     *
     * @param {string} id   Geraete-ID
     * @param {Map<string, ioBroker.StateObject>} punkte  vorhandene Datenpunkte
     * @param {string} kennung  Name des Moduls (die ID, wie sie das Modul selbst fuehrt)
     * @returns {object} JSON-Config-Schema
     */
    kartenSchema(id, punkte, kennung) {
        const ns = this.adapter.namespace;
        // Die ID nur als Wert, ohne Beschriftung "ID" und ohne Kopierknopf - beides zeichnet der
        // Admin fest zu DeviceInfo.identifier, deshalb steht sie hier statt dort.
        const items = {
            ident: {
                type: 'staticText',
                text: kennung,
                noTranslation: true,
                xs: 12,
                style: { fontSize: '0.875rem', opacity: 0.75 },
            },
        };
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
        // Lesezeile mit Klartext statt Rohwert: control 'text' + options. Mit control 'select' zeichnet
        // der Admin ein ausgegrautes Auswahlfeld - das sah bedienbar aus, war es aber nicht.
        const auswahl = texte => ({ control: 'text', options: optionen(texte) });
        const beschreibbar = rel => {
            const o = punkte.get(rel);
            return !!(o && o.common && o.common.write);
        };
        // Bedienbare Zeile: der Admin schreibt den Wert ohne ack in den Datenpunkt, main.js schickt
        // den Befehl - wie beim Schreiben im Objektbaum. Bewusst unabhaengig davon, ob die Anlage
        // laeuft: Das Modul nimmt Betriebsart, Sollwert und Luefterstufe auch im ausgeschalteten
        // Zustand an, und eine Betriebsart schaltet die Anlage dabei EIN (Faikout.c: das
        // Kommando mode setzt power = (Wert != "off") im selben Steuerbefehl).
        const bedienbar = (schluessel, feld, texte, label) => {
            const rel = feldId(id, feld);
            if (!beschreibbar(rel)) {
                return false;
            }
            const o = punkte.get(rel);
            // Beschriftung links als eigenes Element, Auswahl rechts ohne eigene Beschriftung - wie
            // die Lesezeilen. Mit Beschriftung in der Auswahl laeuft deren Rahmen mitten durch den
            // Text (der Admin setzt die Beschriftung, laesst im Rahmen aber keine Luecke dafuer).
            items[`${schluessel}Label`] = {
                type: 'staticText',
                text: label,
                xs: 5,
                // so hoch wie das Auswahlfeld (MUI: 56 px), damit der Text mittig daneben steht
                style: { display: 'flex', alignItems: 'center', minHeight: 56, fontSize: '1rem' },
            };
            items[schluessel] = {
                type: 'state',
                oid: `${ns}.${rel}`,
                foreign: true,
                label: '',
                control: 'select',
                options: optionen(texte, o.common.states),
                xs: 7,
            };
            return true;
        };

        // Ein/Aus steht nicht als Zeile hier, sondern als Umschalter in der Statuszeile. Die
        // Auswahl haengt an control.selectedMode: Betriebsart ohne "Aus", bei ausgeschalteter
        // Anlage die zuletzt eingestellte. Gibt es den Datenpunkt noch nicht (Modul hat sich
        // seit dem Update nicht gemeldet), steht die Betriebsart nur lesend da.
        if (!bedienbar('mode', 'selectedMode', BETRIEBSART_TEXTE, feldName('mode'))) {
            zeile('mode', feldId(id, 'mode'), feldName('mode'), auswahl(MODUS_TEXTE));
        }
        zeile('action', feldId(id, 'action'), feldName('action'), auswahl(TAETIGKEIT_TEXTE));
        zeile('temp', feldId(id, 'temp'), TEXTE.roomTemp, { unit: '°C', digits: 1 });
        zeile('target', feldId(id, 'target'), feldName('target'), { unit: '°C', digits: 1 });
        const sollRel = feldId(id, 'target');
        if (beschreibbar(sollRel)) {
            // Schieber direkt unter dem Sollwert; Bereich und Schritt je Anlage (HA-Discovery).
            // controlDelay: erst schreiben, wenn der Schieber eine Sekunde stillsteht.
            const c = punkte.get(sollRel).common;
            const min = typeof c.min === 'number' ? c.min : felder.FELDER.target.min;
            const max = typeof c.max === 'number' ? c.max : felder.FELDER.target.max;
            items.targetSlider = {
                type: 'state',
                oid: `${ns}.${sollRel}`,
                foreign: true,
                label: '',
                control: 'slider',
                min,
                max,
                step: typeof c.step === 'number' && c.step > 0 ? c.step : 0.5,
                unit: '°C',
                digits: 1,
                controlDelay: SCHIEBER_RUHE_MS,
                falseText: `${min}`,
                trueText: `${max}`,
                noTranslation: true,
                xs: 12,
            };
        }
        // Luefterstufe nur als Stufenregler (die Balken zeigen die Stufe, der Tooltip nennt sie).
        if (beschreibbar(feldId(id, 'fan'))) {
            items.fanSteps = luefterStufen(`${ns}.${feldId(id, 'fan')}`, feldName('fan'));
        } else {
            zeile('fan', feldId(id, 'fan'), feldName('fan'), auswahl(LUEFTER_TEXTE));
        }
        zeile('outside', feldId(id, 'outside'), feldName('outside'), { unit: '°C', digits: 1 });
        if (punkte.has(feldId(id, 'hum'))) {
            // Als Zahl mit %, nicht als Balken (siehe zahlZeileHtml); ohne Wert ausgeblendet.
            const humId = `${ns}.${feldId(id, 'hum')}`;
            items.hum = {
                type: 'staticText',
                format: 'html',
                // func: Muster je Sprache - nur so wertet der Admin ${...} in einem Sprachobjekt aus
                text: { func: zahlZeileHtml(feldName('hum'), '%') },
                dependsOnStates: { v: humId },
                hidden: "!(typeof _states.v?.val === 'number' && isFinite(_states.v.val))",
                xs: 12,
            };
        }
        zeile('consumption', feldId(id, 'consumption'), TEXTE.leistung, { unit: 'W', digits: 0 });
        zeile('energyToday', `${id}.consumption.total.today`, TEXTE.energyToday, { unit: 'kWh', digits: 2 });
        // Die abgelehnte Einstellung (JSON) und der Trennungsgrund stehen bewusst NICHT auf der Karte:
        // Beschriftung und Wert sind zu lang fuer eine Kartenzeile, der Wert lief rechts aus der Karte
        // und war unsichtbar (Admin 8.3.7). Beide bleiben als Datenpunkte im Objektbaum.
        this.regelKarte(items, id, punkte);
        return { type: 'panel', items };
    }

    /**
     * Abschnitt "Regelung" der Karte: Zustand mit Begruendung, Leistungsgrenze, Szene und naechster
     * Schaltpunkt, die drei Schalter, Hinweis auf einen Handeingriff, Fuehler. Nur wenn es die
     * Datenpunkte regel.* gibt (das Modul hat sich seit dem Update gemeldet).
     *
     * @param {Record<string, object>} items  Elemente der Karte (wird ergaenzt)
     * @param {string} id  Geraete-ID
     * @param {Map<string, ioBroker.StateObject>} punkte  vorhandene Datenpunkte
     */
    regelKarte(items, id, punkte) {
        if (!punkte.has(`${id}.regel.zustand`)) {
            return;
        }
        const basis = `${this.adapter.namespace}.${id}`;
        const dp = rel => `${basis}.${rel}`;
        const probeGlobal = !this.adapter.config || this.adapter.config.regelProbelauf !== false;
        const html = (func, states, hidden) => ({
            type: 'staticText',
            format: 'html',
            text: { func },
            dependsOnStates: states,
            ...(hidden ? { hidden } : {}),
            xs: 12,
        });
        items.regelKopf = html(regelKopfHtml(probeGlobal), {
            z: dp('regel.zustand'),
            g: dp('regel.grund'),
            p: dp('regel.bedarf.probelauf'),
        });
        items.regelGrenze = html(regelGrenzeHtml(probeGlobal), {
            s: dp('regel.bedarf.sollwert'),
            a: dp('regel.bedarf.aktiv'),
            p: dp('regel.bedarf.probelauf'),
            f: dp('info.demandFaehig'),
            b: dp('regel.betrieb'),
            st: dp('regel.bedarf.strategie'),
        });
        items.regelPlan = html(
            regelPlanHtml(),
            {
                s: dp('regel.plan.szene'),
                n: dp('regel.plan.naechster'),
                ns: dp('regel.plan.naechsteSzene'),
                a: dp('regel.plan.aktiv'),
            },
            '_states.a?.val !== true',
        );
        items.regelHand = html(
            regelHandHtml(),
            { h: dp('regel.hand.gesperrt'), b: dp('regel.hand.bis') },
            '_states.h?.val !== true',
        );
        if (punkte.has(`${id}.regel.hand.aufheben`)) {
            items.regelFortsetzen = {
                type: 'state',
                oid: dp('regel.hand.aufheben'),
                foreign: true,
                label: '',
                control: 'button',
                buttonValue: true,
                falseText: oberflaeche.TEXTE.fortsetzen,
                tooltip: oberflaeche.TEXTE.tipFreigeben,
                variant: 'outlined',
                dependsOnStates: { h: dp('regel.hand.gesperrt') },
                hidden: '_states.h?.val !== true',
                xs: 12,
            };
        }
        items.regelKnoepfe = regelKnoepfe(basis, punkte, id);
        items.regelFuehler = html(regelFuehlerHtml(), {
            av: dp('regel.fuehler.aussen'),
            aq: dp('regel.fuehler.aussenQuelle'),
            rv: dp('regel.fuehler.raum'),
            rq: dp('regel.fuehler.raumQuelle'),
            fv: dp('regel.fuehler.feuchte'),
            fq: dp('regel.fuehler.feuchteQuelle'),
            fa: dp('regel.feuchte.aktiv'),
        });
    }

    /**
     * Name eines Geraets fuer Dialogtitel.
     *
     * @param {string} id  Geraete-ID
     * @returns {Promise<string>} Name
     */
    async geraetName(id) {
        const obj = await this.adapter.getObjectAsync(id);
        let name = (obj && obj.common && obj.common.name) || id;
        if (name && typeof name === 'object') {
            name = name.en || Object.values(name)[0] || id;
        }
        return String(name);
    }

    /**
     * Nachrichten der Wochenplan-Seite (sendTo aus dem iframe, ueber lib/oberflaeche.js).
     *
     * wochenplanInfo {device, token}: Plan, Szenen, Farben und Texte fuer die Seite.
     * wochenplanEntwurf {device, token, program, abwesenheit}: der bearbeitete Plan - wird hier
     *   geprueft (wochenplan.planLesen) und bis zur Bestaetigung des Dialogs gehalten.
     * wochenplanVorgabe {device, token}: der Vorgabeplan (wochenplan.vorgabePlan).
     *
     * @param {string} befehl  Befehl
     * @param {Record<string, unknown>} msg  Nachricht
     * @returns {Promise<object>} Antwort
     */
    async wochenplanNachricht(befehl, msg) {
        const id = String((msg && msg.device) || '');
        const entwurf = this.planEntwuerfe.get(String((msg && msg.token) || ''));
        if (!entwurf || entwurf.id !== id) {
            return { error: 'unknown or expired dialog' };
        }
        const sz = oberflaeche.szenen(this.adapter, id);
        const sprache = await oberflaeche.sprache(this.adapter);
        if (befehl === 'wochenplanVorgabe') {
            return { program: oberflaeche.planZuProgramm(wochenplan.vorgabePlan(sz)) };
        }
        if (befehl === 'wochenplanInfo') {
            const gelesen = wochenplan.planLesen(
                (await oberflaeche.lies(this.adapter, `${id}.regel.plan.wocheJson`)) || '',
                sz,
            );
            const abw = wochenplan.abwesenheitLesen(
                (await oberflaeche.lies(this.adapter, `${id}.regel.plan.abwesenheitJson`)) || '',
                sz,
            );
            const heute = new Date();
            const frueh = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + 1).getTime();
            const cfg = this.adapter.config || {};
            return {
                program: entwurf.programm || oberflaeche.planZuProgramm(gelesen.plan),
                types: oberflaeche.planTypen(sz, sprache),
                farben: oberflaeche.szenenFarben(sz),
                lang: sprache,
                max: 7 * 24,
                texts: oberflaeche.planTexte(sprache),
                abwesenheit: entwurf.abwesenheitRoh || {
                    aktiv: !!abw,
                    von: oberflaeche.ortszeitText(abw ? abw.von : frueh),
                    bis: oberflaeche.ortszeitText(abw ? abw.bis : frueh + 7 * wochenplan.TAG_MS),
                    szene: abw ? abw.szene : sz.has('abwesend') ? 'abwesend' : [...sz.keys()][0],
                },
                feiertagSonntag: cfg.regelFeiertagSonntag === true,
                planAktiv: (await oberflaeche.lies(this.adapter, `${id}.regel.plan.aktiv`)) === true,
            };
        }
        if (befehl === 'wochenplanEntwurf') {
            const zeilen = Array.isArray(msg.program) ? msg.program : [];
            if (zeilen.length) {
                // sofort pruefen, damit die Seite einen Fehler gleich zeigen kann
                const p = oberflaeche.programmZuPlan(zeilen, sz);
                if (p.fehler) {
                    return { error: p.fehler };
                }
            }
            const a = msg.abwesenheit && typeof msg.abwesenheit === 'object' ? msg.abwesenheit : {};
            let abwesenheit = null;
            if (a.aktiv) {
                const von = oberflaeche.ortszeitLesen(a.von);
                const bis = oberflaeche.ortszeitLesen(a.bis);
                if (!(bis > von) || !sz.has(String(a.szene))) {
                    return { error: oberflaeche.t('pAbwFehler', sprache) };
                }
                abwesenheit = { von, bis, szene: String(a.szene) };
            }
            entwurf.programm = zeilen;
            entwurf.abwesenheit = abwesenheit;
            entwurf.abwesenheitRoh = { aktiv: !!a.aktiv, von: a.von, bis: a.bis, szene: a.szene };
            entwurf.geaendert = true;
            return { ok: true, count: zeilen.length };
        }
        return { error: `unknown command ${befehl}` };
    }

    /**
     * Wochenplan-Dialog: Die Wochenplan-Seite (iframe) bearbeitet einen Entwurf im Adapter; "OK"
     * schreibt ihn ohne ack nach regel.plan.wocheJson und regel.plan.abwesenheitJson (uebernommen
     * wird in lib/regel) und fragt, falls der Wochenplan dieser Anlage aus ist, ob er eingeschaltet
     * werden soll.
     *
     * @param {string} geraetId  Geraete-ID
     * @param {import('@iobroker/dm-utils').ActionContext} context  Kontext der Aktion
     * @returns {Promise<object>} Antwort an die Oberflaeche
     */
    async wochenplanDialog(geraetId, context) {
        const id = String(geraetId);
        if (!(await this.adapter.getObjectAsync(`${id}.regel.plan.wocheJson`))) {
            return this.fehler(`${id}.regel.plan.wocheJson does not exist`);
        }
        const name = await this.geraetName(id);
        const token = randomBytes(12).toString('hex');
        const entwurf = {
            id,
            programm: null,
            abwesenheit: null,
            abwesenheitRoh: null,
            geaendert: false,
            zeit: Date.now(),
        };
        this.planEntwuerfe.set(token, entwurf);
        for (const [k, e] of this.planEntwuerfe) {
            if (Date.now() - e.zeit > ENTWURF_ALTER_MS) {
                this.planEntwuerfe.delete(k);
            }
        }
        let ergebnis;
        try {
            ergebnis = await context.showForm(planFormular(planUrl(this.adapter.namespace, id, token)), {
                title: oberflaeche.alle('planTitel', { name }),
                buttons: ['apply', 'cancel'],
                maxWidth: 'xl',
                // die Seite bearbeitet den Entwurf, nicht die Formulardaten
                ignoreApplyDisabled: true,
            });
        } finally {
            this.planEntwuerfe.delete(token);
        }
        if (!ergebnis || !entwurf.geaendert) {
            return { refresh: false };
        }
        const sz = oberflaeche.szenen(this.adapter, id);
        const p = oberflaeche.programmZuPlan(entwurf.programm, sz);
        if (p.fehler) {
            const grund = entwurf.programm.length
                ? Object.fromEntries(oberflaeche.SPRACHEN.map(l => [l, p.fehler]))
                : oberflaeche.TEXTE.planLeer;
            await context.showMessage(
                Object.fromEntries(
                    oberflaeche.SPRACHEN.map(l => [l, oberflaeche.t('planFehler', l, { grund: grund[l] })]),
                ),
            );
            return { refresh: false };
        }
        await this.schreiben(`${id}.regel.plan.wocheJson`, JSON.stringify(p.plan));
        await this.schreiben(
            `${id}.regel.plan.abwesenheitJson`,
            entwurf.abwesenheit ? JSON.stringify(entwurf.abwesenheit) : '',
        );
        if ((await oberflaeche.lies(this.adapter, `${id}.regel.plan.aktiv`)) !== true) {
            const frage = await context.showForm(
                {
                    type: 'panel',
                    items: {
                        frage: { type: 'staticText', text: oberflaeche.alle('planEinschaltenFrage', { name }), xs: 12 },
                    },
                },
                {
                    title: oberflaeche.alle('planTitel', { name }),
                    buttons: [
                        {
                            type: 'apply',
                            label: oberflaeche.TEXTE.planEinschalten,
                            variant: 'contained',
                            color: 'primary',
                        },
                        { type: 'cancel', label: oberflaeche.TEXTE.planNurSpeichern, variant: 'outlined' },
                    ],
                    ignoreApplyDisabled: true,
                },
            );
            if (frage) {
                await this.schreiben(`${id}.regel.plan.aktiv`, true);
            }
        }
        return { refresh: false };
    }

    /**
     * Inhalt des Details-Dialogs: Kennlinie mit Arbeitspunkt, Rechenweg als Liste, Verlauf der
     * Leistungsgrenze (24 h) und die Eckdaten (wer regelt, Szene, Fuehler mit Quelle).
     *
     * @param {string} id  Geraete-ID
     * @param {string} sprache  Sprache
     * @param {number} [jetzt]  Uhr (ms)
     * @returns {Promise<object>} Formular
     */
    async detailsFormular(id, sprache, jetzt = Date.now()) {
        const a = this.adapter;
        const t = (k, w) => oberflaeche.t(k, sprache, w);
        const lies = rel => oberflaeche.lies(a, `${id}.${rel}`);
        const A = oberflaeche.AMPEL;
        const punkt = await oberflaeche.arbeitspunkt(a, id);
        const k = oberflaeche.bedarfKonfig(a, id);
        const richtung = punkt.richtung || 'heizen';
        const kasten = 'border:1px solid rgba(128,128,128,0.35);border-radius:8px;padding:12px 14px;margin-bottom:12px';
        const titel = text =>
            `<div style="font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;opacity:0.7;margin-bottom:8px">${fest(text)}</div>`;
        const teile = [];
        if (punkt.probelauf) {
            teile.push(
                `<div style="border:1px solid ${A.warn};border-radius:8px;padding:8px 12px;margin-bottom:12px;background:rgba(217,138,0,0.12)">${fest(t('probeBanner'))}</div>`,
            );
        }
        teile.push(
            `<div style="${kasten}">${titel(t(richtung === 'kuehlen' ? 'kennlinieKuehlen' : 'kennlinieHeizen'))}` +
                `${oberflaeche.kennlinieSvg({ punkte: k[richtung], richtung, untergrenze: k.untergrenze, obergrenze: k.obergrenze, punkt, sprache, ohneTitel: true, breite: 720, hoehe: 300 })}</div>`,
        );
        // Rechenweg: die Begruendungen der Regelung, Schritt fuer Schritt
        const schritte = text =>
            String(text || '')
                .split(/\s·\s|\s\|\s|;\s/)
                .map(x => x.trim())
                .filter(Boolean);
        const liste = text =>
            schritte(text)
                .map(x => `<li style="margin:2px 0">${fest(x)}</li>`)
                .join('');
        const regelGrund = liste(await lies('regel.grund'));
        const bedarfGrund = liste(await lies('regel.bedarf.grund'));
        const ergebnis =
            punkt.wert !== null
                ? `<div style="display:inline-block;margin-top:8px;padding:4px 12px;border-radius:6px;background:currentColor"><span style="filter:invert(1) grayscale(1) contrast(9);font-weight:700">${fest(t(punkt.probelauf ? 'wuerdeSenden' : 'sendet', { p: kennlinienbild.zahl(punkt.wert) }))}</span></div>`
                : '';
        teile.push(
            `<div style="${kasten}">${titel(t('rechenweg'))}` +
                `<ul style="margin:0;padding-left:18px">${regelGrund}</ul>${
                    bedarfGrund
                        ? `<div style="margin-top:10px;font-weight:600">${fest(t('grenze'))}</div><ul style="margin:4px 0 0;padding-left:18px">${bedarfGrund}</ul>`
                        : ''
                }${ergebnis}</div>`,
        );
        let verlauf = [];
        try {
            verlauf = JSON.parse((await lies('regel.verlaufJson')) || '[]');
        } catch {
            verlauf = [];
        }
        teile.push(
            `<div style="${kasten}">${titel(t('verlaufTitel'))}` +
                `${kennlinienbild.verlauf({ verlauf, jetzt, breite: 720, hoehe: 150, texte: { jetzt: t('jetzt'), stunde: t('stunde'), leer: t('verlaufLeer') } })}</div>`,
        );
        // Eckdaten
        const zeile = (label, wert) =>
            `<div style="display:flex;gap:12px;margin:3px 0"><div style="flex:0 0 150px;opacity:0.75">${fest(label)}</div><div>${wert}</div></div>`;
        const quelle = q => {
            const text = String(q || '');
            for (const [de, schluessel] of [
                ['BLE-Fühler am Modul', 'qBle'],
                ['Datenpunkt', 'qDp'],
                ['Fühler der Anlage', 'qIntern'],
            ]) {
                if (text === de) {
                    return t(schluessel);
                }
            }
            return text;
        };
        const fuehler = async (art, name, einheit) => {
            const v = await lies(`regel.fuehler.${art}`);
            const q = quelle(await lies(`regel.fuehler.${art}Quelle`));
            const wert = typeof v === 'number' ? `${kennlinienbild.zahl(v, 1)} ${einheit}` : t('fFehlt');
            return zeile(name, `${fest(wert)}${q ? ` <span style="opacity:0.75">· ${fest(q)}</span>` : ''}`);
        };
        const eck = [
            zeile(
                t('werRegelt'),
                fest(t((await lies('regel.betrieb')) === 'faikout' ? 'betriebFaikout' : 'betriebAdapter')),
            ),
        ];
        if ((await lies('regel.plan.aktiv')) === true) {
            const naechster = await lies('regel.plan.naechster');
            eck.push(zeile(t('szene'), fest((await lies('regel.plan.szene')) || t('keinPlan'))));
            if (typeof naechster === 'number' && naechster > 0) {
                const d = new Date(naechster);
                const tag =
                    d.toDateString() === new Date(jetzt).toDateString() ? '' : `${WOCHENTAGE[sprache][d.getDay()]} `;
                eck.push(
                    zeile(
                        t('naechste'),
                        fest(`${tag}${d.toTimeString().slice(0, 5)} ${(await lies('regel.plan.naechsteSzene')) || ''}`),
                    ),
                );
            }
        }
        eck.push(
            await fuehler('aussen', t('fAussen'), '°C'),
            await fuehler('raum', t('fRaum'), '°C'),
            await fuehler('feuchte', t('fFeuchte'), '%'),
        );
        teile.push(`<div>${eck.join('')}</div>`);
        return {
            type: 'panel',
            items: {
                inhalt: { type: 'staticText', format: 'html', text: teile.join(''), noTranslation: true, xs: 12 },
            },
        };
    }

    /**
     * Details-Dialog (nur Anzeige).
     *
     * @param {string} geraetId  Geraete-ID
     * @param {import('@iobroker/dm-utils').ActionContext} context  Kontext der Aktion
     * @returns {Promise<object>} Antwort an die Oberflaeche
     */
    async detailsDialog(geraetId, context) {
        const id = String(geraetId);
        const sprache = await oberflaeche.sprache(this.adapter);
        const name = await this.geraetName(id);
        await context.showForm(await this.detailsFormular(id, sprache), {
            title: oberflaeche.alle('detailsTitel', { name }),
            buttons: ['close'],
            maxWidth: 'md',
            ignoreApplyDisabled: true,
        });
        return { refresh: false };
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
     * Fehlerantwort an die Oberflaeche, zugleich als Warnung im Log.
     *
     * @param {string} message  Fehlertext
     * @returns {{error: {code: number, message: string}}} Fehlerantwort
     */
    fehler(message) {
        this.adapter.log.warn(`Device manager: ${message}`);
        return { error: { code: 400, message } };
    }
}

module.exports = {
    FaikoutDeviceManagement,
    MODUS_TEXTE,
    LUEFTER_TEXTE,
    TAETIGKEIT_TEXTE,
    TEXTE,
    BETRIEBSART_TEXTE,
    STUFEN_TOOLTIP,
    WLAN_TEXTE,
    STUFEN_SYMBOL,
    BALKEN_STUFEN,
    UMSCHALTEN,
    WOCHENPLAN,
    DETAILS,
    REGEL_SCHALTER,
    REGEL_SYMBOL,
    WOCHENTAGE,
    zahlZeileHtml,
    regelKopfHtml,
    regelGrenzeHtml,
    regelPlanHtml,
    regelHandHtml,
    regelFuehlerHtml,
    regelKnoepfe,
    planFormular,
    planUrl,
};
