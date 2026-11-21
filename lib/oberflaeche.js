'use strict';

/**
 * Bedienoberflaeche der Klimaregelung - alles, was Einstellungsseite und Geraetekarten vom Adapter
 * brauchen, ohne selbst zu regeln:
 *
 *  - Texte der Oberflaeche in allen elf Sprachen (TEXTE)
 *  - Antworten auf die sendTo-Nachrichten der Einstellungsseite: Geraeteliste, Kennlinienbild,
 *    "Was diese Anlage kann", Modul-Einstellungen lesen/pruefen/schreiben, Wochenplan-Seite
 *  - Umrechnung Wochenplan <-> Raster der Wochenplan-Seite (admin/wochenplan.html)
 *
 * Geregelt wird ausschliesslich in lib/regel. Diese Datei liest dort nur (Szenen, wirksame
 * Kennlinie) und schreibt nie einen Befehl an ein Modul. Modul-Einstellungen werden hier nur
 * GELESEN (GET /revk-settings?_page=N); das Schreiben uebernimmt eine Funktion des Adapters
 * (adapter.modulEinstellungenSchreiben), die es getrennt gibt - fehlt sie, sagt die Oberflaeche das.
 */

const http = require('node:http');
const discovery = require('./discovery');
const felder = require('./fields');
const kennlinie = require('./regel/kennlinie');
const wochenplan = require('./regel/wochenplan');
const bild = require('./kennlinienbild');
const moduleinstellungen = require('./moduleinstellungen');

const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/**
 * Text in allen elf Sprachen aus einer Liste in der Reihenfolge von SPRACHEN.
 *
 * @param {...string} t  en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn
 * @returns {Record<string, string>} Text je Sprache
 */
const L = (...t) => Object.fromEntries(SPRACHEN.map((s, i) => [s, t[i]]));

