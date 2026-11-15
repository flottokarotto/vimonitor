# ViMonitor

Lokale Web-App fuer Temperaturverlaeufe einer Viessmann-Heizung: **Vorlauf,
Warmwasser und weitere verfuegbare Celsius-Sensoren**, dauerhaft in SQLite
gespeichert. Deutsches Dashboard mit Sensorwahl, 24-Stunden-, 7-Tage- und
30-Tage-Ansicht.

> Die App startet standardmaessig im deutlich gekennzeichneten **Demo-Modus**.
> Echte Messwerte gibt es erst nach Einrichtung eines eigenen Viessmann-API-Clients.
> ViMonitor ist ein unabhaengiges Projekt, kein offizielles Viessmann-Produkt.

## Schnellstart unter Windows

Voraussetzungen: **Node.js >= 24.12** und npm. Im Projektordner in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

Dann **http://localhost:3000** oeffnen. Im Demo-Modus werden sieben Tage
synthetischer Daten in einer eigenen SQLite-Datei erzeugt. Die App laeuft,
solange das Terminal offen ist; `Strg+C` beendet sie. Fuer Entwicklung:

```powershell
npm run dev
```

Der Server lauscht ausschliesslich auf `127.0.0.1`. Es ist keine Firewallfreigabe
noetig. Die App ist nicht fuer einen oeffentlichen Webserver, LAN-Zugriff oder
einen ungeschuetzten Reverse-Proxy ausgelegt.

## Eigene Heizung verbinden

