'use strict';

/*
 * Module anbinden (Reiter "Module suchen", Stufe 2): stellt `mqtthost` EINES Moduls auf diesen
 * Adapter um - nie ohne Klick je Modul, keine Sammelaktion.
 *
 * Ablauf:
 *  1. "Pruefen": frischer Fingerprint der gewaehlten IP, Vorschau (Hostname, IP, Firmware,
 *     MQTT host alt -> neu, mit Anmeldung auch mqttuser alt -> neu; das Passwort nie). Die gelesenen
 *     Werte bleiben als Plan im Speicher des Adapters. Steht mqtthost schon auf diesem Adapter, fehlt
 *     aber die Anmeldung (anderer mqttuser, oder gleicher und das Modul haengt nicht am Broker), wird
 *     dasselbe als "Zugangsdaten uebertragen" angeboten (plan.nurZugang).
 *  2. "Anbinden" (Rueckfrage im Admin; bei anderem Broker zusaetzlich ein Haken): unmittelbar
 *     vorher NOCHMAL ein Fingerprint derselben IP - weicht er vom Plan ab, wird abgebrochen.
 *     Dann EIN POST an /revk-settings: [password=<Settings-Passwort>,] mqtthost=<Adresse>:<Port>
 *     [, mqttuser/mqttpass aus dem Adapter], _reboot=Reboot. Danach Erfolgskontrolle: Das Modul
 *     muss sich binnen 90 s unter seinem Hostnamen am Broker melden.
 *  3. "Zurueckstellen": schreibt den vorher gelesenen alten mqtthost (und ggf. mqttuser) zurueck.
 *     Ein altes MQTT-Passwort ist nicht rueckholbar (die Seite zeigt nur einen Platzhalter) -
 *     deshalb wird mqttpass nur angefasst, wenn der Adapter selbst einen Benutzer hat, und dann
 *     gewarnt.
 *
 * Bewusst NICHT: mqtthost2 (zweiter Broker), OTA/otahost/_upgrade, irgendein anderes Feld.
 * Das Settings-Passwort wird nur fuer den einen Aufruf benutzt - nie gespeichert, nie geloggt.
 * Ein Feld `password` wird NUR gesendet, wenn die Seite danach gefragt hat: An ein ungeschuetztes
 * Modul geschickt, wuerde es sonst als neues Settings-Passwort gespeichert.
 */

const discovery = require('./discovery');

/** So lange darf das Modul nach dem Neustart brauchen, bis es sich am Broker meldet. */
const ERFOLG_MS = 90 * 1000;

/** Ein Plan aus "Pruefen" gilt so lange. */
const PLAN_MS = 10 * 60 * 1000;

/** Zeitlimit fuer den POST (das Modul antwortet, bevor es nach 3 s neu startet). */
const POST_MS = 8000;

