# Faikout – Klimaregelung

Diese Anleitung beschreibt die eingebaute Klimaregelung des Adapters: die Einstellungen im Reiter
**Regelung**, die Gerätekarten, den Wochenplan und das Ändern von Einstellungen im Modul.
[English version](../en/README.md) · [Zurück zur Übersicht](../../README.md)

## 1. Wer mag: erst einmal nur zusehen (Probelauf)

Eine neue Instanz sendet nichts von selbst: Leistungsgrenze, Wochenplan und Feuchteregelung schaltest
du je Anlage ein. Wer vorher in Ruhe prüfen will, ob Kennlinie, Temperaturstufen und Wochenplan passen,
schaltet den **Probelauf** ein: Der Adapter rechnet dann alles mit und zeigt, was er senden würde – er
sendet aber keinen einzigen Befehl an die Anlagen.

Der Haken steht im Reiter *Regelung* ganz unten unter **Für Fortgeschrittene** (für alle Geräte). Ist
er an, steht oben im Reiter ein farbiger Hinweis und auf den Gerätekarten das Etikett „Probelauf“. Das
ist der **eine** Schalter: Ist er aus, senden alle Anlagen.

Soll bewusst nur eine einzelne Anlage im Probelauf bleiben, setzt du in ihrer Karte (Reiter *Regelung*,
Abschnitt *Geräte*) unter **Für Fortgeschrittene** den Haken „Nur diese Anlage im Probelauf“. Gesendet
wird an eine Anlage also nur, wenn der Probelauf für alle aus ist und ihr eigener Haken nicht gesetzt ist.

Der Datenpunkt `<Gerät>.regulation.demand.dryRun` zeigt je Anlage an, ob der Probelauf gerade wirkt. Er
ist **kein Schalter** (nicht beschreibbar); ein Schreibversuch wird mit einem Hinweis im Log abgelehnt.
In Vorabständen war er ein zweiter Schalter je Gerät: Beim Update werden vorhandene Werte einmal an die
Einstellung der Instanz angeglichen. Instanzen aus älteren Versionen behalten dabei ihren Probelauf – dort
bleibt er an, bis du ihn ausschaltest; steht er schon auf aus, senden danach auch Geräte, deren alter
Geräteschalter noch auf an stand (das Log nennt sie beim ersten Start mit einer Warnung).

Die Geräteliste lässt sich unter den Karten als JSON-Datei **exportieren** und wieder **importieren**
(ersetzen oder hinzufügen, mit Rückfrage; gespeichert wird erst mit „Speichern“).

![Reiter Regelung](../img/einstellungen_regelung.png)

### Die Reiter der Einstellungsseite

| Reiter | Was dort steht |
|---|---|
| **Einrichtung** | Schrittliste mit Haken: Broker, Modul verbinden, Zeitplan, Regelung |
| **Zeitpläne** | WANN welche Temperatur gilt: Temperaturstufen der Vorlage (Regler zum Ziehen), Wochenplan der Vorlage und je Gerät Vorschau, Schalter und „Wochenplan bearbeiten“. Eingeklappt: Handeingriff und Feiertage |
| **Regelung** | WIE die Anlage gefahren wird: Schaubild der Regelung, die globale Vorlage (Strategie, Heiz- und Kühlkennlinie mit Grenzen im Bild, Feuchte-Grenzen im Bild), darunter die Geräte als Karten. Eingeklappt: Probelauf und Feinabstimmung |
| **Multisplit** | Welche Innengeräte an einem gemeinsamen Außengerät hängen: Anlagen als Kacheln, Vorschlag aus den Daten, Zuordnen per Ziehen |
| **Verbrauch** | Diagramm und Aufzeichnung; umschaltbar auf Wärme und COP-Linie |
| **Effizienz** | Wärmeleistung, COP/EER und Wärmemenge je Anlage: Modellwahl, Luftstrom je Lüfterstufe, Kalibrierung mit Austrittssensor oder Handmessung |
| **Module suchen**, **MQTT-Broker (Technik)**, **Moduleinstellungen (Technik)** | Anbinden und Technik |

Je Gerät steht im Reiter *Regelung*: wer regelt, die Kennlinien (Heizen/Kühlen), die Sensoren (mit
Live-Wert) und die Feuchte; unter **Für Fortgeschrittene** Strategie, Frostschutz und Probelauf. Die
Temperaturstufen eines Geräts stehen im Reiter *Zeitpläne* bei seinem Wochenplan. Die Marken im Kopf
der Gerätekarte sagen, was gilt: „alles aus der Vorlage“ oder z. B. „eigen: Heizkennlinie, Stufen“.

Unter jeder Kennlinie eines Geräts steht **„So entsteht der Wert gerade“** – der Rechenweg mit den
Zahlen der Regelung, z. B. „Kennlinie 52 % → Raum 1,0 K zu warm: −7 → 45 %“ (bei der Strategie Vortag
„Vortag 48 % + 10 → …“), samt Untergrenze, Obergrenze, voller Leistung, Überheizschutz und der
Höchstleistung der Temperaturstufe, wenn sie greifen. Ist der Wert noch nicht an die Anlage
gesendet, steht der Grund dahinter (z. B. „Haltezeit bis 22:15:36“: nach oben wartet der Adapter
60 Sekunden, nach unten 10 Minuten, ob der Wunsch stabil bleibt). Wie stark die Raumtemperatur korrigiert, stellst
du unter **Für Fortgeschrittene** im Bild **Raumkorrektur** ein (Korrekturstärke und Totband ziehen).

## 2. Vorlage und Einstellungen je Gerät

Die Regelung kennt genau zwei Ebenen:

- die **globale Vorlage** – Strategie, Unter- und Obergrenze, Heiz- und Kühlkennlinie, Vortag,
  Temperaturstufen, Feuchte-Maßnahme und der Wochenplan der Vorlage. Sie gilt für alle Anlagen.
- **je Gerät** ein Eintrag unter **Geräte**. Einen Haken „individuell“ gibt es nicht mehr: Ein Gerät
  folgt der Vorlage, bis du bei ihm etwas änderst – **eigen entsteht beim Ändern**, **„Auf die Vorlage
  zurücksetzen“** führt zurück. Das gilt je Teil einzeln:

