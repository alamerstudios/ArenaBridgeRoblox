# Arena Studio Connecter

Eine Windows-Desktop-App, die **Arena Agent** sicher mit deinen aktuell geöffneten
**Roblox-Studio-Places** verbindet.

Die App startet die lokale HTTP/MCP-Bridge, installiert das Studio-Plugin automatisch,
erstellt einen temporären Cloudflare-HTTPS-Tunnel und erzeugt für jede offene Place einen
fertigen Arena-Prompt. Im Roblox-Plugin müssen **keine URL und kein Token** eingetragen werden.

## Download

<p align="center">
  <a href="https://raw.githubusercontent.com/alamerstudios/ArenaBridgeRoblox/v2.1.1/downloads/Arena-Studio-Connecter-Portable-2.1.1-x64.exe">
    <img src="docs/assets/download-windows.svg" width="372" alt="Arena Studio Connecter als portable Windows-x64-EXE herunterladen" />
  </a>
  <br />
  <sub>Windows 10/11 · 64 Bit · portable · keine Installation erforderlich</sub>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/alamerstudios/ArenaBridgeRoblox/v2.1.1/downloads/Arena-Studio-Connecter-Portable-2.1.1-x64.exe.sha256.txt">SHA-256-Prüfsumme</a>
  ·
  <a href="https://github.com/alamerstudios/ArenaBridgeRoblox/releases/tag/v2.1.1">Release-Details</a>
  ·
  <a href="#windows-exe-verwenden">Schnellstart</a>
</p>

## Highlights

- Dunkelblaue native Desktop-Oberfläche mit Animationen
- Alle aktuell verbundenen Studio-Places mit ihren tatsächlichen Roblox-Namen in einer Übersicht
- Aktiver Roblox-Studio-Account mit Profilbild unten links
- **Play, Run, Stop und Playtest-Status** direkt als Bridge-/MCP-Aktionen
- Lokale **Blender-Meshes** mit optionalem Open-Cloud-Upload und anschließendem Einfügen in Studio
- **Updates ohne Neuinstallation**: geprüfter Download, Neustart und Rollback-Sicherung
- Ein eigener **„Prompt kopieren“**-Button pro Place
- Temporärer Cloudflare Quick Tunnel ohne manuelle Konfiguration
- Session-Token ausschließlich im Prompt/Header, **nie in der Guide-URL**
- Lila **„Arena AI öffnen“**-Button für <https://arena.ai/agent>
- Automatische Plugin-Installation nach `%LOCALAPPDATA%\Roblox\Plugins`
- Plugin verbindet sich automatisch über einen separaten Loopback-Discovery-Port
- Mehrere offene Places werden über `targetClientId` sicher getrennt
- Optionaler Open-Cloud-API-Key, verschlüsselt mit Windows DPAPI gespeichert
- HTTP-API plus MCP-kompatibler JSON-RPC-Endpoint

---

## Windows-EXE verwenden

1. `Arena-Studio-Connecter-Portable-2.1.1-x64.exe` starten. Die portable App muss nicht installiert werden.
   Bei einem nicht signierten Entwicklungsbuild kann Windows SmartScreen einmalig nachfragen.
2. **Arena Studio Connecter** öffnet Bridge, Tunnel und Plugin automatisch. Beim ersten Start
   wird das SHA-256-verifizierte Cloudflared-Modul geladen; das kann je nach Verbindung kurz dauern.
3. Roblox Studio nach der ersten Installation (und nach jedem Plugin-Update) einmal komplett neu starten.
4. Eine Place öffnen (nicht auf der Studio-Startseite bleiben). Sie erscheint nach wenigen
   Sekunden in der Desktop-App. Zeigt das Studio-Plugin stattdessen einen Hinweis zu HTTP
   Requests, folge der Anleitung im nächsten Absatz.
5. Bei der gewünschten Place auf **Prompt kopieren** klicken.
6. Unten links **Arena AI öffnen** wählen und den Prompt in einen neuen Agent-Chat einfügen.