/** Texte - alle elf Sprachen. Platzhalter {name}. */
const TEXTE = {
    vorschau: {
        en: 'Module “{name}” ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nThe module restarts after saving.',
        de: 'Modul „{name}“ ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nDas Modul startet nach dem Speichern neu.',
        ru: 'Модуль «{name}» ({ip})\nПрошивка: {firmware}\nMQTT host: {alt} → {neu}{user}\nПосле сохранения модуль перезапустится.',
        pt: 'Módulo «{name}» ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nO módulo reinicia depois de guardar.',
        nl: 'Module “{name}” ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nDe module herstart na het opslaan.',
        fr: 'Module « {name} » ({ip})\nFirmware : {firmware}\nMQTT host : {alt} → {neu}{user}\nLe module redémarre après l’enregistrement.',
        it: 'Modulo «{name}» ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nIl modulo si riavvia dopo il salvataggio.',
        es: 'Módulo «{name}» ({ip})\nFirmware: {firmware}\nMQTT host: {alt} → {neu}{user}\nEl módulo se reinicia después de guardar.',
        pl: 'Moduł „{name}” ({ip})\nOprogramowanie: {firmware}\nMQTT host: {alt} → {neu}{user}\nModuł uruchomi się ponownie po zapisaniu.',
        uk: 'Модуль «{name}» ({ip})\nПрошивка: {firmware}\nMQTT host: {alt} → {neu}{user}\nПісля збереження модуль перезапуститься.',
        'zh-cn': '模块“{name}”（{ip}）\n固件：{firmware}\nMQTT host：{alt} → {neu}{user}\n保存后模块将重启。',
    },
    leer: {
        en: '(empty)',
        de: '(leer)',
        ru: '(пусто)',
        pt: '(vazio)',
        nl: '(leeg)',
        fr: '(vide)',
        it: '(vuoto)',
        es: '(vacío)',
        pl: '(puste)',
        uk: '(порожньо)',
        'zh-cn': '（空）',
    },
    userZeile: {
        en: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: is set from this adapter (not shown; the old password cannot be read back)',
        de: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: wird aus diesem Adapter gesetzt (nicht angezeigt; das alte Passwort ist nicht rücklesbar)',
        ru: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: задаётся из этого адаптера (не отображается; старый пароль нельзя прочитать)',
        pt: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: é definida a partir deste adaptador (não é mostrada; a palavra-passe antiga não pode ser lida)',
        nl: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: wordt vanuit deze adapter ingesteld (niet getoond; het oude wachtwoord kan niet worden teruggelezen)',
        fr: '\nmqttuser : {userAlt} → {userNeu}\nmqttpass : défini depuis cet adaptateur (non affiché ; l’ancien mot de passe ne peut pas être relu)',
        it: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: viene impostata da questo adattatore (non mostrata; la vecchia password non è rileggibile)',
        es: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: se establece desde este adaptador (no se muestra; la contraseña anterior no se puede volver a leer)',
        pl: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: ustawiane z tego adaptera (nie jest wyświetlane; starego hasła nie da się odczytać)',
        uk: '\nmqttuser: {userAlt} → {userNeu}\nmqttpass: задається з цього адаптера (не відображається; старий пароль неможливо прочитати)',
        'zh-cn': '\nmqttuser：{userAlt} → {userNeu}\nmqttpass：由此适配器设置（不显示；旧密码无法读回）',
    },
    nurZugang: {
        en: '\nThe module is already set to this adapter – only the MQTT credentials are transferred.',
        de: '\nDas Modul ist schon auf diesen Adapter eingestellt – es werden nur die MQTT-Zugangsdaten übertragen.',
        ru: '\nМодуль уже настроен на этот адаптер – передаются только учётные данные MQTT.',
        pt: '\nO módulo já está configurado para este adaptador – só são transferidas as credenciais MQTT.',
        nl: '\nDe module is al op deze adapter ingesteld – alleen de MQTT-inloggegevens worden overgedragen.',
        fr: '\nLe module est déjà réglé sur cet adaptateur – seuls les identifiants MQTT sont transmis.',
        it: '\nIl modulo è già impostato su questo adattatore – vengono trasferite solo le credenziali MQTT.',
        es: '\nEl módulo ya está configurado para este adaptador: solo se transfieren las credenciales MQTT.',
        pl: '\nModuł jest już ustawiony na ten adapter – przesyłane są tylko dane logowania MQTT.',
        uk: '\nМодуль уже налаштовано на цей адаптер – передаються лише облікові дані MQTT.',
        'zh-cn': '\n该模块已设置为此适配器，仅传输 MQTT 登录凭据。',
    },
    andererHinweis: {
        en: '\nATTENTION: the module currently uses another MQTT broker. It will no longer report there.',
        de: '\nACHTUNG: Das Modul nutzt derzeit einen anderen MQTT-Broker. Dort meldet es sich danach nicht mehr.',
        ru: '\nВНИМАНИЕ: модуль сейчас использует другой MQTT-брокер. Туда он больше не будет отправлять данные.',
        pt: '\nATENÇÃO: o módulo usa atualmente outro broker MQTT. Deixará de comunicar com ele.',
        nl: '\nLET OP: de module gebruikt nu een andere MQTT-broker. Daar meldt hij zich daarna niet meer.',
        fr: '\nATTENTION : le module utilise actuellement un autre broker MQTT. Il ne s’y signalera plus.',
        it: '\nATTENZIONE: il modulo usa attualmente un altro broker MQTT. Non vi invierà più dati.',
        es: '\nATENCIÓN: el módulo usa actualmente otro broker MQTT. Dejará de informar allí.',
        pl: '\nUWAGA: moduł używa obecnie innego brokera MQTT. Potem nie będzie się już tam zgłaszał.',
        uk: '\nУВАГА: модуль зараз використовує інший MQTT-брокер. Туди він більше не надсилатиме дані.',
        'zh-cn': '\n注意：该模块当前使用另一个 MQTT 代理，之后将不再向其上报。',
    },
    erfolg: {
        en: 'Module “{name}” is connected to this adapter ({s} s after saving).',
        de: 'Modul „{name}“ ist mit diesem Adapter verbunden ({s} s nach dem Speichern).',
        ru: 'Модуль «{name}» подключён к этому адаптеру ({s} с после сохранения).',
        pt: 'O módulo «{name}» está ligado a este adaptador ({s} s depois de guardar).',
        nl: 'Module “{name}” is verbonden met deze adapter ({s} s na het opslaan).',
        fr: 'Le module « {name} » est connecté à cet adaptateur ({s} s après l’enregistrement).',
        it: 'Il modulo «{name}» è collegato a questo adattatore ({s} s dopo il salvataggio).',
        es: 'El módulo «{name}» está conectado a este adaptador ({s} s después de guardar).',
        pl: 'Moduł „{name}” jest połączony z tym adapterem ({s} s po zapisaniu).',
        uk: 'Модуль «{name}» підключено до цього адаптера ({s} с після збереження).',
        'zh-cn': '模块“{name}”已连接到此适配器（保存后 {s} 秒）。',
    },
    zeitueberschreitung: {
        en: 'Module “{name}” has not connected within {s} s. Check the address and port (Docker port mapping, firewall) – or use “Restore”.',
        de: 'Modul „{name}“ hat sich nicht binnen {s} s gemeldet. Adresse und Port prüfen (Docker-Portmapping, Firewall) – oder „Zurückstellen“.',
        ru: 'Модуль «{name}» не подключился за {s} с. Проверьте адрес и порт (проброс порта Docker, брандмауэр) – или нажмите «Вернуть».',
        pt: 'O módulo «{name}» não se ligou em {s} s. Verifique o endereço e a porta (mapeamento de portas Docker, firewall) – ou use «Repor».',
        nl: 'Module “{name}” heeft zich niet binnen {s} s gemeld. Controleer adres en poort (Docker-poorttoewijzing, firewall) – of gebruik “Terugzetten”.',
        fr: 'Le module « {name} » ne s’est pas connecté en {s} s. Vérifiez l’adresse et le port (mappage de port Docker, pare-feu) – ou utilisez « Restaurer ».',
        it: 'Il modulo «{name}» non si è collegato entro {s} s. Controlla indirizzo e porta (mappatura porte Docker, firewall) – oppure usa «Ripristina».',
        es: 'El módulo «{name}» no se ha conectado en {s} s. Comprueba la dirección y el puerto (asignación de puertos de Docker, cortafuegos) o usa «Restaurar».',
        pl: 'Moduł „{name}” nie połączył się w ciągu {s} s. Sprawdź adres i port (mapowanie portów Dockera, zapora) – lub użyj „Przywróć”.',
        uk: 'Модуль «{name}» не підключився за {s} с. Перевірте адресу та порт (зіставлення портів Docker, брандмауер) – або натисніть «Повернути».',
        'zh-cn': '模块“{name}”在 {s} 秒内未上报。请检查地址和端口（Docker 端口映射、防火墙），或使用“还原”。',
    },
    zurueck: {
        en: 'Module “{name}” restored to MQTT host {alt}. It restarts now.',
        de: 'Modul „{name}“ auf MQTT host {alt} zurückgestellt. Es startet jetzt neu.',
        ru: 'Модуль «{name}» возвращён на MQTT host {alt}. Сейчас он перезапустится.',
        pt: 'Módulo «{name}» reposto para MQTT host {alt}. Reinicia agora.',
        nl: 'Module “{name}” teruggezet naar MQTT host {alt}. Hij herstart nu.',
        fr: 'Module « {name} » restauré sur MQTT host {alt}. Il redémarre maintenant.',
        it: 'Modulo «{name}» ripristinato su MQTT host {alt}. Ora si riavvia.',
        es: 'Módulo «{name}» restaurado a MQTT host {alt}. Se reinicia ahora.',
        pl: 'Moduł „{name}” przywrócony do MQTT host {alt}. Uruchamia się ponownie.',
        uk: 'Модуль «{name}» повернуто на MQTT host {alt}. Зараз він перезапуститься.',
        'zh-cn': '模块“{name}”已还原为 MQTT host {alt}，现在重启。',
    },
    passwortWarnung: {
        en: ' The old MQTT password could not be read back – enter it again on the module.',
        de: ' Das alte MQTT-Passwort war nicht rücklesbar – bitte am Modul neu eintragen.',
        ru: ' Старый пароль MQTT нельзя было прочитать – введите его в модуле заново.',
        pt: ' A palavra-passe MQTT antiga não pôde ser lida – introduza-a novamente no módulo.',
        nl: ' Het oude MQTT-wachtwoord kon niet worden teruggelezen – voer het opnieuw in op de module.',
        fr: ' L’ancien mot de passe MQTT n’a pas pu être relu – saisissez-le à nouveau sur le module.',
        it: ' La vecchia password MQTT non era rileggibile – reinseriscila nel modulo.',
        es: ' La contraseña MQTT anterior no se pudo volver a leer: introdúcela de nuevo en el módulo.',
        pl: ' Starego hasła MQTT nie dało się odczytać – wpisz je ponownie w module.',
        uk: ' Старий пароль MQTT неможливо було прочитати – введіть його в модулі заново.',
        'zh-cn': ' 无法读回旧的 MQTT 密码，请在模块上重新输入。',
    },
    keinPlan: {
        en: 'Check the module first.',
        de: 'Zuerst das Modul prüfen.',
        ru: 'Сначала проверьте модуль.',
        pt: 'Verifique primeiro o módulo.',
        nl: 'Controleer eerst de module.',
        fr: 'Vérifiez d’abord le module.',
        it: 'Prima verifica il modulo.',
        es: 'Comprueba primero el módulo.',
        pl: 'Najpierw sprawdź moduł.',
        uk: 'Спочатку перевірте модуль.',
        'zh-cn': '请先检查模块。',
    },
    geaendert: {
        en: 'The module has changed since the check ({was}) – nothing was saved. Check again.',
        de: 'Das Modul hat sich seit der Prüfung verändert ({was}) – nichts gespeichert. Bitte neu prüfen.',
        ru: 'Модуль изменился после проверки ({was}) – ничего не сохранено. Проверьте снова.',
        pt: 'O módulo mudou desde a verificação ({was}) – nada foi guardado. Verifique novamente.',
        nl: 'De module is sinds de controle veranderd ({was}) – niets opgeslagen. Controleer opnieuw.',
        fr: 'Le module a changé depuis la vérification ({was}) – rien n’a été enregistré. Vérifiez à nouveau.',
        it: 'Il modulo è cambiato dalla verifica ({was}) – non è stato salvato nulla. Verifica di nuovo.',
        es: 'El módulo ha cambiado desde la comprobación ({was}): no se ha guardado nada. Comprueba de nuevo.',
        pl: 'Moduł zmienił się od sprawdzenia ({was}) – nic nie zapisano. Sprawdź ponownie.',
        uk: 'Модуль змінився після перевірки ({was}) – нічого не збережено. Перевірте знову.',
        'zh-cn': '自检查以来模块已发生变化（{was}），未保存任何内容。请重新检查。',
    },
    andererNichtBestaetigt: {
        en: 'The module uses another MQTT broker – confirm “Replace other broker” first.',
        de: 'Das Modul nutzt einen anderen MQTT-Broker – zuerst „Anderen Broker ersetzen“ bestätigen.',
        ru: 'Модуль использует другой MQTT-брокер – сначала подтвердите «Заменить другой брокер».',
        pt: 'O módulo usa outro broker MQTT – confirme primeiro «Substituir outro broker».',
        nl: 'De module gebruikt een andere MQTT-broker – bevestig eerst “Andere broker vervangen”.',
        fr: 'Le module utilise un autre broker MQTT – confirmez d’abord « Remplacer l’autre broker ».',
        it: 'Il modulo usa un altro broker MQTT – conferma prima «Sostituisci altro broker».',
        es: 'El módulo usa otro broker MQTT: confirma primero «Reemplazar otro broker».',
        pl: 'Moduł używa innego brokera MQTT – najpierw potwierdź „Zastąp inny broker”.',
        uk: 'Модуль використовує інший MQTT-брокер – спочатку підтвердьте «Замінити інший брокер».',
        'zh-cn': '该模块使用另一个 MQTT 代理，请先确认“替换其他代理”。',
    },
    passwortNoetig: {
        en: 'The settings of this module are protected – enter the settings password.',
        de: 'Die Einstellungen dieses Moduls sind geschützt – bitte das Settings-Passwort eingeben.',
        ru: 'Настройки этого модуля защищены – введите пароль настроек.',
        pt: 'As definições deste módulo estão protegidas – introduza a palavra-passe das definições.',
        nl: 'De instellingen van deze module zijn beveiligd – voer het instellingenwachtwoord in.',
        fr: 'Les réglages de ce module sont protégés – saisissez le mot de passe des réglages.',
        it: 'Le impostazioni di questo modulo sono protette – inserisci la password Settings.',
        es: 'Los ajustes de este módulo están protegidos: introduce la contraseña de Settings.',
        pl: 'Ustawienia tego modułu są chronione – wpisz hasło ustawień.',
        uk: 'Налаштування цього модуля захищені – введіть пароль налаштувань.',
        'zh-cn': '此模块的设置受保护，请输入 Settings 密码。',
    },
    weblogin: {
        en: 'This module requires a web login (web password). Remove the web password on the module or set the MQTT host by hand.',
        de: 'Dieses Modul verlangt einen Web-Login (Web password). Web-Passwort am Modul entfernen oder den MQTT host von Hand eintragen.',
        ru: 'Этот модуль требует веб-вход (Web password). Удалите веб-пароль в модуле или задайте MQTT host вручную.',
        pt: 'Este módulo exige login web (Web password). Remova a palavra-passe web no módulo ou defina o MQTT host manualmente.',
        nl: 'Deze module vereist een weblogin (Web password). Verwijder het webwachtwoord op de module of vul de MQTT host handmatig in.',
        fr: 'Ce module exige une connexion web (Web password). Supprimez le mot de passe web sur le module ou saisissez le MQTT host à la main.',
        it: 'Questo modulo richiede un accesso web (Web password). Rimuovi la password web sul modulo o imposta MQTT host a mano.',
        es: 'Este módulo requiere inicio de sesión web (Web password). Elimina la contraseña web en el módulo o introduce el MQTT host a mano.',
        pl: 'Ten moduł wymaga logowania w interfejsie WWW (Web password). Usuń hasło WWW w module lub wpisz MQTT host ręcznie.',
        uk: 'Цей модуль вимагає вебвходу (Web password). Видаліть вебпароль у модулі або задайте MQTT host вручну.',
        'zh-cn': '此模块需要网页登录（Web password）。请在模块上删除网页密码，或手动填写 MQTT host。',
    },
    keinModul: {
        en: 'No faikout module answers at {ip}.',
        de: 'Unter {ip} antwortet kein faikout-Modul.',
        ru: 'По адресу {ip} модуль faikout не отвечает.',
        pt: 'Nenhum módulo faikout responde em {ip}.',
        nl: 'Op {ip} antwoordt geen faikout-module.',
        fr: 'Aucun module faikout ne répond à {ip}.',
        it: 'Nessun modulo faikout risponde a {ip}.',
        es: 'Ningún módulo faikout responde en {ip}.',
        pl: 'Pod {ip} nie odpowiada żaden moduł faikout.',
        uk: 'За адресою {ip} модуль faikout не відповідає.',
        'zh-cn': '{ip} 上没有 faikout 模块应答。',
    },
    keineAdresse: {
        en: 'Enter the “Address for modules” first.',
        de: 'Zuerst die „Adresse für Module“ eintragen.',
        ru: 'Сначала укажите «Адрес для модулей».',
        pt: 'Introduza primeiro o «Endereço para módulos».',
        nl: 'Vul eerst het “Adres voor modules” in.',
        fr: 'Saisissez d’abord l’« Adresse pour les modules ».',
        it: 'Inserisci prima l’«Indirizzo per i moduli».',
        es: 'Introduce primero la «Dirección para los módulos».',
        pl: 'Najpierw wpisz „Adres dla modułów”.',
        uk: 'Спочатку вкажіть «Адресу для модулів».',
        'zh-cn': '请先填写“模块使用的地址”。',
    },
    schonHier: {
        en: 'Module “{name}” is already set to this adapter.',
        de: 'Modul „{name}“ ist schon auf diesen Adapter eingestellt.',
        ru: 'Модуль «{name}» уже настроен на этот адаптер.',
        pt: 'O módulo «{name}» já está configurado para este adaptador.',
        nl: 'Module “{name}” is al ingesteld op deze adapter.',
        fr: 'Le module « {name} » est déjà réglé sur cet adaptateur.',
        it: 'Il modulo «{name}» è già impostato su questo adattatore.',
        es: 'El módulo «{name}» ya está configurado para este adaptador.',
        pl: 'Moduł „{name}” jest już ustawiony na ten adapter.',
        uk: 'Модуль «{name}» уже налаштовано на цей адаптер.',
        'zh-cn': '模块“{name}”已设置为此适配器。',
    },
    keinRueckweg: {
        en: 'Nothing to restore for {ip} – “Restore” only works after “Connect” while the adapter keeps running.',
        de: 'Für {ip} gibt es nichts zurückzustellen – „Zurückstellen“ geht nur nach „Anbinden“, solange der Adapter läuft.',
        ru: 'Для {ip} нечего возвращать – «Вернуть» работает только после «Подключить», пока адаптер запущен.',
        pt: 'Nada a repor para {ip} – «Repor» só funciona depois de «Ligar» enquanto o adaptador estiver em execução.',
        nl: 'Voor {ip} valt niets terug te zetten – “Terugzetten” werkt alleen na “Koppelen” zolang de adapter draait.',
        fr: 'Rien à restaurer pour {ip} – « Restaurer » ne fonctionne qu’après « Connecter », tant que l’adaptateur tourne.',
        it: 'Niente da ripristinare per {ip} – «Ripristina» funziona solo dopo «Collega» finché l’adattatore è in esecuzione.',
        es: 'Nada que restaurar para {ip}: «Restaurar» solo funciona después de «Vincular» mientras el adaptador siga en marcha.',
        pl: 'Dla {ip} nie ma czego przywracać – „Przywróć” działa tylko po „Podłącz”, dopóki adapter działa.',
        uk: 'Для {ip} нічого повертати – «Повернути» працює лише після «Підключити», поки адаптер працює.',
        'zh-cn': '{ip} 没有可还原的内容——“还原”只在“连接”之后且适配器仍在运行时可用。',
    },
    modulFehler: {
        en: 'The module rejected the change: {fehler}',
        de: 'Das Modul hat die Änderung abgelehnt: {fehler}',
        ru: 'Модуль отклонил изменение: {fehler}',
        pt: 'O módulo rejeitou a alteração: {fehler}',
        nl: 'De module heeft de wijziging geweigerd: {fehler}',
        fr: 'Le module a refusé la modification : {fehler}',
        it: 'Il modulo ha rifiutato la modifica: {fehler}',
        es: 'El módulo rechazó el cambio: {fehler}',
        pl: 'Moduł odrzucił zmianę: {fehler}',
        uk: 'Модуль відхилив зміну: {fehler}',
        'zh-cn': '模块拒绝了更改：{fehler}',
    },
};

