# MAD Telemetrie (Prototyp)

Browser-App ohne Build-Schritt und ohne Abhängigkeiten. Liest ALFANO-7-Sessions (`.alf2`) direkt ein.

## Starten

```sh
cd webapp
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Einfachster Weg auf dem Mac: `mad-telemetrie.zip` entpacken und `index.html` in Chrome doppelklicken (dann fehlen nur die Beispieldaten). Das Satellitenbild braucht Internet; in der claude.ai-Vorschau ist es gesperrt, weil diese keine externen Kartendaten lädt.
Online-Version: https://claude.ai/artifact/7b8b2XMARWXNv4XUUnEDMD

## Was drin ist (Stand v4, 20.10.2026)

Design wie die MAD Boxenmauer: dunkles Kopfband mit MAD- und Stiffel-Racing-Logo, Teamstreifen, rote Akzente, Widgets mit roter Schräge, Vollbild mit Taste F.

- Import: `.alf2` per Drag & Drop oder Button, mehrere Dateien auf einmal. Duplikate werden erkannt. Daten bleiben in IndexedDB dieses Browsers.
- Session-Baum links wie in ADA PRO: Sessions nach Strecke, aufgeklappte Session zeigt alle Runden mit Rang. Häkchen = Runde ins Overlay, bis zu 6 Runden aus beliebigen Sessions derselben Strecke, Farben wie in ADA (gelb, cyan, grün, pink, orange, grau).
- Referenz: die erste Runde. Klick auf eine Runde in der Legende macht sie zur Referenz.
- Kurven: Kanäle frei wählbar (beliebig viele untereinander, auch Rechenkanäle), X-Achse Distanz oder Zeit, Kreise an Kurvenminima und Vmax, Werte aller Runden direkt am Cursor. Bereich ziehen = Zoom, Doppelklick = zurück.
- Werte-Tabelle am Cursor: je Runde Zeit, Distanz, Δ Zeit (an gleicher Stelle) und Δ Distanz (zur gleichen Zeit, in Metern), Kanalwerte mit Balken.
- Strecke auf Satellitenbild (Esri) oder als Plan, Referenz eingefärbt nach Speed/Drehzahlband/Gas-Bremse/Querbeschleunigung, weitere Runden als Linien, alle Karts als Punkte.
- G-Kraft am Cursor (Vektor und Spur), Sektoren aller ausgewählten Runden mit Abstand zur Referenz und theoretischer Runde.
- Wiedergabe in Echtzeit (×0,5 bis ×4), alle Runden als Geister nach Zeit. Schritt ±0,1 s (auch Pfeiltasten), Leertaste = Start/Pause.
- Tabs: Runden (Verlauf und Tabelle, Klick = Runde ins Overlay), Max/Min je Runde (Klick markiert die Stelle), Drehzahlbänder, Motor (Zug über Drehzahl, Übersetzung), G-G-Diagramm, Session-Verlauf (ganze Session über die Zeit, z. B. Wasser und EGT, Runden als Felder), Video (ein Video je ausgewählter Runde, pro Session einmal synchronisieren, alle laufen gemeinsam), Setup-Notizen.
- Tab „Wochenende“: alle Sessions der Strecke im Zeitraum ±3 Tage mit Bestzeit, Δ zur Event-Bestzeit, theoretischer Runde, Vmax, Wasser/EGT max, Verlauf der Bestzeiten; „Bestrunden vergleichen“ legt die schnellste Runde jeder Session übereinander. Filter „Zeitraum“ (Heute, letzte 3 Tage) in der Bibliothek.
- Kerpen: ALFANO-Streckennamen mit KERPEN/ERFTLAND werden als „Erftlandring Kerpen“ geführt. Import ohne Dateityp-Filter, damit das iPad .alf2 nicht ausgraut.
- Fahrer zuordnen: Standardnamen (`ALFANO_7`, `Driver_N`) werden markiert; Zuordnung global pro Rohname oder pro Session im Kopf.

G-Sensor: Offset 1000, 1/100 g, X = quer, Y = längs (+ = Bremsen), per GPS-Abgleich bestätigt.

Nicht nachgebaut, weil die Sensoren fehlen: Lambda, Reifendruck/-temperatur, Lenkung, Pedale, Getriebe (Junior fährt Direktantrieb).

## Dateien

- `index.html`, `app.css`, `app.js`: die App
- `assets/`: MAD- und Stiffel-Racing-Logo (wie in der Boxenmauer)
- `samples/samples.json`: drei echte Sessions (2× Wackersdorf, 1× Ampfing) als Base64 für die Demo

## Bekannte Grenzen

- 25-Hz-Spalten werden ignoriert, es wird mit 10 Hz gearbeitet.
- Die Datei `LAP_<n+1>` (Einfahrt in die Box) wird nicht angezeigt.
