'use strict';

/*
 * Ablauf von "Module suchen" (Reiter in den Instanzeinstellungen, per sendTo).
 *
 * Einmalig je Klick: mDNS-Anfrage (oder eine einzelne Adresse), dann je Kandidat ein GET auf
 * /revk-settings - hoechstens 4 gleichzeitig, je 2 s Zeitlimit. Keine Hintergrund- oder
 * Zeitplansuche, kein Bereichsscan. Formularwerte der Module werden nicht geloggt und nicht
 * gespeichert; die Ergebniszeilen landen in einem Feld mit "_"-Namen, das der Admin nicht speichert.
 */

const discovery = require('./discovery');

/** Hoechstens so viele mDNS-Kandidaten werden abgefragt (_http._tcp melden auch Drucker & Co.). */
const MAX_KANDIDATEN = 64;

/** Statustexte der Ergebnistabelle - alle elf Sprachen. */
const STATUS_TEXTE = {
    verbunden: {
        en: 'connected to this adapter',
        de: 'mit diesem Adapter verbunden',
        ru: 'подключён к этому адаптеру',
        pt: 'ligado a este adaptador',
        nl: 'verbonden met deze adapter',
        fr: 'connecté à cet adaptateur',
        it: 'collegato a questo adattatore',
        es: 'conectado a este adaptador',
        pl: 'połączony z tym adapterem',
        uk: 'підключено до цього адаптера',
        'zh-cn': '已连接到此适配器',
    },
    eingestellt: {
        en: 'set to this adapter, not connected',
        de: 'auf diesen Adapter eingestellt, nicht verbunden',
        ru: 'настроен на этот адаптер, не подключён',
        pt: 'configurado para este adaptador, não ligado',
        nl: 'ingesteld op deze adapter, niet verbonden',
        fr: 'réglé sur cet adaptateur, non connecté',
        it: 'impostato su questo adattatore, non collegato',
        es: 'configurado para este adaptador, no conectado',
        pl: 'ustawiony na ten adapter, niepołączony',
        uk: 'налаштовано на цей адаптер, не підключено',
        'zh-cn': '已设置为此适配器，未连接',
    },
    keinBroker: {
        en: 'no MQTT broker set',
        de: 'kein MQTT-Broker eingetragen',
        ru: 'MQTT-брокер не задан',
        pt: 'nenhum broker MQTT definido',
        nl: 'geen MQTT-broker ingesteld',
        fr: 'aucun broker MQTT défini',
        it: 'nessun broker MQTT impostato',
        es: 'ningún broker MQTT configurado',
        pl: 'brak ustawionego brokera MQTT',
        uk: 'MQTT-брокер не задано',
        'zh-cn': '未设置 MQTT 代理',
    },
    andererBroker: {
        en: 'other MQTT broker',
        de: 'anderer MQTT-Broker',
        ru: 'другой MQTT-брокер',
        pt: 'outro broker MQTT',
        nl: 'andere MQTT-broker',
        fr: 'autre broker MQTT',
        it: 'altro broker MQTT',
        es: 'otro broker MQTT',
        pl: 'inny broker MQTT',
        uk: 'інший MQTT-брокер',
        'zh-cn': '其他 MQTT 代理',
    },
    passwort: {
        en: 'settings protected by password',
        de: 'Einstellungen passwortgeschützt',
        ru: 'настройки защищены паролем',
        pt: 'definições protegidas por palavra-passe',
        nl: 'instellingen met wachtwoord beveiligd',
        fr: 'réglages protégés par mot de passe',
        it: 'impostazioni protette da password',
        es: 'ajustes protegidos con contraseña',
        pl: 'ustawienia chronione hasłem',
        uk: 'налаштування захищені паролем',
        'zh-cn': '设置受密码保护',
    },
    weblogin: {
        en: 'web login required (not checked)',
        de: 'Web-Login nötig (nicht geprüft)',
        ru: 'требуется веб-вход (не проверено)',
        pt: 'login web necessário (não verificado)',
        nl: 'weblogin vereist (niet gecontroleerd)',
        fr: 'connexion web requise (non vérifié)',
        it: 'accesso web richiesto (non verificato)',
        es: 'se requiere inicio de sesión web (no comprobado)',
        pl: 'wymagane logowanie WWW (nie sprawdzono)',
        uk: 'потрібен вебвхід (не перевірено)',
        'zh-cn': '需要网页登录（未检查）',
    },
    keinFaikout: {
        en: 'no faikout module at this address',
        de: 'unter dieser Adresse kein faikout-Modul',
        ru: 'по этому адресу нет модуля faikout',
        pt: 'nenhum módulo faikout neste endereço',
        nl: 'geen faikout-module op dit adres',
        fr: 'aucun module faikout à cette adresse',
        it: 'nessun modulo faikout a questo indirizzo',
        es: 'ningún módulo faikout en esta dirección',
        pl: 'brak modułu faikout pod tym adresem',
        uk: 'за цією адресою немає модуля faikout',
        'zh-cn': '此地址没有 faikout 模块',
    },
};