/**
 * Text in der gewuenschten Sprache, Rueckfall Englisch.
 *
 * @param {string} schluessel Eintrag in TEXTE
 * @param {string} sprache Sprachkuerzel
 * @param {Record<string, string|number>} [werte] Platzhalter
 * @returns {string} Text
 */
function t(schluessel, sprache, werte = {}) {
    const e = TEXTE[schluessel];
    return ((e && (e[sprache] || e.en)) || schluessel).replace(/\{(\w+)\}/g, (_, k) => String(werte[k] ?? ''));
}

/**
 * Formulardaten fuer den POST. Reihenfolge zaehlt: Das Settings-Passwort muss zuerst kommen
 * (settings_lib.c: das erste `password` meldet an, es wird nicht gespeichert).
 *
 * @param {object} f Felder
 * @param {string} [f.passwort] Settings-Passwort - nur wenn die Seite danach gefragt hat
 * @param {string} f.mqtthost neuer MQTT host
 * @param {string} [f.mqttuser] nur wenn er geaendert werden soll
 * @param {string} [f.mqttpass] nur wenn es geaendert werden soll (undefined = bleibt)
 * @returns {string} application/x-www-form-urlencoded
 */
function koerper(f) {
    const p = new URLSearchParams();
    if (f.passwort) {
        p.append('password', f.passwort);
    }
    p.append('mqtthost', f.mqtthost);
    if (f.mqttuser !== undefined) {
        p.append('mqttuser', f.mqttuser);
    }
    if (f.mqttpass !== undefined) {
        p.append('mqttpass', f.mqttpass);
    }
    p.append('_reboot', 'Reboot');
    return p.toString();
}

