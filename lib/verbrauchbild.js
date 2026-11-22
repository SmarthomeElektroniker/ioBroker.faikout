'use strict';

/**
 * Daten fuer die Verbrauchsansicht (admin/verbrauch.html): EIN gestapeltes Balkendiagramm, je Geraet
 * eine dauerhaft gleiche Farbe.
 *
 * Quelle sind ausschliesslich die eigenen Datenpunkte des Adapters:
 *   <Geraet>.consumption.{total,heating,cooling}.{hoursJson,daysJson,monthsJson} und die laufenden
 *   Werte currentHour/today/thisMonth, dazu status.consumption (aktuelle Leistung in W).
 * Ansicht "alles" je Geraet = heating + cooling (Innengeraet); total ist der Zaehler des Aussengeraets
 * und dient nur als Rueckfall fuer Module ohne Heiz-/Kuehlzaehler (Issue #8, Multisplit).
 * Die Listen reichen 48 Stunden, 62 Tage und 24 Monate zurueck (lib/verbrauch.js). Eine Historie aus
 * einem History-Adapter wird bewusst NICHT dazugemischt: ohne passende Aggregation waeren die Werte
 * erfunden - die Seite sagt stattdessen, wie weit die eigenen Listen reichen.
 *
 * Der Rechenteil (fenster, sammeln) kennt kein ioBroker; `antwort` holt die Werte vom Adapter.
 */

const verbrauch = require('./verbrauch');

const SPRACHEN = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const L = (...t) => Object.fromEntries(SPRACHEN.map((s, i) => [s, t[i]]));

/**
 * Feste Palette, acht Plaetze, je Platz ein Ton fuer hellen und dunklen Grund. Die Reihenfolge ist
 * Teil der Sicherheit fuer Farbschwache (Nachbarn im Stapel bleiben unterscheidbar) - nicht umsortieren.
 */
const PALETTE = [
    { hell: '#2a78d6', dunkel: '#3987e5' },
    { hell: '#eb6834', dunkel: '#d95926' },
    { hell: '#1baf7a', dunkel: '#199e70' },
    { hell: '#eda100', dunkel: '#c98500' },
    { hell: '#e87ba4', dunkel: '#d55181' },
    { hell: '#008300', dunkel: '#0ca30c' },
    { hell: '#6250d6', dunkel: '#9085e9' },
    { hell: '#e34948', dunkel: '#e66767' },
];

const ZEITRAEUME = ['tag', 'woche', 'monat', 'jahr'];
const ARTEN = { alles: 'total', heizen: 'heating', kuehlen: 'cooling' };

