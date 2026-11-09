# MAD Boxenmauer

Anpassbares Dashboard für Trainings- und Renntage: große Uhr, Live-Regenradar über der Strecke, Regenprognose, Tageszeitplan mit Erinnerungen, Renntag-Checkliste und Notizen.

## Starten

1. `mad-boxenmauer.zip` entpacken.
2. `index.html` in Chrome, Edge oder Safari öffnen (Doppelklick genügt, kein Server nötig).
3. Für Radar, Satellitenbild und Wetter braucht der Rechner Internet (z. B. Hotspot an der Strecke). Uhr, Zeitplan, Checkliste und Notizen laufen auch offline.

Alle Eingaben (Layout, Zeitpläne, Einstellungen) bleiben im Browser des jeweiligen Rechners gespeichert. Über *Einstellungen → Sichern (JSON)* lässt sich alles auf einen anderen Rechner übertragen.

## Bedienung

- **Training / Renntag** oben schaltet zwischen zwei getrennt gespeicherten Layouts um.
- **Anordnen**: Das Raster aus 12 Spalten wird als Kästchen sichtbar. Widget am Titel packen und an die gewünschte Stelle ziehen; die rote Fläche zeigt, wo es einrastet, andere Widgets weichen nach unten aus und rücken nach oben nach. Größe an der roten Ecke unten rechts ziehen oder über die Felder Breite (x/12) und Höhe wählen. Auf dem Handy werden die Widgets untereinander in derselben Reihenfolge gezeigt.
- **Strecke** oben wählen. Die 11 Strecken aus den ALFANO-Daten sind mit exaktem GPS-Streckenverlauf hinterlegt, der Erftlandring Kerpen mit Standort; dessen Streckenverlauf holt das Dashboard beim ersten Öffnen aus OpenStreetMap, sofern er dort eingezeichnet ist. Weitere Strecken (z. B. Viterbo, Genk) unter *Einstellungen → Eigene Strecke* suchen oder im Radar per Rechtsklick / langem Tippen setzen.
- **Vollbild**: Das Symbol ganz rechts oben (oder Taste **F**) schaltet wie bei YouTube auf echtes Vollbild, Esc oder nochmal F beendet es. Im Vollbild verschwindet die obere Leiste nach 3 Sekunden ohne Mausbewegung und kommt bei Bewegung oder Antippen zurück. Das MAD-Logo mit „powered by SR“ steht im Vollbild dauerhaft in einer Leiste am unteren Rand. Auf dem iPhone bietet Safari kein Vollbild für Webseiten, dort fehlt der Knopf; stattdessen *Teilen → Zum Home-Bildschirm*.
- **Ton an** einmal antippen, damit Erinnerungen piepen. *Einstellungen → Systembenachrichtigungen erlauben* zeigt sie zusätzlich als macOS-/Windows-Mitteilung.
- **Eigene Klasse** in den Einstellungen (z. B. `OK Junior`): diese Turns werden markiert (★), der Filter *Meine Klasse* zeigt nur sie plus Pflichttermine, und auf Wunsch wird auch an sie erinnert.

## Vorbereitete Veranstaltung: Eifel-Erft-Cup Finale Kerpen (24.–25.10.2026)

- Ab einer Woche vorher zeigt der Tageszeitplan oben *Eifel-Erft-Cup Finale Kerpen* mit **Veranstaltung laden** (bzw. **Offiziellen Zeitplan laden**, falls schon der vorläufige Plan geladen war). Das stellt Strecke (Erftlandring), Renntag-Layout, Klasse *OK-N Senior, Gruppe 3* und Startnummer *194* ein, setzt die Livetiming-Quelle und trägt den offiziellen Zeitplan V1 (Stand 06.09.2026) ein.
- Samstag (Testtag): 6 Trainingsrunden je Gruppe à 13 min ab 09:00, Registrierung und Technische Abnahme 14–17 Uhr, Fahrerbesprechung für Mini/Junior 17:30. Sonntag: Warm-up ab 08:30, Zeittraining ab 09:30, Rennen 1/2/3 ab 10:40, 13:20, 15:30 (Gruppe 3 Senior: 08:50, 09:50, 11:20, 14:00, 16:10), Siegerehrung ca. 17:30.
- Im Samstags-PDF steht versehentlich der 21.03.2026; das Dashboard verwendet den 24.10. Beim eigenen Import eines Plans mit vergangenem Datum bietet der Import an, alle Zeilen auf den nächsten passenden Wochentag zu verschieben.
- Ein vom Team selbst importierter Plan wird beim Laden der Veranstaltung nicht überschrieben, ebenso eine selbst eingetragene Klasse oder Startnummer.

## Zeitplan