/** Alle Texte der Regelungs-Oberflaeche. Platzhalter in geschweiften Klammern. */
const TEXTE = {
    // ---- Geraetekarte
    regelung: L(
        'Control',
        'Regelung',
        'Регулирование',
        'Regulação',
        'Regeling',
        'Régulation',
        'Regolazione',
        'Regulación',
        'Regulacja',
        'Регулювання',
        '调节',
    ),
    zOk: L(
        'active',
        'aktiv',
        'активно',
        'ativa',
        'actief',
        'active',
        'attiva',
        'activa',
        'aktywna',
        'активне',
        '运行中',
    ),
    zHand: L(
        'manual override',
        'Handeingriff',
        'ручное вмешательство',
        'intervenção manual',
        'handmatige ingreep',
        'intervention manuelle',
        'intervento manuale',
        'intervención manual',
        'ingerencja ręczna',
        'ручне втручання',
        '手动干预',
    ),
    zGestoert: L(
        'fault',
        'gestört',
        'неисправность',
        'avaria',
        'storing',
        'défaut',
        'guasto',
        'avería',
        'usterka',
        'несправність',
        '故障',
    ),
    zOffline: L(
        'no connection',
        'keine Verbindung',
        'нет связи',
        'sem ligação',
        'geen verbinding',
        'pas de connexion',
        'nessuna connessione',
        'sin conexión',
        'brak połączenia',
        'немає зв’язку',
        '无连接',
    ),
    zAus: L(
        'switched off',
        'ausgeschaltet',
        'выключено',
        'desligada',
        'uitgeschakeld',
        'désactivée',
        'disattivata',
        'desactivada',
        'wyłączona',
        'вимкнено',
        '已关闭',
    ),
    probelauf: L(
        'Dry run',
        'Probelauf',
        'Пробный режим',
        'Modo de teste',
        'Proefloop',
        'Marche d’essai',
        'Funzionamento di prova',
        'Modo de prueba',
        'Tryb próbny',
        'Пробний режим',
        '试运行',
    ),
    grenze: L(
        'Power limit',
        'Leistungsgrenze',
        'Ограничение мощности',
        'Limite de potência',
        'Vermogensgrens',
        'Limite de puissance',
        'Limite di potenza',
        'Límite de potencia',
        'Limit mocy',
        'Обмеження потужності',
        '功率上限',
    ),
    nichtGesendet: L(
        'Dry run: not sent',
        'Probelauf: nicht gesendet',
        'Пробный режим: не отправлено',
        'Modo de teste: não enviado',
        'Proefloop: niet verzonden',
        'Marche d’essai : non envoyé',
        'Prova: non inviato',
        'Modo de prueba: no enviado',
        'Tryb próbny: nie wysłano',
        'Пробний режим: не надіслано',
        '试运行：未发送',
    ),
    nichtUnterstuetzt: L(
        'not supported by this unit',
        'von dieser Anlage nicht unterstützt',
        'не поддерживается этим устройством',
        'não suportado por este aparelho',
        'niet ondersteund door dit toestel',
        'non pris en charge par cet appareil',
        'non supportato da questo apparecchio',
        'no compatible con este equipo',
        'nieobsługiwane przez to urządzenie',
        'не підтримується цим пристроєм',
        '此设备不支持',
    ),
    grenzeAus: L(
        'not limited',
        'nicht begrenzt',
        'без ограничения',
        'sem limite',
        'niet begrensd',
        'non limitée',
        'non limitata',
        'sin límite',
        'bez limitu',
        'без обмеження',
        '不限制',
    ),
    szene: L('Scene', 'Szene', 'Сцена', 'Cenário', 'Scène', 'Scène', 'Scenario', 'Escena', 'Scena', 'Сцена', '场景'),
    naechste: L(
        'Next switch',
        'Nächste Schaltung',
        'Следующее переключение',
        'Próxima comutação',
        'Volgende schakeling',
        'Prochaine commutation',
        'Prossima commutazione',
        'Próxima conmutación',
        'Następne przełączenie',
        'Наступне перемикання',
        '下次切换',
    ),
    keinPlan: L(
        'no weekly schedule',
        'kein Wochenplan',
        'нет недельного расписания',
        'sem programa semanal',
        'geen weekschema',
        'pas de programme hebdomadaire',
        'nessun programma settimanale',
        'sin programa semanal',
        'brak harmonogramu tygodniowego',
        'немає тижневого розкладу',
        '无周计划',
    ),
    automatik: L(
        'Automation',
        'Automatik',
        'Автоматика',
        'Automatismo',
        'Automatiek',
        'Automatisme',
        'Automatismo',
        'Automatismo',
        'Automatyka',
        'Автоматика',
        '自动功能',
    ),
    tipBedarfAn: L(
        'Demand control is on – click to switch it off',
        'Bedarfsregelung ist an – Klick schaltet sie aus',
        'Регулирование по потребности включено – нажмите, чтобы выключить',
        'Regulação por necessidade ligada – clique para desligar',
        'Vraagregeling staat aan – klik om uit te schakelen',
        'Régulation selon le besoin active – cliquer pour la désactiver',
        'Regolazione in base al fabbisogno attiva – clic per disattivarla',
        'Regulación por demanda activada – clic para desactivarla',
        'Regulacja według zapotrzebowania włączona – kliknij, aby wyłączyć',
        'Регулювання за потребою увімкнено – натисніть, щоб вимкнути',
        '按需调节已开启 – 点击关闭',
    ),
    tipBedarfAus: L(
        'Demand control is off – click to switch it on',
        'Bedarfsregelung ist aus – Klick schaltet sie ein',
        'Регулирование по потребности выключено – нажмите, чтобы включить',
        'Regulação por necessidade desligada – clique para ligar',
        'Vraagregeling staat uit – klik om in te schakelen',
        'Régulation selon le besoin inactive – cliquer pour l’activer',
        'Regolazione in base al fabbisogno disattivata – clic per attivarla',
        'Regulación por demanda desactivada – clic para activarla',
        'Regulacja według zapotrzebowania wyłączona – kliknij, aby włączyć',
        'Регулювання за потребою вимкнено – натисніть, щоб увімкнути',
        '按需调节已关闭 – 点击开启',
    ),
    tipFeuchteAn: L(
        'Humidity control is on – click to switch it off',
        'Feuchteregelung ist an – Klick schaltet sie aus',
        'Регулирование влажности включено – нажмите, чтобы выключить',
        'Regulação de humidade ligada – clique para desligar',
        'Vochtregeling staat aan – klik om uit te schakelen',
        'Régulation d’humidité active – cliquer pour la désactiver',
        'Regolazione dell’umidità attiva – clic per disattivarla',
        'Regulación de humedad activada – clic para desactivarla',
        'Regulacja wilgotności włączona – kliknij, aby wyłączyć',
        'Регулювання вологості увімкнено – натисніть, щоб вимкнути',
        '湿度调节已开启 – 点击关闭',
    ),
    tipFeuchteAus: L(
        'Humidity control is off – click to switch it on',
        'Feuchteregelung ist aus – Klick schaltet sie ein',
        'Регулирование влажности выключено – нажмите, чтобы включить',
        'Regulação de humidade desligada – clique para ligar',
        'Vochtregeling staat uit – klik om in te schakelen',
        'Régulation d’humidité inactive – cliquer pour l’activer',
        'Regolazione dell’umidità disattivata – clic per attivarla',
        'Regulación de humedad desactivada – clic para activarla',
        'Regulacja wilgotności wyłączona – kliknij, aby włączyć',
        'Регулювання вологості вимкнено – натисніть, щоб увімкнути',
        '湿度调节已关闭 – 点击开启',
    ),
    tipPlanAn: L(
        'Weekly schedule is on – click to switch it off',
        'Wochenplan ist an – Klick schaltet ihn aus',
        'Недельное расписание включено – нажмите, чтобы выключить',
        'Programa semanal ligado – clique para desligar',
        'Weekschema staat aan – klik om uit te schakelen',
        'Programme hebdomadaire actif – cliquer pour le désactiver',
        'Programma settimanale attivo – clic per disattivarlo',
        'Programa semanal activado – clic para desactivarlo',
        'Harmonogram tygodniowy włączony – kliknij, aby wyłączyć',
        'Тижневий розклад увімкнено – натисніть, щоб вимкнути',
        '周计划已开启 – 点击关闭',
    ),
    tipPlanAus: L(
        'Weekly schedule is off – click to switch it on',
        'Wochenplan ist aus – Klick schaltet ihn ein',
        'Недельное расписание выключено – нажмите, чтобы включить',
        'Programa semanal desligado – clique para ligar',
        'Weekschema staat uit – klik om in te schakelen',
        'Programme hebdomadaire inactif – cliquer pour l’activer',
        'Programma settimanale disattivato – clic per attivarlo',
        'Programa semanal desactivado – clic para activarlo',
        'Harmonogram tygodniowy wyłączony – kliknij, aby włączyć',
        'Тижневий розклад вимкнено – натисніть, щоб увімкнути',
        '周计划已关闭 – 点击开启',
    ),
    handBis: L(
        'Manual override. Schedule and scenes wait until',
        'Handeingriff. Plan und Szenen warten bis',
        'Ручное вмешательство. Расписание и сцены ждут до',
        'Intervenção manual. Programa e cenários aguardam até',
        'Handmatige ingreep. Schema en scènes wachten tot',
        'Intervention manuelle. Programme et scènes attendent jusqu’à',
        'Intervento manuale. Programma e scenari attendono fino alle',
        'Intervención manual. Programa y escenas esperan hasta',
        'Ingerencja ręczna. Harmonogram i sceny czekają do',
        'Ручне втручання. Розклад і сцени чекають до',
        '手动干预。计划和场景等待至',
    ),
    tipFreigeben: L(
        'Applies the scene of the schedule again at once',
        'Setzt sofort wieder die Szene des Plans',
        'Сразу снова применяет сцену расписания',
        'Aplica de imediato novamente o cenário do programa',
        'Zet meteen weer de scène van het schema',
        'Applique de nouveau immédiatement la scène du programme',
        'Applica subito di nuovo lo scenario del programma',
        'Aplica de inmediato otra vez la escena del programa',
        'Od razu ponownie ustawia scenę harmonogramu',
        'Одразу знову застосовує сцену розкладу',
        '立即重新应用计划中的场景',
    ),
    ruht: L(
        'rests (Faikout auto)',
        'ruht (Faikout-Auto)',
        'не работает (Faikout-авто)',
        'parada (Faikout automático)',
        'rust (Faikout-auto)',
        'au repos (Faikout auto)',
        'ferma (Faikout auto)',
        'en reposo (Faikout automático)',
        'spoczywa (Faikout auto)',
        'не працює (Faikout-авто)',
        '暂停（Faikout 自动）',
    ),
    kopieFehlt: L(
        'Choose two different units that both have an entry.',
        'Zwei verschiedene Geräte wählen, die beide einen Eintrag haben.',
        'Выберите два разных устройства, у каждого из которых есть запись.',
        'Escolha dois aparelhos diferentes que tenham ambos uma entrada.',
        'Kies twee verschillende toestellen die elk een item hebben.',
        'Choisissez deux appareils différents ayant chacun une entrée.',
        'Scegli due apparecchi diversi che abbiano entrambi una voce.',
        'Elija dos equipos distintos que tengan ambos una entrada.',
        'Wybierz dwa różne urządzenia, z których każde ma wpis.',
        'Виберіть два різні пристрої, кожен з яких має запис.',
        '请选择两台不同且都有条目的设备。',
    ),
    fortsetzen: L(
        'Release',
        'Freigeben',
        'Разблокировать',
        'Libertar',
        'Vrijgeven',
        'Libérer',
        'Sblocca',
        'Liberar',
        'Zwolnij',
        'Розблокувати',
        '解除',
    ),
    fuehler: L(
        'Sensors',
        'Fühler',
        'Датчики',
        'Sensores',
        'Sensoren',
        'Capteurs',
        'Sensori',
        'Sensores',
        'Czujniki',
        'Датчики',
        '传感器',
    ),
    fAussen: L(
        'Outside',
        'Außen',
        'Снаружи',
        'Exterior',
        'Buiten',
        'Extérieur',
        'Esterno',
        'Exterior',
        'Zewnątrz',
        'Зовні',
        '室外',
    ),
    fRaum: L(
        'Room',
        'Raum',
        'Помещение',
        'Divisão',
        'Kamer',
        'Pièce',
        'Ambiente',
        'Habitación',
        'Pomieszczenie',
        'Приміщення',
        '房间',
    ),
    fFeuchte: L(
        'Humidity',
        'Feuchte',
        'Влажность',
        'Humidade',
        'Vochtigheid',
        'Humidité',
        'Umidità',
        'Humedad',
        'Wilgotność',
        'Вологість',
        '湿度',
    ),
    fFehlt: L(
        'missing',
        'fehlt',
        'нет данных',
        'em falta',
        'ontbreekt',
        'manquant',
        'mancante',
        'falta',
        'brak',
        'немає даних',
        '缺失',
    ),
    fRueckfall: L(
        'fallback',
        'Rückfall',
        'резервный датчик',
        'recurso',
        'terugval',
        'repli',
        'ripiego',
        'respaldo',
        'zastępczy',
        'резервний датчик',
        '备用',
    ),
    aktWochenplan: L(
        'Edit weekly schedule',
        'Wochenplan bearbeiten',
        'Изменить недельное расписание',
        'Editar programa semanal',
        'Weekschema bewerken',
        'Modifier le programme hebdomadaire',
        'Modifica programma settimanale',
        'Editar programa semanal',
        'Edytuj harmonogram tygodniowy',
        'Змінити тижневий розклад',
        '编辑周计划',
    ),
    aktDetails: L(
        'Show how the control decides',
        'Zeigen, wie die Regelung entscheidet',
        'Показать, как принимается решение',
        'Mostrar como a regulação decide',
        'Tonen hoe de regeling beslist',
        'Montrer comment la régulation décide',
        'Mostra come decide la regolazione',
        'Mostrar cómo decide la regulación',
        'Pokaż, jak decyduje regulacja',
        'Показати, як ухвалюється рішення',
        '显示调节的决策过程',
    ),
    // ---- Details-Dialog
    detailsTitel: L(
        'Control of {name}',
        'Regelung von {name}',
        'Регулирование: {name}',
        'Regulação de {name}',
        'Regeling van {name}',
        'Régulation de {name}',
        'Regolazione di {name}',
        'Regulación de {name}',
        'Regulacja: {name}',
        'Регулювання: {name}',
        '{name} 的调节',
    ),
    probeBanner: L(
        'Dry run. The adapter calculates everything but sends nothing to the unit.',
        'Probelauf. Der Adapter rechnet alles mit, sendet aber nichts an die Anlage.',
        'Пробный режим. Адаптер всё рассчитывает, но ничего не отправляет на устройство.',
        'Modo de teste. O adaptador calcula tudo, mas não envia nada para o aparelho.',
        'Proefloop. De adapter rekent alles mee, maar stuurt niets naar het toestel.',
        'Marche d’essai. L’adaptateur calcule tout mais n’envoie rien à l’appareil.',
        'Funzionamento di prova. L’adattatore calcola tutto ma non invia nulla all’apparecchio.',
        'Modo de prueba. El adaptador lo calcula todo, pero no envía nada al equipo.',
        'Tryb próbny. Adapter wszystko oblicza, ale niczego nie wysyła do urządzenia.',
        'Пробний режим. Адаптер усе розраховує, але нічого не надсилає на пристрій.',
        '试运行。适配器只做计算，不向设备发送任何指令。',
    ),
    rechenweg: L(
        'How the adapter decides right now',
        'So entscheidet der Adapter gerade',
        'Как адаптер решает сейчас',
        'Como o adaptador decide neste momento',
        'Zo beslist de adapter op dit moment',
        'Comment l’adaptateur décide en ce moment',
        'Come decide l’adattatore in questo momento',
        'Cómo decide el adaptador ahora mismo',
        'Jak adapter decyduje w tej chwili',
        'Як адаптер вирішує зараз',
        '适配器当前的决策依据',
    ),
    verlaufTitel: L(
        'Power limit, last 24 hours',
        'Leistungsgrenze, letzte 24 Stunden',
        'Ограничение мощности за последние 24 часа',
        'Limite de potência, últimas 24 horas',
        'Vermogensgrens, laatste 24 uur',
        'Limite de puissance, 24 dernières heures',
        'Limite di potenza, ultime 24 ore',
        'Límite de potencia, últimas 24 horas',
        'Limit mocy, ostatnie 24 godziny',
        'Обмеження потужності за останні 24 години',
        '功率上限，最近 24 小时',
    ),
    kennlinieHeizen: L(
        'Heating curve',
        'Heizkennlinie',
        'Кривая отопления',
        'Curva de aquecimento',
        'Stooklijn',
        'Courbe de chauffe',
        'Curva di riscaldamento',
        'Curva de calefacción',
        'Krzywa grzewcza',
        'Крива опалення',
        '制热曲线',
    ),
    kennlinieKuehlen: L(
        'Cooling curve',
        'Kühlkennlinie',
        'Кривая охлаждения',
        'Curva de arrefecimento',
        'Koellijn',
        'Courbe de refroidissement',
        'Curva di raffreddamento',
        'Curva de refrigeración',
        'Krzywa chłodzenia',
        'Крива охолодження',
        '制冷曲线',
    ),
    untergrenze: L(
        'Lower limit',
        'Untergrenze',
        'Нижний предел',
        'Limite inferior',
        'Ondergrens',
        'Limite basse',
        'Limite inferiore',
        'Límite inferior',
        'Dolna granica',
        'Нижня межа',
        '下限',
    ),
    obergrenze: L(
        'Upper limit',
        'Obergrenze',
        'Верхний предел',
        'Limite superior',
        'Bovengrens',
        'Limite haute',
        'Limite superiore',
        'Límite superior',
        'Górna granica',
        'Верхня межа',
        '上限',
    ),
    wuerdeSenden: L(
        'would send {p} %',
        'würde senden {p} %',
        'отправил бы {p} %',
        'enviaria {p} %',
        'zou {p} % sturen',
        'enverrait {p} %',
        'invierebbe {p} %',
        'enviaría {p} %',
        'wysłałby {p} %',
        'надіслав би {p} %',
        '将发送 {p} %',
    ),
    sendet: L(
        'power limit {p} %',
        'Leistungsgrenze {p} %',
        'ограничение мощности {p} %',
        'limite de potência {p} %',
        'vermogensgrens {p} %',
        'limite de puissance {p} %',
        'limite di potenza {p} %',
        'límite de potencia {p} %',
        'limit mocy {p} %',
        'обмеження потужності {p} %',
        '功率上限 {p} %',
    ),
    unterzeile: L(
        'raw {r} % · outside {t} °C',
        'roh {r} % · außen {t} °C',
        'расчёт {r} % · снаружи {t} °C',
        'bruto {r} % · exterior {t} °C',
        'ruw {r} % · buiten {t} °C',
        'brut {r} % · extérieur {t} °C',
        'grezzo {r} % · esterno {t} °C',
        'bruto {r} % · exterior {t} °C',
        'surowo {r} % · na zewnątrz {t} °C',
        'розрахунок {r} % · зовні {t} °C',
        '原始值 {r} % · 室外 {t} °C',
    ),
    aussenBei: L(
        'outside {t} °C',
        'außen {t} °C',
        'снаружи {t} °C',
        'exterior {t} °C',
        'buiten {t} °C',
        'extérieur {t} °C',
        'esterno {t} °C',
        'exterior {t} °C',
        'na zewnątrz {t} °C',
        'зовні {t} °C',
        '室外 {t} °C',
    ),
    verlaufLeer: L(
        'No power limit in the last 24 hours',
        'Keine Leistungsgrenze in den letzten 24 Stunden',
        'За последние 24 часа ограничений не было',
        'Sem limite de potência nas últimas 24 horas',
        'Geen vermogensgrens in de laatste 24 uur',
        'Aucune limite de puissance ces 24 dernières heures',
        'Nessun limite di potenza nelle ultime 24 ore',
        'Sin límite de potencia en las últimas 24 horas',
        'Brak limitu mocy w ostatnich 24 godzinach',
        'За останні 24 години обмежень не було',
        '最近 24 小时没有功率上限',
    ),
    jetzt: L('now', 'jetzt', 'сейчас', 'agora', 'nu', 'maintenant', 'adesso', 'ahora', 'teraz', 'зараз', '现在'),
    stunde: L('h', 'h', 'ч', 'h', 'u', 'h', 'h', 'h', 'h', 'год', '小时'),
    werRegelt: L(
        'Who controls',
        'Wer regelt',
        'Кто регулирует',
        'Quem regula',
        'Wie regelt',
        'Qui régule',
        'Chi regola',
        'Quién regula',
        'Kto reguluje',
        'Хто регулює',
        '由谁调节',
    ),
    betriebAdapter: L(
        'Adapter controls',
        'Adapter regelt',
        'Регулирует адаптер',
        'O adaptador regula',
        'Adapter regelt',
        'L’adaptateur régule',
        'Regola l’adattatore',
        'Regula el adaptador',
        'Reguluje adapter',
        'Регулює адаптер',
        '由适配器调节',
    ),
    betriebFaikout: L(
        'Faikout auto (the module controls)',
        'Faikout-Auto (das Modul regelt)',
        'Faikout-авто (регулирует модуль)',
        'Faikout automático (o módulo regula)',
        'Faikout-auto (de module regelt)',
        'Faikout auto (le module régule)',
        'Faikout auto (regola il modulo)',
        'Faikout automático (regula el módulo)',
        'Faikout auto (reguluje moduł)',
        'Faikout-авто (регулює модуль)',
        'Faikout 自动（由模块调节）',
    ),
    keineDaten: L(
        'This unit has not reported since the adapter started.',
        'Diese Anlage hat sich seit dem Start des Adapters noch nicht gemeldet.',
        'Это устройство ещё не выходило на связь после запуска адаптера.',
        'Este aparelho ainda não comunicou desde o arranque do adaptador.',
        'Dit toestel heeft zich sinds de start van de adapter nog niet gemeld.',
        'Cet appareil ne s’est pas encore signalé depuis le démarrage de l’adaptateur.',
        'Questo apparecchio non si è ancora fatto vivo dall’avvio dell’adattatore.',
        'Este equipo aún no se ha comunicado desde el inicio del adaptador.',
        'To urządzenie nie zgłosiło się jeszcze od uruchomienia adaptera.',
        'Цей пристрій ще не виходив на зв’язок після запуску адаптера.',
        '适配器启动后，此设备尚未上报。',
    ),
    qBle: L(
        'BLE sensor on the module',
        'BLE-Fühler am Modul',
        'BLE-датчик на модуле',
        'Sensor BLE no módulo',
        'BLE-sensor aan de module',
        'Capteur BLE sur le module',
        'Sensore BLE sul modulo',
        'Sensor BLE en el módulo',
        'Czujnik BLE przy module',
        'BLE-датчик на модулі',
        '模块上的 BLE 传感器',
    ),
    qDp: L(
        'Data point',
        'Datenpunkt',
        'Точка данных',
        'Ponto de dados',
        'Datapunt',
        'Point de données',
        'Punto dati',
        'Punto de datos',
        'Punkt danych',
        'Точка даних',
        '数据点',
    ),
    qIntern: L(
        'Sensor of the unit',
        'Fühler der Anlage',
        'Датчик устройства',
        'Sensor do aparelho',
        'Sensor van het toestel',
        'Capteur de l’appareil',
        'Sensore dell’apparecchio',
        'Sensor del equipo',
        'Czujnik urządzenia',
        'Датчик пристрою',
        '设备自带传感器',
    ),
    // ---- Wochenplan-Dialog
    planTitel: L(
        'Weekly schedule of {name}',
        'Wochenplan von {name}',
        'Недельное расписание: {name}',
        'Programa semanal de {name}',
        'Weekschema van {name}',
        'Programme hebdomadaire de {name}',
        'Programma settimanale di {name}',
        'Programa semanal de {name}',
        'Harmonogram tygodniowy: {name}',
        'Тижневий розклад: {name}',
        '{name} 的周计划',
    ),
    pTagKopieren: L(
        'Copy day',
        'Tag kopieren',
        'Копировать день',
        'Copiar dia',
        'Dag kopiëren',
        'Copier le jour',
        'Copia giorno',
        'Copiar día',
        'Kopiuj dzień',
        'Копіювати день',
        '复制当天',
    ),
    pTagEinfuegen: L(
        'Paste day',
        'Tag einfügen',
        'Вставить день',
        'Colar dia',
        'Dag plakken',
        'Coller le jour',
        'Incolla giorno',
        'Pegar día',
        'Wklej dzień',
        'Вставити день',
        '粘贴当天',
    ),
    pNeu: L(
        '+ switching time',
        '+ Schaltpunkt',
        '+ точка переключения',
        '+ comutação',
        '+ schakelpunt',
        '+ commutation',
        '+ commutazione',
        '+ conmutación',
        '+ punkt przełączenia',
        '+ точка перемикання',
        '+ 切换点',
    ),
    pNeuUm: L(
        'New switching time at {time}',
        'Neuer Schaltpunkt um {time}',
        'Новая точка переключения в {time}',
        'Nova comutação às {time}',
        'Nieuw schakelpunt om {time}',
        'Nouvelle commutation à {time}',
        'Nuova commutazione alle {time}',
        'Nueva conmutación a las {time}',
        'Nowy punkt przełączenia o {time}',
        'Нова точка перемикання о {time}',
        '在 {time} 新增切换点',
    ),
    pLoeschen: L(
        'Delete',
        'Löschen',
        'Удалить',
        'Eliminar',
        'Verwijderen',
        'Supprimer',
        'Elimina',
        'Eliminar',
        'Usuń',
        'Видалити',
        '删除',
    ),
    pLoeschenFrage: L(
        'Delete the switching time {time}?',
        'Schaltpunkt {time} löschen?',
        'Удалить точку переключения {time}?',
        'Eliminar a comutação {time}?',
        'Schakelpunt {time} verwijderen?',
        'Supprimer la commutation {time} ?',
        'Eliminare la commutazione {time}?',
        '¿Eliminar la conmutación {time}?',
        'Usunąć punkt przełączenia {time}?',
        'Видалити точку перемикання {time}?',
        '删除切换点 {time}？',
    ),
    pAbbrechen: L(
        'Cancel',
        'Abbrechen',
        'Отмена',
        'Cancelar',
        'Annuleren',
        'Annuler',
        'Annulla',
        'Cancelar',
        'Anuluj',
        'Скасувати',
        '取消',
    ),
    pSchaltpunkte: L(
        'switching times',
        'Schaltpunkte',
        'точек переключения',
        'comutações',
        'schakelpunten',
        'commutations',
        'commutazioni',
        'conmutaciones',
        'punktów przełączenia',
        'точок перемикання',
        '个切换点',
    ),
    pHinweis: L(
        'Click into a block: new switching time there. Drag a line: move the switching time (15-minute steps). Click a line: choose another scene or delete it.',
        'In einen Block klicken: neuer Schaltpunkt an dieser Stelle. Linie ziehen: Schaltzeit verschieben (15-Minuten-Schritte). Linie anklicken: andere Szene wählen oder löschen.',
        'Щелчок по блоку: новая точка переключения в этом месте. Перетаскивание линии: сдвиг времени (шаг 15 минут). Щелчок по линии: выбрать другую сцену или удалить.',
        'Clique num bloco: nova comutação nesse ponto. Arraste uma linha: desloca a hora (passos de 15 minutos). Clique numa linha: escolher outro cenário ou eliminar.',
        'Klik in een blok: nieuw schakelpunt op die plek. Lijn slepen: schakeltijd verschuiven (stappen van 15 minuten). Lijn aanklikken: andere scène kiezen of verwijderen.',
        'Cliquer dans un bloc : nouvelle commutation à cet endroit. Faire glisser une ligne : déplacer l’heure (pas de 15 minutes). Cliquer sur une ligne : choisir une autre scène ou supprimer.',
        'Clic in un blocco: nuova commutazione in quel punto. Trascina una linea: sposta l’orario (passi di 15 minuti). Clic su una linea: scegli un altro scenario o elimina.',
        'Clic en un bloque: nueva conmutación en ese punto. Arrastrar una línea: mover la hora (pasos de 15 minutos). Clic en una línea: elegir otra escena o eliminar.',
        'Kliknij w blok: nowy punkt przełączenia w tym miejscu. Przeciągnij linię: przesuń godzinę (krok 15 minut). Kliknij linię: wybierz inną scenę lub usuń.',
        'Клацання по блоку: нова точка перемикання в цьому місці. Перетягування лінії: зсув часу (крок 15 хвилин). Клацання по лінії: вибрати іншу сцену або видалити.',
        '点击色块：在该处新增切换点。拖动分隔线：移动切换时间（15 分钟一档）。点击分隔线：选择其他场景或删除。',
    ),
    pSzeneAb: L(
        'Scene from {time}',
        'Szene ab {time}',
        'Сцена с {time}',
        'Cenário a partir das {time}',
        'Scène vanaf {time}',
        'Scène à partir de {time}',
        'Scenario dalle {time}',
        'Escena desde las {time}',
        'Scena od {time}',
        'Сцена з {time}',
        '{time} 起的场景',
    ),
    pVorgabe: L(
        'Load default schedule',
        'Vorgabeplan laden',
        'Загрузить стандартное расписание',
        'Carregar programa predefinido',
        'Standaardschema laden',
        'Charger le programme par défaut',
        'Carica programma predefinito',
        'Cargar programa predeterminado',
        'Wczytaj harmonogram domyślny',
        'Завантажити стандартний розклад',
        '载入默认计划',
    ),
    pAbwesenheit: L(
        'Absence',
        'Abwesenheit',
        'Отсутствие',
        'Ausência',
        'Afwezigheid',
        'Absence',
        'Assenza',
        'Ausencia',
        'Nieobecność',
        'Відсутність',
        '外出',
    ),
    pVon: L('from', 'von', 'с', 'de', 'van', 'du', 'dal', 'desde', 'od', 'з', '从'),
    pBis: L('until', 'bis', 'по', 'até', 'tot', 'au', 'al', 'hasta', 'do', 'по', '到'),
    pSzeneInZeit: L(
        'Scene during this time',
        'Szene in dieser Zeit',
        'Сцена на это время',
        'Cenário neste período',
        'Scène in deze periode',
        'Scène pendant cette période',
        'Scenario in questo periodo',
        'Escena durante este tiempo',
        'Scena w tym czasie',
        'Сцена на цей час',
        '此期间的场景',
    ),
    pFeiertag: L(
        'On public holidays the Sunday schedule applies.',
        'An Feiertagen gilt der Sonntagsplan.',
        'В праздничные дни действует воскресное расписание.',
        'Nos feriados aplica-se o programa de domingo.',
        'Op feestdagen geldt het zondagsschema.',
        'Les jours fériés, le programme du dimanche s’applique.',
        'Nei giorni festivi vale il programma della domenica.',
        'En festivos se aplica el programa del domingo.',
        'W święta obowiązuje harmonogram niedzielny.',
        'У святкові дні діє недільний розклад.',
        '节假日按周日计划执行。',
    ),
    pPlanAus: L(
        'The weekly schedule of this unit is switched off. It only takes effect once it is switched on.',
        'Der Wochenplan dieser Anlage ist ausgeschaltet. Er wirkt erst, wenn er eingeschaltet wird.',
        'Недельное расписание этого устройства выключено. Оно начнёт действовать только после включения.',
        'O programa semanal deste aparelho está desligado. Só tem efeito depois de ligado.',
        'Het weekschema van dit toestel is uitgeschakeld. Het werkt pas nadat het is ingeschakeld.',
        'Le programme hebdomadaire de cet appareil est désactivé. Il n’agit qu’une fois activé.',
        'Il programma settimanale di questo apparecchio è disattivato. Ha effetto solo dopo l’attivazione.',
        'El programa semanal de este equipo está desactivado. Solo actúa cuando se activa.',
        'Harmonogram tygodniowy tego urządzenia jest wyłączony. Zadziała dopiero po włączeniu.',
        'Тижневий розклад цього пристрою вимкнено. Він почне діяти лише після ввімкнення.',
        '此设备的周计划已关闭，开启后才会生效。',
    ),
    pAnlageAus: L(
        'unit off',
        'Anlage aus',
        'устройство выкл.',
        'aparelho desligado',
        'toestel uit',
        'appareil éteint',
        'apparecchio spento',
        'equipo apagado',
        'urządzenie wyłączone',
        'пристрій вимк.',
        '设备关闭',
    ),
    pMax: L('max.', 'max.', 'макс.', 'máx.', 'max.', 'max.', 'max.', 'máx.', 'maks.', 'макс.', '最高'),
    pAbwFehler: L(
        'Absence: the end must be later than the start.',
        'Abwesenheit: Das Ende muss nach dem Beginn liegen.',
        'Отсутствие: окончание должно быть позже начала.',
        'Ausência: o fim tem de ser depois do início.',
        'Afwezigheid: het einde moet na het begin liggen.',
        'Absence : la fin doit être postérieure au début.',
        'Assenza: la fine deve essere successiva all’inizio.',
        'Ausencia: el final debe ser posterior al inicio.',
        'Nieobecność: koniec musi być późniejszy niż początek.',
        'Відсутність: кінець має бути пізніше за початок.',
        '外出：结束时间必须晚于开始时间。',
    ),
    planFehler: L(
        'The weekly schedule was not saved: {grund}',
        'Der Wochenplan wurde nicht gespeichert: {grund}',
        'Недельное расписание не сохранено: {grund}',
        'O programa semanal não foi guardado: {grund}',
        'Het weekschema is niet opgeslagen: {grund}',
        'Le programme hebdomadaire n’a pas été enregistré : {grund}',
        'Il programma settimanale non è stato salvato: {grund}',
        'El programa semanal no se ha guardado: {grund}',
        'Harmonogram tygodniowy nie został zapisany: {grund}',
        'Тижневий розклад не збережено: {grund}',
        '周计划未保存：{grund}',
    ),
    planLeer: L(
        'the schedule has no switching time',
        'der Plan hat keinen Schaltpunkt',
        'в расписании нет ни одной точки переключения',
        'o programa não tem nenhuma comutação',
        'het schema heeft geen schakelpunt',
        'le programme ne contient aucune commutation',
        'il programma non contiene commutazioni',
        'el programa no tiene ninguna conmutación',
        'harmonogram nie ma żadnego punktu przełączenia',
        'у розкладі немає жодної точки перемикання',
        '计划中没有切换点',
    ),
    planEinschaltenFrage: L(
        'The weekly schedule is saved, but it is switched off for {name}. Switch it on now?',
        'Der Wochenplan ist gespeichert, für {name} aber ausgeschaltet. Jetzt einschalten?',
        'Недельное расписание сохранено, но для {name} оно выключено. Включить сейчас?',
        'O programa semanal foi guardado, mas está desligado para {name}. Ligar agora?',
        'Het weekschema is opgeslagen, maar staat uit voor {name}. Nu inschakelen?',
        'Le programme hebdomadaire est enregistré, mais désactivé pour {name}. L’activer maintenant ?',
        'Il programma settimanale è salvato, ma è disattivato per {name}. Attivarlo ora?',
        'El programa semanal se ha guardado, pero está desactivado para {name}. ¿Activarlo ahora?',
        'Harmonogram tygodniowy zapisano, ale dla {name} jest wyłączony. Włączyć teraz?',
        'Тижневий розклад збережено, але для {name} його вимкнено. Увімкнути зараз?',
        '周计划已保存，但 {name} 的周计划处于关闭状态。现在开启吗？',
    ),
    planEinschalten: L(
        'Switch on',
        'Einschalten',
        'Включить',
        'Ligar',
        'Inschakelen',
        'Activer',
        'Attiva',
        'Activar',
        'Włącz',
        'Увімкнути',
        '开启',
    ),
    planNurSpeichern: L(
        'Only save',
        'Nur speichern',
        'Только сохранить',
        'Só guardar',
        'Alleen opslaan',
        'Enregistrer seulement',
        'Solo salvare',
        'Solo guardar',
        'Tylko zapisz',
        'Лише зберегти',
        '仅保存',
    ),
    // ---- Einstellungsseite: Was diese Anlage kann
    kWaehlen: L(
        'Choose a unit above to see what it supports.',
        'Oben eine Anlage wählen, dann steht hier, was sie kann.',
        'Выберите устройство выше, чтобы увидеть его возможности.',
        'Escolha um aparelho acima para ver o que suporta.',
        'Kies hierboven een toestel om te zien wat het kan.',
        'Choisissez un appareil ci-dessus pour voir ce qu’il sait faire.',
        'Scegli sopra un apparecchio per vedere cosa supporta.',
        'Elija arriba un equipo para ver qué admite.',
        'Wybierz powyżej urządzenie, aby zobaczyć, co obsługuje.',
        'Виберіть пристрій вище, щоб побачити його можливості.',
        '请先在上方选择设备，这里会显示它支持的功能。',
    ),
    kDemandJa: L(
        'Power limit: supported',
        'Leistungsgrenze: unterstützt',
        'Ограничение мощности: поддерживается',
        'Limite de potência: suportado',
        'Vermogensgrens: ondersteund',
        'Limite de puissance : prise en charge',
        'Limite di potenza: supportato',
        'Límite de potencia: compatible',
        'Limit mocy: obsługiwany',
        'Обмеження потужності: підтримується',
        '功率上限：支持',
    ),
    kDemandJaSub: L(
        'The unit reports the set value back.',
        'Die Anlage meldet den gesetzten Wert zurück.',
        'Устройство возвращает установленное значение.',
        'O aparelho devolve o valor definido.',
        'Het toestel meldt de ingestelde waarde terug.',
        'L’appareil renvoie la valeur réglée.',
        'L’apparecchio restituisce il valore impostato.',
        'El equipo devuelve el valor ajustado.',
        'Urządzenie odsyła ustawioną wartość.',
        'Пристрій повертає встановлене значення.',
        '设备会回报所设置的数值。',
    ),
    kDemandNein: L(
        'Power limit: not supported',
        'Leistungsgrenze: nicht unterstützt',
        'Ограничение мощности: не поддерживается',
        'Limite de potência: não suportado',
        'Vermogensgrens: niet ondersteund',
        'Limite de puissance : non prise en charge',
        'Limite di potenza: non supportato',
        'Límite de potencia: no compatible',
        'Limit mocy: nieobsługiwany',
        'Обмеження потужності: не підтримується',
        '功率上限：不支持',
    ),
    kDemandNeinSub: L(
        'The unit does not take a power limit. Demand control rests; schedule and humidity control keep working.',
        'Die Anlage übernimmt keine Leistungsgrenze. Die Bedarfsregelung ruht, Wochenplan und Feuchteregelung arbeiten weiter.',
        'Устройство не принимает ограничение мощности. Регулирование по потребности не работает; расписание и регулирование влажности продолжают работать.',
        'O aparelho não aceita limite de potência. A regulação por necessidade fica parada; programa e humidade continuam.',
        'Het toestel neemt geen vermogensgrens over. De vraagregeling rust; schema en vochtregeling werken door.',
        'L’appareil n’accepte pas de limite de puissance. La régulation selon le besoin est au repos ; programme et humidité continuent.',
        'L’apparecchio non accetta un limite di potenza. La regolazione in base al fabbisogno è ferma; programma e umidità continuano.',
        'El equipo no acepta un límite de potencia. La regulación por demanda queda en reposo; programa y humedad siguen funcionando.',
        'Urządzenie nie przyjmuje limitu mocy. Regulacja według zapotrzebowania spoczywa; harmonogram i wilgotność działają dalej.',
        'Пристрій не приймає обмеження потужності. Регулювання за потребою не працює; розклад і регулювання вологості працюють далі.',
        '设备不接受功率上限。按需调节暂停，周计划和湿度调节继续工作。',
    ),
    kDemandUnb: L(
        'Power limit: not tested yet',
        'Leistungsgrenze: noch nicht geprüft',
        'Ограничение мощности: ещё не проверено',
        'Limite de potência: ainda não testado',
        'Vermogensgrens: nog niet getest',
        'Limite de puissance : pas encore testée',
        'Limite di potenza: non ancora verificato',
        'Límite de potencia: aún no comprobado',
        'Limit mocy: jeszcze nie sprawdzono',
        'Обмеження потужності: ще не перевірено',
        '功率上限：尚未检测',
    ),
    kDemandUnbSub: L(
        'This shows with the first command outside the dry run.',
        'Das zeigt sich beim ersten Befehl außerhalb des Probelaufs.',
        'Это выяснится при первой команде вне пробного режима.',
        'Isso vê-se com o primeiro comando fora do modo de teste.',
        'Dat blijkt bij het eerste commando buiten de proefloop.',
        'Cela se verra à la première commande hors marche d’essai.',
        'Si vedrà con il primo comando fuori dal funzionamento di prova.',
        'Se verá con el primer comando fuera del modo de prueba.',
        'Okaże się przy pierwszym poleceniu poza trybem próbnym.',
        'Це з’ясується під час першої команди поза пробним режимом.',
        '退出试运行后发送第一条指令时即可得知。',
    ),
    kBleJa: L(
        'BLE sensor on the module: connected',
        'BLE-Fühler am Modul: verbunden',
        'BLE-датчик на модуле: подключён',
        'Sensor BLE no módulo: ligado',
        'BLE-sensor aan de module: verbonden',
        'Capteur BLE sur le module : connecté',
        'Sensore BLE sul modulo: collegato',
        'Sensor BLE en el módulo: conectado',
        'Czujnik BLE przy module: połączony',
        'BLE-датчик на модулі: під’єднано',
        '模块上的 BLE 传感器：已连接',
    ),
    kBleJaSub: L(
        'It always takes priority over all other room sensors.',
        'Er hat immer Vorrang vor allen anderen Raumfühlern.',
        'Он всегда имеет приоритет перед остальными комнатными датчиками.',
        'Tem sempre prioridade sobre todos os outros sensores da divisão.',
        'Hij heeft altijd voorrang op alle andere kamersensoren.',
        'Il a toujours priorité sur tous les autres capteurs de la pièce.',
        'Ha sempre la precedenza su tutti gli altri sensori ambiente.',
        'Siempre tiene prioridad sobre los demás sensores de la habitación.',
        'Zawsze ma pierwszeństwo przed innymi czujnikami pomieszczenia.',
        'Він завжди має пріоритет перед іншими кімнатними датчиками.',
        '它始终优先于其他所有房间传感器。',
    ),
    kBleNein: L(
        'BLE sensor on the module: none',
        'BLE-Fühler am Modul: keiner',
        'BLE-датчик на модуле: нет',
        'Sensor BLE no módulo: nenhum',
        'BLE-sensor aan de module: geen',
        'Capteur BLE sur le module : aucun',
        'Sensore BLE sul modulo: nessuno',
        'Sensor BLE en el módulo: ninguno',
        'Czujnik BLE przy module: brak',
        'BLE-датчик на модулі: немає',
        '模块上的 BLE 传感器：无',
    ),
    kBleNeinSub: L(
        'The room sensor is the data point chosen below or the sensor of the unit.',
        'Raumfühler ist der unten gewählte Datenpunkt oder der Fühler der Anlage.',
        'Комнатным датчиком служит выбранная ниже точка данных или датчик устройства.',
        'O sensor da divisão é o ponto de dados escolhido abaixo ou o sensor do aparelho.',
        'Kamersensor is het hieronder gekozen datapunt of de sensor van het toestel.',
        'Le capteur de la pièce est le point de données choisi ci-dessous ou le capteur de l’appareil.',
        'Il sensore ambiente è il punto dati scelto sotto o il sensore dell’apparecchio.',
        'El sensor de la habitación es el punto de datos elegido abajo o el sensor del equipo.',
        'Czujnikiem pomieszczenia jest wybrany niżej punkt danych lub czujnik urządzenia.',
        'Кімнатним датчиком є вибрана нижче точка даних або датчик пристрою.',
        '房间传感器为下方选择的数据点或设备自带传感器。',
    ),
    kFeuchteJa: L(
        'Humidity value: available',
        'Feuchtewert: vorhanden',
        'Значение влажности: есть',
        'Valor de humidade: disponível',
        'Vochtwaarde: aanwezig',
        'Valeur d’humidité : disponible',
        'Valore di umidità: disponibile',
        'Valor de humedad: disponible',
        'Wartość wilgotności: dostępna',
        'Значення вологості: є',
        '湿度值：可用',
    ),
    kFeuchteJaSub: L(
        'Required for humidity control.',
        'Voraussetzung für die Feuchteregelung.',
        'Необходимо для регулирования влажности.',
        'Necessário para a regulação de humidade.',
        'Voorwaarde voor de vochtregeling.',
        'Nécessaire à la régulation d’humidité.',
        'Necessario per la regolazione dell’umidità.',
        'Necesario para la regulación de humedad.',
        'Wymagane do regulacji wilgotności.',
        'Потрібно для регулювання вологості.',
        '湿度调节的前提条件。',
    ),
    kFeuchteNein: L(
        'Humidity value: missing',
        'Feuchtewert: fehlt',
        'Значение влажности: отсутствует',
        'Valor de humidade: em falta',
        'Vochtwaarde: ontbreekt',
        'Valeur d’humidité : manquante',
        'Valore di umidità: mancante',
        'Valor de humedad: falta',
        'Wartość wilgotności: brak',
        'Значення вологості: відсутнє',
        '湿度值：缺失',
    ),
    kFeuchteNeinSub: L(
        'Humidity control needs a humidity data point – choose one below.',
        'Die Feuchteregelung braucht einen Feuchte-Datenpunkt – unten wählen.',
        'Регулированию влажности нужна точка данных влажности – выберите её ниже.',
        'A regulação de humidade precisa de um ponto de dados de humidade – escolha abaixo.',
        'De vochtregeling heeft een vocht-datapunt nodig – kies het hieronder.',
        'La régulation d’humidité a besoin d’un point de données d’humidité – à choisir ci-dessous.',
        'La regolazione dell’umidità richiede un punto dati di umidità – sceglilo sotto.',
        'La regulación de humedad necesita un punto de datos de humedad – elíjalo abajo.',
        'Regulacja wilgotności wymaga punktu danych wilgotności – wybierz go poniżej.',
        'Регулюванню вологості потрібна точка даних вологості – виберіть її нижче.',
        '湿度调节需要湿度数据点 – 请在下方选择。',
    ),
    // ---- Einstellungsseite: Kennlinie
    fZuWenig: L(
        'At least two points are needed.',
        'Es braucht mindestens zwei Stützpunkte.',
        'Нужно не менее двух точек.',
        'São necessários pelo menos dois pontos.',
        'Er zijn minstens twee punten nodig.',
        'Il faut au moins deux points.',
        'Servono almeno due punti.',
        'Se necesitan al menos dos puntos.',
        'Potrzebne są co najmniej dwa punkty.',
        'Потрібно щонайменше дві точки.',
        '至少需要两个点。',
    ),
    fZahl: L(
        'Point {n} is not a number.',
        'Stützpunkt {n} ist keine Zahl.',
        'Точка {n} – не число.',
        'O ponto {n} não é um número.',
        'Punt {n} is geen getal.',
        'Le point {n} n’est pas un nombre.',
        'Il punto {n} non è un numero.',
        'El punto {n} no es un número.',
        'Punkt {n} nie jest liczbą.',
        'Точка {n} – не число.',
        '第 {n} 个点不是数字。',
    ),
    fBereich: L(
        'Point {n}: the power must be between 0 and 100 %.',
        'Stützpunkt {n}: Die Leistung muss zwischen 0 und 100 % liegen.',
        'Точка {n}: мощность должна быть от 0 до 100 %.',
        'Ponto {n}: a potência tem de estar entre 0 e 100 %.',
        'Punt {n}: het vermogen moet tussen 0 en 100 % liggen.',
        'Point {n} : la puissance doit être comprise entre 0 et 100 %.',
        'Punto {n}: la potenza deve essere compresa tra 0 e 100 %.',
        'Punto {n}: la potencia debe estar entre 0 y 100 %.',
        'Punkt {n}: moc musi mieścić się między 0 a 100 %.',
        'Точка {n}: потужність має бути від 0 до 100 %.',
        '第 {n} 个点：功率必须在 0 到 100 % 之间。',
    ),
    fAufsteigend: L(
        'The temperatures must rise from row to row.',
        'Die Temperaturen müssen von Zeile zu Zeile steigen.',
        'Температуры должны возрастать от строки к строке.',
        'As temperaturas têm de subir de linha para linha.',
        'De temperaturen moeten van rij tot rij stijgen.',
        'Les températures doivent augmenter d’une ligne à l’autre.',
        'Le temperature devono crescere di riga in riga.',
        'Las temperaturas deben aumentar de fila en fila.',
        'Temperatury muszą rosnąć z wiersza na wiersz.',
        'Температури мають зростати від рядка до рядка.',
        '温度必须逐行升高。',
    ),
    fFallend: L(
        'The heating curve must fall: the colder outside, the more power.',
        'Die Heizkennlinie muss fallen: je kälter draußen, desto mehr Leistung.',
        'Кривая отопления должна убывать: чем холоднее снаружи, тем больше мощность.',
        'A curva de aquecimento tem de descer: quanto mais frio lá fora, mais potência.',
        'De stooklijn moet dalen: hoe kouder buiten, hoe meer vermogen.',
        'La courbe de chauffe doit descendre : plus il fait froid dehors, plus de puissance.',
        'La curva di riscaldamento deve scendere: più freddo fuori, più potenza.',
        'La curva de calefacción debe descender: cuanto más frío fuera, más potencia.',
        'Krzywa grzewcza musi opadać: im zimniej na zewnątrz, tym więcej mocy.',
        'Крива опалення має спадати: що холодніше зовні, то більша потужність.',
        '制热曲线必须下降：室外越冷，功率越高。',
    ),
    fSteigend: L(
        'The cooling curve must rise: the warmer outside, the more power.',
        'Die Kühlkennlinie muss steigen: je wärmer draußen, desto mehr Leistung.',
        'Кривая охлаждения должна возрастать: чем теплее снаружи, тем больше мощность.',
        'A curva de arrefecimento tem de subir: quanto mais calor lá fora, mais potência.',
        'De koellijn moet stijgen: hoe warmer buiten, hoe meer vermogen.',
        'La courbe de refroidissement doit monter : plus il fait chaud dehors, plus de puissance.',
        'La curva di raffreddamento deve salire: più caldo fuori, più potenza.',
        'La curva de refrigeración debe ascender: cuanto más calor fuera, más potencia.',
        'Krzywa chłodzenia musi rosnąć: im cieplej na zewnątrz, tym więcej mocy.',
        'Крива охолодження має зростати: що тепліше зовні, то більша потужність.',
        '制冷曲线必须上升：室外越热，功率越高。',
    ),
    fGrenzen: L(
        'The lower limit must be at least 30 % and not above the upper limit; the upper limit at most 100 %.',
        'Die Untergrenze muss mindestens 30 % betragen und darf nicht über der Obergrenze liegen; die Obergrenze höchstens 100 %.',
        'Нижний предел – не менее 30 % и не выше верхнего; верхний предел – не более 100 %.',
        'O limite inferior tem de ser pelo menos 30 % e não superior ao limite superior; este no máximo 100 %.',
        'De ondergrens moet minstens 30 % zijn en niet boven de bovengrens liggen; de bovengrens hoogstens 100 %.',
        'La limite basse doit être d’au moins 30 % sans dépasser la limite haute ; celle-ci au plus 100 %.',
        'Il limite inferiore deve essere almeno 30 % e non superare quello superiore; quest’ultimo al massimo 100 %.',
        'El límite inferior debe ser al menos 30 % y no superar el superior; este como máximo 100 %.',
        'Dolna granica musi wynosić co najmniej 30 % i nie przekraczać górnej; górna najwyżej 100 %.',
        'Нижня межа – щонайменше 30 % і не вище верхньої; верхня межа – щонайбільше 100 %.',
        '下限至少为 30 % 且不得高于上限；上限最高为 100 %。',
    ),
    // ---- Modul-Einstellungen
    mAdresseFehlt: L(
        'Choose a module first.',
        'Zuerst ein Modul wählen.',
        'Сначала выберите модуль.',
        'Escolha primeiro um módulo.',
        'Kies eerst een module.',
        'Choisissez d’abord un module.',
        'Scegli prima un modulo.',
        'Elija primero un módulo.',
        'Najpierw wybierz moduł.',
        'Спочатку виберіть модуль.',
        '请先选择模块。',
    ),
    mNichtErreicht: L(
        'The module at {ip} did not answer ({grund}).',
        'Das Modul unter {ip} hat nicht geantwortet ({grund}).',
        'Модуль по адресу {ip} не ответил ({grund}).',
        'O módulo em {ip} não respondeu ({grund}).',
        'De module op {ip} antwoordde niet ({grund}).',
        'Le module à l’adresse {ip} n’a pas répondu ({grund}).',
        'Il modulo all’indirizzo {ip} non ha risposto ({grund}).',
        'El módulo en {ip} no respondió ({grund}).',
        'Moduł pod adresem {ip} nie odpowiedział ({grund}).',
        'Модуль за адресою {ip} не відповів ({grund}).',
        '位于 {ip} 的模块没有应答（{grund}）。',
    ),
    mKeinFaikout: L(
        'There is no faikout module at {ip}.',
        'Unter {ip} antwortet kein Faikout-Modul.',
        'По адресу {ip} нет модуля faikout.',
        'Não há nenhum módulo faikout em {ip}.',
        'Op {ip} antwoordt geen faikout-module.',
        'Aucun module faikout ne répond à l’adresse {ip}.',
        'All’indirizzo {ip} non risponde alcun modulo faikout.',
        'En {ip} no responde ningún módulo faikout.',
        'Pod adresem {ip} nie odpowiada żaden moduł faikout.',
        'За адресою {ip} немає модуля faikout.',
        '{ip} 上没有 faikout 模块应答。',
    ),
    mPasswort: L(
        'The settings of this module are password-protected. Reading is not possible here.',
        'Die Einstellungen dieses Moduls sind mit einem Passwort geschützt. Lesen ist hier nicht möglich.',
        'Настройки этого модуля защищены паролем. Прочитать их здесь нельзя.',
        'As definições deste módulo estão protegidas por palavra-passe. Não é possível lê-las aqui.',
        'De instellingen van deze module zijn met een wachtwoord beveiligd. Lezen is hier niet mogelijk.',
        'Les réglages de ce module sont protégés par mot de passe. La lecture n’est pas possible ici.',
        'Le impostazioni di questo modulo sono protette da password. Qui non è possibile leggerle.',
        'Los ajustes de este módulo están protegidos con contraseña. Aquí no se pueden leer.',
        'Ustawienia tego modułu są chronione hasłem. Odczyt nie jest tu możliwy.',
        'Налаштування цього модуля захищено паролем. Прочитати їх тут неможливо.',
        '此模块的设置受密码保护，无法在此读取。',
    ),
    mGelesen: L(
        'Read from {name} at {zeit}. Change values below, then check.',
        'Gelesen von {name} um {zeit} Uhr. Werte unten ändern, dann prüfen.',
        'Прочитано с {name} в {zeit}. Измените значения ниже, затем проверьте.',
        'Lido de {name} às {zeit}. Altere os valores abaixo e depois verifique.',
        'Gelezen van {name} om {zeit}. Wijzig de waarden hieronder en controleer daarna.',
        'Lu depuis {name} à {zeit}. Modifiez les valeurs ci-dessous, puis vérifiez.',
        'Letto da {name} alle {zeit}. Modifica i valori qui sotto, poi verifica.',
        'Leído de {name} a las {zeit}. Cambie los valores abajo y después compruebe.',
        'Odczytano z {name} o {zeit}. Zmień wartości poniżej, a potem sprawdź.',
        'Прочитано з {name} о {zeit}. Змініть значення нижче, потім перевірте.',
        '已于 {zeit} 从 {name} 读取。请在下方修改数值，然后检查。',
    ),
    mKeineAenderung: L(
        'Nothing changed – the form matches the module.',
        'Nichts geändert – das Formular stimmt mit dem Modul überein.',
        'Изменений нет – форма совпадает с модулем.',
        'Nada alterado – o formulário coincide com o módulo.',
        'Niets gewijzigd – het formulier komt overeen met de module.',
        'Rien de modifié – le formulaire correspond au module.',
        'Nessuna modifica – il modulo coincide con il formulario.',
        'Nada ha cambiado – el formulario coincide con el módulo.',
        'Nic nie zmieniono – formularz zgadza się z modułem.',
        'Змін немає – форма збігається з модулем.',
        '没有更改 – 表单与模块一致。',
    ),
    mAenderungen: L(
        'Changes for {name} (nothing has been written yet):',
        'Änderungen für {name} (noch nichts geschrieben):',
        'Изменения для {name} (пока ничего не записано):',
        'Alterações para {name} (ainda nada foi escrito):',
        'Wijzigingen voor {name} (er is nog niets geschreven):',
        'Modifications pour {name} (rien n’a encore été écrit) :',
        'Modifiche per {name} (non è ancora stato scritto nulla):',
        'Cambios para {name} (aún no se ha escrito nada):',
        'Zmiany dla {name} (nic jeszcze nie zapisano):',
        'Зміни для {name} (ще нічого не записано):',
        '{name} 的更改（尚未写入）：',
    ),
    mErstLesen: L(
        'Read the settings from the module first.',
        'Zuerst die Einstellungen aus dem Modul lesen.',
        'Сначала прочитайте настройки из модуля.',
        'Leia primeiro as definições do módulo.',
        'Lees eerst de instellingen uit de module.',
        'Lisez d’abord les réglages du module.',
        'Leggi prima le impostazioni dal modulo.',
        'Lea primero los ajustes del módulo.',
        'Najpierw odczytaj ustawienia z modułu.',
        'Спочатку прочитайте налаштування з модуля.',
        '请先从模块读取设置。',
    ),
    mErstPruefen: L(
        'Check the changes first.',
        'Zuerst die Änderungen prüfen.',
        'Сначала проверьте изменения.',
        'Verifique primeiro as alterações.',
        'Controleer eerst de wijzigingen.',
        'Vérifiez d’abord les modifications.',
        'Verifica prima le modifiche.',
        'Compruebe primero los cambios.',
        'Najpierw sprawdź zmiany.',
        'Спочатку перевірте зміни.',
        '请先检查更改。',
    ),
    mAn: L('on', 'an', 'вкл.', 'ligado', 'aan', 'activé', 'attivo', 'activado', 'wł.', 'увімк.', '开'),
    mAus: L('off', 'aus', 'выкл.', 'desligado', 'uit', 'désactivé', 'disattivo', 'desactivado', 'wył.', 'вимк.', '关'),
    mNichtVerbunden: L(
        'The module “{name}” is not connected to the broker of this adapter. Nothing was written.',
        'Das Modul „{name}“ ist nicht mit dem Broker dieses Adapters verbunden. Es wurde nichts geschrieben.',
        'Модуль «{name}» не подключён к брокеру этого адаптера. Ничего не записано.',
        'O módulo «{name}» não está ligado ao broker deste adaptador. Nada foi escrito.',
        'De module “{name}” is niet verbonden met de broker van deze adapter. Er is niets geschreven.',
        'Le module « {name} » n’est pas connecté au broker de cet adaptateur. Rien n’a été écrit.',
        'Il modulo «{name}» non è connesso al broker di questo adattatore. Nulla è stato scritto.',
        'El módulo «{name}» no está conectado al bróker de este adaptador. No se ha escrito nada.',
        'Moduł „{name}” nie jest połączony z brokerem tego adaptera. Niczego nie zapisano.',
        'Модуль «{name}» не під’єднано до брокера цього адаптера. Нічого не записано.',
        '模块“{name}”未连接到此适配器的代理，未写入任何内容。',
    ),
    mNichtGesendet: L(
        'The message could not be sent. Nothing was written.',
        'Die Nachricht konnte nicht gesendet werden. Es wurde nichts geschrieben.',
        'Сообщение не удалось отправить. Ничего не записано.',
        'Não foi possível enviar a mensagem. Nada foi escrito.',
        'Het bericht kon niet worden verzonden. Er is niets geschreven.',
        'Le message n’a pas pu être envoyé. Rien n’a été écrit.',
        'Impossibile inviare il messaggio. Nulla è stato scritto.',
        'No se pudo enviar el mensaje. No se ha escrito nada.',
        'Nie udało się wysłać wiadomości. Niczego nie zapisano.',
        'Повідомлення не вдалося надіслати. Нічого не записано.',
        '消息无法发送，未写入任何内容。',
    ),
    mUngueltig: L(
        'Nothing was written: {grund}',
        'Es wurde nichts geschrieben: {grund}',
        'Ничего не записано: {grund}',
        'Nada foi escrito: {grund}',
        'Er is niets geschreven: {grund}',
        'Rien n’a été écrit : {grund}',
        'Nulla è stato scritto: {grund}',
        'No se ha escrito nada: {grund}',
        'Niczego nie zapisano: {grund}',
        'Нічого не записано: {grund}',
        '未写入任何内容：{grund}',
    ),
    mEingabe: L(
        'Invalid value for “{feld}”.',
        'Ungültiger Wert für „{feld}“.',
        'Недопустимое значение для «{feld}».',
        'Valor inválido para «{feld}».',
        'Ongeldige waarde voor “{feld}”.',
        'Valeur non valide pour « {feld} ».',
        'Valore non valido per «{feld}».',
        'Valor no válido para «{feld}».',
        'Nieprawidłowa wartość dla „{feld}”.',
        'Неприпустиме значення для «{feld}».',
        '“{feld}”的值无效。',
    ),
    mErgebnisOk: L(
        'Written to {name} and read back – everything was applied:',
        'In {name} geschrieben und zurückgelesen – alles übernommen:',
        'Записано в {name} и прочитано обратно – всё принято:',
        'Escrito em {name} e lido de volta – tudo foi aplicado:',
        'Naar {name} geschreven en teruggelezen – alles overgenomen:',
        'Écrit dans {name} et relu – tout a été appliqué :',
        'Scritto in {name} e riletto – tutto applicato:',
        'Escrito en {name} y leído de vuelta – todo aplicado:',
        'Zapisano w {name} i odczytano ponownie – wszystko przyjęto:',
        'Записано в {name} і прочитано назад – усе прийнято:',
        '已写入 {name} 并回读 – 全部生效：',
    ),
    mErgebnisTeil: L(
        'Written to {name}, but not everything was applied:',
        'In {name} geschrieben, aber nicht alles wurde übernommen:',
        'Записано в {name}, но принято не всё:',
        'Escrito em {name}, mas nem tudo foi aplicado:',
        'Naar {name} geschreven, maar niet alles is overgenomen:',
        'Écrit dans {name}, mais tout n’a pas été appliqué :',
        'Scritto in {name}, ma non tutto è stato applicato:',
        'Escrito en {name}, pero no todo se ha aplicado:',
        'Zapisano w {name}, ale nie wszystko przyjęto:',
        'Записано в {name}, але прийнято не все:',
        '已写入 {name}，但并非全部生效：',
    ),
    mZeit: L(
        'Sent to {name}, but the module did not answer within {s} s. It may still be restarting – read again later.',
        'An {name} gesendet, aber das Modul hat innerhalb von {s} s nicht geantwortet. Es startet vielleicht noch neu – später erneut lesen.',
        'Отправлено на {name}, но модуль не ответил в течение {s} с. Возможно, он ещё перезапускается – прочитайте позже ещё раз.',
        'Enviado para {name}, mas o módulo não respondeu em {s} s. Talvez ainda esteja a reiniciar – leia de novo mais tarde.',
        'Naar {name} verzonden, maar de module antwoordde niet binnen {s} s. Mogelijk herstart hij nog – lees later opnieuw.',
        'Envoyé à {name}, mais le module n’a pas répondu en {s} s. Il redémarre peut-être encore – relisez plus tard.',
        'Inviato a {name}, ma il modulo non ha risposto entro {s} s. Forse si sta ancora riavviando – rileggi più tardi.',
        'Enviado a {name}, pero el módulo no respondió en {s} s. Quizá aún se esté reiniciando – vuelva a leer más tarde.',
        'Wysłano do {name}, ale moduł nie odpowiedział w ciągu {s} s. Być może jeszcze się uruchamia – odczytaj ponownie później.',
        'Надіслано на {name}, але модуль не відповів протягом {s} с. Можливо, він ще перезапускається – прочитайте пізніше ще раз.',
        '已发送到 {name}，但模块在 {s} 秒内没有应答。它可能仍在重启 – 请稍后再读取。',
    ),
    mFeldOk: L(
        'applied',
        'übernommen',
        'принято',
        'aplicado',
        'overgenomen',
        'appliqué',
        'applicato',
        'aplicado',
        'przyjęto',
        'прийнято',
        '已生效',
    ),
    mFeldNicht: L(
        'not applied (module reports: {ist})',
        'nicht übernommen (im Modul steht: {ist})',
        'не принято (в модуле: {ist})',
        'não aplicado (no módulo: {ist})',
        'niet overgenomen (in de module staat: {ist})',
        'non appliqué (dans le module : {ist})',
        'non applicato (nel modulo: {ist})',
        'no aplicado (en el módulo: {ist})',
        'nie przyjęto (w module: {ist})',
        'не прийнято (у модулі: {ist})',
        '未生效（模块中为：{ist}）',
    ),
    mSicherungFehlt: L(
        'Choose a saved state first.',
        'Zuerst einen gesicherten Stand wählen.',
        'Сначала выберите сохранённое состояние.',
        'Escolha primeiro um estado guardado.',
        'Kies eerst een opgeslagen stand.',
        'Choisissez d’abord un état sauvegardé.',
        'Scegli prima uno stato salvato.',
        'Elija primero un estado guardado.',
        'Najpierw wybierz zapisany stan.',
        'Спочатку виберіть збережений стан.',
        '请先选择已保存的状态。',
    ),
    mSicherungGeladen: L(
        'Saved state of {zeit} loaded into the form.',
        'Gesicherter Stand vom {zeit} in das Formular übernommen.',
        'Сохранённое состояние от {zeit} загружено в форму.',
        'Estado guardado de {zeit} carregado no formulário.',
        'Opgeslagen stand van {zeit} in het formulier geladen.',
        'État sauvegardé du {zeit} chargé dans le formulaire.',
        'Stato salvato del {zeit} caricato nel modulo.',
        'Estado guardado del {zeit} cargado en el formulario.',
        'Zapisany stan z {zeit} wczytano do formularza.',
        'Збережений стан від {zeit} завантажено у форму.',
        '已将 {zeit} 保存的状态载入表单。',
    ),
    kDaikin: L(
        'With Daikin the power limit only works if the original Daikin Wi-Fi module is switched on (remote control: hold “Powerful” for 5 s until “SP 1” appears – no internet or cloud needed) and demand control is set to “On” in the Daikin app. “Off” there always means 100 %; “Auto” means the cloud controls.',
        'Bei Daikin wirkt die Leistungsgrenze nur, wenn das originale Daikin-WLAN-Modul eingeschaltet ist (Fernbedienung: „Powerful“ 5 s halten, bis „SP 1“ erscheint – Internet oder Cloud ist dafür nicht nötig) und in der Daikin-App die Leistungssteuerung auf „Ein“ steht. „Aus“ bedeutet dort immer 100 %; „Auto“ heißt: die Cloud regelt.',
        'У Daikin ограничение мощности действует, только если включён оригинальный Wi-Fi-модуль Daikin (пульт: удерживать «Powerful» 5 с, пока не появится «SP 1» – интернет и облако не нужны) и в приложении Daikin управление мощностью установлено на «Вкл.». «Выкл.» там всегда означает 100 %; «Авто» означает, что регулирует облако.',
        'Na Daikin o limite de potência só atua se o módulo Wi-Fi original da Daikin estiver ligado (comando: manter «Powerful» 5 s até aparecer «SP 1» – não é preciso internet nem cloud) e se, na app Daikin, o controlo de potência estiver em «Ligado». «Desligado» significa aí sempre 100 %; «Auto» significa que a cloud regula.',
        'Bij Daikin werkt de vermogensgrens alleen als de originele Daikin-wifimodule is ingeschakeld (afstandsbediening: “Powerful” 5 s ingedrukt houden tot “SP 1” verschijnt – internet of cloud is niet nodig) en in de Daikin-app de vermogensregeling op “Aan” staat. “Uit” betekent daar altijd 100 %; “Auto” betekent dat de cloud regelt.',
        'Chez Daikin, la limite de puissance n’agit que si le module Wi-Fi Daikin d’origine est activé (télécommande : maintenir « Powerful » 5 s jusqu’à l’affichage de « SP 1 » – ni internet ni cloud nécessaires) et si, dans l’application Daikin, le contrôle de la puissance est sur « Activé ». « Désactivé » y signifie toujours 100 % ; « Auto » signifie que le cloud régule.',
        'Con Daikin il limite di potenza agisce solo se il modulo Wi-Fi Daikin originale è acceso (telecomando: tenere premuto «Powerful» per 5 s finché compare «SP 1» – non servono internet né cloud) e se nell’app Daikin il controllo della potenza è su «Attivo». «Disattivo» lì significa sempre 100 %; «Auto» significa che regola il cloud.',
        'En Daikin el límite de potencia solo actúa si el módulo Wi-Fi original de Daikin está encendido (mando: mantener «Powerful» 5 s hasta que aparezca «SP 1» – no hace falta internet ni nube) y si en la app de Daikin el control de potencia está en «Activado». «Desactivado» allí significa siempre 100 %; «Auto» significa que regula la nube.',
        'W Daikin limit mocy działa tylko wtedy, gdy oryginalny moduł Wi-Fi Daikin jest włączony (pilot: przytrzymać „Powerful” 5 s, aż pojawi się „SP 1” – internet ani chmura nie są potrzebne), a w aplikacji Daikin sterowanie mocą jest ustawione na „Wł.”. „Wył.” oznacza tam zawsze 100 %; „Auto” oznacza, że reguluje chmura.',
        'У Daikin обмеження потужності діє, лише якщо ввімкнено оригінальний Wi-Fi-модуль Daikin (пульт: утримувати «Powerful» 5 с, доки не з’явиться «SP 1» – інтернет і хмара не потрібні) і в застосунку Daikin керування потужністю встановлено на «Увімк.». «Вимк.» там завжди означає 100 %; «Авто» означає, що регулює хмара.',
        '对于 Daikin，只有在原装 Daikin Wi-Fi 模块已开启（遥控器：按住“Powerful”5 秒直到显示“SP 1” – 无需互联网或云端），且 Daikin 应用中的功率控制设为“开”时，功率上限才会生效。“关”在那里始终表示 100 %；“自动”表示由云端调节。',
    ),
    kFaikoutPlan: L(
        'Faikout auto: the weekly schedule changes the target {n} times on one day. In this mode every change of the target is stored in the module (flash memory). Recommendation: choose “Adapter controls”.',
        'Faikout-Auto: Der Wochenplan ändert das Ziel an einem Tag {n}-mal. In dieser Betriebsart wird jede Zieländerung im Modul gespeichert (Flash-Speicher). Empfehlung: „Adapter regelt“ wählen.',
        'Faikout-авто: недельное расписание меняет цель {n} раз за день. В этом режиме каждое изменение цели сохраняется в модуле (флеш-память). Рекомендация: выбрать «Регулирует адаптер».',
        'Faikout automático: o programa semanal altera o alvo {n} vezes num dia. Neste modo, cada alteração do alvo é guardada no módulo (memória flash). Recomendação: escolher «O adaptador regula».',
        'Faikout-auto: het weekschema wijzigt het doel {n} keer op één dag. In deze modus wordt elke doelwijziging in de module opgeslagen (flashgeheugen). Advies: kies “Adapter regelt”.',
        'Faikout auto : le programme hebdomadaire modifie la cible {n} fois en une journée. Dans ce mode, chaque changement de cible est enregistré dans le module (mémoire flash). Recommandation : choisir « L’adaptateur régule ».',
        'Faikout auto: il programma settimanale cambia l’obiettivo {n} volte in un giorno. In questa modalità ogni cambio di obiettivo viene salvato nel modulo (memoria flash). Consiglio: scegliere «Regola l’adattatore».',
        'Faikout automático: el programa semanal cambia el objetivo {n} veces en un día. En este modo cada cambio de objetivo se guarda en el módulo (memoria flash). Recomendación: elegir «Regula el adaptador».',
        'Faikout auto: harmonogram tygodniowy zmienia cel {n} razy w ciągu dnia. W tym trybie każda zmiana celu jest zapisywana w module (pamięć flash). Zalecenie: wybrać „Reguluje adapter”.',
        'Faikout-авто: тижневий розклад змінює ціль {n} разів за день. У цьому режимі кожна зміна цілі зберігається в модулі (флеш-пам’ять). Рекомендація: вибрати «Регулює адаптер».',
        'Faikout 自动：周计划在一天内更改目标 {n} 次。此模式下每次目标变更都会保存到模块（闪存）。建议：选择“由适配器调节”。',
    ),
    fuehlerKorrektur: L(
        'Sensor correction',
        'Fühlerkorrektur',
        'Поправка датчика',
        'Correção do sensor',
        'Sensorcorrectie',
        'Correction du capteur',
        'Correzione del sensore',
        'Corrección del sensor',
        'Korekta czujnika',
        'Поправка датчика',
        '传感器修正',
    ),
    zielKurz: L('target', 'Ziel', 'цель', 'alvo', 'doel', 'cible', 'obiettivo', 'objetivo', 'cel', 'ціль', '目标'),
    mFehlt: L(
        'Not available on this module (depends on firmware and unit): {felder}',
        'Bei diesem Modul nicht vorhanden (hängt von Firmware und Anlage ab): {felder}',
        'На этом модуле отсутствует (зависит от прошивки и устройства): {felder}',
        'Não disponível neste módulo (depende do firmware e do aparelho): {felder}',
        'Niet aanwezig op deze module (hangt af van firmware en toestel): {felder}',
        'Absent sur ce module (dépend du firmware et de l’appareil) : {felder}',
        'Non presente su questo modulo (dipende da firmware e apparecchio): {felder}',
        'No disponible en este módulo (depende del firmware y del equipo): {felder}',
        'Niedostępne w tym module (zależy od oprogramowania i urządzenia): {felder}',
        'На цьому модулі відсутнє (залежить від прошивки та пристрою): {felder}',
        '此模块不提供（取决于固件和设备）：{felder}',
    ),
    brokerFehler: L(
        'Connection failed: {grund}',
        'Verbindung fehlgeschlagen: {grund}',
        'Не удалось подключиться: {grund}',
        'A ligação falhou: {grund}',
        'Verbinding mislukt: {grund}',
        'Échec de la connexion : {grund}',
        'Connessione non riuscita: {grund}',
        'La conexión falló: {grund}',
        'Połączenie nie powiodło się: {grund}',
        'Не вдалося під’єднатися: {grund}',
        '连接失败：{grund}',
    ),
    mLeer: L(
        '(empty)',
        '(leer)',
        '(пусто)',
        '(vazio)',
        '(leeg)',
        '(vide)',
        '(vuoto)',
        '(vacío)',
        '(puste)',
        '(порожньо)',
        '（空）',
    ),
};