/** Texte der Seite in allen elf Sprachen. */
const TEXTE = {
    tag: L('Day', 'Tag', 'День', 'Dia', 'Dag', 'Jour', 'Giorno', 'Día', 'Dzień', 'День', '日'),
    woche: L('Week', 'Woche', 'Неделя', 'Semana', 'Week', 'Semaine', 'Settimana', 'Semana', 'Tydzień', 'Тиждень', '周'),
    monat: L('Month', 'Monat', 'Месяц', 'Mês', 'Maand', 'Mois', 'Mese', 'Mes', 'Miesiąc', 'Місяць', '月'),
    jahr: L('Year', 'Jahr', 'Год', 'Ano', 'Jaar', 'Année', 'Anno', 'Año', 'Rok', 'Рік', '年'),
    alles: L('All', 'Alles', 'Всё', 'Tudo', 'Alles', 'Tout', 'Tutto', 'Todo', 'Wszystko', 'Усе', '全部'),
    heizen: L(
        'Heating only',
        'Nur Heizen',
        'Только обогрев',
        'Só aquecimento',
        'Alleen verwarmen',
        'Chauffage seul',
        'Solo riscaldamento',
        'Solo calefacción',
        'Tylko grzanie',
        'Лише обігрів',
        '仅制热',
    ),
    kuehlen: L(
        'Cooling only',
        'Nur Kühlen',
        'Только охлаждение',
        'Só arrefecimento',
        'Alleen koelen',
        'Refroidissement seul',
        'Solo raffreddamento',
        'Solo refrigeración',
        'Tylko chłodzenie',
        'Лише охолодження',
        '仅制冷',
    ),
    alleGeraete: L(
        'All devices',
        'Alle Geräte',
        'Все устройства',
        'Todos os aparelhos',
        'Alle apparaten',
        'Tous les appareils',
        'Tutti i dispositivi',
        'Todos los equipos',
        'Wszystkie urządzenia',
        'Усі пристрої',
        '所有设备',
    ),
    summe: L('Total', 'Summe', 'Сумма', 'Total', 'Totaal', 'Total', 'Totale', 'Total', 'Suma', 'Сума', '合计'),
    jetzt: L('now', 'jetzt', 'сейчас', 'agora', 'nu', 'maintenant', 'ora', 'ahora', 'teraz', 'зараз', '当前'),
    zurueck: L(
        'Earlier',
        'Früher',
        'Раньше',
        'Anterior',
        'Eerder',
        'Plus tôt',
        'Precedente',
        'Anterior',
        'Wcześniej',
        'Раніше',
        '更早',
    ),
    vor: L(
        'Later',
        'Später',
        'Позже',
        'Seguinte',
        'Later',
        'Plus tard',
        'Successivo',
        'Siguiente',
        'Później',
        'Пізніше',
        '更晚',
    ),
    tabelle: L(
        'Table',
        'Tabelle',
        'Таблица',
        'Tabela',
        'Tabel',
        'Tableau',
        'Tabella',
        'Tabla',
        'Tabela',
        'Таблиця',
        '表格',
    ),
    diagramm: L(
        'Chart',
        'Diagramm',
        'Диаграмма',
        'Gráfico',
        'Diagram',
        'Graphique',
        'Grafico',
        'Gráfico',
        'Wykres',
        'Діаграма',
        '图表',
    ),
    zeit: L(
        'Period',
        'Zeitraum',
        'Период',
        'Período',
        'Periode',
        'Période',
        'Periodo',
        'Periodo',
        'Okres',
        'Період',
        '时段',
    ),
    titel: L(
        'Consumption in kWh',
        'Verbrauch in kWh',
        'Потребление, кВт·ч',
        'Consumo em kWh',
        'Verbruik in kWh',
        'Consommation en kWh',
        'Consumo in kWh',
        'Consumo en kWh',
        'Zużycie w kWh',
        'Споживання, кВт·год',
        '用电量（kWh）',
    ),
    leistung: L(
        'Current power',
        'Aktuelle Leistung',
        'Текущая мощность',
        'Potência atual',
        'Huidig vermogen',
        'Puissance actuelle',
        'Potenza attuale',
        'Potencia actual',
        'Moc bieżąca',
        'Поточна потужність',
        '当前功率',
    ),
    keinGeraet: L(
        'No device has reported yet. As soon as a module is connected, its consumption appears here.',
        'Noch hat sich kein Gerät gemeldet. Sobald ein Modul verbunden ist, erscheint sein Verbrauch hier.',
        'Пока ни одно устройство не вышло на связь. Как только модуль подключится, здесь появится его потребление.',
        'Ainda nenhum aparelho comunicou. Assim que um módulo estiver ligado, o consumo aparece aqui.',
        'Er heeft zich nog geen apparaat gemeld. Zodra een module verbonden is, verschijnt het verbruik hier.',
        'Aucun appareil ne s’est encore annoncé. Dès qu’un module est connecté, sa consommation apparaît ici.',
        'Nessun dispositivo si è ancora annunciato. Appena un modulo è collegato, il suo consumo appare qui.',
        'Aún no se ha anunciado ningún equipo. En cuanto se conecte un módulo, su consumo aparecerá aquí.',
        'Żadne urządzenie jeszcze się nie zgłosiło. Gdy moduł się połączy, jego zużycie pojawi się tutaj.',
        'Ще жоден пристрій не вийшов на зв’язок. Щойно модуль підключиться, тут з’явиться його споживання.',
        '还没有设备上报。模块连接后，其用电量会显示在这里。',
    ),
    keinZaehler: L(
        'No device reports an energy counter. Without a counter there is nothing to show (e.g. IR bridge).',
        'Kein Gerät meldet einen Energiezähler. Ohne Zähler gibt es nichts zu zeigen (z. B. IR-Brücke).',
        'Ни одно устройство не передаёт счётчик энергии. Без счётчика показывать нечего (например, ИК-мост).',
        'Nenhum aparelho comunica um contador de energia. Sem contador não há nada para mostrar (p. ex. ponte IR).',
        'Geen apparaat meldt een energieteller. Zonder teller is er niets te tonen (bijv. IR-brug).',
        'Aucun appareil ne fournit de compteur d’énergie. Sans compteur, il n’y a rien à afficher (p. ex. pont IR).',
        'Nessun dispositivo fornisce un contatore di energia. Senza contatore non c’è nulla da mostrare (es. ponte IR).',
        'Ningún equipo comunica un contador de energía. Sin contador no hay nada que mostrar (p. ej. puente IR).',
        'Żadne urządzenie nie podaje licznika energii. Bez licznika nie ma czego pokazać (np. mostek IR).',
        'Жоден пристрій не передає лічильник енергії. Без лічильника показувати нічого (наприклад, ІЧ-міст).',
        '没有设备上报电能计数。没有计数就无法显示（例如红外桥）。',
    ),
    keineDaten: L(
        'No values for this period. The adapter keeps hourly values for 48 hours, daily values for 62 days and monthly values for 24 months – counted from the first report of each device.',
        'Für diesen Zeitraum gibt es keine Werte. Der Adapter behält Stundenwerte 48 Stunden, Tageswerte 62 Tage und Monatswerte 24 Monate – gezählt ab der ersten Meldung des jeweiligen Geräts.',
        'За этот период значений нет. Адаптер хранит часовые значения 48 часов, суточные 62 дня и месячные 24 месяца – с первого сообщения каждого устройства.',
        'Não há valores para este período. O adaptador guarda valores horários durante 48 horas, diários durante 62 dias e mensais durante 24 meses – a contar da primeira mensagem de cada aparelho.',
        'Voor deze periode zijn er geen waarden. De adapter bewaart uurwaarden 48 uur, dagwaarden 62 dagen en maandwaarden 24 maanden – geteld vanaf de eerste melding van elk apparaat.',
        'Aucune valeur pour cette période. L’adaptateur conserve les valeurs horaires 48 heures, journalières 62 jours et mensuelles 24 mois – à partir du premier message de chaque appareil.',
        'Nessun valore per questo periodo. L’adattatore conserva i valori orari per 48 ore, giornalieri per 62 giorni e mensili per 24 mesi – dal primo messaggio di ciascun dispositivo.',
        'No hay valores para este periodo. El adaptador conserva valores horarios 48 horas, diarios 62 días y mensuales 24 meses, contados desde el primer mensaje de cada equipo.',
        'Brak wartości dla tego okresu. Adapter przechowuje wartości godzinowe 48 godzin, dzienne 62 dni i miesięczne 24 miesiące – licząc od pierwszego zgłoszenia urządzenia.',
        'За цей період значень немає. Адаптер зберігає погодинні значення 48 годин, добові 62 дні та місячні 24 місяці – від першого повідомлення кожного пристрою.',
        '该时段没有数据。适配器保留 48 小时的小时值、62 天的日值和 24 个月的月值，从各设备首次上报起计。',
    ),
    ohneZaehler: L(
        'without energy counter',
        'ohne Energiezähler',
        'без счётчика энергии',
        'sem contador de energia',
        'zonder energieteller',
        'sans compteur d’énergie',
        'senza contatore di energia',
        'sin contador de energía',
        'bez licznika energii',
        'без лічильника енергії',
        '无电能计数',
    ),
    reichweite: L(
        'Own counters of the adapter: hours 48 h, days 62 d, months 24 mo back.',
        'Eigene Zähler des Adapters: Stunden 48 h, Tage 62 d, Monate 24 Mon. zurück.',
        'Собственные счётчики адаптера: часы 48 ч, дни 62 д, месяцы 24 мес. назад.',
        'Contadores próprios do adaptador: horas 48 h, dias 62 d, meses 24 m para trás.',
        'Eigen tellers van de adapter: uren 48 u, dagen 62 d, maanden 24 mnd terug.',
        'Compteurs propres de l’adaptateur : heures 48 h, jours 62 j, mois 24 mois en arrière.',
        'Contatori propri dell’adattatore: ore 48 h, giorni 62 g, mesi 24 mesi indietro.',
        'Contadores propios del adaptador: horas 48 h, días 62 d, meses 24 m hacia atrás.',
        'Własne liczniki adaptera: godziny 48 h, dni 62 d, miesiące 24 mies. wstecz.',
        'Власні лічильники адаптера: години 48 год, дні 62 д, місяці 24 міс. назад.',
        '适配器自身的计数可回溯：小时值 48 小时、日值 62 天、月值 24 个月。',
    ),
    weitere: L(
        'Others',
        'Weitere',
        'Прочие',
        'Outros',
        'Overige',
        'Autres',
        'Altri',
        'Otros',
        'Pozostałe',
        'Інші',
        '其他',
    ),
    nichtVerbunden: L(
        'The adapter does not answer. Is the instance running?',
        'Der Adapter antwortet nicht. Läuft die Instanz?',
        'Адаптер не отвечает. Запущен ли экземпляр?',
        'O adaptador não responde. A instância está a correr?',
        'De adapter antwoordt niet. Draait de instantie?',
        'L’adaptateur ne répond pas. L’instance est-elle démarrée ?',
        'L’adattatore non risponde. L’istanza è in esecuzione?',
        'El adaptador no responde. ¿Está en marcha la instancia?',
        'Adapter nie odpowiada. Czy instancja działa?',
        'Адаптер не відповідає. Чи запущено екземпляр?',
        '适配器没有响应。实例在运行吗？',
    ),
    // ---- Ansicht "Waerme & COP" (lib/effizienz)
    strom: {
        en: 'Electricity',
        de: 'Strom',
        ru: 'Электроэнергия',
        pt: 'Eletricidade',
        nl: 'Stroom',
        fr: 'Électricité',
        it: 'Elettricità',
        es: 'Electricidad',
        pl: 'Prąd',
        uk: 'Електроенергія',
        'zh-cn': '电能',
    },
    waerme: {
        en: 'Heat & COP',
        de: 'Wärme & COP',
        ru: 'Тепло и COP',
        pt: 'Calor e COP',
        nl: 'Warmte & COP',
        fr: 'Chaleur & COP',
        it: 'Calore e COP',
        es: 'Calor y COP',
        pl: 'Ciepło i COP',
        uk: 'Тепло й COP',
        'zh-cn': '热量与 COP',
    },
    waermeTitel: {
        en: 'Heat',
        de: 'Wärme',
        ru: 'Тепло',
        pt: 'Calor',
        nl: 'Warmte',
        fr: 'Chaleur',
        it: 'Calore',
        es: 'Calor',
        pl: 'Ciepło',
        uk: 'Тепло',
        'zh-cn': '热量',
    },
    kaelteTitel: {
        en: 'Cooling',
        de: 'Kälte',
        ru: 'Холод',
        pt: 'Frio',
        nl: 'Koude',
        fr: 'Froid',
        it: 'Freddo',
        es: 'Frío',
        pl: 'Chłód',
        uk: 'Холод',
        'zh-cn': '冷量',
    },
    waermeKaelteTitel: {
        en: 'Heat and cooling',
        de: 'Wärme und Kälte',
        ru: 'Тепло и холод',
        pt: 'Calor e frio',
        nl: 'Warmte en koude',
        fr: 'Chaleur et froid',
        it: 'Calore e freddo',
        es: 'Calor y frío',
        pl: 'Ciepło i chłód',
        uk: 'Тепло і холод',
        'zh-cn': '热量与冷量',
    },
    cop: {
        en: 'COP',
        de: 'COP',
        ru: 'COP',
        pt: 'COP',
        nl: 'COP',
        fr: 'COP',
        it: 'COP',
        es: 'COP',
        pl: 'COP',
        uk: 'COP',
        'zh-cn': 'COP',
    },
    eer: {
        en: 'EER',
        de: 'EER',
        ru: 'EER',
        pt: 'EER',
        nl: 'EER',
        fr: 'EER',
        it: 'EER',
        es: 'EER',
        pl: 'EER',
        uk: 'EER',
        'zh-cn': 'EER',
    },
    arbeitszahl: {
        en: 'COP/EER',
        de: 'COP/EER',
        ru: 'COP/EER',
        pt: 'COP/EER',
        nl: 'COP/EER',
        fr: 'COP/EER',
        it: 'COP/EER',
        es: 'COP/EER',
        pl: 'COP/EER',
        uk: 'COP/EER',
        'zh-cn': 'COP/EER',
    },
    gueteEstimated: {
        en: 'estimated',
        de: 'geschätzt',
        ru: 'оценка',
        pt: 'estimado',
        nl: 'geschat',
        fr: 'estimé',
        it: 'stimato',
        es: 'estimado',
        pl: 'szacunek',
        uk: 'оцінка',
        'zh-cn': '估算',
    },
    gueteCalibrated: {
        en: 'calibrated',
        de: 'kalibriert',
        ru: 'калибровка',
        pt: 'calibrado',
        nl: 'gekalibreerd',
        fr: 'étalonné',
        it: 'calibrato',
        es: 'calibrado',
        pl: 'kalibracja',
        uk: 'калібрування',
        'zh-cn': '已校准',
    },
    gueteMeasured: {
        en: 'measured',
        de: 'gemessen',
        ru: 'измерение',
        pt: 'medido',
        nl: 'gemeten',
        fr: 'mesuré',
        it: 'misurato',
        es: 'medido',
        pl: 'pomiar',
        uk: 'вимірювання',
        'zh-cn': '实测',
    },
    waermeFuss: {
        en: 'Heat, cooling and COP are calculated from airflow and temperatures of the indoor unit (tab “Efficiency”) – {guete}. Defrosting and pauses are included in the COP.',
        de: 'Wärme, Kälte und COP sind aus Luftstrom und Temperaturen des Innengeräts gerechnet (Reiter „Effizienz“) – {guete}. Abtauen und Pausen sind im COP enthalten.',
        ru: 'Тепло, холод и COP рассчитываются по воздушному потоку и температурам внутреннего блока (вкладка «Эффективность») – {guete}. Оттайка и паузы учтены в COP.',
        pt: 'Calor, frio e COP são calculados a partir do caudal de ar e das temperaturas da unidade interior (separador «Eficiência») – {guete}. A descongelação e as pausas estão incluídas no COP.',
        nl: 'Warmte, koude en COP worden berekend uit luchtstroom en temperaturen van het binnendeel (tabblad “Efficiëntie”) – {guete}. Ontdooien en pauzes zijn in de COP inbegrepen.',
        fr: 'La chaleur, le froid et le COP sont calculés à partir du débit d’air et des températures de l’unité intérieure (onglet « Efficacité ») – {guete}. Le dégivrage et les pauses sont inclus dans le COP.',
        it: "Calore, freddo e COP sono calcolati dalla portata d'aria e dalle temperature dell'unità interna (scheda «Efficienza») – {guete}. Sbrinamento e pause sono inclusi nel COP.",
        es: 'El calor, el frío y el COP se calculan a partir del caudal de aire y de las temperaturas de la unidad interior (pestaña «Eficiencia») – {guete}. El desescarche y las pausas están incluidos en el COP.',
        pl: 'Ciepło, chłód i COP są obliczane z przepływu powietrza i temperatur jednostki wewnętrznej (zakładka „Efektywność”) – {guete}. Odszranianie i pauzy są wliczone w COP.',
        uk: 'Тепло, холод і COP розраховуються за повітряним потоком і температурами внутрішнього блока (вкладка «Ефективність») – {guete}. Розморожування та паузи враховано в COP.',
        'zh-cn': '热量、冷量和 COP 根据室内机的风量和温度计算得出（“能效”标签页）– {guete}。除霜和暂停时段已计入 COP。',
    },
    ohneWaerme: {
        en: 'no heat values',
        de: 'ohne Wärmewerte',
        ru: 'нет данных о тепле',
        pt: 'sem valores de calor',
        nl: 'geen warmtewaarden',
        fr: 'sans valeurs de chaleur',
        it: 'senza valori di calore',
        es: 'sin valores de calor',
        pl: 'brak danych o cieple',
        uk: 'немає даних про тепло',
        'zh-cn': '无热量数据',
    },
    keineWaerme: {
        en: 'No unit reports the values needed for heat output (intake air, refrigerant temperature, fan).',
        de: 'Keine Anlage meldet die Werte, die für die Wärmeleistung nötig sind (Ansaugluft, Kältemitteltemperatur, Lüfter).',
        ru: 'Ни одно устройство не передаёт значения, нужные для тепловой мощности (забираемый воздух, температура хладагента, вентилятор).',
        pt: 'Nenhum aparelho comunica os valores necessários para a potência térmica (ar de entrada, temperatura do fluido frigorigéneo, ventilador).',
        nl: 'Geen toestel meldt de waarden die nodig zijn voor het warmtevermogen (aanzuiglucht, koudemiddeltemperatuur, ventilator).',
        fr: 'Aucun appareil ne transmet les valeurs nécessaires à la puissance calorifique (air aspiré, température du fluide frigorigène, ventilateur).',
        it: 'Nessun apparecchio comunica i valori necessari per la potenza termica (aria in ingresso, temperatura del refrigerante, ventola).',
        es: 'Ningún equipo informa de los valores necesarios para la potencia calorífica (aire de entrada, temperatura del refrigerante, ventilador).',
        pl: 'Żadne urządzenie nie zgłasza wartości potrzebnych do mocy grzewczej (powietrze zasysane, temperatura czynnika chłodniczego, wentylator).',
        uk: 'Жоден пристрій не передає значень, потрібних для теплової потужності (повітря на вході, температура холодоагента, вентилятор).',
        'zh-cn': '没有设备上报计算制热量所需的数值（进风、冷媒温度、风机）。',
    },
};