1. Die Heizung muss bereits im eigenen **ViCare-Konto** erreichbar sein.
2. Im [Viessmann-Developer-Portal](https://app.developer.viessmann-climatesolutions.com)
   mit diesem Konto anmelden und unter **Your clients** einen API-Client anlegen.
3. Als Redirect-URI exakt **`http://localhost:3000/auth/callback`** eintragen.
   Den oeffentlichen Client mit **PKCE / S256** verwenden, sofern das Portal nach
   dieser Einstellung fragt. Die App verwendet keinen Client-Secret.
4. Die erzeugte Client-ID nur in die lokale Datei `.env` eintragen:

   ```dotenv
   DEMO_MODE=false
   VIESSMANN_CLIENT_ID=deine-client-id
   VIESSMANN_REDIRECT_URI=http://localhost:3000/auth/callback
   ```

5. App neu starten. Im Dashboard unter **Verbindung & Einrichtung** auf
   **Mit Viessmann verbinden** klicken. Ausschliesslich auf der Viessmann-Seite
   anmelden; die App verlangt kein ViCare-Passwort.
6. Nach der Rueckleitung das gewuenschte Heizgeraet auswaehlen und **Geraet verwenden**
   anklicken. Auch bei nur einem Geraet wird die Auswahl bestaetigt.
   Kommunikationsmodule (`E3_TCU...`) und Raumregelungsmodule
   (`E3_RoomControl...`) werden aus der Auswahl ausgeblendet.

Die App verwendet OAuth Authorization Code mit PKCE, einem einmaligen,
cookiegebundenen State und den Scopes `IoT User offline_access`. Access-Tokens
werden automatisch mit dem Refresh-Token erneuert. Bei widerrufener Freigabe
erneut anmelden. Offene Anmeldungen verfallen nach zehn Minuten; ein Neustart
verwirft sie.

Welche Features verfuegbar sind, haengt vom Heizungsmodell, Gateway und gebuchten
API-Paket ab. Das [Developer-Portal](https://developer.viessmann-climatesolutions.com/)
und die [offizielle API-Dokumentation](https://api.viessmann-climatesolutions.com/documentation)
sind fuer Freigaben und aktuelle Limits massgeblich. Eine kostenlose Verfuegbarkeit
bestimmter Datenpunkte wird nicht vorausgesetzt.

**Der echte Heizungszugriff wurde noch nicht an einer realen Anlage getestet.**
OAuth, Erkennung und Messabfragen sind mit simulierten API-Antworten getestet;
der lokale Demo-Modus ist zusaetzlich im Browser geprueft.

## Dashboard und Erfassung

- Automatische Messabfrage alle **fuenf Minuten**. Das sind 288 regulaere
  Feature-Abfragen am Tag, zuzueglich Anmeldung und Geraeteerkennung.
- **Anzeige aktualisieren** liest nur die lokale Datenbank und verbraucht kein
  zusaetzliches Viessmann-Messkontingent.
- Beide Diagramme bieten eine Sensorwahl. Falls kein passender Vorlauf- oder
  Warmwassersensor existiert, wird dies angezeigt. Andere Sensoren lassen sich
  ausdruecklich manuell auswaehlen; Kesseltemperatur wird nicht als Vorlauf ausgegeben.
- Bekannte Temperaturdatenpunkte erhalten verstaendliche deutsche Namen, auch
  fuer bereits gespeicherte Messungen. Sollwerte und Temperaturgrenzen sind
  entsprechend gekennzeichnet. Die technische Kennung bleibt als Tooltip an der
  Sensorwahl erhalten; unbekannte Datenpunkte behalten ihre API-Bezeichnung.
- Vorlauf-Erkennung: `heating.primaryCircuit.sensors.temperature.supply` und
  `heating.circuits.<n>.sensors.temperature.supply`.
- Warmwasser-Erkennung: `heating.dhw.sensors.temperature.main` und
  `heating.dhw.sensors.temperature.hotWaterStorage`.
- Weitere aktivierte, bereite Features mit numerischen `celsius`-Properties
  werden ebenfalls aufgezeichnet. Rohantworten und Steuerbefehle werden nicht gespeichert.
- Zeitstempel sind **Abrufzeitpunkte in UTC**. Die Anzeige verwendet die
  Browser-Zeitzone; sie sind keine vom Sensor bestaetigten Messzeitpunkte.
- Maximal 601 Zeitbloecke pro Diagramm. Angezeigt werden Mittelwerte, im Tooltip
  auch Minimum, Maximum und Messanzahl. Messluecken werden nicht interpoliert.
- Y-Achsen zeigen gerundete Celsius-Werte mit hoechstens einer Nachkommastelle
  und deutschem Dezimalkomma; die gespeicherten Messwerte bleiben unveraendert.
- Abfragen laufen nicht parallel. Fehler erzeugen keine Ersatzmesswerte.
  Wiederholungsversuche erfolgen mit wachsender Pause bis zu einer Stunde;
  ein laengeres `Retry-After` der API wird ebenfalls beachtet.
- Daten aelter als 2,5 Abfrageintervalle werden als veraltet markiert.
- Bei geschlossenem Terminal, ausgeschaltetem PC oder Standby findet keine
  Erfassung statt. Die API liefert hier nur aktuelle Werte; fehlende historische
  Messungen werden nach einem Neustart nicht nachgeladen.
- Es gibt keine automatische Loeschung alter Daten. Fuer kontinuierliche
  Langzeitmessungen ist spaeter ein dauerhaft laufender Rechner sinnvoll.

## Lokale Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `DEMO_MODE` | `true` | Nur `true` oder `false`; Demo und echte Daten bleiben getrennt |
| `PORT` | `3000` | Lokaler Port, 1024 bis 65535 |
| `POLL_INTERVAL_SECONDS` | `300` | Ganzzahlig, mindestens 300, maximal 86400 |
| `DATA_DIR` | `./data` | Datenverzeichnis, relativ zum Arbeitsverzeichnis |
| `VIESSMANN_CLIENT_ID` | leer | Im echten Modus erforderlich |
| `VIESSMANN_REDIRECT_URI` | `http://localhost:<PORT>/auth/callback` | Muss zum Port und zum Portal-Eintrag passen |

Nach Konfigurationsaenderungen den Server neu starten; fuer reine
Konfigurationsaenderungen ist kein neuer Build erforderlich.

## Datenhaltung und Datenschutz

```text
data/
  vimonitor.sqlite    echte Messwerte, Geraetewahl und verschluesselte Tokens
  demo.sqlite         ausschliesslich Demo-Daten
  token.key           lokaler AES-256-GCM-Schluessel
```

SQLite kann zusaetzlich `-wal`- und `-shm`-Dateien anlegen. Die Tabellen
`readings`, `sensors` und `settings` enthalten die Messhistorie, Sensor-Metadaten
und lokale Einstellungen. Messwerte sind pro Geraet, Sensor und Abrufzeitpunkt
eindeutig.

`.env`, das gesamte Datenverzeichnis, Datenbankdateien und Logs werden von Git
ausgeschlossen. Vor eigenen Commits trotzdem `git status` pruefen, besonders bei
einem benutzerdefinierten `DATA_DIR`. **Keine Datenbank, Tokens, Schluessel,
Client-IDs oder Anlagenkennungen auf GitHub hochladen.**

Tokens werden in SQLite verschluesselt; **die Messdaten selbst nicht**. Wer
Datenbank und Schluessel lesen kann, kann die Tokens entschluesseln. Die
Verschluesselung ersetzt daher keine Betriebssystemrechte. Das Datenverzeichnis
unter Windows nur dem eigenen Benutzer zugaenglich machen (Dateieigenschaften >
Sicherheit), insbesondere auf gemeinsam genutzten Rechnern. Es werden keine
Analyse-, CDN- oder Telemetriedienste eingebunden. Chart.js wird lokal ausgeliefert.

Fuer ein konsistentes Backup die App stoppen und das gesamte Datenverzeichnis
einschliesslich `token.key` an einen geschuetzten Ort kopieren. Ohne den
Schluessel koennen vorhandene Tokens nicht wiederhergestellt werden.

## Entwicklung und Tests

```powershell
npm run typecheck
npm test
npm run build
```

Die Tests verwenden temporaere Datenbanken und simulierte HTTP-Antworten, keine
echten Viessmann-Zugaenge. GitHub Actions fuehrt sie unter Windows und Linux aus.

| Bereich | Datei |
|---|---|
| Umsetzungsplan | [PLAN.md](PLAN.md) |
| OAuth und Viessmann-API | [src/viessmann.ts](src/viessmann.ts) |
| Messzyklus und Demo-Daten | [src/collector.ts](src/collector.ts) |
| SQLite und Tokenverschluesselung | [src/store.ts](src/store.ts) |
| Lokale HTTP-Endpunkte | [src/app.ts](src/app.ts) |
| Dashboard | [public/](public/) |

## Fehlerbehebung

- **Port belegt:** `PORT` aendern, passende Redirect-URI in `.env` und im
  Developer-Portal eintragen.
- **HTTP 401 / Anmeldung abgelaufen:** erneut bei Viessmann anmelden.
- **HTTP 403 von Viessmann:** API-Paket, Freigaben und verwendetes Konto pruefen.
- **HTTP 429:** Abfragelimit erreicht. Wiederholungspause abwarten, Intervall ggf.
  erhoehen und andere Apps mit demselben Konto beruecksichtigen.
- **Keine Sensoren:** anderes Geraet waehlen oder die Feature-Freigaben pruefen.
  Nicht jedes aufgefuehrte Gateway-Geraet stellt Heizungsdaten bereit.
- **Fehler beim OAuth-Callback:** erneut unter `http://localhost:3000` anmelden.
  Kein Wechsel auf `127.0.0.1` waehrend der Anmeldung, da das State-Cookie an
  `localhost` gebunden ist.
- **SQLite nicht verfuegbar:** mit `node --version` die erforderliche Node-Version
  pruefen. Es wird kein zusaetzliches SQLite-Paket installiert.