/**
 * Text in einer Sprache mit eingesetzten Werten.
 *
 * @param {string} schluessel  Schluessel in TEXTE
 * @param {string} sprache  Sprache
 * @param {Record<string, string|number>} [werte]  Platzhalter
 * @returns {string} Text
 */
function t(schluessel, sprache, werte = {}) {
    const e = TEXTE[schluessel] || {};
    let s = e[sprache] || e.en || schluessel;
    for (const [k, v] of Object.entries(werte)) {
        s = s.split(`{${k}}`).join(String(v));
    }
    return s;
}

/**
 * Text in allen Sprachen mit eingesetzten Werten.
 *
 * @param {string} schluessel  Schluessel in TEXTE
 * @param {Record<string, string|number>} [werte]  Platzhalter
 * @returns {Record<string, string>} Text je Sprache
 */
function alle(schluessel, werte = {}) {
    return Object.fromEntries(SPRACHEN.map(s => [s, t(schluessel, s, werte)]));
}

const esc = bild.esc;
const text = v => String(v === undefined || v === null ? '' : v).trim();

/** Farben fuer Meldungen: gruen/gelb/grau, auf hellem und dunklem Grund lesbar. */
const AMPEL = { gut: '#3d9a50', warn: '#d98a00', aus: '#8a8a8a', fehler: '#d9534f' };