const p2 = n => String(n).padStart(2, '0');
const tagKey = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const monatKey = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
const stundeKey = d => `${tagKey(d)}T${p2(d.getHours())}`;

/**
 * Das Zeitfenster eines Diagramms: seine Balken (Schluessel wie in den Listen des Adapters).
 *
 * @param {string} zeitraum  tag | woche | monat | jahr
 * @param {number} versatz  0 = laufender Zeitraum, 1 = der davor ...
 * @param {Date} jetzt  Uhr (Ortszeit)
 * @returns {{zeitraum: string, versatz: number, raster: string, von: string, bis: string, schluessel: string[], laufend: string}} Fenster;
 *   raster = stunde | tag | monat, laufend = Schluessel des gerade laufenden Balkens
 */
function fenster(zeitraum, versatz, jetzt) {
    const z = ZEITRAEUME.includes(zeitraum) ? zeitraum : 'woche';
    const v = Math.max(0, Math.floor(Number(versatz) || 0));
    const j = jetzt instanceof Date ? jetzt : new Date(jetzt);
    const schluessel = [];
    let raster;
    let laufend;
    if (z === 'tag') {
        raster = 'stunde';
        laufend = stundeKey(j);
        const d = new Date(j.getFullYear(), j.getMonth(), j.getDate() - v);
        for (let h = 0; h < 24; h++) {
            schluessel.push(`${tagKey(d)}T${p2(h)}`);
        }
    } else if (z === 'woche') {
        raster = 'tag';
        laufend = tagKey(j);
        // Montag der Woche
        const wt = (j.getDay() + 6) % 7;
        for (let i = 0; i < 7; i++) {
            schluessel.push(tagKey(new Date(j.getFullYear(), j.getMonth(), j.getDate() - wt - 7 * v + i)));
        }
    } else if (z === 'monat') {
        raster = 'tag';
        laufend = tagKey(j);
        const erster = new Date(j.getFullYear(), j.getMonth() - v, 1);
        const tage = new Date(erster.getFullYear(), erster.getMonth() + 1, 0).getDate();
        for (let i = 1; i <= tage; i++) {
            schluessel.push(tagKey(new Date(erster.getFullYear(), erster.getMonth(), i)));
        }
    } else {
        raster = 'monat';
        laufend = monatKey(j);
        const jahr = j.getFullYear() - v;
        for (let m = 0; m < 12; m++) {
            schluessel.push(`${jahr}-${p2(m + 1)}`);
        }
    }
    return {
        zeitraum: z,
        versatz: v,
        raster,
        von: schluessel[0],
        bis: schluessel[schluessel.length - 1],
        schluessel,
        laufend,
    };
}