| Teil | eigen, sobald … | wo |
|---|---|---|
| Heizkennlinie, Kühlkennlinie | du einen Punkt ziehst – Überschrift „(eigene Kennlinie)“ statt „(globale Kennlinie)“ | Regelung → Gerätekarte |
| Grenzen (Unter-/Obergrenze) | du eine Grenzlinie verschiebst | Regelung → Gerätekarte, im Kennlinienbild |
| Temperaturstufen | du eine Stufe des Geräts änderst – „(eigene Stufen)“ statt „(globale Stufen)“ | Zeitpläne → beim Gerät „Stufen anpassen“ |
| Strategie (mit Vortag-Werten) | du etwas anderes als „Wie Vorlage“ wählst | Regelung → Gerätekarte → Für Fortgeschrittene |
| Feuchte-Maßnahme | du etwas anderes als „Wie Vorlage“ wählst | Regelung → Gerätekarte → Feuchte |

Für jeden Teil ohne eigenen Wert gilt die Vorlage (und für diese die Werksvorgabe).
Immer gerätebezogen sind: wer regelt, die Sensorquellen und der Frostschutz.
Eine Anlage ganz ohne Eintrag nimmt die Vorlage, der ioBroker-Adapter regelt und die Sensoren stehen auf
Automatik.

Die Werksvorgaben der Vorlage: Untergrenze **40 %**, Obergrenze **100 %**, Heizkennlinie
−10 °C → 100 %, 0 °C → 75 %, 7 °C → 55 %, 15 °C → 40 %, Kühlkennlinie 25 °C → 40 %, 30 °C → 65 %,
35 °C → 95 %.

### Wer regelt?

| Betriebsart | Was passiert | Geeignet für |
| --- | --- | --- |
| **ioBroker-Adapter regelt** | Der Adapter schaltet nach Wochenplan und Temperaturstufen, begrenzt die Leistung nach Bedarf und greift bei Feuchte ein. Im Modul wird dabei nichts gespeichert. | den Normalfall |
| **Faikout-Modul regelt selbst** | Das Modul regelt selbst auf die Zieltemperatur (Automatik der Firmware). Der Adapter liefert Ziel, Sensorwert und Wochenplan. | wenn das Modul auch ohne ioBroker weiterregeln soll |

Grenzen von „Faikout-Modul regelt selbst“:

- **Voraussetzung im Modul:** Die Automatik muss dort eingeschaltet sein – in der Weboberfläche des
  Moduls „Enable“ einschalten und bei „Auto temp“ einen Bereich wählen (nicht „Off“; Einstellungen
  `autoe` und `autor`). Solange das fehlt, steht auf der Gerätekarte „nicht eingerichtet“ mit dem
  Hinweis, dass die Automatik des Moduls nicht eingeschaltet ist.
- Die Leistungsgrenze wird nur mit der Strategie **Auto** gesetzt. Mit der Strategie „Kennlinie“
  ruht die Bedarfsregelung; auf der Karte steht dann „ruht (Modul regelt selbst)“.
- **Zurück zu „ioBroker-Adapter regelt“:** Die Automatik im Modul dabei wieder ausschalten („Auto temp“
  auf „Off“). Das Modul führt die Anlage nach dem Umstellen noch bis zu zehn Minuten selbst weiter; was es
  in dieser Zeit verstellt, wertet der Adapter nicht als Handeingriff, er stellt seine Sollwerte durch.
  Bleibt die Automatik des Moduls eingeschaltet, steht auf der Karte „nicht eingerichtet“ mit dem Hinweis
  „Die Automatik des Moduls ist noch eingeschaltet – im Modul ausschalten“.
- **Jede Zieländerung wird im Modul gespeichert (Flash-Speicher).** Ändert der Wochenplan das Ziel
  an einem Tag sechsmal oder öfter, warnen der Reiter und der Wochenplan-Dialog. Für Pläne mit
  vielen Schaltpunkten ist „ioBroker-Adapter regelt“ die bessere Wahl.

### Was diese Anlage kann

Hier steht live, ob die Anlage die Leistungsgrenze übernimmt, ob ein BLE-Sensor am Modul hängt und
ob ein Feuchtewert vorhanden ist.

#### Leistungsgrenze bei Daikin

Zwei Dinge sind zu unterscheiden:

- **A) Einstellung „Bedarfssteuerung“ in der Daikin-App (Onecta):** Aus / manuell (fester Wert) / Auto.
- **B) Das Daikin-WLAN-Modul selbst**, per Fernbedienung ein- oder ausgeschaltet (SP-Menü: „Powerful“
  gedrückt halten → „SP 1“ = WLAN an, „SP oFF“ = aus; Handbuch 3P649406) – unabhängig von der App.

| B) Daikin-WLAN-Modul | A) Bedarfssteuerung in Onecta | Leistungsgrenze vom Adapter |
|---|---|---|
| aus („SP oFF“) | egal | wirkt **nicht** (eigene Messung) |
| an, ohne Internet (eigenes Netz) | manuell (fester Wert) | wirkt; Adapter und App dürfen schreiben, der letzte Wert gilt (eigene Messung) |
| an, ohne Internet | Aus | Anlage bleibt bei 100 % (eigene Messung) |
| an, ohne Internet | Auto | ohne Cloud nicht sinnvoll |
| an, mit Cloud (z. B. fest eingebaute Module der Perfera) | Auto oder manuell | die Cloud setzt ihren Wert nach Sekunden zurück, der Wert des Adapters hält nicht (Tester-Bericht) |
| an, mit Cloud | Aus | Werte des Adapters halten (Tester-Bericht, noch nicht gegengeprüft) |

**Empfehlung:** Modul an („SP 1“); mit Cloud → App „Aus“; ohne Internet → App „manuell (fester Wert)“.
Rückmeldungen im Forum sind willkommen. Eine Ablehnung bei ausgeschalteter Anlage sagt nichts aus – der
Adapter zeigt dann weiter „noch nicht geprüft“.

#### Multisplit: eine Leistungsgrenze je Außengerät

Hängen mehrere Innengeräte an einem gemeinsamen Außengerät und sind sie im Reiter **Multisplit**
zugeordnet (nur bestätigte Zuordnungen, nie Vorschläge), regelt der Adapter die Leistungsgrenze **je
Außengerät**:

- Jedes laufende Innengerät rechnet seine Anforderung wie bisher (Kennlinie bzw. Vortag,
  Raumkorrektur, Feuchte, Frostschutz, Temperaturstufe, auch nach einem Handeingriff).