// ------------------------------------------------------------------ Zugriff auf den Adapter

/**
 * Wert eines Datenpunkts dieses Adapters oder null.
 *
 * @param {object} adapter  Adapter
 * @param {string} rel  ID ohne Namensraum
 * @returns {Promise<unknown>} Wert
 */
async function lies(adapter, rel) {
    try {
        const s = await adapter.getStateAsync(rel);
        return s ? s.val : null;
    } catch {
        return null;
    }
}

/**
 * Sprache des Systems.
 *
 * @param {object} adapter  Adapter
 * @returns {Promise<string>} Sprachkuerzel
 */
async function sprache(adapter) {
    if (typeof adapter.sprache === 'function') {
        const s = await adapter.sprache();
        return SPRACHEN.includes(s) ? s : 'en';
    }
    return 'en';
}

/**
 * Geraete-ID zu dem, was in einer Zeile der Einstellungen steht (ID oder Name).
 *
 * @param {object} adapter  Adapter
 * @param {unknown} wert  ID oder Name
 * @returns {string} ID, wenn bekannt, sonst der Wert selbst
 */
function geraetId(adapter, wert) {
    const w = text(wert);
    if (!w || !adapter.geraete || adapter.geraete.has(w)) {
        return w;
    }
    for (const [id, g] of adapter.geraete) {
        if (g && g.name === w) {
            return id;
        }
    }
    return w;
}