/**
 * Liste des Adapters ([{hour|day|month, kwh}]) als Nachschlagetabelle. Luecken (kwh null) bleiben weg.
 *
 * @param {unknown} liste  Liste oder JSON-Text
 * @param {string} feld  hour | day | month
 * @returns {Map<string, number>} Schluessel -> kWh
 */
function listeLesen(liste, feld) {
    let l = liste;
    if (typeof l === 'string') {
        try {
            l = JSON.parse(l);
        } catch {
            l = [];
        }
    }
    const m = new Map();
    for (const e of Array.isArray(l) ? l : []) {
        if (e && typeof e[feld] === 'string' && typeof e.kwh === 'number' && Number.isFinite(e.kwh)) {
            m.set(e[feld], e.kwh);
        }
    }
    return m;
}

const runden = v => Math.round(v * 1000) / 1000;

/**
 * Werte eines Geraets fuer ein Fenster.
 *
 * @param {{hours?: unknown, days?: unknown, months?: unknown, currentHour?: unknown, today?: unknown, thisMonth?: unknown}|null} quelle
 *   Listen und laufende Werte einer Art (total/heating/cooling)
 * @param {ReturnType<typeof fenster>} f  Fenster
 * @returns {{werte: Array<number|null>, aelteste: string|null}} Wert je Balken (null = kein Wert) und der
 *   aelteste Schluessel, den die Liste dieses Rasters kennt
 */