/** Zusammenfassungen fuer die Rueckmeldung am Knopf - alle elf Sprachen. */
const ERGEBNIS_TEXTE = {
    gefunden: {
        en: '{n} faikout module(s) found ({k} mDNS candidates checked).',
        de: '{n} faikout-Modul(e) gefunden ({k} mDNS-Kandidaten geprüft).',
        ru: 'Найдено модулей faikout: {n} (проверено кандидатов mDNS: {k}).',
        pt: '{n} módulo(s) faikout encontrado(s) ({k} candidatos mDNS verificados).',
        nl: '{n} faikout-module(s) gevonden ({k} mDNS-kandidaten gecontroleerd).',
        fr: '{n} module(s) faikout trouvé(s) ({k} candidats mDNS vérifiés).',
        it: '{n} modulo/i faikout trovato/i ({k} candidati mDNS verificati).',
        es: '{n} módulo(s) faikout encontrado(s) ({k} candidatos mDNS comprobados).',
        pl: 'Znaleziono moduły faikout: {n} (sprawdzono kandydatów mDNS: {k}).',
        uk: 'Знайдено модулів faikout: {n} (перевірено кандидатів mDNS: {k}).',
        'zh-cn': '找到 {n} 个 faikout 模块（已检查 {k} 个 mDNS 候选）。',
    },
    keiner: {
        en: '0 modules found. Is ioBroker running in Docker? The search (mDNS) does not get out of the container there – enter the address of the module under “Single address” and click “Check address”.',
        de: '0 Module gefunden. Läuft der ioBroker in Docker? Dort kommt die Suche (mDNS) nicht aus dem Container heraus – trage die Adresse des Moduls bei „Einzelne Adresse“ ein und klicke „Adresse prüfen“.',
        ru: 'Найдено модулей: 0. ioBroker работает в Docker? Там поиск (mDNS) не выходит за пределы контейнера – введите адрес модуля в поле «Отдельный адрес» и нажмите «Проверить адрес».',
        pt: '0 módulos encontrados. O ioBroker corre em Docker? Aí a pesquisa (mDNS) não sai do contentor – introduza o endereço do módulo em «Endereço individual» e clique em «Verificar endereço».',
        nl: '0 modules gevonden. Draait ioBroker in Docker? Daar komt de zoekopdracht (mDNS) niet uit de container – vul het adres van de module in bij “Eén adres” en klik op “Adres controleren”.',
        fr: '0 module trouvé. ioBroker tourne-t-il dans Docker ? La recherche (mDNS) ne sort alors pas du conteneur – saisissez l’adresse du module sous « Adresse unique » et cliquez sur « Vérifier l’adresse ».',
        it: '0 moduli trovati. ioBroker gira in Docker? Lì la ricerca (mDNS) non esce dal container – inserisci l’indirizzo del modulo in «Indirizzo singolo» e fai clic su «Verifica indirizzo».',
        es: '0 módulos encontrados. ¿ioBroker se ejecuta en Docker? Allí la búsqueda (mDNS) no sale del contenedor: introduce la dirección del módulo en «Dirección individual» y haz clic en «Comprobar dirección».',
        pl: 'Znaleziono 0 modułów. Czy ioBroker działa w Dockerze? Tam wyszukiwanie (mDNS) nie wychodzi poza kontener – wpisz adres modułu w polu „Pojedynczy adres” i kliknij „Sprawdź adres”.',
        uk: 'Знайдено модулів: 0. ioBroker працює в Docker? Там пошук (mDNS) не виходить за межі контейнера – введіть адресу модуля в полі «Окрема адреса» й натисніть «Перевірити адресу».',
        'zh-cn':
            '找到 0 个模块。ioBroker 是否运行在 Docker 中？在那里搜索（mDNS）无法离开容器——请在“单个地址”中输入模块地址，然后点击“检查地址”。',
    },
    adresseFehlt: {
        en: 'Enter an IP address or host name first.',
        de: 'Zuerst eine IP-Adresse oder einen Hostnamen eintragen.',
        ru: 'Сначала введите IP-адрес или имя хоста.',
        pt: 'Introduza primeiro um endereço IP ou nome de host.',
        nl: 'Voer eerst een IP-adres of hostnaam in.',
        fr: 'Saisissez d’abord une adresse IP ou un nom d’hôte.',
        it: 'Inserisci prima un indirizzo IP o un nome host.',
        es: 'Introduce primero una dirección IP o un nombre de host.',
        pl: 'Najpierw wpisz adres IP lub nazwę hosta.',
        uk: 'Спочатку введіть IP-адресу або ім’я хоста.',
        'zh-cn': '请先输入 IP 地址或主机名。',
    },
    dockerHinweis: {
        en: 'Only Docker addresses found ({a}). Enter the address of the Docker host under which the modules reach the broker port.',
        de: 'Nur Docker-Adressen gefunden ({a}). Die Adresse des Docker-Hosts eintragen, unter der die Module den Broker-Port erreichen.',
        ru: 'Найдены только адреса Docker ({a}). Укажите адрес хоста Docker, по которому модули достигают порта брокера.',
        pt: 'Apenas endereços Docker encontrados ({a}). Introduza o endereço do host Docker pelo qual os módulos alcançam a porta do broker.',
        nl: 'Alleen Docker-adressen gevonden ({a}). Voer het adres van de Docker-host in waarop de modules de brokerpoort bereiken.',
        fr: 'Seules des adresses Docker trouvées ({a}). Saisissez l’adresse de l’hôte Docker par laquelle les modules atteignent le port du broker.',
        it: 'Trovati solo indirizzi Docker ({a}). Inserisci l’indirizzo dell’host Docker tramite cui i moduli raggiungono la porta del broker.',
        es: 'Solo se encontraron direcciones de Docker ({a}). Introduce la dirección del host Docker por la que los módulos alcanzan el puerto del broker.',
        pl: 'Znaleziono tylko adresy Dockera ({a}). Wpisz adres hosta Dockera, pod którym moduły osiągają port brokera.',
        uk: 'Знайдено лише адреси Docker ({a}). Вкажіть адресу хоста Docker, за якою модулі досягають порту брокера.',
        'zh-cn': '只找到 Docker 地址（{a}）。请填写 Docker 主机的地址，模块通过该地址访问代理端口。',
    },
    adressenErkannt: {
        en: 'Addresses of this host: {a}',
        de: 'Adressen dieses Rechners: {a}',
        ru: 'Адреса этого хоста: {a}',
        pt: 'Endereços deste host: {a}',
        nl: 'Adressen van deze host: {a}',
        fr: 'Adresses de cet hôte : {a}',
        it: 'Indirizzi di questo host: {a}',
        es: 'Direcciones de este host: {a}',
        pl: 'Adresy tego hosta: {a}',
        uk: 'Адреси цього хоста: {a}',
        'zh-cn': '本机地址：{a}',
    },
};