/**
 * Zeile eines Geraets in den Instanzeinstellungen (regelGeraete), gesucht ueber ID oder Name.
 *
 * @param {object} adapter  Adapter
 * @param {string} [id]  Geraete-ID
 * @returns {object} Zeile oder leeres Objekt
 */
function geraeteZeile(adapter, id) {
    const liste = adapter.config && Array.isArray(adapter.config.regelGeraete) ? adapter.config.regelGeraete : [];
    const g = id && adapter.geraete && adapter.geraete.get(id);
    return liste.find(z => z && id && (text(z.geraet) === id || (g && text(z.geraet) === g.name))) || {};
}

/**
 * Szenen eines Geraets (ID -> Szene). Die Regelung kennt sie (szenenVon); ohne laufende Regelung
 * aus der Konfiguration: Szenen des Geraets, sonst die Vorgabe der Instanz, sonst die Werksvorgabe.
 *
 * @param {object} adapter  Adapter
 * @param {string} [id]  Geraete-ID
 * @returns {Map<string, object>} Szenen
 */
function szenen(adapter, id) {
    const r = adapter.regelung;
    if (id && r && typeof r.szenenVon === 'function') {
        const m = r.szenenVon(id);
        if (m instanceof Map && m.size) {
            return m;
        }
    }
    const eigene = geraeteZeile(adapter, id).szenen;
    if (Array.isArray(eigene) && eigene.length) {
        const gelesen = wochenplan.szenenLesen(eigene);
        if (!gelesen.fehler && gelesen.szenen.size) {
            return gelesen.szenen;
        }
    }
    const laufend = r && r.einstellung && r.einstellung.szenen;
    return laufend instanceof Map && laufend.size
        ? laufend
        : wochenplan.szenenLesen(adapter.config && adapter.config.regelSzenen).szenen;
}