- **Alle** Innengeräte der Gruppe – auch die ausgeschalteten – bekommen **denselben Wert: das
  Maximum** dieser Anforderungen. Verlangt ein Raum volle Leistung, gilt 100 % für alle. Ob Daikin
  den höchsten, den niedrigsten oder „den höchsten unter 100“ nimmt, ist nicht belegt – bei gleichen
  Werten ist es egal, und kein Raum wird unterversorgt.
- Läuft kein Innengerät mehr, geht einmal 100 % an alle, danach ruht die Vorgabe.
- Haltezeiten und Takt (Senken nach 10 min, Erhöhen nach 1 min, mindestens 3 min Abstand, höchstens
  12 Befehle je Stunde) gelten je Außengerät; ein Befehl geht an alle Innengeräte zusammen.
- Die Gruppe regelt nur, wenn die Bedarfsregelung an **allen** ihren Innengeräten eingeschaltet ist
  und keines den Wert grundsätzlich ablehnt. Ein Probelauf an einem Innengerät gilt für die ganze
  Gruppe. Lehnt ein ausgeschaltetes Innengerät den Wert ab (failed-set), ist das kein „nicht fähig“;
  es wird nicht immer wieder beschrieben und bekommt den Wert, sobald es läuft.
- Strategie „Auto“ (Vortag): Grundlage ist der Zähler des Außengeräts. Bezugsleistung ist die Summe
  der Bezugsleistungen der Innengeräte (Vorgabe je Gerät 1000 W, Geräte ohne Modul mit der Vorgabe
  der Instanz); ein eigener Wert steht in `aussengeraete[].vortagReferenzW`.
- **Innengeräte ohne Faikout-Modul** („weitere Innengeräte“): Dort kann der Adapter nichts setzen, ihr
  Wert in der Daikin-App bestimmt mit. **Stelle an diesen Geräten in der Daikin-App keine eigene
  Leistungsgrenze ein** (Bedarfssteuerung ab bzw. 100 %), sonst redet ihr Wert mit.

Anzeige: `<Gerät>.regulation.demand.reason` beginnt mit dem Gruppenbezug, z. B. „Gruppe „Garten“:
65 % = Maximum aus Wohnzimmer 65, Büro 45; Gästezimmer aus – folgt der Gruppe | eigene Anforderung
45 % …“. Unter dem Außengerät stehen `outdoorUnits.<Kennung>.demand`, `.demandReason` und `.leader`
(das Innengerät, das den Wert gerade bestimmt).

### Bedarfsregelung (Leistungsgrenze)

Die Bedarfsregelung begrenzt die Leistung der Anlage in 5-%-Stufen, damit sie gleichmäßig
durchläuft statt zu takten. Liegt der Raum 2 K oder mehr unter dem Ziel, gibt der Adapter immer
100 % frei – auch über eine niedrigere Obergrenze und über die Höchstleistung der Temperaturstufe
hinweg. Erreicht dagegen die Kennlinie selbst 100 % (Werksvorgabe bei −10 °C), ist das ein normaler
Wert: Die Höchstleistung der Temperaturstufe begrenzt ihn weiter.
Liegt der Raum 1,5 K oder mehr über dem Ziel (beim Kühlen darunter), geht die Leistung auf die
Mindeststufe 30 % – aber nie unter die Untergrenze der Anlage (Überheizschutz).

- **Kennlinie nach Außentemperatur:** Stützpunkte „Außen °C → Leistung %“, im Bild mit der Maus zu
  ziehen (die Tabelle dazu ist eingeklappt). Das Bild zeigt Unter- und Obergrenze und – sobald die
  Anlage Werte meldet – den aktuellen Arbeitspunkt. Die Heizkennlinie muss fallen (je kälter, desto mehr), die
  Kühlkennlinie steigen.
- **Auto (Vortag + Zuschlag):** die Leistung von gestern plus Reserve, so arbeitet auch „Auto“ in
  der Daikin-App. Ohne Daten von gestern gibt der Adapter 100 % frei.

Leere Felder übernehmen die Vorgabe. Eingeschaltet wird die Bedarfsregelung je Gerät auf der
Gerätekarte.

### Temperaturstufen

Temperaturstufen (früher „Szenen“) stehen im Reiter **Zeitpläne** – dort, wo sie gebraucht werden: Der
Wochenplan schaltet zwischen ihnen um. Eine Temperaturstufe ist ein kompletter Zustand der Anlage:
an/aus, Betriebsart, Zieltemperatur, Lüfter und eine **Höchstleistung**, die die Leistung aus der
Regelung zusätzlich begrenzt. Je Stufe lässt sich festlegen, ob Bedarfs- und Feuchteregelung in
dieser Zeit arbeiten. Ohne eigene Stufen gelten vier Werksstufen:

| Stufe | Ziel | Lüfter | Höchstleistung |
|---|---|---|---|
| Komfort | 21 °C | Auto | 100 % |
| Absenken | 19 °C | Nacht | 60 % |
| Abwesend | 17 °C | Auto | 50 % |
| Aus | Anlage aus | – | – |

Die Stufen der Vorlage gelten für alle Geräte ohne eigene Stufen. Eigene Stufen eines Geräts stellst
du im Reiter *Zeitpläne* bei seinem Wochenplan ein („Stufen anpassen“): Sie entstehen, sobald du dort
eine Stufe änderst, und gelten wie die Vorlage erst mit „Speichern“ der Instanz. „Auf die Vorlage
zurücksetzen“ verwirft sie wieder. Benutzt der Wochenplan des Geräts dabei Stufen, die es in der
Vorlage nicht gibt, fragt die Seite vorher je Stufe nach dem Ersatz (vorgeschlagen wird die Stufe der
Vorlage mit der nächstliegenden Temperatur); der Plan wird damit beim „Speichern“ umgeschrieben.

### Sensorquellen und Frostschutz

Für Außentemperatur, Raumtemperatur und Luftfeuchte wählbar:

- **Automatisch** – der beste verfügbare Sensor. Ein BLE-Sensor am Modul hat immer Vorrang (das
  legt die Firmware fest).
- **Sensor der Anlage**, **BLE-Sensor am Modul** oder ein beliebiger **Datenpunkt** aus ioBroker.

Ist ein Wert zu alt, fällt der Adapter auf den nächsten Sensor zurück und zeigt das auf der Karte
gelb an. Bei einem Raum-Datenpunkt gibt es zwei Wege: Die Anlage regelt selbst und der Adapter
gleicht ihren Sollwert an (empfohlen, auch für träge Sensoren in einem anderen Raum – der Sollwert
an der Anlage weicht dann um höchstens ±3 K vom Ziel ab), oder der Sensorwert geht ans Modul.