> **HTTP-Freigabe:** Roblox erlaubt Plugins aus Sicherheitsgründen **nicht**, die HTTP-Einstellung
> einer Place selbst zu ändern (`HttpService.HttpEnabled` hat *LocalUserSecurity*). Das Plugin
> fragt die lokale App deshalb direkt an. Antwortet Studio dabei mit „Http requests are not
> enabled“, aktiviere einmalig **Datei → Experience Settings → Security → Allow HTTP Requests**.
> Bei einer unveröffentlichten `.rbxl`-Datei geht es auch über die Command Bar
> (`View` → `Command Bar`) mit `game:GetService("HttpService").HttpEnabled = true`. Fragt Studio
> nach einer HTTP-Erlaubnis für das Plugin, erlaube `127.0.0.1`. Danach verbindet sich die Place
> innerhalb weniger Sekunden von selbst - URL, Token und API-Key müssen im Plugin weiterhin
> **nicht** eingegeben werden.

### Updates ohne Neuinstallation

Die EXE sucht bei aktivierter Option beim Start und alle sechs Stunden nach einem neueren
GitHub-Release. Ein verfügbares Update wird automatisch heruntergeladen, aber **nicht ohne
Bestätigung installiert**. Unter **Einstellungen → App-Updates** genügt dann ein Klick auf
**Update installieren & neu starten**; eine erneute Installation ist nicht erforderlich.

Die portable EXE wird erst nach SHA-256- und PE-Prüfung vorbereitet. Beim Neustart ersetzt ein
lokaler Helfer die Datei und behält die vorherige Version als Rollback-Sicherung. Der alternative
Electron-NSIS-Build nutzt `latest.yml`, Setup und Blockmap aus demselben Release. Fehlen
Release-Assets, funktioniert auch der bisher versionierte `downloads/`-Pfad als Fallback.

### Was im kopierten Prompt steht

Der Prompt enthält:

- die temporäre `https://…trycloudflare.com`-Adresse,
- den nur für diesen App-Start gültigen Bridge-Token,
- die eindeutige Studio-Client-ID der gewählten Place,
- Place-/Universe-/Account-Metadaten,
- einen Link auf `/agent/guide?clientId=…`,
- klare Anweisungen zur Authentifizierung und sicheren Zielauswahl.

Der Token wird nicht an die URL gehängt. Arena Agent sendet ihn nur so:

```text
Authorization: Bearer <SESSION_TOKEN>
```

Die Guide-URL selbst ist geheimnisfrei. Schreibende API-Aufrufe bleiben ohne gültigen
Bearer-Token gesperrt.

---

## Automatisches Roblox-Plugin

Bei jedem App-Start wird aus
[`roblox/ArenaStudioConnecter.server.lua`](roblox/ArenaStudioConnecter.server.lua) ein lokales
`ArenaStudioConnecter.rbxmx` erzeugt und in den Roblox-Plugin-Ordner kopiert. Eine alte,
von dieser Repo stammende Vorgänger-Plugin-Datei wird entfernt; andere lokale Plugins werden
nicht verändert.

Das Plugin fragt die aktuelle lokale Bridge-Session über
`http://127.0.0.1:32192/v1/session` ab. Dieser Discovery-Port:

- bindet ausschließlich an `127.0.0.1`,
- wird **nicht** durch Cloudflare veröffentlicht,
- liefert den dynamischen Token nur an lokale Prozesse,
- speichert den Token nicht in Roblox Studio.

Danach meldet das Plugin Place-ID, Universe-ID, Place-Name und den Studio-Account an und
pollt gezielt nach Befehlen für diese Place.

### Keine Place wird angezeigt?

Die App zeigt auf der Startseite und unter **Einstellungen → Studio Plugin** („Letzter
Plugin-Kontakt“), wie weit die Verbindung bereits gekommen ist. Prüfe in dieser Reihenfolge:

1. Läuft die EXE nur **einmal**? Der feste Erkennungs-Port `32192` kann nur von einer Instanz
   genutzt werden; eine zweite zeigt sonst „Plugin-Port ist bereits belegt“.
2. Wurde Roblox Studio nach dem ersten EXE-Start bzw. nach einem Plugin-Update **komplett neu
   gestartet**? Studio lädt lokale Plugins nur beim Start.
3. Ist wirklich eine **Place geöffnet** (nicht die Studio-Startseite)?
4. Was sagt das Studio-Plugin? In Studio auf den Toolbar-Button **Arena Studio Connecter**
   klicken - dort steht der genaue Grund, z. B. dass **Allow HTTP Requests** noch aus ist
   (siehe Hinweis oben). Auch die Studio-**Output**-Konsole zeigt die Meldung.