/**
 * Wirksame Einstellung der Bedarfsregelung eines Geraets (Instanzvorgabe oder eigene Kennlinie).
 *
 * @param {object} adapter  Adapter
 * @param {string} id  Geraete-ID
 * @returns {{heizen: number[][], kuehlen: number[][], untergrenze: number, obergrenze: number, strategie: string}} Einstellung
 */
function bedarfKonfig(adapter, id) {
    const c = adapter.config || {};
    const zahl = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    let k = null;
    try {
        const e = adapter.regelung && adapter.regelung.einstellung;
        const r = adapter.regelung && adapter.regelung.geraete && adapter.regelung.geraete.get(id);
        const g = adapter.geraete && adapter.geraete.get(id);
        const je = e && typeof e.fuer === 'function' ? e.fuer(id, g ? g.name : id) : null;
        k = r && r.konfig && r.konfig.bedarf ? r.konfig.bedarf : je && je.konfig ? je.konfig.bedarf : e && e.konfig;
    } catch {
        k = null;
    }
    if (k && Array.isArray(k.heizen) && Array.isArray(k.kuehlen)) {
        return {
            heizen: k.heizen,
            kuehlen: k.kuehlen,
            untergrenze: k.untergrenze,
            obergrenze: k.obergrenze,
            strategie: k.strategie,
        };
    }
    const lesen = (roh, vorgabe) => {
        const p = kennlinie.lesen(text(roh) || Array.isArray(roh) ? roh : vorgabe);
        return p.punkte.length ? p.punkte : vorgabe;
    };
    return {
        heizen: lesen(c.regelKennlinieHeizen, kennlinie.VORGABE_HEIZEN),
        kuehlen: lesen(c.regelKennlinieKuehlen, kennlinie.VORGABE_KUEHLEN),
        untergrenze: zahl(c.regelUntergrenze, 40),
        obergrenze: zahl(c.regelObergrenze, 95),
        strategie: c.regelStrategie === 'vortag' ? 'vortag' : 'kennlinie',
    };
}

/**
 * Gilt fuer dieses Geraet der Probelauf? (Instanz ODER Geraet - nur beides aus sendet.)
 *
 * @param {object} adapter  Adapter
 * @param {string} id  Geraete-ID
 * @returns {Promise<boolean>} Probelauf
 */
async function probelauf(adapter, id) {
    const global = !adapter.config || adapter.config.regelProbelauf !== false;
    return global || (await lies(adapter, `${id}.regel.bedarf.probelauf`)) !== false;
}

/**
 * Arbeitspunkt eines Geraets aus den Datenpunkten der Regelung.
 *
 * @param {object} adapter  Adapter
 * @param {string} id  Geraete-ID
 * @returns {Promise<{x: number|null, wert: number|null, roh: number|null, richtung: 'heizen'|'kuehlen'|null, probelauf: boolean, aktiv: boolean}>} Arbeitspunkt
 */
async function arbeitspunkt(adapter, id) {
    const feld = f => `${id}.${felder.FELDER[f].kanal}.${felder.objektId(f)}`;
    const mittel = await lies(adapter, `${id}.regel.bedarf.aussenMittel`);
    const aussen =
        Number.isFinite(mittel) && mittel !== null ? mittel : await lies(adapter, `${id}.regel.fuehler.aussen`);
    const an = (await lies(adapter, feld('power'))) === true;
    const modus = await lies(adapter, feld('mode'));
    const taetigkeit = await lies(adapter, feld('action'));
    let richtung = null;
    if (an && modus === 'heat') {
        richtung = 'heizen';
    } else if (an && modus === 'cool') {
        richtung = 'kuehlen';
    } else if (an && modus === 'heat_cool') {
        richtung = taetigkeit === 'cooling' ? 'kuehlen' : 'heizen';
    }
    const aktiv = (await lies(adapter, `${id}.regel.bedarf.aktiv`)) === true;
    const soll = await lies(adapter, `${id}.regel.bedarf.sollwert`);
    const roh = await lies(adapter, `${id}.regel.bedarf.rohwert`);
    return {
        x: typeof aussen === 'number' && Number.isFinite(aussen) ? aussen : null,
        wert: aktiv && typeof soll === 'number' ? soll : null,
        roh: typeof roh === 'number' ? roh : null,
        richtung,
        probelauf: await probelauf(adapter, id),
        aktiv,
    };
}

// ------------------------------------------------------------------ Kennlinie

/**
 * Prueft Stuetzpunkte und nennt den Fehler als Schluessel in TEXTE (uebersetzbar).
 *
 * @param {unknown} roh  Text "x:y, x:y", [[x, y], ...] oder [{x, y}, ...]
 * @param {'heizen'|'kuehlen'} richtung  Richtung
 * @returns {{punkte: number[][], fehler: {schluessel: string, werte: object}|null}} Punkte und Fehler
 */
function kennliniePruefen(roh, richtung) {
    const gelesen = kennlinie.lesen(typeof roh === 'string' || Array.isArray(roh) ? roh : '');
    const punkte = gelesen.punkte || [];
    const fehler = (schluessel, werte = {}) => ({ punkte, fehler: { schluessel, werte } });
    if (punkte.length < 2) {
        return fehler('fZuWenig');
    }
    for (let i = 0; i < punkte.length; i++) {
        const [x, y] = punkte[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return fehler('fZahl', { n: i + 1 });
        }
        if (y < 0 || y > 100) {
            return fehler('fBereich', { n: i + 1 });
        }
        if (i > 0) {
            if (x <= punkte[i - 1][0]) {
                return fehler('fAufsteigend');
            }
            if (richtung === 'heizen' && y > punkte[i - 1][1]) {
                return fehler('fFallend');
            }
            if (richtung === 'kuehlen' && y < punkte[i - 1][1]) {
                return fehler('fSteigend');
            }
        }
    }
    return { punkte, fehler: null };
}

/**
 * Kennlinienbild mit Beschriftung in einer Sprache.
 *
 * @param {object} o  Angaben
 * @param {number[][]} o.punkte  Stuetzpunkte
 * @param {'heizen'|'kuehlen'} o.richtung  Richtung
 * @param {number} o.untergrenze  Untergrenze
 * @param {number} o.obergrenze  Obergrenze
 * @param {object|null} [o.punkt]  Arbeitspunkt aus arbeitspunkt()
 * @param {string} o.sprache  Sprache
 * @param {boolean} [o.ohneTitel]  keine Ueberschrift im Bild
 * @param {number} [o.breite]  Breite
 * @param {number} [o.hoehe]  Hoehe
 * @returns {string} SVG
 */
function kennlinieSvg(o) {
    const s = o.sprache;
    let ap = null;
    const p = o.punkt;
    if (p && p.x !== null) {
        const meine = p.richtung === o.richtung;
        ap = { x: p.x, wert: meine ? p.wert : null };
        if (meine && p.wert !== null) {
            ap.text = t(p.probelauf ? 'wuerdeSenden' : 'sendet', s, { p: bild.zahl(p.wert) });
            ap.unterzeile =
                p.roh !== null
                    ? t('unterzeile', s, { r: bild.zahl(p.roh, 1), t: bild.zahl(p.x, 1) })
                    : t('aussenBei', s, { t: bild.zahl(p.x, 1) });
        } else {
            ap.text = t('aussenBei', s, { t: bild.zahl(p.x, 1) });
        }
    }
    return bild.kennlinie({
        punkte: o.punkte,
        richtung: o.richtung,
        untergrenze: o.untergrenze,
        obergrenze: o.obergrenze,
        arbeitspunkt: ap,
        breite: o.breite,
        hoehe: o.hoehe,
        texte: {
            titel: o.ohneTitel ? '' : t(o.richtung === 'kuehlen' ? 'kennlinieKuehlen' : 'kennlinieHeizen', s),
            untergrenze: t('untergrenze', s),
            obergrenze: t('obergrenze', s),
            leer: t('fZuWenig', s),
        },
    });
}

/**
 * Antwort auf "regelKennlinieBild": das Bild als HTML fuer ein textSendTo-Element der
 * Einstellungsseite. Die Werte kommen aus dem (ungespeicherten) Formular.
 *
 * @param {object} adapter  Adapter
 * @param {object} msg  {richtung, punkte, untergrenze, obergrenze, geraet}
 * @returns {Promise<string>} HTML
 */
async function kennlinieHtml(adapter, msg) {
    const s = await sprache(adapter);
    const richtung = msg.richtung === 'kuehlen' ? 'kuehlen' : 'heizen';
    const c = adapter.config || {};
    const leer = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    const roh = leer(msg.punkte)
        ? richtung === 'kuehlen'
            ? kennlinie.VORGABE_KUEHLEN
            : kennlinie.VORGABE_HEIZEN
        : msg.punkte;
    const zahl = (v, d) => (leer(v) || !Number.isFinite(Number(v)) ? d : Number(v));
    const unter = zahl(msg.untergrenze, zahl(c.regelUntergrenze, 40));
    const ober = zahl(msg.obergrenze, zahl(c.regelObergrenze, 95));
    const pruefung = kennliniePruefen(roh, richtung);
    const id = geraetId(adapter, msg.geraet);
    const punkt = id && adapter.geraete && adapter.geraete.has(id) ? await arbeitspunkt(adapter, id) : null;
    const meldungen = [];
    if (pruefung.fehler) {
        meldungen.push(t(pruefung.fehler.schluessel, s, pruefung.fehler.werte));
    }
    if (!(unter >= 30 && unter <= ober && ober <= 100)) {
        meldungen.push(t('fGrenzen', s));
    }
    const svg = kennlinieSvg({
        punkte: pruefung.punkte,
        richtung,
        untergrenze: unter,
        obergrenze: ober,
        punkt: pruefung.fehler ? null : punkt,
        sprache: s,
    });
    const warnung = meldungen
        .map(
            m =>
                `<div style="margin-top:6px;padding:6px 10px;border-radius:6px;border:1px solid ${AMPEL.fehler};color:${AMPEL.fehler};font-size:0.9em">${esc(m)}</div>`,
        )
        .join('');
    return `<div style="max-width:640px">${svg}${warnung}</div>`;
}

// ------------------------------------------------------------------ Was diese Anlage kann

/**
 * Antwort auf "regelKann": Faehigkeiten einer Anlage als HTML.
 *
 * @param {object} adapter  Adapter
 * @param {object} msg  {geraet}
 * @returns {Promise<string>} HTML
 */
async function kannHtml(adapter, msg) {
    const s = await sprache(adapter);
    const id = geraetId(adapter, msg.geraet);
    const blass = 'opacity:0.75;font-size:0.9em';
    if (!id) {
        return `<div style="${blass}">${esc(t('kWaehlen', s))}</div>`;
    }
    if (!adapter.geraete || !adapter.geraete.has(id)) {
        return `<div style="${blass}">${esc(t('keineDaten', s))}</div>`;
    }
    const hinweis = text =>
        `<div style="margin-top:10px;padding:8px 12px;border-radius:6px;border:1px solid ${AMPEL.warn};background:rgba(217,138,0,0.12)">${esc(text)}</div>`;
    const hinweise = [];
    const faehig = await lies(adapter, `${id}.info.demandFaehig`);
    const raumQuelle = text(await lies(adapter, `${id}.regel.fuehler.raumQuelle`));
    const feuchte = await lies(adapter, `${id}.regel.fuehler.feuchte`);
    // Art des Raumfuehlers aus dem eigenen Datenpunkt; aeltere Geraete ohne ihn: am Quellentext
    const raumArt = await lies(adapter, `${id}.regel.fuehler.raumArt`);
    const ble = typeof raumArt === 'string' ? raumArt === 'ble' : raumQuelle.startsWith('BLE');
    const punkte = [
        faehig === 'ja'
            ? ['gut', 'kDemandJa', 'kDemandJaSub']
            : faehig === 'nein'
              ? ['warn', 'kDemandNein', 'kDemandNeinSub']
              : ['aus', 'kDemandUnb', 'kDemandUnbSub'],
        ble ? ['gut', 'kBleJa', 'kBleJaSub'] : ['aus', 'kBleNein', 'kBleNeinSub'],
        typeof feuchte === 'number'
            ? ['gut', 'kFeuchteJa', 'kFeuchteJaSub']
            : ['warn', 'kFeuchteNein', 'kFeuchteNeinSub'],
    ];
    const eintrag = ([farbe, titel, unter]) => {
        const [vorn, hinten] = t(titel, s).split(/[:：]\s*/);
        return (
            '<div style="display:flex;gap:10px;align-items:flex-start;flex:1 1 240px;min-width:220px">' +
            `<span style="flex:none;width:10px;height:10px;border-radius:50%;margin-top:6px;background:${AMPEL[farbe]}"></span>` +
            `<div><div>${esc(vorn)}: <b>${esc(hinten || '')}</b></div><div style="${blass}">${esc(t(unter, s))}</div></div></div>`
        );
    };
    if (faehig === 'nein') {
        // Begruendung der Regelung (wenn sie eine liefert), darunter der Hinweis fuer Daikin-Anlagen
        const grund = text(await lies(adapter, `${id}.regel.bedarf.faehigGrund`));
        if (grund) {
            hinweise.push(`<div style="margin-top:10px;${blass}">${esc(grund)}</div>`);
        }
        hinweise.push(hinweis(t('kDaikin', s)));
    }
    // Faikout-Auto speichert jede Zielaenderung im Modul: bei vielen Schaltpunkten am Tag warnen.
    // `betrieb` kommt aus dem (ungespeicherten) Formular.
    if (msg.betrieb === 'faikout') {
        const sz = szenen(adapter, id);
        const plan = wochenplan.planLesen((await lies(adapter, `${id}.regel.plan.wocheJson`)) || '', sz).plan;
        const n = zielwechselMax(plan, sz);
        if (n >= ZIELWECHSEL_WARNUNG) {
            hinweise.push(hinweis(t('kFaikoutPlan', s, { n })));
        }
    }
    return `<div style="display:flex;flex-wrap:wrap;gap:12px 24px">${punkte.map(eintrag).join('')}</div>${hinweise.join('')}`;
}

/** Ab so vielen Zielaenderungen an einem Tag warnt die Oberflaeche bei Faikout-Auto (Flash im Modul). */
const ZIELWECHSEL_WARNUNG = 6;

/**
 * Hoechste Zahl der Schaltpunkte MIT Zielaenderung an einem Tag: gezaehlt wird ein Schaltpunkt,
 * dessen Szene eine andere Zieltemperatur (oder Ein/Aus) hat als die davor geltende.
 *
 * @param {Array<Array<{t: number, s: string}>>|null} plan  Wochenplan
 * @param {Map<string, object>} sz  Szenen
 * @returns {number} Hoechstwert ueber die sieben Tage
 */