**Frostschutz:** Unter der eingestellten Raumtemperatur heizt der Adapter auf 10 °C – auch wenn
der Plan „Aus“ vorsieht. 0 schaltet den Frostschutz ab.

### Kopieren, Einfügen, Zurücksetzen

Unter jeder Grafik (Kennlinie, Temperaturstufen, Feuchte, Wochenplan) stehen drei Knöpfe:
**Kopieren** merkt den Inhalt, **Einfügen** setzt ihn bei einem anderen Gerät oder in der Vorlage ein
(grau, solange nichts Passendes kopiert ist), **Vorlage übernehmen** bzw. **Auf die Werksvorgabe
zurücksetzen** setzt zurück. Nach dem Einfügen oder Zurücksetzen erscheint kurz **Rückgängig**. Kennlinien, Stufen und
Feuchte-Grenzen gelten erst mit „Speichern“; ein Wochenplan am Gerät wirkt sofort.

## 3. Für alle Geräte

- **Handeingriff:** Bedient jemand die Anlage am Gerät oder in einer App, warten Plan und Temperaturstufen –
  bis zum nächsten Schaltpunkt, eine feste Dauer oder gar nicht. Bedarfs- und Feuchteregelung
  arbeiten weiter. „Handeingriff beenden“ auf der Karte beendet das Warten sofort.
- **Feuchte und Taupunkt:** ΔTP ist der Abstand zwischen Raumtemperatur und Taupunkt. Wird er zu
  klein oder die Feuchte zu hoch, schaltet der Adapter auf Entfeuchten, senkt beim Kühlen das Ziel
  um 1 K oder meldet nur – je nach Einstellung, mit Mindestlaufzeit und Pause.
- **Feiertage:** An Feiertagen kann der Sonntagsplan gelten (bundesweite deutsche Feiertage und
  eigene Daten).

## 4. Gerätekarten

![Gerätekarten](../img/karten.png)

Die Karte zeigt den laufenden Betrieb und bietet die Bedienung des Alltags:

- **Regelung:** Zustand (aktiv, Handeingriff, nicht eingerichtet, gestört, keine Verbindung,
  ausgeschaltet) mit der Begründung in Klartext. „Nicht eingerichtet“ heißt: Der Wochenplan ist
  eingeschaltet, aber noch keiner hinterlegt (dann erscheint oben der Knopf „Plan anlegen“), oder
  die Automatik des Moduls ist bei „Faikout-Modul regelt selbst“ noch aus. Rot („gestört“) steht nur
  bei echten Störungen.
- **Solltemperatur:** Schieber für große Schritte, die Knöpfe − und + daneben für je einen Schritt
  der Anlage (meist 0,5 K).
- **Sensoren:** Fehlt ein gewählter Datenpunkt, nennt die Karte ihn mit Namen und sagt, welcher
  Sensor stattdessen gilt.
- **Leistungsgrenze** als Zahl und Stufenbalken, mit Hinweis, wenn nur gerechnet wird (Probelauf),
  die Regelung ruht oder die Anlage den Wert nicht übernimmt.
- **Temperaturstufe** und **nächste Schaltung**, darunter der Verweis auf den Knopf „Wochenplan“.
- **Automatik:** drei Symbolknöpfe schalten Bedarfsregelung, Feuchteregelung und Wochenplan ein und
  aus (gefüllt = an).
- **Handeingriff:** Hinweis mit Uhrzeit und Knopf „Handeingriff beenden“.
- **Sensoren:** grün = gewählter Sensor liefert, gelb = Rückfall oder kein Wert; die Quelle steht im
  Tooltip.

Unten auf der Karte öffnet der beschriftete Knopf **Wochenplan** (mit Kalendersymbol) den Wochenplan
dieser Anlage, der Knopf daneben die **Details**.

### Wochenplan

Den Wochenplan gibt es an zwei Stellen – es ist derselbe Editor und derselbe Plan:

- im Reiter **Zeitpläne** der Einstellungen: je Gerät eine Zeile mit der Woche als Vorschau, Schalter
  „aktiv“ und „Wochenplan bearbeiten“; Pläne lassen sich zwischen Geräten kopieren und einfügen,
- auf der **Gerätekarte**: Knopf „Wochenplan“.

Der Wochenplan liegt je Gerät im Datenpunkt `regulation.schedule.weekJson` und **wirkt sofort** – er
braucht kein „Speichern“ der Einstellungsseite. Der **Plan der Vorlage** dagegen ist ein Wert der
Einstellungen: „Vorgabeplan laden“ im Editor setzt ihn ein (ohne Plan der Vorlage den Werksplan).

![Wochenplan](../img/wochenplan.png)

- In einen Block klicken: neuer Schaltpunkt an dieser Stelle, danach die Temperaturstufe wählen.
- Eine Linie ziehen: Schaltzeit verschieben (15-Minuten-Schritte).
- Eine Linie anklicken: andere Stufe wählen oder den Schaltpunkt löschen.
- Rechts je Tag: „+ Schaltpunkt“, Tag kopieren, Tag einfügen.
- **Vorgabeplan laden** setzt den Plan der Vorlage ein; ohne einen solchen den Werksplan (werktags
  morgens und abends Komfort, am Wochenende tagsüber).
- **Abwesenheit:** von/bis und die Temperaturstufe, die in dieser Zeit gilt.

Gespeichert wird erst mit „Plan übernehmen“. Ist der Wochenplan des Geräts ausgeschaltet, fragt der Adapter
danach, ob er eingeschaltet werden soll.

### Details

![Details](../img/details.png)

Die Details erklären die aktuelle Entscheidung: Kennlinie mit Arbeitspunkt, der Rechenweg Schritt
für Schritt, die Leistungsgrenze der letzten 24 Stunden und die verwendeten Sensoren mit ihrer
Quelle.

## 5. Einstellungen im Modul ändern

![Modul-Einstellungen](../img/modul_schreiben.png)

Im Reiter **Moduleinstellungen**:

1. Modul wählen (oder Adresse eintragen) und **Aus Modul lesen**. Gelesen wird nur per HTTP GET.
2. Werte im Formular ändern und **Unterschied prüfen** – die Vorschau nennt jede Änderung als
   „alt → neu“.