function werteVon(quelle, f) {
    const q = quelle || {};
    const feld = { stunde: 'hour', tag: 'day', monat: 'month' }[f.raster];
    const liste = listeLesen({ stunde: q.hours, tag: q.days, monat: q.months }[f.raster], feld);
    // Der laufende Balken steht (je nach Raster) nicht in der Liste, sondern im laufenden Wert
    const laufend = { stunde: q.currentHour, tag: q.today, monat: q.thisMonth }[f.raster];
    if (typeof laufend === 'number' && Number.isFinite(laufend)) {
        liste.set(f.laufend, laufend);
    }
    const alle = [...liste.keys()].sort();
    return {
        werte: f.schluessel.map(k => (liste.has(k) ? runden(liste.get(k)) : null)),
        aelteste: alle.length ? alle[0] : null,
    };
}

/**
 * Stellt die Antwort fuer die Seite zusammen.
 *
 * @param {Array<{id: string, name: string, platz: number, leistung: number|null, online?: boolean,
 *   arten: Record<string, object|null>}>} geraete  Geraete mit ihren Quellen je Art (total/heating/cooling)
 * @param {{zeitraum?: string, versatz?: number, art?: string}} wahl  Auswahl der Seite
 * @param {Date} jetzt  Uhr
 * @returns {object} Antwort (siehe Kopf von admin/verbrauch.html)
 */