function zielwechselMax(plan, sz) {
    if (!Array.isArray(plan) || plan.length !== 7) {
        return 0;
    }
    const ziel = id => {
        const e = sz.get(id);
        return e ? (e.power ? `an:${e.soll}` : 'aus') : '';
    };
    // Szene, die vor Montag 00:00 gilt: die letzte der Woche
    let davor = '';
    for (const tag of plan) {
        if (tag.length) {
            davor = ziel(tag[tag.length - 1].s);
        }
    }
    let max = 0;
    for (const tag of plan) {
        let n = 0;
        for (const e of tag) {
            const z = ziel(e.s);
            if (z !== davor) {
                n++;
            }
            davor = z;
        }
        max = Math.max(max, n);
    }
    return max;
}

// ------------------------------------------------------------------ Wochenplan-Seite

/** Tageskuerzel der Wochenplan-Seite (Index 0 = Montag). */
const TAGE = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Farben der Szenen: bekannte Namen fest, weitere der Reihe nach. Hell: weisse Schrift, dunkel: dunkle Schrift. */
const SZENEN_FARBEN = {
    hell: { komfort: '#a3492f', absenken: '#4a7350', abwesend: '#3e5c8a', aus: '#6b6b6b' },
    dunkel: { komfort: '#d4896b', absenken: '#8fb391', abwesend: '#8ea6cf', aus: '#a0a0a0' },
    weitereHell: ['#7a4a8c', '#2f7a7a', '#8a6a1f', '#8c2336', '#55687a'],
    weitereDunkel: ['#c09ad0', '#7fc4c4', '#d3b56a', '#dd8fa0', '#9eacb9'],
};

/**
 * Farbe je Szene fuer hell und dunkel.
 *
 * @param {Map<string, object>} sz  Szenen
 * @returns {{hell: Record<string, string>, dunkel: Record<string, string>}} Farben nach Szenen-ID
 */