/**
 * Liest das Modul fuer Vorschau/Anbinden - per GET, bei Passwortschutz per Login-POST
 * (`password=` allein meldet nur an und speichert nichts).
 *
 * @param {string} ip Adresse
 * @param {string} [passwort] Settings-Passwort
 * @param {object} [opt] Optionen fuer discovery.seiteHolen
 * @returns {Promise<{fp: object, werte: Record<string, string>, fehler?: string}>} Fingerprint + Formularwerte
 */
async function lesen(ip, passwort, opt = {}) {
    let r = await discovery.seiteHolen(ip, { ...opt, methode: 'GET' });
    let fp = discovery.antwortAuswerten(ip, r);
    if (fp.faikout && fp.art === 'passwort' && passwort) {
        r = await discovery.seiteHolen(ip, {
            ...opt,
            methode: 'POST',
            koerper: new URLSearchParams({ password: passwort }).toString(),
        });
        const fehler = r.ok ? discovery.fehlerLesen(r.html) : '';
        if (fehler) {
            return { fp, werte: {}, fehler };
        }
        const mitLogin = discovery.antwortAuswerten(ip, r);
        if (mitLogin.faikout) {
            fp = { ...mitLogin, geschuetzt: true };
        }
    }
    const werte =
        fp.faikout && fp.art === 'seite' && r.html ? discovery.formularLesen(r.html, ['mqtthost', 'mqttuser']) : {};
    return { fp, werte };
}