5. Steht in der App weiterhin „Noch kein Kontakt aus Roblox Studio“, erreicht das Plugin die App
   gar nicht: EXE neu starten, keine zweite Instanz laufen lassen und Studio danach neu öffnen.
6. Hat das Plugin die Session geladen („Session geladen vor …“), meldet sich aber nicht an,
   im Studio-Plugin auf **„Jetzt erneut verbinden“** klicken. Technische Details stehen in
   `%LOCALAPPDATA%\Arena Studio Connecter\logs\bridge.log`.

---

## Playtests durch Arena AI

Die Aktionen `play_game`, `get_play_state` und `stop_game` stehen über REST und MCP bereit.
`play_game` startet mit `{ "mode": "play" }` einen normalen Play-Client oder mit
`{ "mode": "run" }` eine Server-Simulation ohne Avatar. Die bereits von Studio geladene zweite
**Plugin-Instanz im Playtest-Datenmodell** übernimmt Status und Stop. Sie registriert keine
zweite Place und benötigt kein injiziertes Server-Script. Stop wird während des Starts für ihre
bekannte Client-ID eingereiht und ruft anschließend `StudioTestService:EndTest(...)` auf; der
Editor bleibt das Ziel aller dauerhaften Build-Befehle.

Das Starten ist asynchron: Eine erfolgreiche `play_game`-Antwort bedeutet, dass Studio den
Start angenommen hat. `get_play_state` meldet nach der Reporter-Verbindung `reporterReady: true`.
Eine erfolgreiche Stop-Antwort bestätigt zunächst `accepted/ending`; das endgültige Ende wird
über den Playtest-Status geprüft. Nach einem Playtest verwirft Studio dessen Datenmodell;
dauerhafte Änderungen deshalb immer erst im Edit-Modus ausführen. Auf sehr alten
Studio-Versionen ohne `StudioTestService` bleibt eine RunService-Simulation als gekennzeichneter
Fallback erhalten.

### Maschinenlesbare Aktionsergebnisse

Jede ausgeführte Aktion liefert `ok`, `command` und entweder `result` oder `error`. Ein Fehler
**innerhalb** einer Studio- oder Desktop-Aktion ist kein Bad Gateway: REST antwortet mit HTTP
`200`, `ok: false` und `error.code` (`STUDIO_ACTION_FAILED` bzw. `LOCAL_ACTION_FAILED`).
`error.message` enthält die eigentliche Meldung inklusive Studio-Traceback; `error.details`
enthält unter anderem Aktion, Befehls-ID und Plugin-Version. Echte Timeouts bleiben HTTP
`504`/`COMMAND_TIMEOUT`. MCP setzt zusätzlich `isError: true` und liefert dieselbe Struktur.

---

## Blender-Meshes und Open Cloud

Blender läuft ausschließlich lokal auf deinem PC. Arena sendet eine deklarative Mesh-Beschreibung
(Primitive oder Vertices/Faces) an die Desktop-Bridge; ein eingebettetes Blender-Python-Skript
exportiert daraus FBX oder GLB. Open Cloud wird nur für den optionalen Upload verwendet. Ein
typischer Ablauf ist:

1. **Einstellungen → Blender & Open Cloud**: Blender installieren bzw. `blender.exe` auswählen.
2. Dort den Open-Cloud-Key und die Creator-ID konfigurieren. Ohne Creator-ID wird für einen
   User-Upload der angemeldete Studio-Account verwendet.
3. Arena erzeugt mit `create_blender_mesh` das Modell. Nach dem Upload enthält das Ergebnis die
   `assetId`; `insert_model` fügt es über `InsertService:LoadAsset` in die gewünschte Place ein.

Mit `{ "upload": false }` ist auch ein rein lokaler Export möglich. Der Open-Cloud-Upload
akzeptiert Modelldateien bis 20 MB und wartet die Assets-Operation inklusive Moderationsergebnis
ab. Ein hochgeladenes **Model** kann mehrere MeshParts enthalten; es ist nicht automatisch ein
einzelnes MeshPart-Asset.

Die Desktop-App speichert den Key über Windows DPAPI verschlüsselt. Er bleibt auf dem PC und wird
weder an Arena oder Studio noch in Logs, die Cloudflare-URL oder den kopierten Prompt gesendet.

### Open-Cloud-Key richtig berechtigen