3. **In Modul schreiben** und die Rückfrage bestätigen. Der Adapter sendet eine einzige
   MQTT-Nachricht mit nur den geänderten Werten, wartet, bis das Modul wieder antwortet, liest
   zurück und zeigt das Ergebnis je Einstellung. Das kann bis zu einer Minute dauern: Ein Modul
   zeigt einen neuen Wert auf seiner Einstellungsseite oft erst nach etwa 30 Sekunden. Solange
   dreht sich das Symbol im Knopf.

Vor jedem Schreiben merkt sich der Adapter den gelesenen Stand (die letzten fünf je Modul). Unter
**Gesicherter Stand** lässt er sich wieder in das Formular laden und mit demselben Ablauf
zurückschreiben.

Wichtig:

- Geschrieben wird nur eine feste Liste: Statusintervall, Statusmeldungen in Echtzeit, Ziel in
  ganzen Grad, Thermostat-Betrieb, Leistungsgrenze ausblenden und der zusätzliche Befehlsname.
  Firmware/OTA, Broker, WLAN, Passwörter und der Name des Moduls lassen sich von hier aus nie
  ändern.
- Welche Einstellungen ein Modul anbietet, hängt von Firmware und Anlage ab. Was fehlt, wird
  genannt und nie geschrieben.
- Jedes Schreiben belastet den Flash-Speicher des Moduls und startet es bei manchen Einstellungen
  neu (etwa 10 Sekunden ohne Verbindung). Bitte gezielt ändern, nicht zum Ausprobieren im
  Minutentakt.

## 6. Eigener oder externer Broker

Ab Werk läuft der **eigene MQTT-Broker** des Adapters – es muss nichts weiter installiert werden,
die Module zeigen einfach darauf. Im Reiter **MQTT-Broker** lässt sich stattdessen ein **externer
Broker** wählen (zum Beispiel Mosquitto oder der MQTT-Adapter von ioBroker). Der Adapter verbindet
sich dann als Client; einzutragen sind Adresse, Port (1883, mit TLS meist 8883), bei Bedarf TLS,
Benutzername, Passwort, Client-ID und ein Topic-Präfix.

- **Verbindung testen** prüft die Werte aus dem Formular schon vor dem Speichern und sagt, ob der
  Broker erreichbar ist, die Anmeldung ablehnt oder nicht antwortet.
- Mit externem Broker läuft der eigene Broker nicht, sein Port wird frei.
- Die Module müssen selbst auf den externen Broker zeigen (Modul-Einstellung `mqtthost`). Der
  Adapter stellt das nicht automatisch um; der Reiter „Module suchen“ zeigt, welche Module noch
  auf einen anderen Broker zeigen, und kann ein Modul umstellen.
- Beim Wechsel gehen keine Daten verloren: Datenpunkte, Wochenpläne und Sicherungen bleiben. Nach
  dem Speichern startet der Adapter neu.

![Externer Broker](../img/broker_extern.png)

## 7. VIS-Baustein „Regelung“

![VIS-Baustein](../img/vis_regelung.png)

Der Baustein „Climate control (display)“ zeigt für ein Gerät Zustand, Temperaturstufe und nächste Schaltung,
die Kennlinie mit Arbeitspunkt, die Leistungsgrenze und welche Regelungen laufen. Er ist reine
Anzeige; bedient wird über die übrigen Bausteine oder die Gerätekarte. Als Attribut genügt das
Geräteobjekt, z. B. `faikout.0.Wohnzimmer`.

## 8. Datenpunkte

Alles, was die Oberfläche zeigt, steht auch als Datenpunkt unter `<Gerät>.regulation.*` bereit, unter
den Kanälen `demand` (Leistungsgrenze), `schedule` (Wochenplan), `humidity` (Feuchte), `manual`
(Handeingriff), `target` (Tasten wärmer/kühler) und `sensors` (Sensoren). Ob die Anlage eine
Leistungsgrenze annimmt, steht in `<Gerät>.info.demandCapable` (`unknown`, `yes`, `no`).

| Datenpunkt unter `regulation.` | Werte | Bedeutung |
|---|---|---|
| `state` | ok · manual · setup · fault · offline · off | Zustand der Regelung insgesamt |
| `reason` |  | Begründung im Klartext |
| `mode` | adapter · faikout | wer regelt |
| `lastCommand` |  | letzter Befehl (JSON; im Probelauf: würde senden) |
| `historyJson` |  | Leistungsgrenze der letzten 24 Stunden |
| `demand.active` |  | Schalter Leistungsgrenze |
| `demand.dryRun` |  | Anzeige: Probelauf wirkt für diese Anlage (kein Schalter) |
| `demand.setpoint` · `rawValue` · `outsideMean` |  | berechnete Grenze, Rohwert, Außenmittel (30 min) |
| `demand.state` · `demand.reason` | ok · fault · notCapable · neutral · off | Zustand und Begründung der Leistungsgrenze |
| `demand.strategy` | curve · previousDay | Strategie |
| `demand.wouldSend` · `commandsPerHour` |  | letzter demand-Befehl, Befehle der letzten Stunde |
| `demand.curveJson` · `capableReason` · `stateJson` |  | Kennlinie der Anlage, Begründung der Fähigkeit, interner Zustand (neustartfest) |
| `schedule.active` · `weekJson` · `absenceJson` |  | Schalter, Wochenplan und Abwesenheit |
| `schedule.level` · `next` · `nextLevel` · `missing` |  | aktuelle Temperaturstufe, nächster Schaltpunkt mit seiner Stufe, „noch kein Plan hinterlegt“ |
| `humidity.active` · `dewPoint` · `margin` · `intervention` · `reason` |  | Feuchteregelung: Schalter, Taupunkt, Abstand, Eingriff, Begründung |
| `manual.locked` · `until` · `resume` |  | Handeingriff: Automatik wartet, bis wann, Taste „fortsetzen“ |
| `target.up` · `target.down` |  | Tasten: Solltemperatur einen Schritt wärmer/kühler |
| `sensors.outside` · `room` · `humidity` |  | verwendete Sensorwerte |
| `sensors.…Source` · `…Status` · `…Kind` | Status: ok · fallback · missing; Kind: ble · dp · internal | Quelle im Klartext, Stand und Art je Sensor |
| `sensors.correction` · `target` · `note` |  | Sensorkorrektur, Ziel am Raumsensor, Hinweis auf fehlenden Datenpunkt |

Vorabstände von 1.0.0 führten diese Datenpunkte unter `<Gerät>.regel.*`. Der Adapter zieht sie beim
Start einmal um (Schalter, Wochenplan, Abwesenheit, Verlauf und eigene History-Einstellungen bleiben
erhalten) und löscht die alten Objekte.