/**
 * Plan fuer "Anbinden" aus einem frischen Lesen.
 *
 * @param {{fp: object, werte: Record<string, string>}} gelesen Ergebnis von lesen()
 * @param {object} ziel Zielwerte
 * @param {string} ziel.adresse Adresse fuer Module
 * @param {number} ziel.port Broker-Port
 * @param {string} [ziel.user] MQTT-Benutzer des Adapters (leer = Anmeldung am Modul unangetastet)
 * @param {string[]} ziel.eigeneAdressen Adressen dieses Adapters
 * @param {boolean} [ziel.verbunden] haengt das Modul gerade am Broker? (false = nein; fehlt = unbekannt)
 * @returns {object} Plan
 */
function planen(gelesen, ziel) {
    const { fp, werte } = gelesen;
    const neu = `${ziel.adresse}:${ziel.port}`;
    const st = discovery.statusBestimmen(fp, { adressen: ziel.eigeneAdressen, port: ziel.port, geraete: [] });
    // "Schon hier" heisst: es gibt nichts zu tun. Das stimmt nur, wenn auch die Anmeldung passt - der
    // Adapter verlangt keine (kein Benutzer), oder das Modul hat denselben mqttuser UND haengt am Broker.
    // Das Passwort am Modul ist nicht lesbar: gleicher Benutzer, aber nicht verbunden, heisst deshalb
    // "Passwort stimmt wohl nicht" - dann werden die Zugangsdaten angeboten (wer nachtraeglich
    // Benutzer/Passwort setzt, konnte sie sonst nicht an angebundene Module uebertragen).
    const hostGleich = String(werte.mqtthost || '').toLowerCase() === neu.toLowerCase();
    const zugangPasst = !ziel.user || ((werte.mqttuser ?? '') === ziel.user && ziel.verbunden !== false);
    return {
        ip: fp.adresse,
        revkId: fp.revkId || '',
        hostname: fp.hostname || '',
        titel: fp.titel || fp.hostname || '',
        version: fp.version || '',
        hardware: fp.hardware || '',
        geschuetzt: !!fp.geschuetzt,
        alt: { mqtthost: werte.mqtthost ?? '', mqttuser: werte.mqttuser ?? '' },
        neu: { mqtthost: neu, mqttuser: ziel.user ? ziel.user : undefined },
        anderer: st.code === 'andererBroker',
        schonHier: hostGleich && zugangPasst,
        // mqtthost stimmt schon, es fehlen nur Benutzer/Passwort ("Zugangsdaten uebertragen")
        nurZugang: hostGleich && !zugangPasst,
        zeit: Date.now(),
    };
}