Das Tutorial in **Einstellungen → Open Cloud API Key** führt durch denselben Ablauf:

1. Im [Creator Dashboard](https://create.roblox.com/dashboard/credentials) einen neuen API-Key
   unter einem passenden Namen erstellen.
2. Unter **Access Permissions → Assets** **Read und Write** aktivieren. Für diesen Workflow sind
   keine Data-Store-, Messaging-, Memory-Store- oder Place-Publishing-Rechte erforderlich.
3. Den Creator wählen: eigenen User oder eine Gruppe, für die der Account Assets hochladen darf.
   Bei einer Gruppe deren numerische ID in den App-Einstellungen eintragen.
4. Optional die IP-CIDR auf die aktuelle öffentliche IP und ein Ablaufdatum setzen. Bei wechselnder
   IP muss die Liste später angepasst werden.
5. Den einmal angezeigten Key direkt in der App speichern.

Diese Open-Cloud-Berechtigungen sind getrennt von **Allow HTTP Requests** in Studio und von den
Plugin-Rechten. Der Key wird für die normale Live-Verbindung, Play/Stop und das Einfügen bereits
vorhandener Assets nicht benötigt.

---

## Architektur

```text
┌──────────────────────── Arena Studio Connecter.exe ────────────────────────┐
│                                                                            │
│  Desktop UI ── Prompt/Status ── Local Bridge ── Cloudflare Quick Tunnel    │
│                                  127.0.0.1:<dynamisch>      │               │
│                                             ▲              │ HTTPS         │
│  Plugin Discovery 127.0.0.1:32192 ──────────┘              ▼               │
└────────────────────────────────────────────────────── Arena Agent ─────────┘
                         ▲
                         │ Long Poll + Bearer Token
                         │
                  Roblox Studio Plugin
                  (eine Client-ID pro Place)
```

Roblox Studio nimmt keine eingehenden Verbindungen an. Deshalb pollt das Plugin die lokale
Bridge. Arena Agent erreicht dieselbe Bridge über den temporären Tunnel. Befehle enthalten
eine `targetClientId`, damit bei mehreren Studio-Fenstern nie die falsche Place geändert wird.

---

## API für Arena Agent

| Methode | Pfad | Token | Zweck |
|---|---|:---:|---|
| GET | `/health` | – | Liveness-Check |
| GET | `/agent/guide?clientId=…` | – | Secret-freie Agent-Anleitung |
| GET | `/status` | ✓ | Bridge, Statistik und verbundene Places |
| GET | `/actions` | ✓ | Verfügbare Studio-Aktionen |
| POST | `/command` | ✓ | Befehl gezielt an eine Place senden |
| GET | `/command/:id` | ✓ | Asynchronen Befehl nachschlagen |
| GET | `/queue` | ✓ | Queue-Zustand |
| GET | `/logs` | ✓ | Bereinigte Bridge-Logs |
| POST | `/token/rotate` | ✓ | Session-Token sofort austauschen |
| GET/POST | `/mcp` | ✓ | MCP-kompatibles JSON-RPC 2.0 |
| POST | `/studio/handshake` | ✓ | Plugin-Anmeldung |
| GET | `/studio/poll` | ✓ | Plugin-Long-Poll |
| POST | `/studio/result` | ✓ | Plugin-Ergebnis |

Beispiel für eine gezielte Place:

```bash
curl -X POST "https://DEIN-TUNNEL.trycloudflare.com/command" \
  -H "Authorization: Bearer <SESSION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "list_instances",
    "params": { "path": "game.Workspace", "depth": 2 },
    "targetClientId": "CLIENT_ID_AUS_DEM_PROMPT"
  }'
```

Vollständige Endpunkt- und Aktionsdetails stehen in [docs/API.md](docs/API.md).

---

## Sicherheit

- Bei jedem Start entsteht ein neuer kryptografischer Token mit 192 Bit Entropie.
- Session-Token liegen nur im RAM und in einer lokalen, gitignorierten Session-Datei.
- Logs maskieren bekannte Secrets.
- Der öffentliche Tunnel zeigt keine Desktop-Oberfläche und keine Discovery-Route.
- Alle Steuer-, MCP- und Studio-Endpunkte verlangen den Token.
- Der Guide enthält keinen Token.
- Nach 20 ungültigen Authentifizierungsversuchen wird der Client blockiert.
- Die Bridge begrenzt Requests und Request-Größen.
- Open-Cloud-Keys werden mit Windows DPAPI verschlüsselt.
- Das Electron-Fenster läuft mit `contextIsolation`, Sandbox und deaktivierter Node-Integration.
- Die portable Einzeldatei-App nutzt ein isoliertes natives WebView2-Fenster; dessen Control-API bindet nur an eine zufällige Loopback-Adresse und akzeptiert ausschließlich den eigenen Origin.

Der Session-Token erlaubt Codeausführung in der ausgewählten Studio-Place. Teile ihn nur mit
dem Arena-Agent-Chat, für den er erzeugt wurde. App-Neustart oder `POST /token/rotate` macht
den alten Token sofort ungültig.

---

## Entwicklung

Voraussetzung: Node.js 18+.

```bash
npm install
npm test                    # Unit- und End-to-End-Tests
npm start                   # Bridge ohne Desktop-Fenster
npm run desktop             # Electron-App im Entwicklungsmodus
npm run dist:standalone     # direkte Windows-x64-Einzeldatei-EXE
npm run dist:download       # geprüfte EXE nach downloads/ übernehmen
npm run dist:win            # alternativ: Electron Installer + portable EXE
```

`npm run dist:standalone` funktioniert auch auf Linux: Das Skript lädt die fest gepinnten
npm-Pakete für Bun 1.4.3 und das native Windows-WebView2-Modul, verifiziert die PE-Datei
per SHA-256 und cross-kompiliert anschließend eine direkt startbare EXE:

```text
release/Arena-Studio-Connecter-Portable-2.1.1-x64.exe
```

`npm run dist:download` übernimmt exakt diese Datei nach `downloads/` und erzeugt die
SHA-256-Prüfsumme für den README-Download. Es gibt keinen vorgeschalteten Selbstentpacker.
Cloudflared 2026.8.2 wird beim ersten App-Start aus der offiziellen Quelle oder dem gepinnten
npm-Fallback geladen und vor der Ausführung gegen den fest hinterlegten SHA-256-Wert geprüft.

Der alternative Electron-Build erzeugt zusätzlich
`Arena-Studio-Connecter-Setup-2.1.1-x64.exe`, `latest.yml`, Blockmaps und eine separat benannte
Electron-Portable-EXE. Die temporären Build-Ausgaben unter `release/` sind gitignoriert; die
direkt startbare Haupt-EXE unter `downloads/` wird versioniert.

`npm run hash:release` erzeugt für alle EXE-Dateien in `release/` die jeweilige SHA-256-Datei.
Lade EXEs, Prüfsummen, `latest.yml` und Blockmaps bei einem Release in dasselbe GitHub-Release
hoch. Ohne Release-Assets nutzt die portable Haupt-EXE weiterhin den versionierten
`downloads/`-Pfad samt Prüfsumme.

### Projektstruktur

```text
desktop/
  main.js                 Electron-Hauptprozess und Service-Lifecycle
  preload.cjs             minimale, sichere Renderer-API
  cloudflareTunnel.js     Cloudflare-Prozess und URL-Erkennung
  discoveryServer.js      nur lokaler Plugin-Bootstrap
  pluginInstaller.js      automatische RBXMX-Installation
  settingsStore.js        DPAPI-verschlüsselte Einstellungen
  robloxMetadata.js       Place-Namen und Avatar-Cache
  updateManager.js        geprüfte portable Updates und Rollback
  renderer/               dunkelblaue animierte Desktop-UI
standalone/
  main.js                 kompakter Bun-/WebView2-Host für die portable EXE
  windowsSettingsStore.js DPAPI- und Autostart-Integration ohne Electron
downloads/
  direkte Windows-EXE und Prüfsumme für den README-Download
src/
  server.js               HTTP-Server, Routing und Auth
  core/                   Token, Session, Queue, Prompt, Logging
  routes/                 REST, Studio, MCP und Agent Guide
  services/               lokaler Blender-Export und Open-Cloud-Upload
roblox/
  ArenaStudioConnecter.server.lua
scripts/
  Build-Vorbereitung, Cloudflared-Download, CLI, Mock-Studio, PowerShell-Launcher
tests/
  Token-, Server-, Routing-, Prompt-, Discovery- und Installer-Tests
```

## Lizenz

MIT