function sammeln(geraete, wahl, jetzt) {
    const w = wahl || {};
    const art = Object.prototype.hasOwnProperty.call(ARTEN, w.art) ? w.art : 'alles';
    // Ansicht "waerme": statt des Stroms die geschaetzte Waerme/Kaelte je Geraet, dazu der Strom derselben
    // Zeitabschnitte fuer die Arbeitszahl (lib/effizienz). Die bisherige Ansicht (Strom) bleibt die Vorgabe.
    const waerme = w.ansicht === 'waerme';
    const f = fenster(w.zeitraum, w.versatz, jetzt);
    let aelteste = null;
    const summen = (a, b) => a.map((v, i) => (v === null && b[i] === null ? null : runden((v || 0) + (b[i] || 0))));
    const liste = (geraete || []).map(g => {
        const arten = g.arten || {};
        const hatZaehler = waerme ? !!g.effizienz : !!(arten.total || arten.heating || arten.cooling);
        let r;
        let strom = null;
        if (waerme) {
            const e = g.effizienz || {};
            const teil = m => werteVon(e[m], f);
            const paare = { alles: ['waerme', 'kaelte'], heizen: ['waerme'], kuehlen: ['kaelte'] }[art];
            const teile = paare.map(teil);
            const stromTeile = paare.map(m => teil(m === 'waerme' ? 'stromHeizen' : 'stromKuehlen'));
            r = {
                werte: teile.length > 1 ? summen(teile[0].werte, teile[1].werte) : teile[0].werte,
                aelteste:
                    teile
                        .map(t => t.aelteste)
                        .filter(Boolean)
                        .sort()[0] || null,
            };
            strom = stromTeile.length > 1 ? summen(stromTeile[0].werte, stromTeile[1].werte) : stromTeile[0].werte;
        } else if (art === 'alles' && (arten.heating || arten.cooling)) {
            // "Alles" je INNENGERAET = Heizen + Kuehlen. total (Modulfeld energy) ist der Zaehler des
            // Aussengeraets: bei Multisplit meldet ihn jedes Modul, die Summenzeile zaehlte ihn mehrfach
            // (Issue #8). total nur, wenn das Modul keinen Heiz-/Kuehlzaehler meldet.
            const teile = [arten.heating, arten.cooling].filter(Boolean).map(q => werteVon(q, f));
            r = {
                werte: teile.length > 1 ? summen(teile[0].werte, teile[1].werte) : teile[0].werte,
                aelteste:
                    teile
                        .map(t => t.aelteste)
                        .filter(Boolean)
                        .sort()[0] || null,
            };
        } else {
            r = werteVon(arten[ARTEN[art]] || null, f);
        }
        if (r.aelteste && (!aelteste || r.aelteste < aelteste)) {
            aelteste = r.aelteste;
        }
        const summe = r.werte.reduce((s, v) => s + (v || 0), 0);
        const platz = Number.isInteger(g.platz) && g.platz >= 0 ? g.platz : 0;
        const eintrag = {
            id: g.id,
            name: g.name || g.id,
            platz,
            farbe: platz < PALETTE.length ? PALETTE[platz] : null,
            leistung: typeof g.leistung === 'number' && Number.isFinite(g.leistung) ? Math.round(g.leistung) : null,
            // Kennung des gemeinsamen Aussengeraets (Multisplit) oder null: dessen Leistung zaehlt in der Summe nur einmal
            aussengeraet: typeof g.aussengeraet === 'string' ? g.aussengeraet : null,
            zaehler: hatZaehler,
            werte: r.werte,
            summe: runden(summe),
            hatWerte: r.werte.some(v => v !== null),
        };
        if (waerme) {
            eintrag.strom = strom;
            eintrag.guete = g.guete || 'estimated';
            eintrag.unsicherheit = typeof g.unsicherheit === 'number' ? g.unsicherheit : null;
        }
        return eintrag;
    });
    const mitZaehler = liste.filter(g => g.zaehler);
    const hatDaten = liste.some(g => g.hatWerte);
    let hinweis = '';
    if (!liste.length) {
        hinweis = 'keinGeraet';
    } else if (!mitZaehler.length) {
        hinweis = waerme ? 'keineWaerme' : 'keinZaehler';
    } else if (!hatDaten) {
        hinweis = 'keineDaten';
    }
    return {
        zeitraum: f.zeitraum,
        versatz: f.versatz,
        art,
        ansicht: waerme ? 'waerme' : 'strom',
        // die Umschaltung Strom / Waerme gibt es nur, wenn mindestens ein Geraet Waerme liefert
        waermeDa: (geraete || []).some(g => !!g.effizienz),
        raster: f.raster,
        schluessel: f.schluessel,
        laufend: f.laufend,
        // "Frueher" geht, solange das Fenster davor noch Werte haben kann
        zurueck: !!aelteste && aelteste < f.von,
        vor: f.versatz > 0,
        geraete: liste,
        hinweis,
    };
}