/**
 * Vorschautext der Rueckfrage.
 *
 * @param {object} plan Plan aus planen()
 * @param {string} sprache Sprachkuerzel
 * @returns {string} Text
 */
function vorschau(plan, sprache) {
    const firmware = plan.hardware ? `${plan.version} (${plan.hardware})` : plan.version;
    let text = t('vorschau', sprache, {
        name: plan.titel,
        ip: plan.ip,
        firmware,
        alt: plan.alt.mqtthost || t('leer', sprache),
        neu: plan.neu.mqtthost,
        // Benutzer alt -> neu; das Passwort wird nie angezeigt
        user:
            plan.neu.mqttuser !== undefined
                ? t('userZeile', sprache, {
                      userAlt: plan.alt.mqttuser || t('leer', sprache),
                      userNeu: plan.neu.mqttuser,
                  })
                : '',
    });
    if (plan.nurZugang) {
        text += t('nurZugang', sprache);
    }
    if (plan.anderer) {
        text += t('andererHinweis', sprache);
    }
    return text;
}

/**
 * Vergleicht den frisch gelesenen Stand mit dem Plan aus "Pruefen".
 *
 * @param {object} plan Plan
 * @param {object} frisch Plan aus dem frischen Lesen
 * @returns {string} '' wenn gleich, sonst die abweichenden Angaben
 */