- *Importieren → Datei wählen*: **PDF** (z. B. Zeitplan aus Sportity), Foto vom Aushang oder Screenshot. Mehrtägige Pläne (Sa/So, Do–So) werden anhand der Tagesüberschriften auf die einzelnen Tage verteilt; bei Rennläufen wird „Pre-Grid Closing“ als **Vorstart** übernommen, und Erinnerung sowie Countdown richten sich dann nach dem Vorstart. Getestet mit dem AKM-Zeitplan Wackersdorf (59 Termine an 2 Tagen) und der Trofeo delle Industrie (15 Termine an 4 Tagen). Bei Fotos: Die Texterkennung (Tesseract, Deutsch/Englisch/Italienisch) läuft im Browser, lädt beim ersten Mal ca. 10 MB Sprachdaten und braucht dafür Internet. Das Ergebnis erscheint als Tabelle zum Prüfen, bevor es übernommen wird.
- *Importieren → Text einfügen*: Zeitplan aus Sportity, PDF oder WhatsApp kopieren und einfügen. Erkannt werden Formate wie `08:00-08:30 …`, `8.00 …`, `08h00 …` und Blöcke mit Uhrzeit in eigener Zeile.
- Die Art jedes Termins wird aus Stichwörtern bestimmt (Fahrerbesprechung/Briefing, Reifen/Pneumatici, Transponder, Papierabnahme/Verifiche sportive, Technische Abnahme/Scrutineering, Mittag/Pausa, Leihkart/Noleggio, Training/Heat/Finale …). Pflichttermine bekommen automatisch eine Erinnerung (Standard 15 min vorher und zum Start).
- *Bearbeiten* öffnet alle Termine des Tages als Tabelle. Mit ‹ › lassen sich Folgetage eines Rennwochenendes vorbereiten.
- Beim ersten Start steht ein mit **BEISPIEL** markierter Renntag-Plan im heutigen Tag, damit man sieht, wie es aussieht. Über *Bearbeiten → Tag leeren* entfernen.

## Livetiming

- Widget *Livetiming* (im Renntag-Layout schon drin, sonst über *Anordnen → Widget hinzufügen*).
- **Apex Timing** (South Garda/Lonato und viele italienische Bahnen, auch die Trofeo delle Industrie): Die Daten kommen direkt aus dem Live-Datenstrom von Apex und werden als eigene Tabelle angezeigt. Oben stehen groß die eigenen Karts mit Position, letzter und bester Runde und Abstand. Startnummern oder Namen dafür unter *Einstellungen* oder im ⚙ des Widgets eintragen. Lila = schnellste Runde gesamt, grün = persönliche Bestzeit.
- Andere Apex-Strecken: ⚙ → *Andere Strecke mit Apex Timing* und die Kennung aus der Adresse `apex-timing.com/live-timing/<kennung>/` eintragen.
- **racemon (AKM/DKM)** und andere Anbieter: werden vorerst als eingebettete Webseite gezeigt. Lässt die Seite das nicht zu, bleibt die Fläche leer; dann über *In eigenem Fenster öffnen*.
- *Rohdaten* unten im Widget zeigt, was gerade ankommt. Falls die Tabelle leer bleibt, obwohl auf der Strecke gefahren wird, hilft ein Screenshot davon bei der Fehlersuche.
- Die Livetiming-Daten sind nur für den Teamgebrauch gedacht, nicht zum Weiterverbreiten.

## Datenquellen und Grenzen

- **Radar**: RainViewer (kostenlos). Der freie Zugang liefert nur die letzten ca. 2 Stunden ohne Vorhersage und nur bis Zoomstufe 7; näher heran wird das Radarbild vergrößert. Die Animation zeigt Zugrichtung und Tempo der Regenfront, die Ringe 10/25/50/100 km helfen beim Abschätzen.
- **Prognose**: Open-Meteo (kostenlos, ohne Schlüssel), Niederschlag in 15-Minuten-Schritten für 4 Stunden, Regenwahrscheinlichkeit je Stunde und Tageswerte für heute und die nächsten 3 Tage. Kommt laut Prognose innerhalb einer Stunde Regen, erscheint ein blauer Hinweis.
- **Satellitenbild**: Esri World Imagery. **Streckenverlauf** für Bahnen ohne ALFANO-Daten: OpenStreetMap (Overpass).
- **Sportity**: Es gibt keine öffentliche Schnittstelle, deshalb der Weg über Screenshot oder kopierten Text.
- In der claude.ai-Vorschau sind Karte, Radar, Wetter und Livetiming gesperrt; dort funktioniert dafür die Foto-Auswertung über Claude statt Tesseract.

## Dateien

`index.html`, `dashboard.css`, `dashboard.js`, `tracks.js` (Strecken mit GPS-Verlauf, aus den .alf2-Dateien erzeugt), `vendor/leaflet/` (Kartenbibliothek) und `vendor/pdfjs/` (PDF-Leser), beide lokal mitgeliefert.
