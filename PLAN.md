# ViMonitor: Umsetzungsplan

## Ziel

Eine lokal auf Windows laufende Web-App liest Temperaturen einer
Viessmann-Heizung ueber die ViCare/IoT-API, speichert Messwerte dauerhaft in
SQLite und zeigt interaktive Zeitverlaeufe. Der Quellcode wird im oeffentlichen
GitHub-Repository `flottokarotto/vimonitor` entwickelt. Zugangsdaten, OAuth-Tokens,
Anlagenkennungen und Messdaten werden nicht veroeffentlicht.

## Technik

- Node.js ab Version 24.12, TypeScript und Express fuer das lokale Backend.
- Eingebautes `node:sqlite` fuer die Datenhaltung ohne separaten Datenbankserver.
- HTML, CSS und JavaScript mit lokal ausgeliefertem Chart.js fuer das Dashboard.
- OAuth Authorization Code mit PKCE und State-Pruefung. Die Anmeldung findet bei
  Viessmann statt; die App fragt kein ViCare-Passwort ab.
- Verschluesselte Tokenablage mit einem nur lokal gespeicherten Schluessel.
- Bindung ausschliesslich an `127.0.0.1`; kein oeffentlicher Serverbetrieb.

## Schritte und Commit-Meilensteine

1. **Plan und Grundgeruest:** Repository anlegen, diesen Plan und Git-Ausschluesse
   committen; Build, Konfiguration und Tests vorbereiten.
2. **Datenerfassung:** OAuth, Anlagen-/Geraeteauswahl, Sensorerkennung, SQLite und
   zyklische Abfrage implementieren und testen; funktionalen Zwischenstand committen.
3. **Dashboard:** Aktuelle Werte, Vorlauf- und Warmwasserdiagramme, Sensorwahl,
   Zeitraeume und Verbindungs-/Fehlerstatus umsetzen; Dashboard committen.
4. **Pruefung und Dokumentation:** Automatisierte Tests, Typecheck, Build und
   Browserpruefung mit Demo-Daten; Einrichtung dokumentieren und Abschluss committen.

## Verhalten

- Standard-Abfrageintervall: 300 Sekunden, also 288 regulaere Messabfragen pro
  Tag. Erkennung und Anmeldung verursachen weitere Requests. Die tatsaechlichen
  Tariflimits im Viessmann-Portal sind massgeblich.
- Keine Heizungssteuerung: ausschliesslich lesende Anlagen-/Feature-Abfragen.
- Vorlauf und Warmwasser werden aus den verfuegbaren Temperatur-Features
  ermittelt. Fehlende Sensoren werden nicht durch erfundene Werte ersetzt.
- Alle verfuegbaren numerischen Celsius-Sensoren koennen aufgezeichnet werden.
- Bei mehreren Geraeten ist eine ausdrueckliche Auswahl erforderlich.
- Messwerte enthalten UTC-Zeitstempel und die Geraete-/Sensorzuordnung; die
  Anzeige verwendet die lokale Zeit des Browsers.
- Fehlgeschlagene Messungen erzeugen keine Ersatzmesswerte. Fehler und veraltete
  Daten bleiben sichtbar. Bei API-Limits wird die Abfrage verzoegert.
- Ein expliziter Demo-Modus verwendet eine getrennte SQLite-Datei und synthetische,
  deutlich gekennzeichnete Messwerte. Er funktioniert ohne API-Client.
- Zeitraeume: 24 Stunden, 7 Tage, 30 Tage; begrenzte Diagrammpunktzahl durch
  zeitliche Aggregation mit Minimum, Maximum und Mittelwert.
- Daten bleiben lokal erhalten; automatische Loeschung ist zunaechst nicht vorgesehen.

## Einrichtung des echten Zugangs

Im Viessmann-Developer-Portal mit dem vorhandenen ViCare-Konto einen API-Client
anlegen. Als Redirect-URI `http://localhost:3000/auth/callback` registrieren und
PKCE aktivieren, sofern das Portal diese Option anbietet. Client-ID nur lokal
in `.env` eintragen, Demo-Modus abschalten und die Anmeldung im Dashboard starten.
Die abschliessende Dokumentation beschreibt die genauen Schritte.

## Nachweis und Grenzen

Automatisierte Tests pruefen SQLite-Persistenz, Sensorinterpretation,
OAuth-/Refresh-Verhalten, Fehlerfaelle und HTTP-Endpunkte. Ein Browser-Smoke-Test
prueft den Demo-Modus. Der echte Zugriff auf die Heizung kann erst nach Erstellung
des persoenlichen API-Clients und lokaler Anmeldung verifiziert werden.

## Quellen

- [Viessmann Developer Portal](https://developer.viessmann-climatesolutions.com/)
- [Offizielle API-Dokumentation](https://api.viessmann-climatesolutions.com/documentation)
- [Aktuelle OAuth-/Endpoint-Beispiele von evcc](https://docs.evcc.io/en/heating/viessmann-heatpump-api/)