/**
 * Text in der gewuenschten Sprache, Rueckfall Englisch.
 *
 * @param {Record<string, string>} eintrag Uebersetzungen
 * @param {string} sprache Sprachkuerzel
 * @param {Record<string, string|number>} [werte] Platzhalter {name}
 * @returns {string} Text
 */
function text(eintrag, sprache, werte = {}) {
    const t = (eintrag && (eintrag[sprache] || eintrag.en)) || '';
    return t.replace(/\{(\w+)\}/g, (_, k) => String(werte[k] ?? ''));
}

/**
 * Firmware-Anzeige: "tcl-ea64592 (S3-MINI-N4-R2)".
 *
 * @param {object} fp Fingerprint
 * @returns {string} Anzeige
 */
function firmwareText(fp) {
    if (!fp || !fp.version) {
        return '';
    }
    return fp.hardware ? `${fp.version} (${fp.hardware})` : fp.version;
}

/**
 * Eine Ergebniszeile fuer die Tabelle.
 *
 * @param {object} fp Fingerprint (discovery.fingerprint)
 * @param {{code: string, geraet?: string}} st Status (discovery.statusBestimmen)
 * @param {string} sprache Sprachkuerzel
 * @param {string} [mdnsName] Name aus der mDNS-Ankuendigung
 * @returns {{name: string, ip: string, firmware: string, status: string, code: string}} Zeile
 */