function abweichung(plan, frisch) {
    const felder = ['revkId', 'hostname', 'version'];
    const anders = felder.filter(f => plan[f] !== frisch[f]);
    if (plan.alt.mqtthost !== frisch.alt.mqtthost) {
        anders.push('mqtthost');
    }
    // Der alte Benutzer steht in der Vorschau und im Rueckweg, sobald der Adapter einen setzt
    if (plan.neu && plan.neu.mqttuser !== undefined && plan.alt.mqttuser !== frisch.alt.mqttuser) {
        anders.push('mqttuser');
    }
    return anders.join(', ');
}

/**
 * Wartet, bis `geschafft()` wahr ist, hoechstens `maxMs`.
 *
 * @param {() => boolean} geschafft Pruefung
 * @param {object} opt Optionen
 * @param {number} [opt.maxMs] Obergrenze
 * @param {number} [opt.schrittMs] Abstand der Pruefungen
 * @param {{setTimeout: (fn: () => void, ms: number) => unknown}} opt.timer Zeitgeber des Adapters
 * @param {() => boolean} [opt.abbruch] true = sofort aufhoeren (Adapter wird beendet)
 * @returns {Promise<boolean>} true bei Erfolg
 */
function warten(geschafft, opt) {
    const maxMs = opt.maxMs ?? ERFOLG_MS;
    const schrittMs = opt.schrittMs ?? 1000;
    const start = Date.now();
    return new Promise(resolve => {
        const runde = () => {
            if (geschafft()) {
                return resolve(true);
            }
            if ((opt.abbruch && opt.abbruch()) || Date.now() - start >= maxMs) {
                return resolve(false);
            }
            opt.timer.setTimeout(runde, schrittMs);
        };
        runde();
    });
}

/**
 * Schreibt per POST und wertet die Antwort aus.
 *
 * @param {string} ip Adresse
 * @param {string} daten Formulardaten aus koerper()
 * @param {object} [opt] Optionen fuer discovery.seiteHolen
 * @returns {Promise<{ok: boolean, fehler?: string}>} Ergebnis
 */
async function posten(ip, daten, opt = {}) {
    const r = await discovery.seiteHolen(ip, { timeoutMs: POST_MS, ...opt, methode: 'POST', koerper: daten });
    if (!r.ok) {
        return { ok: false, fehler: r.fehler };
    }
    if (r.status !== 200) {
        return { ok: false, fehler: `HTTP ${r.status}` };
    }
    const fehler = discovery.fehlerLesen(r.html);
    return fehler ? { ok: false, fehler } : { ok: true };
}

module.exports = {
    ERFOLG_MS,
    PLAN_MS,
    POST_MS,
    TEXTE,
    t,
    koerper,
    lesen,
    planen,
    vorschau,
    abweichung,
    warten,
    posten,
};