function szenenFarben(sz) {
    const hell = {};
    const dunkel = {};
    let n = 0;
    for (const id of sz.keys()) {
        if (SZENEN_FARBEN.hell[id]) {
            hell[id] = SZENEN_FARBEN.hell[id];
            dunkel[id] = SZENEN_FARBEN.dunkel[id];
        } else {
            hell[id] = SZENEN_FARBEN.weitereHell[n % SZENEN_FARBEN.weitereHell.length];
            dunkel[id] = SZENEN_FARBEN.weitereDunkel[n % SZENEN_FARBEN.weitereDunkel.length];
            n++;
        }
    }
    return { hell, dunkel };
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Wochenplan der Regelung -> Zeilen der Wochenplan-Seite.
 *
 * @param {Array<Array<{t: number, s: string}>>|null} plan  Plan (7 Tage) oder null
 * @returns {Array<{day: string, time: string, type: string}>} Zeilen
 */
function planZuProgramm(plan) {
    const zeilen = [];
    (Array.isArray(plan) ? plan : []).forEach((tag, d) => {
        for (const e of Array.isArray(tag) ? tag : []) {
            zeilen.push({ day: TAGE[d], time: hhmm(e.t), type: e.s });
        }
    });
    return zeilen;
}

/**
 * Zeilen der Wochenplan-Seite -> geprufter Wochenplan.
 *
 * @param {unknown} zeilen  [{day, time, type}, ...]
 * @param {Map<string, object>} sz  Szenen
 * @returns {{plan: Array<Array<{t: number, s: string}>>|null, fehler: string|null}} Plan oder Fehler (Text der Regelung)
 */
function programmZuPlan(zeilen, sz) {
    const plan = [[], [], [], [], [], [], []];
    for (const z of Array.isArray(zeilen) ? zeilen : []) {
        const d = TAGE.indexOf(z && z.day);
        const m = /^(\d{1,2}):(\d{2})$/.exec(String((z && z.time) || ''));
        if (d < 0 || !m) {
            return { plan: null, fehler: `Schaltpunkt ${JSON.stringify(z)} ungültig` };
        }
        plan[d].push({ t: Number(m[1]) * 60 + Number(m[2]), s: String(z.type || '') });
    }
    return wochenplan.planLesen(plan, sz);
}

const z2 = n => String(n).padStart(2, '0');

/**
 * Zeitstempel -> "YYYY-MM-DDTHH:MM" in Ortszeit des Adapters (fuer <input type=datetime-local>).
 *
 * @param {number} ms  Zeitstempel
 * @returns {string} Text
 */
function ortszeitText(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}T${z2(d.getHours())}:${z2(d.getMinutes())}`;
}

/**
 * "YYYY-MM-DDTHH:MM" (Ortszeit des Adapters) -> Zeitstempel oder NaN.
 *
 * @param {unknown} s  Text
 * @returns {number} ms
 */
function ortszeitLesen(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
}

/**
 * Texte der Wochenplan-Seite in einer Sprache.
 *
 * @param {string} s  Sprache
 * @returns {Record<string, string>} Texte
 */
function planTexte(s) {
    const schluessel = [
        'pTagKopieren',
        'pTagEinfuegen',
        'pNeu',
        'pNeuUm',
        'pLoeschen',
        'pLoeschenFrage',
        'pAbbrechen',
        'pSchaltpunkte',
        'pHinweis',
        'pSzeneAb',
        'pVorgabe',
        'pAbwesenheit',
        'pVon',
        'pBis',
        'pSzeneInZeit',
        'pFeiertag',
        'pPlanAus',
        'pAbwFehler',
        'kFaikoutPlan',
    ];
    return Object.fromEntries(schluessel.map(k => [k, t(k, s)]));
}

/**
 * Szenen als Auswahl fuer die Wochenplan-Seite.
 *
 * @param {Map<string, object>} sz  Szenen
 * @param {string} s  Sprache
 * @returns {Array<{type: string, label: string, info: string}>} Auswahl
 */
function planTypen(sz, s) {
    return [...sz.values()].map(e => ({
        type: e.id,
        label: e.name,
        // Ziel der Szene: daran erkennt die Wochenplan-Seite Schaltpunkte mit Zielaenderung
        ziel: e.power ? `an:${e.soll}` : 'aus',
        info: e.power
            ? `${bild.zahl(e.soll, Number.isInteger(e.soll) ? 0 : 1)} °C${e.deckel < 100 ? ` · ${t('pMax', s)} ${e.deckel} %` : ''}`
            : t('pAnlageAus', s),
    }));
}

// ------------------------------------------------------------------ Modul-Einstellungen

/** Einstellungen, die die Oberflaeche zeigt und schreibt (feste Liste, siehe lib/moduleinstellungen.js). */
const MODUL_FELDER = moduleinstellungen.FELDER;

/** Reiter der Einstellungsseite des Moduls: Basic, Faikout, Extra, Library. */
const MODUL_SEITEN = [-1, 0, -2, -3];

/**
 * Liest alle Eingabefelder einer Einstellungsseite des Moduls.
 *
 * @param {string} html  Seiteninhalt
 * @returns {Record<string, string|boolean>} Feld -> Wert (Schalter als boolean)
 */
function modulSeiteLesen(html) {
    const werte = {};
    const attribute = tag => {
        const a = {};
        const re = /([a-zA-Z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
        let m;
        while ((m = re.exec(tag))) {
            a[m[1].toLowerCase()] = discovery.entmaskieren(m[2] ?? m[3] ?? m[4] ?? '');
        }
        return a;
    };
    for (const m of String(html || '').matchAll(/<input\b([^>]*)>/g)) {
        const a = attribute(m[1]);
        const name = String(a.name || '');
        // "_feld" = unveraendert, "__feld" = verstecktes Begleitfeld eines Schalters
        if (!name.startsWith('_') || name.startsWith('__')) {
            continue;
        }
        const feld = name.slice(1);
        // Zugangsdaten nie uebernehmen - manche Firmware zeigt Passwortfelder als gewoehnliche Textfelder
        if (/pass|password|cookie/i.test(feld)) {
            continue;
        }
        if (!feld || feld in werte || a.type === 'submit' || a.type === 'radio' || a.type === 'password') {
            continue;
        }
        werte[feld] = a.type === 'checkbox' ? 'checked' in a : a.value || '';
    }
    return werte;
}

/**
 * Liest die Einstellungen eines Moduls - NUR GET. Fragt die vier Reiter nacheinander ab.
 *
 * @param {string} ip  Adresse des Moduls
 * @param {object} [opt]  {request, timer, timeoutMs} wie discovery.seiteHolen
 * @returns {Promise<{ok: boolean, art?: string, fehler?: string, name?: string, werte?: Record<string, string|boolean>}>} Ergebnis
 */
async function modulLesen(ip, opt = {}) {
    const basis = opt.request || http.request;
    const werte = {};
    let name = '';
    // "adresse:port" ist erlaubt (Simulator, Portweiterleitung); ohne Angabe Port 80
    const teile = /^([^:]+):(\d{1,5})$/.exec(ip);
    const ziel = teile ? { host: teile[1], port: Number(teile[2]) } : {};
    for (const seite of MODUL_SEITEN) {
        // Dieselbe gepruefte Leseroutine wie die Modulsuche, nur mit dem Reiter in der Adresse.
        // Die Methode steht fest auf GET - ein POST wuerde im Modul speichern.
        const request = (o, cb) => basis({ ...o, ...ziel, method: 'GET', path: `/revk-settings?_page=${seite}` }, cb);
        const r = await discovery.seiteHolen(ip, {
            timeoutMs: opt.timeoutMs || 4000,
            timer: opt.timer,
            request,
            methode: 'GET',
        });
        const fp = discovery.antwortAuswerten(ip, r);
        if (!fp.ok) {
            return { ok: false, art: 'nichtErreicht', fehler: fp.fehler || 'no answer' };
        }
        if (!fp.faikout) {
            return { ok: false, art: fp.art === 'weblogin' ? 'passwort' : 'keinFaikout' };
        }
        if (fp.art === 'passwort') {
            return { ok: false, art: 'passwort' };
        }
        name = name || fp.titel || fp.hostname || '';
        // Behalten wird NUR, was die Oberflaeche zeigt und schreiben darf (feste Liste). Alles andere -
        // Netz, Broker, Zugangsdaten - verlaesst den Adapter nicht und landet in keiner Sicherung.
        const seiteWerte = modulSeiteLesen(r.html);
        for (const f of MODUL_FELDER) {
            if (f.feld in seiteWerte && !(f.feld in werte)) {
                werte[f.feld] = seiteWerte[f.feld];
            }
        }
    }
    return { ok: true, name: name || ip, werte };
}

/**
 * Anzeige eines Werts in der Vorschau.
 *
 * @param {{art: string}} f  Feldbeschreibung
 * @param {unknown} v  Wert
 * @param {string} s  Sprache
 * @returns {string} Text
 */
function modulWertText(f, v, s) {
    if (f.art === 'bool') {
        return t(moduleinstellungen.wandeln('bool', v).wert ? 'mAn' : 'mAus', s);
    }
    return text(v) === '' ? t('mLeer', s) : text(v);
}

/**
 * Vergleicht Formular und gelesenen Stand.
 *
 * @param {Record<string, unknown>} gelesen  Stand aus dem Modul (Feldnamen des Moduls)
 * @param {Record<string, unknown>} formular  Formularwerte (Feldnamen `form`)
 * @returns {Array<{feld: string, form: string, art: string, alt: unknown, neu: unknown}>} Aenderungen
 */
function modulAenderungen(gelesen, formular) {
    return modulUnterschied(gelesen, formular).aenderungen;
}

/**
 * Wie modulAenderungen, zusaetzlich mit den abgewiesenen Eingaben.
 *
 * @param {Record<string, unknown>} gelesen  Stand aus dem Modul
 * @param {Record<string, unknown>} formular  Formularwerte (Feldnamen `form`)
 * @returns {{aenderungen: object[], fehler: Array<{feld: string, grund: string}>}} Unterschied
 */
function modulUnterschied(gelesen, formular) {
    const wunsch = {};
    for (const f of MODUL_FELDER) {
        if (formular && formular[f.form] !== undefined && formular[f.form] !== null) {
            wunsch[f.feld] = formular[f.form];
        }
    }
    const u = moduleinstellungen.unterschied(gelesen, wunsch);
    return {
        aenderungen: u.aenderungen.map(a => ({ ...a, form: MODUL_FELDER.find(f => f.feld === a.feld).form })),
        fehler: u.fehler,
    };
}

/**
 * Formularfelder aus einem Stand des Moduls.
 *
 * @param {Record<string, unknown>} werte  Stand (Feldnamen des Moduls)
 * @returns {Record<string, unknown>} Formularwerte
 */
function modulFormular(werte) {
    const native = {};
    for (const f of MODUL_FELDER) {
        const v = werte ? werte[f.feld] : undefined;
        const w = v === undefined ? {} : moduleinstellungen.wandeln(f.art, v);
        native[f.form] = v === undefined || w.fehler ? null : w.wert;
    }
    return native;
}

/**
 * Einstellungen der Liste, die dieses Modul nicht anbietet.
 *
 * @param {Record<string, unknown>} werte  gelesener Stand
 * @returns {string[]} Feldnamen
 */
function modulFehlend(werte) {
    return MODUL_FELDER.filter(f => !werte || !(f.feld in werte)).map(f => f.feld);
}

/**
 * Vorschau "alt -> neu" und der Plan, fuer den sie gilt.
 *
 * @param {object[]} aenderungen  Aenderungen
 * @param {string} name  Geraetename
 * @param {string} s  Sprache
 * @returns {{_modPlan: string, _modVorschau: string}} Formularwerte
 */
function modulVorschau(aenderungen, name, s) {
    if (!aenderungen.length) {
        return { _modPlan: '', _modVorschau: t('mKeineAenderung', s) };
    }
    const zeilen = aenderungen.map(a => {
        const f = moduleinstellungen.feldVon(a.feld);
        return `• ${a.feld}: ${modulWertText(f, a.alt, s)} → ${modulWertText(f, a.neu, s)}`;
    });
    return {
        _modPlan: JSON.stringify(aenderungen.map(a => [a.feld, a.neu])),
        _modVorschau: [t('mAenderungen', s, { name }), ...zeilen].join('\n'),
    };
}

/**
 * Geraet dieses Adapters zu einem Modulnamen (so meldet sich das Modul am Broker).
 *
 * @param {object} adapter  Adapter
 * @param {string} name  Name des Moduls
 * @returns {string|null} Geraete-ID oder null
 */
function geraetZuName(adapter, name) {
    for (const [id, g] of adapter.geraete || []) {
        if (g && g.name === name) {
            return id;
        }
    }
    return null;
}

/**
 * Sicherungen eines Geraets (native.modulSicherung im Geraeteobjekt), neueste zuletzt.
 *
 * @param {object} adapter  Adapter
 * @param {string|null} id  Geraete-ID
 * @returns {Promise<Array<{zeit: number, werte: Record<string, unknown>}>>} Sicherungen
 */
async function modulSicherungen(adapter, id) {
    if (!id) {
        return [];
    }
    try {
        const o = await adapter.getObjectAsync(id);
        const liste = o && o.native && o.native.modulSicherung;
        return Array.isArray(liste) ? liste.filter(x => x && typeof x.zeit === 'number' && x.werte) : [];
    } catch {
        return [];
    }
}

const zeitText = (ms, s) =>
    new Date(ms).toLocaleString(s, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Antwort auf modulEinstellungen{Liste,Lesen,Pruefen,Schreiben,Sicherungen,Wiederherstellen}.
 *
 * Lesen: fuellt die Formularfelder (`native`) und merkt den gelesenen Stand als JSON in `_modStand`.
 * Pruefen: nennt die Unterschiede; `_modPlan` haelt fest, wofuer die Vorschau gilt.
 * Schreiben: sichert den gelesenen Stand im Geraeteobjekt, sendet EINE Nachricht setting/<Name>
 *   ueber den eigenen Broker, liest per HTTP GET zurueck und nennt das Ergebnis je Feld.
 * Wiederherstellen: laedt eine Sicherung in das Formular und zeigt den Unterschied - geschrieben
 *   wird danach mit demselben Knopf und derselben Rueckfrage.
 *
 * @param {object} adapter  Adapter
 * @param {string} befehl  Befehl
 * @param {object} msg  Nachricht
 * @returns {Promise<object>} Antwort fuer die Einstellungsseite
 */
async function modulEinstellungen(adapter, befehl, msg) {
    const s = await sprache(adapter);
    const ip = text(msg.ip);
    if (befehl === 'modulEinstellungenListe') {
        // Module, deren Adresse der Adapter aus der Statusmeldung kennt, dazu die der letzten Suche
        const liste = [];
        const gesehen = new Set();
        for (const [id, g] of adapter.geraete || []) {
            const adresse = text(await lies(adapter, `${id}.info.ipv4`));
            if (adresse && !gesehen.has(adresse)) {
                gesehen.add(adresse);
                liste.push({ label: `${g.name} (${adresse})`, value: adresse });
            }
        }
        for (const m of adapter.letzteSuche || []) {
            if (m.ip && !gesehen.has(m.ip)) {
                gesehen.add(m.ip);
                liste.push({ label: `${m.name} (${m.ip})`, value: m.ip });
            }
        }
        return liste;
    }
    let stand = null;
    try {
        stand = JSON.parse(text(msg.stand) || 'null');
    } catch {
        stand = null;
    }
    if (befehl === 'modulEinstellungenSicherungen') {
        // selectSendTo: gesicherte Staende des gelesenen Moduls, neueste zuerst
        const liste = stand && stand.name ? await modulSicherungen(adapter, geraetZuName(adapter, stand.name)) : [];
        return liste
            .slice()
            .reverse()
            .map(x => ({ label: zeitText(x.zeit, s), value: String(x.zeit) }));
    }
    if (!ip) {
        return { error: t('mAdresseFehlt', s) };
    }
    const lesen = () =>
        typeof adapter.modulEinstellungenLesen === 'function'
            ? adapter.modulEinstellungenLesen({ ip })
            : modulLesen(ip, { timer: adapter });
    if (befehl === 'modulEinstellungenLesen') {
        const r = await lesen();
        if (!r.ok) {
            const schluessel = { nichtErreicht: 'mNichtErreicht', keinFaikout: 'mKeinFaikout', passwort: 'mPasswort' };
            return { error: t(schluessel[r.art] || 'mNichtErreicht', s, { ip, grund: r.fehler || '' }) };
        }
        adapter.log.info(`Module settings read from ${r.name} (${Object.keys(r.werte).length} fields)`);
        return {
            native: {
                _modStand: JSON.stringify({ ip, name: r.name, zeit: Date.now(), werte: r.werte }),
                _modPlan: '',
                _modVorschau: '',
                _modSicherung: '',
                // Der Feldumfang haengt von Firmware und Anlage ab: was das Modul nicht anbietet, wird
                // genannt, bleibt im Formular ausgeblendet und wird nie geschrieben.
                _modFehlt: modulFehlend(r.werte).length
                    ? t('mFehlt', s, { felder: modulFehlend(r.werte).join(', ') })
                    : '',
                _modHinweis: t('mGelesen', s, {
                    name: r.name,
                    zeit: new Date().toLocaleTimeString(s, { hour: '2-digit', minute: '2-digit' }),
                }),
                ...modulFormular(r.werte),
            },
        };
    }
    if (!stand || stand.ip !== ip || !stand.werte) {
        return { error: t('mErstLesen', s) };
    }
    if (befehl === 'modulEinstellungenWiederherstellen') {
        const liste = await modulSicherungen(adapter, geraetZuName(adapter, stand.name));
        const sicherung = liste.find(x => String(x.zeit) === text(msg.zeit));
        if (!sicherung) {
            return { error: t('mSicherungFehlt', s) };
        }
        const formular = { ...modulFormular(stand.werte) };
        for (const [k, v] of Object.entries(modulFormular(sicherung.werte))) {
            if (v !== null) {
                formular[k] = v;
            }
        }
        const v = modulVorschau(modulUnterschied(stand.werte, formular).aenderungen, stand.name, s);
        return {
            native: {
                ...formular,
                ...v,
                _modVorschau: `${t('mSicherungGeladen', s, { zeit: zeitText(sicherung.zeit, s) })}\n${v._modVorschau}`,
            },
        };
    }
    const u = modulUnterschied(stand.werte, msg.formular || {});
    if (u.fehler.length) {
        return { error: t('mEingabe', s, { feld: u.fehler[0].feld }) };
    }
    const aenderungen = u.aenderungen;
    if (befehl === 'modulEinstellungenPruefen') {
        return { native: modulVorschau(aenderungen, stand.name, s) };
    }
    if (befehl === 'modulEinstellungenSchreiben') {
        if (!aenderungen.length || text(msg.plan) !== JSON.stringify(aenderungen.map(a => [a.feld, a.neu]))) {
            return { error: t('mErstPruefen', s) };
        }
        const id = geraetZuName(adapter, stand.name);
        if (!id || !adapter.broker || typeof adapter.broker.publish !== 'function') {
            return { error: t('mNichtVerbunden', s, { name: stand.name }) };
        }
        // Sicherung des gelesenen Stands VOR dem Schreiben (hoechstens die letzten fuenf)
        const sicherungen = moduleinstellungen.sicherungAnhaengen(
            await modulSicherungen(adapter, id),
            stand.werte,
            Date.now(),
        );
        await adapter.extendObject(id, { native: { modulSicherung: sicherungen } });
        const zeitlimitMs = Number(msg.zeitlimitMs) > 0 ? Number(msg.zeitlimitMs) : moduleinstellungen.RUECKLESEN_MS;
        const r = await moduleinstellungen.schreiben({
            name: stand.name,
            aenderungen,
            senden: (topic, nutzlast) => adapter.broker.publish(topic, nutzlast),
            lesen,
            warten: ms => new Promise(res => adapter.setTimeout(res, ms)),
            zeitlimitMs,
            abstandMs: Number(msg.abstandMs) > 0 ? Number(msg.abstandMs) : undefined,
        });
        adapter.log.info(
            `Module settings written to ${stand.name}: ${aenderungen.map(a => a.feld).join(', ')} - ${r.art}`,
        );
        if (r.art === 'ungueltig') {
            return { error: t('mUngueltig', s, { grund: r.fehler }) };
        }
        if (r.art === 'nichtGesendet') {
            return { error: t('mNichtGesendet', s) };
        }
        if (r.art === 'zeit') {
            return {
                native: {
                    _modPlan: '',
                    _modStand: '',
                    _modVorschau: t('mZeit', s, { name: stand.name, s: Math.round(zeitlimitMs / 1000) }),
                },
            };
        }
        const zeilen = r.felder.map(f => {
            const d = moduleinstellungen.feldVon(f.feld);
            const ergebnis = f.ok ? t('mFeldOk', s) : t('mFeldNicht', s, { ist: modulWertText(d, f.ist, s) });
            return `${f.ok ? '✓' : '✗'} ${f.feld} = ${modulWertText(d, f.soll, s)}: ${ergebnis}`;
        });
        return {
            native: {
                ...modulFormular(r.werte),
                _modStand: JSON.stringify({ ip, name: stand.name, zeit: Date.now(), werte: r.werte }),
                _modPlan: '',
                _modSicherung: '',
                _modHinweis: t('mGelesen', s, {
                    name: stand.name,
                    zeit: new Date().toLocaleTimeString(s, { hour: '2-digit', minute: '2-digit' }),
                }),
                _modVorschau: [t(r.ok ? 'mErgebnisOk' : 'mErgebnisTeil', s, { name: stand.name }), ...zeilen].join(
                    '\n',
                ),
            },
        };
    }
    return { error: `unknown command ${befehl}` };
}

// ------------------------------------------------------------------ Nachrichten

/** Felder einer Geraetezeile, die "Uebernehmen" kopiert. */
const KOPIE_FELDER = {
    szenen: ['szenen'],
    kennlinie: [
        'strategie',
        'kennlinieHeizen',
        'kennlinieKuehlen',
        'untergrenze',
        'obergrenze',
        'vortagBezug',
        'vortagZuschlag',
        'vortagReferenzW',
    ],
};

/**
 * "Werte eines anderen Geraets uebernehmen": kopiert Szenen und/oder Kennlinie mit Grenzen von einer
 * Zeile der (ungespeicherten) Liste regelGeraete in eine andere. Aendert nichts im Adapter - die
 * Einstellungsseite bekommt die neue Liste zurueck, wirksam wird sie erst mit dem Speichern.
 *
 * @param {unknown} zeilen  regelGeraete aus dem Formular
 * @param {string} von  Geraet der Quellzeile
 * @param {string} nach  Geraet der Zielzeile
 * @param {string} was  'szenen' | 'kennlinie' | 'beides'
 * @returns {object[]|null} neue Liste oder null, wenn Quelle/Ziel fehlen
 */
function zeilenUebernehmen(zeilen, von, nach, was) {
    const liste = JSON.parse(JSON.stringify(Array.isArray(zeilen) ? zeilen : []));
    const quelle = liste.find(z => z && text(z.geraet) === text(von));
    const ziel = liste.find(z => z && text(z.geraet) === text(nach));
    if (!quelle || !ziel || quelle === ziel) {
        return null;
    }
    const feldListe = [
        ...(was !== 'kennlinie' ? KOPIE_FELDER.szenen : []),
        ...(was !== 'szenen' ? KOPIE_FELDER.kennlinie : []),
    ];
    for (const f of feldListe) {
        if (quelle[f] === undefined) {
            delete ziel[f];
        } else {
            ziel[f] = JSON.parse(JSON.stringify(quelle[f]));
        }
    }
    return liste;
}

/**
 * Ergebnis des Verbindungstests (lib/brokerextern.testen) als Formularwerte: `_brokerTest` nennt die
 * Art - dazu zeigt die Einstellungsseite den uebersetzten Text - und `_brokerTestText` die Meldung
 * fuer den Fall "fehler" (Text des Brokers bzw. der Verbindung, nicht uebersetzbar).
 *
 * @param {{ok?: boolean, art?: string, fehler?: string}|null} r  Ergebnis des Tests
 * @param {string} s  Sprache
 * @returns {{native: {_brokerTest: string, _brokerTestText: string}}} Antwort fuer den Knopf
 */
function brokerTestAntwort(r, s) {
    const bekannt = ['ok', 'anmeldung', 'nichtErreichbar', 'zeit', 'eingabe', 'fehler'];
    const art = r && r.ok ? 'ok' : r && bekannt.includes(r.art) && r.art !== 'ok' ? r.art : 'fehler';
    return {
        native: {
            _brokerTest: art,
            _brokerTestText: art === 'fehler' ? t('brokerFehler', s, { grund: text(r && r.fehler) || '?' }) : '',
        },
    };
}

/** Befehle, die diese Datei beantwortet. */
const BEFEHLE = new Set([
    'brokerVerbindungTesten',
    'regelGeraeteListe',
    'regelZeilenListe',
    'regelUebernehmen',
    'regelKennlinieBild',
    'regelKann',
    'modulEinstellungenListe',
    'modulEinstellungenLesen',
    'modulEinstellungenPruefen',
    'modulEinstellungenSchreiben',
    'modulEinstellungenSicherungen',
    'modulEinstellungenWiederherstellen',
    'wochenplanInfo',
    'wochenplanEntwurf',
    'wochenplanVorgabe',
]);

/**
 * Beantwortet die Nachrichten der Regelungs-Oberflaeche.
 *
 * @param {object} adapter  Adapter
 * @param {ioBroker.Message} obj  Nachricht
 * @returns {Promise<boolean>} true, wenn die Nachricht hier erledigt wurde
 */
async function nachricht(adapter, obj) {
    if (!obj || !BEFEHLE.has(obj.command)) {
        return false;
    }
    const msg = obj.message && typeof obj.message === 'object' ? obj.message : {};
    let antwort;
    try {
        switch (obj.command) {
            case 'brokerVerbindungTesten': {
                // Werte aus dem (ungespeicherten) Formular; leeres Passwort = das gespeicherte
                const c = adapter.config || {};
                const testen = adapter.brokerTestFunktion || require('./brokerextern').testen;
                const r = await testen({
                    host: text(msg.host),
                    port: Number(msg.port) || (msg.tls ? 8883 : 1883),
                    tls: msg.tls === true,
                    user: text(msg.user),
                    pass: text(msg.pass) || String(c.externPass || ''),
                    clientId: text(msg.clientId) || `iobroker-faikout-${adapter.instance ?? 0}`,
                });
                antwort = brokerTestAntwort(r, await sprache(adapter));
                break;
            }
            case 'regelGeraeteListe':
                // Wert = Name des Geraets: so steht er lesbar im Titel des Eintrags (die Regelung findet
                // die Zeile ueber ID oder Name). Alte Eintraege mit der ID bleiben gueltig.
                antwort = [...(adapter.geraete || new Map())].map(([id, g]) => ({
                    label: g.name || id,
                    value: g.name || id,
                }));
                break;
            case 'regelZeilenListe':
                // Geraete, die in der (ungespeicherten) Liste einen Eintrag haben
                antwort = (Array.isArray(msg.zeilen) ? msg.zeilen : [])
                    .map(text)
                    .filter(Boolean)
                    .map(w => {
                        const g = adapter.geraete && adapter.geraete.get(geraetId(adapter, w));
                        return { label: (g && g.name) || w, value: w };
                    });
                break;
            case 'regelUebernehmen': {
                // Die neue Liste wird SOFORT gespeichert und die Seite neu geladen: Tabellen innerhalb
                // eines Eintrags (Szenen, Stuetzpunkte) lesen ihre Zeilen nur beim Aufbau der Seite -
                // eine nur ins Formular gelegte Liste zeigten sie nicht an (im Admin 8.3.5 geprueft).
                const s = await sprache(adapter);
                const liste = zeilenUebernehmen(msg.zeilen, msg.von, msg.nach, msg.was);
                if (!liste) {
                    antwort = { error: t('kopieFehlt', s) };
                    break;
                }
                await adapter.extendForeignObjectAsync(`system.adapter.${adapter.namespace}`, {
                    native: { regelGeraete: liste },
                });
                adapter.log.info(`Settings of "${text(msg.von)}" copied to "${text(msg.nach)}" (${text(msg.was)})`);
                antwort = { reloadBrowser: true };
                break;
            }
            case 'regelKennlinieBild':
                antwort = await kennlinieHtml(adapter, msg);
                break;
            case 'regelKann':
                antwort = await kannHtml(adapter, msg);
                break;
            case 'wochenplanInfo':
            case 'wochenplanEntwurf':
            case 'wochenplanVorgabe':
                antwort =
                    adapter.deviceManagement && typeof adapter.deviceManagement.wochenplanNachricht === 'function'
                        ? await adapter.deviceManagement.wochenplanNachricht(obj.command, msg)
                        : { error: 'device manager not available' };
                break;
            default:
                antwort = await modulEinstellungen(adapter, obj.command, msg);
        }
    } catch (e) {
        adapter.log.warn(`${obj.command}: ${e.message}`);
        antwort = { error: e.message };
    }
    if (obj.callback) {
        adapter.sendTo(obj.from, obj.command, antwort, obj.callback);
    }
    return true;
}

module.exports = {
    SPRACHEN,
    TEXTE,
    AMPEL,
    TAGE,
    MODUL_FELDER,
    BEFEHLE,
    t,
    alle,
    lies,
    sprache,
    szenen,
    szenenFarben,
    geraeteZeile,
    brokerTestAntwort,
    geraetId,
    zielwechselMax,
    ZIELWECHSEL_WARNUNG,
    modulUnterschied,
    modulFehlend,
    zeilenUebernehmen,
    KOPIE_FELDER,
    bedarfKonfig,
    probelauf,
    arbeitspunkt,
    kennliniePruefen,
    kennlinieSvg,
    kennlinieHtml,
    kannHtml,
    planZuProgramm,
    programmZuPlan,
    planTexte,
    planTypen,
    ortszeitText,
    ortszeitLesen,
    modulSeiteLesen,
    modulLesen,
    modulAenderungen,
    modulEinstellungen,
    nachricht,
};