Mit der Umbenennung der „Szenen“ in „Temperaturstufen“ heißen zwei Datenpunkte anders. Auch sie
zieht der Adapter beim Start um (Wert und History-Einstellungen bleiben):

| alt | neu |
|---|---|
| `regulation.schedule.scene` (Vorabstand: `regel.plan.szene`) | `regulation.schedule.level` |
| `regulation.schedule.nextScene` (Vorabstand: `regel.plan.naechsteSzene`) | `regulation.schedule.nextLevel` |

### Einstellungen: alt → neu

Beim ersten Start mit 1.0.0 zieht der Adapter die Instanzeinstellungen einmal um und startet danach
neu. Eigene Werte werden dabei nie überschrieben.

| alt | neu | Umzug |
|---|---|---|
| `regelSzenen` | `regelStufen` | Liste wird übernommen |
| je Gerät `szenen` | je Gerät `stufen` | Liste wird übernommen |
| je Gerät `individuell` (Zwischenstand) | entfällt | Einträge mit Haken behalten ihre eigenen Werte; bei Einträgen ohne Haken werden die bisher ungenutzten eigenen Werte geleert – das Regelverhalten bleibt in beiden Fällen, wie es war |
| – | `regelPlanVorlage` | neu, leer = Werksplan |
| `regelObergrenze` 95 | 100 | nur, wenn noch die alte Werksvorgabe 95 eingestellt ist |
| Heizkennlinie −10 °C → 95 % | −10 °C → 100 % | nur, wenn die Kennlinie exakt die alte Werksvorgabe ist |
| `User` (Vorabstand 0.5.0) | `user` | Benutzername des eigenen Brokers wird übernommen – die Module bleiben angemeldet |

### JSON-Datenpunkte

Die Schlüssel in den JSON-Datenpunkten sind englisch. Vorabstände von 1.0.0 schrieben deutsche
Schlüssel: Der Adapter liest sie weiterhin (auch wenn ein Skript noch das alte Format schreibt),
schreibt selbst nur noch die englischen und schreibt gespeicherte Altwerte beim Start einmal um.

| Datenpunkt | alt | neu | Beispiel (neu) |
|---|---|---|---|
| `demand.curveJson` | `heizen` · `kuehlen` · `untergrenze` · `obergrenze` | `heating` · `cooling` · `lowerLimit` · `upperLimit` | `{"heating":[[-10,100],[0,75],[7,55],[15,40]],"cooling":[[25,40],[30,65],[35,95]],"lowerLimit":40,"upperLimit":100}` |
| `lastCommand` | `felder` · `zeit` · `aktion` (`senden`/`wuerde`) | `fields` · `time` · `action` (`send`/`would`) | `{"fields":{"target":22,"fan":"auto"},"time":"2026-11-21T11:38:19.361Z","action":"send"}` |
| `demand.wouldSend` | `wert` · `zeit` · `aktion` (`senden`/`wuerde`) · `ist` | `value` · `time` · `action` (`send`/`would`) · `current` | `{"value":85,"time":"2026-11-21T12:14:38.489Z","action":"would","current":100}` |
| `schedule.absenceJson` | `von` · `bis` · `szene` (zwischenzeitlich `scene`) | `from` · `to` · `level` | `{"from":1798326000000,"to":1798930800000,"level":"abwesend"}` (Zeit in ms oder als ISO-Text; leer = keine Abwesenheit) |

Unverändert, weil ohne deutsche Schlüssel: `schedule.weekJson` (sieben Tage ab Montag, je Schaltpunkt
`{"t": Minuten seit Mitternacht, "s": ID der Temperaturstufe}`), `historyJson` (Paare `[Zeit in ms, Prozent]`) und
`consumption.*Json` (`hour`/`day`/`month`, `kwh`). `demand.stateJson` ist das Gedächtnis des Adapters
über einen Neustart hinweg – keine Schnittstelle, der Aufbau kann sich jederzeit ändern.

Die IDs der Temperaturstufen (`komfort`, `absenken`, `abwesend`, `aus` oder aus dem eigenen Namen
gebildet) sind sprachunabhängig und bleiben, wie sie sind: an ihnen hängt der Wochenplan – bestehende
Pläne gelten unverändert weiter. Nur der angezeigte Name der vier Werksstufen folgt der Systemsprache;
eigene Stufen behalten ihren Namen.

## 9. Verbrauch

Der Reiter „Verbrauch“ zeigt ein Diagramm für alle Anlagen: gestapelte Balken je Tag, Woche, Monat
oder Jahr, jede Anlage in ihrer eigenen, dauerhaft gleichen Farbe; die Balkenhöhe ist die Summe.
Die Chips darüber sind die Legende – ein Klick blendet eine Anlage aus. Der Tooltip nennt den Wert
je Anlage und die Summe; umschaltbar sind „Alles“, „Nur Heizen“ und „Nur Kühlen“ sowie Diagramm
oder Tabelle. Die Daten kommen aus den eigenen Zählern des Adapters (48 Stunden, 62 Tage,
24 Monate); ein History-Adapter ist dafür nicht nötig.

### Multisplit: Innengeräte einem Außengerät zuordnen

Hängen mehrere Innengeräte an **einem** Außengerät, melden ihre Module denselben Zähler des
Außengeräts. Damit Verbrauch, COP und Leistungsgrenze stimmen, sagst du dem Adapter im Reiter
**Multisplit**, welche Innengeräte zusammengehören. Der Adapter ordnet **nie selbst** zu.

1. **Ansehen:** Jede Anlage ist eine Kachel – oben das Außengerät (der Lüfter dreht, wenn es läuft),
   an der Leitung darunter die Innengeräte. Einzelne Anlagen stehen grau darunter.
2. **Vorschlag:** Erkennt der Adapter gleiche Zähler, erscheint ein Vorschlag (sonst Knopf
   **„Zuordnung vorschlagen“**). Pfeile und Kennungen (A1, A2, B1 …) zeigen, welches Innengerät wohin
   wandert; jede vorgeschlagene Anlage hat ihre eigene Farbe. Die Stufe sagt, wie belastbar er ist:
   *sicher* (Zähler über 10 kWh, höchstens 200 Wh auseinander, 10 Minuten lang beobachtet – oder gleiche
   Zähler **und** gleich laufende Verdichter), *wird noch geprüft* oder *unsicher* (nur Verdichter und
   Außentemperatur laufen gleich). Die Beobachtung
   übersteht einen Neustart des Adapters.
