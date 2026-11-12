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

/** Betriebsarten zum Waehlen - ohne "Aus": Ausschalten geht nur ueber den Ein/Aus-Umschalter. */
const BETRIEBSART_TEXTE = Object.fromEntries(Object.entries(MODUS_TEXTE).filter(([w]) => w !== 'off'));

/** Kurze Knopftexte der Sonderstufen. */
const STUFEN_KNOPF = {
    auto: {
        en: 'Auto',
        de: 'Auto',
        ru: 'Авто',
        pt: 'Auto',
        nl: 'Auto',
        fr: 'Auto',
        it: 'Auto',
        es: 'Auto',
        pl: 'Auto',
        uk: 'Авто',
        'zh-cn': '自动',
    },
    night: {
        en: 'Quiet',
        de: 'Leise',
        ru: 'Тихий',
        pt: 'Silencioso',
        nl: 'Stil',
        fr: 'Silencieux',
        it: 'Silenzioso',
        es: 'Silencioso',
        pl: 'Cichy',
        uk: 'Тихий',
        'zh-cn': '静音',
    },
};

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
 * Die Spalten stehen enger als ueblich (innerStyle), sonst passen sieben Knoepfe nicht in die Karte.
 *
 * @param {string} oid  volle ID von control.fan
 * @returns {object} JSON-Config-Panel
 */
function luefterStufen(oid) {
    const items = {};
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
    for (const wert of ['auto', 'night']) {
        const ist = `_states.v?.val === '${wert}'`;
        const stil = {
            minWidth: 0,
            width: '100%',
            height: 30,
            padding: '0 4px',
            textTransform: 'none',
            boxShadow: 'none',
            whiteSpace: 'nowrap',
        };
        const gemeinsam = {
            falseText: STUFEN_KNOPF[wert],
            falseTextStyle: stil,
            xs: 3,
            // unten buendig mit den Balken
            style: { display: 'flex', alignItems: 'flex-end', height: 36 },
        };
        knopf(`${wert}On`, wert, `!(${ist})`, { ...gemeinsam, variant: 'contained' });
        knopf(`${wert}Off`, wert, ist, { ...gemeinsam, variant: 'outlined' });
    }
    const liste = JSON.stringify(BALKEN_STUFEN).replace(/"/g, "'");
    BALKEN_STUFEN.forEach((wert, i) => {
        // gefuellt, wenn die eingestellte Stufe mindestens diese ist
        const voll = `${liste}.indexOf(_states.v?.val) >= ${i}`;
        const stil = farbe => ({
            minWidth: 0,
            width: '100%',
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
            xs: 1,
            style: { display: 'flex', alignItems: 'flex-end', height: 36 },
        };
        knopf(`step${i + 1}On`, wert, `!(${voll})`, { ...gemeinsam, falseTextStyle: stil(BALKEN_VOLL) });
        knopf(`step${i + 1}Off`, wert, voll, { ...gemeinsam, falseTextStyle: stil(BALKEN_LEER) });
    });
    return { type: 'panel', xs: 12, innerStyle: { '--Grid-columnSpacing': '6px' }, items };
}

/**
 * Die Bedienelemente des Bedien-Dialogs (Knopf unten rechts auf der Karte). Nur Felder, die es
 * als beschreibbaren Datenpunkt gibt. `art` legt fest, wie der eingehende Wert geprueft wird.
 *
 * Ein/Aus steht bewusst NICHT im Dialog: Ein Schalter dort schaltet ohne Rueckfrage. Ein/Aus
 * ist der Umschalter in der Statuszeile (Aktion powerToggle) und fragt vorher nach.
 */
const BEDIENUNG = [
    // Betriebsart ohne "Aus" (siehe fields.selectedMode); ausgeschaltet wird nur ueber Ein/Aus.
    { feld: 'selectedMode', art: 'auswahl', texte: BETRIEBSART_TEXTE, label: 'mode' },
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

        // Kein Hersteller: Der Adapter kennt nur Daikin-Anlagen, die Zeile sagte nichts (Nutzerwunsch).
        const info = {
            id,
            identifier: (obj.native && obj.native.faikoutName) || id,
            name,
            icon: 'airCondition',
            connectionType: 'wifi',
            status,
            controls: this.bedienelemente(id, punkte),
            customInfo: { id, schema: this.kartenSchema(id, punkte) },
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
     * Wert eines Bedienelements fuer den Bedien-Dialog. Der Admin fragt ihn bei jeder Aenderung
     * des Datenpunkts ab (dm:deviceControlState). Ohne diese Funktion warnt dm-utils jedes Mal
     * "Device get state ... is disabled because it has no handler" und der Dialog bleibt stehen.
     *
     * @param {string} geraetId   Geraete-ID
     * @param {string} controlId  Feldname
     * @returns {Promise<object>} Zustand des Datenpunkts oder Fehler
     */
    async zustandLesen(geraetId, controlId) {
        if (!BEDIENUNG.some(b => b.feld === controlId)) {
            return { error: { code: 404, message: `Unknown control ${controlId}` } };
        }
        const st = await this.adapter.getStateAsync(feldId(String(geraetId), controlId));
        return st || { error: { code: 404, message: `No value for ${geraetId}/${controlId}` } };
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
        zeile('fan', feldId(id, 'fan'), feldName('fan'), auswahl(LUEFTER_TEXTE));
        if (beschreibbar(feldId(id, 'fan'))) {
            items.fanSteps = luefterStufen(`${ns}.${feldId(id, 'fan')}`);
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
                label: feldName(b.label || b.feld),
                stateId: `${ns}.${rel}`,
                handler: (geraetId, controlId, wert) => this.bedienen(geraetId, controlId, wert),
                getStateHandler: (geraetId, controlId) => this.zustandLesen(geraetId, controlId),
            };
            if (b.art === 'auswahl') {
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
     * @param {string} controlId  Feldname (mode, target, fan)
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

module.exports = {
    FaikoutDeviceManagement,
    MODUS_TEXTE,
    LUEFTER_TEXTE,
    TAETIGKEIT_TEXTE,
    TEXTE,
    BEDIENUNG,
    BETRIEBSART_TEXTE,
    STUFEN_KNOPF,
    BALKEN_STUFEN,
    UMSCHALTEN,
    zahlZeileHtml,
};