function zeile(fp, st, sprache, mdnsName) {
    let status = text(STATUS_TEXTE[st.code] || STATUS_TEXTE.keinFaikout, sprache);
    if (st.geraet) {
        status += ` (${st.geraet})`;
    }
    const name =
        fp.titel && fp.hostname && fp.titel !== fp.hostname
            ? `${fp.titel} / ${fp.hostname}`
            : fp.titel || fp.hostname || mdnsName || '';
    return { name, ip: fp.adresse, firmware: firmwareText(fp), status, code: st.code };
}

/**
 * Sucht Module (mDNS) oder prueft eine einzelne Adresse.
 *
 * @param {object} opt Optionen
 * @param {string} [opt.ziel] einzelne IP/Hostname; leer = mDNS-Suche
 * @param {string[]} opt.adressen Adressen dieses Adapters (fuer "verbunden/anderer Broker")
 * @param {number} opt.port Broker-Port
 * @param {Array<{name: string, modulId?: string|null, verbunden?: boolean}>} opt.geraete Geraete des Adapters
 * @param {string} [opt.sprache] Sprachkuerzel
 * @param {object} [opt.timer] Zeitgeber des Adapters
 * @param {typeof discovery.mdnsSuchen} [opt.mdnsSuchen] fuer Tests
 * @param {typeof discovery.fingerprint} [opt.fingerprint] fuer Tests
 * @returns {Promise<{zeilen: object[], fingerprints: object[], text: string, kandidaten: number}>} Ergebnis
 */
async function suchen(opt) {
    const sprache = opt.sprache || 'en';
    const fpFn = opt.fingerprint || discovery.fingerprint;
    let kandidaten;
    const einzel = String(opt.ziel || '').trim();
    if (einzel) {
        kandidaten = [{ ip: einzel, name: '' }];
    } else {
        const m = await (opt.mdnsSuchen || discovery.mdnsSuchen)({ dauerMs: 3000, timer: opt.timer });
        kandidaten = m.kandidaten.slice(0, MAX_KANDIDATEN);
    }
    const fps = await discovery.begrenzt(kandidaten, 4, k => fpFn(k.ip, { timeoutMs: 2000, timer: opt.timer }));
    const ctx = { adressen: opt.adressen, port: opt.port, geraete: opt.geraete };
    const zeilen = [];
    const fingerprints = [];
    fps.forEach((fp, i) => {
        // Fremde Geraete der mDNS-Suche bleiben unsichtbar; eine eingetippte Adresse bekommt immer Antwort.
        if (!fp.faikout && fp.art !== 'weblogin' && !einzel) {
            return;
        }
        const st = discovery.statusBestimmen(fp, ctx);
        zeilen.push(zeile(fp, st.code === 'fremd' ? { code: 'keinFaikout' } : st, sprache, kandidaten[i].name));
        if (fp.faikout || fp.art === 'weblogin') {
            fingerprints.push({ ...fp, status: st.code });
        }
    });
    const n = fingerprints.length;
    let t;
    if (einzel) {
        t = zeilen.map(z => `${z.ip}: ${z.status}`).join('\n');
    } else {
        t = n
            ? text(ERGEBNIS_TEXTE.gefunden, sprache, { n, k: kandidaten.length })
            : text(ERGEBNIS_TEXTE.keiner, sprache);
    }
    return { zeilen, fingerprints, text: t, kandidaten: kandidaten.length };
}

module.exports = { suchen, zeile, text, firmwareText, STATUS_TEXTE, ERGEBNIS_TEXTE, MAX_KANDIDATEN };