3. **Übernehmen:** Mit dem grünen **✓** an der vorgeschlagenen Kachel übernimmst du genau dieses
   Außengerät. **„Vorschlag schließen“** verwirft den Rest; Abgelehntes kommt erst über „Zuordnung
   vorschlagen“ oder bei einer geänderten Gruppe wieder.
4. **Von Hand:** Ein Innengerät auf ein Außengerät, auf eine einzelne Anlage oder auf „Neues
   Außengerät“ ziehen; herausziehen und irgendwo loslassen löst es wieder (mit „Rückgängig“). Das
   Menü ⌄ an jeder kleinen Kachel kann dasselbe.
5. **Speichern** – erst dann gilt die Zuordnung.

Danach zeigt die Kachel Leistung (Summe der Innengeräte), Energie heute, den Anteil jedes Innengeräts, den **Rest** (Verbrauch
des Außengeräts, den die Innengeräte nicht erklären, z. B. Abtauen oder Innengeräte ohne Modul) und den **System-COP**. Innengeräte
ohne Faikout-Modul trägst du als Zahl unter „Weitere Innengeräte ohne Faikout-Modul“ ein. Jedes
Außengerät bekommt eine eigene **Gerätekarte** (nur Anzeige) und die Datenpunkte
`outdoorUnits.<Kennung>.*`. Mit eingeschalteter Bedarfsregelung gilt die Leistungsgrenze je
Außengerät (siehe „Multisplit: eine Leistungsgrenze je Außengerät“).

## 10. Effizienz: Wärmeleistung und COP

Der Reiter „Effizienz“ beantwortet: **Wie viel Wärme (oder Kälte) liefert die Anlage für ihren Strom?**
Der Adapter schätzt das aus Werten, die die Anlage ohnehin meldet – ohne Zusatzgerät:

    Wärme = Luftdichte × c_p × Luftstrom × (Austrittstemperatur − Ansaugtemperatur)
    Austrittstemperatur = Ansaug + ε × (liquid − Ansaug)
    COP (Kühlen: EER) = Wärme ÷ Strom

- **Ansaugluft** ist `status.achome`, **liquid** ist der Kältemittelsensor am Innengerät (`status.liquid`),
  der **Strom** kommt aus der gemeldeten Leistung `status.consumption` (der Energiezähler `status.energy` zählt nur in 100-Wh-Schritten und dient als Rückfall).
- Der **Luftstrom** folgt der Lüfterstufe bzw. der gemeldeten Drehzahl (`status.fanfreq`) über die
  Kennlinie des Modells (Datenblatt, Heizen und Kühlen getrennt). Läuft eine feste Stufe ein paar Minuten,
  merkt sich der Adapter ihre Drehzahl – danach rechnet er auch bei „Auto“ über die Drehzahl.
- **ε** sagt, wie stark die Luft dem Register folgt. Ohne Messung stammt ε aus dem Datenblatt (Bypassfaktor der
  Leistungstabelle; ohne Modell ein generischer Wert). `liquid` sitzt an der Flüssigkeitsleitung, nicht mitten
  im Register – ε ist deshalb ein Erfahrungswert und kann über 1 liegen. Genau wird er erst durch die
  **Kalibrierung**.

**Ehrlich gesagt:** Ohne Kalibrierung ist die Leistung eine Schätzung mit etwa ±25–35 %, kalibriert etwa
±10–20 %. Der Adapter weist die Unsicherheit je Wert aus (`efficiency.uncertainty`) und rechnet sie aus den
tatsächlichen Anteilen (ε, Luftstrom, Temperaturabstand, Restfehler der Kalibrierung). Bei sehr kleiner Last,
kurz nach dem Anlauf und bei „Auto“ ohne gelernte Drehzahl steht ein Hinweis dabei.

Was **nicht** gerechnet wird:

- **Abtauen** (Heizen, Register kälter als der Raum): keine Wärme, Kennzeichen `efficiency.defrosting`. Der
  Strom dieser Zeit zählt aber in den Tages-COP – wie auf der Stromrechnung.
- **Stillstand** des Verdichters: Leistung 0.
- **Kühlen:** nur die fühlbare Kälte. Die Entfeuchtung (latent) kommt nur dazu, wenn ein Sensor dauerhaft
  Temperatur und Feuchte am Austritt misst und die Anlage ihre Raumfeuchte meldet; sonst ist die Kälteleistung
  unterschätzt und so gekennzeichnet.
- **Anlagen ohne die nötigen Werte** (z. B. IR-Brücken): „nicht verfügbar – diese Anlage meldet … nicht“.
  Der Stromverbrauch funktioniert weiter.

### Der Reiter

Oben das Schaubild der Rechnung, darunter je Anlage eine Karte. Die Kopfzeile zeigt das Wichtigste
(„COP 3,4 · 1,62 kW · geschätzt ±28 %“). Aufgeklappt:

1. **Live-Werte:** Wärmeleistung, COP jetzt (geglättet), COP heute, Wärme heute, Luftstrom und geschätzte
   Austrittstemperatur – jeweils mit der Güte *geschätzt*, *kalibriert* oder *gemessen*.
2. **Modell:** „Modell wählen“ öffnet die Suche (Text, Reihe, Bauform, Baugröße). Mitgeliefert sind
   96 Daikin-Innengeräte mit Luftstrom je Stufe, Nennleistung, SEER/SCOP und Quelle. Jeder Eintrag sagt, wie er
   geprüft ist, und nennt, was die Herstellertabelle nicht hergibt – es ist nichts geraten oder aufgefüllt.
   Fehlt dein Gerät: **Eigenes Modell anlegen** (Luftstrom aus dem Datenblatt, m³/min = m³/h ÷ 60). Ohne
   Modell rechnet der Adapter mit generischen Werten und größerer Unsicherheit.
3. **Luftstrom je Lüfterstufe:** Balken zum Ziehen (auch Pfeiltasten oder Doppelklick auf die Zahl). Eigene
   Werte sind umrandet; „Auf das Datenblatt zurücksetzen“ nimmt sie zurück. Zwischenstufen ohne
   Datenblattwert sind gerechnet und so gekennzeichnet.
4. **ε je Stufe** mit dem Band der Unsicherheit und der Angabe, was gilt.
5. **Kalibrieren** (siehe unten).

Ganz unten: **Strompreis je kWh** (optional) – dann zeigen die Karten, was eine kWh Wärme heute kostet
(`efficiency.heatPrice`).