/**
 * Farbplatz eines Geraets: einmal vergeben und im Geraeteobjekt gemerkt (native.verbrauchFarbe), damit
 * die Farbe gleich bleibt, auch wenn Geraete dazukommen oder wegfallen.
 *
 * @param {object} adapter  Adapter
 * @param {string[]} ids  Geraete-IDs
 * @returns {Promise<Map<string, number>>} ID -> Platz (ab 0; Plaetze ab PALETTE.length = "Weitere")
 */
async function farbplaetze(adapter, ids) {
    const plaetze = new Map();
    const offen = [];
    for (const id of ids) {
        let platz = null;
        try {
            const o = await adapter.getObjectAsync(id);
            platz = o && o.native ? o.native.verbrauchFarbe : null;
        } catch {
            platz = null;
        }
        if (Number.isInteger(platz) && platz >= 0 && ![...plaetze.values()].includes(platz)) {
            plaetze.set(id, platz);
        } else {
            offen.push(id);
        }
    }
    for (const id of offen.sort()) {
        let platz = 0;
        const belegt = new Set(plaetze.values());
        while (belegt.has(platz)) {
            platz++;
        }
        plaetze.set(id, platz);
        try {
            await adapter.extendObjectAsync(id, { native: { verbrauchFarbe: platz } });
        } catch {
            // ohne Merken bleibt die Farbe trotzdem stabil, solange sich die Geraeteliste nicht aendert
        }
    }
    return plaetze;
}