Modell, eigene Luftstromwerte und Preis gelten nach „Speichern“. Messung und Kalibrierungen wirken sofort.

### Kalibrieren mit einem Austrittssensor

Einen Funk-Temperatursensor etwa 10 cm vor den Luftaustritt legen und im Abschnitt „Kalibrieren“:

1. **Sensor wählen** – den Datenpunkt des Sensors (optional die Feuchte), dann „Messung starten“.
2. **Messen** – die Messung läuft im Adapter über Tage und übersteht einen Neustart. Alle zwei Minuten kommt
   ein Messpunkt dazu, solange die Anlage gleichmäßig läuft; Abtauen, Anlauf, Stillstand und sehr kleine Last
   bleiben draußen (die Zahl steht dabei). Balken zeigen die **Abdeckung je Lüfterstufe** („Stufe Mittel:
   42 Messpunkte, ok“) und je Außentemperaturbereich; ein Hinweis nennt die Stufe, die man als Nächstes etwa
   40 Minuten laufen lassen sollte. Ab 20 Punkten gilt eine Stufe als gut abgedeckt.
3. **Ergebnis** – ε je Stufe, der Restfehler und die Begründung: Liegen die gemessenen Stufen höchstens 5 %
   auseinander, gilt **ein Wert für alle Stufen**; sonst behält jede Stufe ihren Wert. Nicht gemessene Stufen
   werden zwischen gemessenen interpoliert bzw. vom Nachbarn übertragen – gekennzeichnet. **Übernehmen** macht
   das Ergebnis zur geltenden Kalibrierung, **Verwerfen** löscht die Messung.

**Handmessung statt Sensor:** Zeit und Austrittstemperatur eintragen. Die übrigen Werte (Stufe, Ansaugluft,
liquid) sucht der Adapter für diesen Moment heraus – aus seinem eigenen Verlauf der letzten 24 Stunden, sonst
aus dem History-Adapter (wenn `status.*` dort aufgezeichnet wird); findet er nichts, fragt er sie ab. Eine
Messung während des Abtauens lehnt er mit Begründung ab.

Je Anlage gibt es eine Liste aller Kalibrierungen (Datum, Herkunft, Punkte, Unsicherheit); eine davon gilt.
„Auf die Datenblatt-Schätzung zurücksetzen“ schaltet zurück, ohne etwas zu löschen. Bleibt der Sensor
dauerhaft am Austritt, kann der Adapter **messen statt schätzen** (Haken unter der Liste).

### Datenpunkte

| Datenpunkt (`<Gerät>.efficiency.…`) | Inhalt |
|---|---|
| `heatOutput`, `coolingOutput` | Wärme- bzw. Kälteleistung in kW |
| `cop` | COP bzw. EER jetzt, über etwa fünf Minuten geglättet |
| `airflow`, `outletTemperature` | Luftstrom in m³/h, Austrittstemperatur (geschätzt oder gemessen) |
| `state`, `defrosting` | was die Anlage tut (heating, cooling, defrosting, idle, off, unavailable) |
| `quality`, `uncertainty`, `missing` | Güte (estimated, calibrated, measured, unavailable), Unsicherheit in %, fehlende Werte |
| `heat.today/yesterday/thisMonth/lastMonth`, `cold.…` | Wärme- bzw. Kältemenge in kWh |
| `copToday/Yesterday/ThisMonth/LastMonth`, `eer…` | Wärme ÷ Strom über denselben Zeitraum |
| `hoursJson`, `daysJson`, `monthsJson` | Reihen `{hour/day/month, heat, cold, elHeat, elCool}` (48 Stunden, 62 Tage, 24 Monate) |
| `heatPrice` | Kosten je kWh Wärme heute (nur mit Strompreis) |

Zähler und Nenner des Tages-COP laufen über dieselben Zeitabschnitte: War der Adapter oder das Modul länger
als fünf Minuten weg, zählt dieser Abschnitt auf beiden Seiten nicht. Die Zählerwerte der Anlage
stehen unverändert unter `consumption.*`; über einen Tag können beide Summen leicht voneinander abweichen.

Im Reiter **Verbrauch** schaltet „Wärme & COP“ das Diagramm um: Balken zeigen die Wärme je Anlage, die Linie
den COP (Achse rechts). „Strom“ bleibt die Vorgabe. Die Gerätekarte zeigt „COP heute 3,8 (geschätzt)“; im VIS-Baustein „Messwerte“ gibt es den Messwert „COP heute“.

### Ausblick

- **Regelung auf den besten COP** (die Anlage im effizienten Teillastbereich halten, Takten vermeiden) ist
  bewusst noch nicht gebaut – erst sollen die Werte über einen Winter belastbar sein.
- **Multisplit** (mehrere Innengeräte an einem Außengerät): Jedes Modul meldet die Leistung **seines**
  Innengeräts (`status.consumption`, S21 „FX60“; der Verdichter `status.comp` ist an allen gleich). Seit
  1.2.1 rechnet der COP je Innengerät, auch der Momentan-COP, mit dieser Leistung. Der Adapter prüft sie
  gegen den eigenen Heiz-/Kühlzähler des Innengeräts: Stellt sie sich als Leistung des ganzen Außengeräts
  heraus (gemessen über 1 kWh Zählerzuwachs: mehr als das 1,5-Fache), nimmt er wieder den Zähler (100-Wh-Stufen,
  kein Momentan-COP) und zählt die Leistung je Außengerät einmal. Für die ganze Anlage gibt es den
  **System-COP** am Außengerät (Reiter Multisplit, `outdoorUnits.<Kennung>.copToday`).

## 11. Sprachen

Die Oberfläche gibt es in elf Sprachen (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn); sie folgt der
Systemsprache des ioBroker, Zahlen stehen mit dem Dezimalzeichen der Sprache. Deutsch und Englisch
pflegt der Autor selbst. Die anderen neun Übersetzungen sind maschinell erstellt und maschinell
gegengelesen (Begriffe einheitlich, Darstellung in allen Sprachen bei breitem und schmalem Fenster
geprüft), aber nicht von Muttersprachlern durchgesehen – Korrekturen sind willkommen. Die VIS-Bausteine zeigen ihre Texte in
denselben elf Sprachen – sie folgen der Sprache von VIS, mit Rückfall auf Englisch (die Attributnamen
sind ebenfalls übersetzt); diese Anleitung gibt es auf Deutsch und Englisch.