/**
 * Antwort auf den Befehl verbrauchDaten {zeitraum, versatz, art}.
 *
 * @param {object} adapter  Adapter
 * @param {{zeitraum?: string, versatz?: number, art?: string}} msg  Auswahl der Seite
 * @param {Date} [jetzt]  Uhr (fuer Tests)
 * @returns {Promise<object>} Antwort mit Texten und Sprache
 */
async function antwort(adapter, msg, jetzt = new Date()) {
    let sprache = 'en';
    if (typeof adapter.sprache === 'function') {
        const s = await adapter.sprache();
        sprache = SPRACHEN.includes(s) ? s : 'en';
    }
    const lies = async rel => {
        try {
            const s = await adapter.getStateAsync(rel);
            return s ? s.val : null;
        } catch {
            return null;
        }
    };
    const ids = [...(adapter.geraete || new Map()).keys()];
    const gruppen = verbrauch.gemeinsameZaehler(verbrauch.aussenZaehler(adapter.geraete));
    const plaetze = await farbplaetze(adapter, ids);
    const geraete = [];
    for (const [id, g] of adapter.geraete || new Map()) {
        const arten = {};
        for (const a of Object.values(ARTEN)) {
            const p = `${id}.consumption.${a}`;
            const hours = await lies(`${p}.hoursJson`);
            const days = await lies(`${p}.daysJson`);
            const months = await lies(`${p}.monthsJson`);
            const today = await lies(`${p}.today`);
            // Kein Zaehler dieser Art: die Datenpunkte fehlen oder waren nie gefuellt
            arten[a] =
                hours === null && days === null && months === null && today === null
                    ? null
                    : {
                          hours,
                          days,
                          months,
                          today,
                          currentHour: await lies(`${p}.currentHour`),
                          thisMonth: await lies(`${p}.thisMonth`),
                      };
        }
        // Waerme, Kaelte und der Strom derselben Zeitabschnitte: direkt aus der Laufzeit (lib/effizienz)
        const ez = adapter.effizienz && adapter.effizienz.zustand ? adapter.effizienz.zustand.get(id) : null;
        const eff = ez && ez.werte && ez.ergebnis && ez.ergebnis.art !== 'nichtVerfuegbar' ? ez : null;
        geraete.push({
            id,
            name: (g && g.name) || id,
            platz: plaetze.get(id),
            leistung: await lies(`${id}.status.consumption`),
            arten,
            aussengeraet: gruppen.get(id) || null,
            effizienz: eff ? eff.werte : null,
            guete: eff ? eff.ergebnis.guete : null,
            unsicherheit: eff ? eff.ergebnis.unsicherheit : null,
        });
    }
    geraete.sort((a, b) => a.platz - b.platz);
    return {
        ...sammeln(geraete, msg, jetzt),
        lang: sprache,
        texte: Object.fromEntries(Object.entries(TEXTE).map(([k, v]) => [k, v[sprache] || v.en])),
    };
}

module.exports = {
    SPRACHEN,
    PALETTE,
    TEXTE,
    ZEITRAEUME,
    ARTEN,
    fenster,
    listeLesen,
    werteVon,
    sammeln,
    farbplaetze,
    antwort,
};
