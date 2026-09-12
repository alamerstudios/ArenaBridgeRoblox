# NexusAI Bridge

Lokale Bridge zwischen KI-Tooling und **Roblox Studio**.
Sie stellt eine HTTP-API plus einen **MCP-Endpoint** (JSON-RPC 2.0) bereit, über die Befehle
direkt in einer laufenden Studio-Session ausgeführt werden — Luau ausführen, Instanzen lesen
und anlegen, Skript-Quelltext ändern, Selection steuern und mehr.

> **Jeder Start erzeugt einen neuen Token.**
> Es ist **kein Token im Code hinterlegt**. Der Token entsteht bei jedem Bridge-Start neu
> (192 Bit Entropie aus `crypto.randomBytes`), lebt nur im Speicher und in einer
> gitignorierten Session-Datei, und wird bei **jedem** Request geprüft.

---

## Schnellstart

### Windows

```bat
start-bridge.bat
```

### Alle Plattformen

```bash
npm start
```

Die Bridge gibt beim Start diese Box aus — `url` und `token` sind bei jedem Start anders:

```
============================================================
NexusAI Bridge: LAEUFT
============================================================
---BRIDGE---
url: http://127.0.0.1:8787
token: nxs_BEISPIEL_bei_jedem_Start_anders
---END---

Dashboard : http://127.0.0.1:8787/dashboard?token=nxs_...
Status    : http://127.0.0.1:8787/status   (Header: Authorization: Bearer <token>)
MCP       : http://127.0.0.1:8787/mcp      (JSON-RPC 2.0)
Session   : .runtime/session.json
Logfile   : logs/bridge.log

Der Token wird bei jedem Start neu erzeugt. Stop: Strg+C
============================================================
```

Voraussetzung: **Node.js 18+**. Keine externen Abhängigkeiten — `npm install` ist nicht nötig.

---

## Wie der Token funktioniert

| | |
|---|---|
| **Erzeugung** | `crypto.randomBytes(24)` → base64url, Präfix `nxs_` — bei jedem Start neu |
| **Format** | `nxs_<32 Zeichen base64url>`, 192 Bit Entropie |
| **Gültigkeit** | Nur für die laufende Session. Bridge neu starten = neuer Token |
| **Speicherung** | Nur im RAM + `.runtime/session.json` (gitignored, Dateirechte `0600`) |
| **Prüfung** | Bei **jedem** Request, konstant-zeitlich (SHA-256 + `timingSafeEqual`) |
| **In Logs** | Immer maskiert: `nxs_jr_l...1RAj` — der Klartext-Token kann nicht ins Log gelangen |
| **Rotation** | `POST /token/rotate` erzeugt jederzeit einen neuen; der alte wird sofort ungültig |
| **Brute-Force** | Nach 20 Fehlversuchen pro IP `429`; zusätzlich 600 Requests/Minute Limit |

Ein Regressionstest (`tests/token.test.js`) scannt den kompletten Quellbaum und schlägt fehl,
sobald irgendwo ein Token-Literal auftaucht.

### Token an Clients übergeben

Vier gleichwertige Wege:

```bash
curl -H "Authorization: Bearer $TOKEN"   http://127.0.0.1:8787/status
curl -H "X-Bridge-Token: $TOKEN"         http://127.0.0.1:8787/status   # Roblox-freundlich
curl -H "X-Api-Key: $TOKEN"              http://127.0.0.1:8787/status
curl "http://127.0.0.1:8787/status?token=$TOKEN"                        # Browser-freundlich
```

Skripte müssen den Token **nicht** abtippen — die laufende Bridge schreibt ihn nach
`.runtime/session.json`, und die mitgelieferte CLI liest ihn von dort automatisch.

---

## Roblox Studio verbinden

1. **HTTP freischalten**: In Studio → *Game Settings → Security → „Allow HTTP Requests"* aktivieren.
2. **Plugin installieren**: `roblox/NexusAIPlugin.server.lua` nach
   `%LOCALAPPDATA%\Roblox\Plugins\` kopieren (oder in Studio Rechtsklick auf das Script →
   *„Save as Local Plugin"*). Studio neu starten.
3. **Verbinden**: Toolbar → **NexusAI Bridge**. `url` und `token` aus der `---BRIDGE---` Box
   eintragen und auf *Verbinden* klicken. Der Status wechselt auf grün.

Das Plugin merkt sich die URL, **nicht** aber den Token — der ändert sich ja bei jedem Start.

### Architektur

Roblox Studio kann keine eingehenden Verbindungen annehmen, deshalb pollt das Plugin die Bridge:

```
  KI-Client / CLI / Dashboard
            │  POST /command   (Authorization: Bearer <token>)
            ▼
     ┌──────────────────┐
     │  NexusAI Bridge  │   Token-Prüfung → Queue → Logging
     └──────────────────┘
            ▲  GET /studio/poll     (Long-Poll, ~25 s)
            │  POST /studio/result
     Roblox Studio Plugin
```

---

## Web-Dashboard

`http://127.0.0.1:8787/dashboard` — die Startausgabe enthält einen fertigen Link mit Token.

Zeigt Live-Status, Statistiken, verbundene Clients, Befehlsverlauf und Logs; erlaubt
Befehle direkt an Studio zu senden und den Token per Klick zu rotieren.
Das Dashboard-HTML enthält **keinen** Token — er kommt aus dem `?token=`-Parameter oder
dem Eingabefeld und liegt nur im `sessionStorage`. Der Parameter wird nach dem Verbinden
sofort aus der Adressleiste entfernt.

---

## CLI

Die CLI findet URL und Token automatisch über `.runtime/session.json`:

```bash
node scripts/bridge-cli.js status
node scripts/bridge-cli.js ping
node scripts/bridge-cli.js actions
node scripts/bridge-cli.js logs --limit 50 --level warn
node scripts/bridge-cli.js command run_luau '{"code":"return workspace:GetChildren()"}'
node scripts/bridge-cli.js command create_instance '{"className":"Part","parent":"game.Workspace"}'
node scripts/bridge-cli.js mcp tools/list
node scripts/bridge-cli.js rotate
```

Explizit geht es auch: `--url http://127.0.0.1:8787 --token nxs_...`
oder über `NEXUSAI_BRIDGE_URL` / `NEXUSAI_BRIDGE_TOKEN`.
Der PowerShell-Launcher setzt diese Variablen automatisch und kopiert den Token in die Zwischenablage.

---

## Endpoints

| Methode | Pfad | Token | Zweck |
|---------|------|:-----:|-------|
| GET | `/health` | – | Öffentlicher Liveness-Check |
| GET | `/status` | ✓ | Status, Statistik, Clients, Queue |
| GET | `/ping` | ✓ | Authentifizierter Ping |
| GET | `/actions` | ✓ | Katalog der Studio-Aktionen |
| POST | `/command` | ✓ | Befehl an Studio senden und auf Ergebnis warten |
| GET | `/command/:id` | ✓ | Befehl nachschlagen |
| GET | `/queue` | ✓ | Warteschlange |
| GET | `/logs` | ✓ | Letzte Logeinträge |
| POST | `/token/rotate` | ✓ | Neuen Token erzeugen |
| GET/POST | `/mcp` | ✓ | MCP / JSON-RPC 2.0 |
| POST | `/studio/handshake` | ✓ | Plugin-Anmeldung |
| GET | `/studio/poll` | ✓ | Long-Poll des Plugins |
| POST | `/studio/result` | ✓ | Ergebnis vom Plugin |
| POST | `/studio/log` | ✓ | Studio-Output ins Bridge-Log |
| GET | `/dashboard` | – | Web-Dashboard (Token in der UI) |

Vollständige Details inkl. Parametern, Fehlercodes und Roblox-Typ-Serialisierung: **[docs/API.md](docs/API.md)**.

### Beispiel

```bash
TOKEN="nxs_..."   # aus der ---BRIDGE--- Box

curl -X POST http://127.0.0.1:8787/command \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"run_luau","params":{"code":"return 1+1"}}'
```

---

## MCP-Integration

Die Bridge spricht JSON-RPC 2.0 nach MCP-Form (`initialize`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`). Alle 13 Studio-Aktionen stehen als MCP-Tools mit
JSON-Schema zur Verfügung.

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_place_info","arguments":{}}}'
```

Da der Token pro Start wechselt, muss die Konfiguration des MCP-Clients den Token aus
`.runtime/session.json` beziehen statt ihn fest zu hinterlegen.

---

## Optionen

```
-p, --port <n>            Port (Standard: 0 = freier Port wird automatisch gewählt)
    --host <addr>         Bind-Adresse (Standard: 127.0.0.1)
    --log-level <level>   debug | info | warn | error | silent
    --log-file <path>     Logdatei (Standard: logs/bridge.log)
    --no-log-file         Dateilogging aus
    --json-logs           Logs als NDJSON
    --no-dashboard        Dashboard deaktivieren
    --open                Dashboard im Browser öffnen
    --token-bytes <n>     Token-Entropie in Bytes, 16–64 (Standard: 24)
    --command-timeout <ms> Max. Wartezeit auf Studio (Standard: 30000)
    --print-config        Konfiguration ausgeben und beenden
-h, --help / -v, --version
```

Alles auch per Umgebungsvariable: `NEXUSAI_PORT`, `NEXUSAI_HOST`, `NEXUSAI_LOG_LEVEL`,
`NEXUSAI_LOG_FILE`, `NEXUSAI_DASHBOARD`, `NEXUSAI_TOKEN_BYTES`, …

PowerShell-Launcher:

```powershell
.\scripts\start-bridge.ps1 -Port 8787 -LogLevel debug -Open
```

---

## Entwicklung

```bash
npm test                          # 22 Tests (Token, Auth, Rotation, Queue, MCP, Dashboard)
npm run dev                       # Auto-Reload + Debug-Logs
node scripts/mock-studio.js       # Studio-Plugin simulieren, ohne Roblox zu starten
```

Der Mock-Client ist der schnellste Weg, die Bridge und das Dashboard end-to-end zu testen:
Bridge in einem Terminal starten, `mock-studio.js` in einem zweiten — danach liefern
`/command` und `/mcp` echte Antworten.

### Projektstruktur

```
src/
  index.js              Entry point, CLI, Shutdown
  server.js             HTTP-Server, Routing, Auth-Middleware
  core/
    token.js            Token-Erzeugung, konstant-zeitlicher Vergleich, Extraktion
    session.js          Session-Zustand, Rotation, Statistik, Session-Datei
    commandQueue.js     Queue mit Timeouts und Historie
    logger.js           Level-Logger mit Ringpuffer, Datei-Sink und Token-Redaktion
    config.js           Defaults < ENV < CLI-Flags
    banner.js           ---BRIDGE--- Startausgabe
  routes/
    api.js              /status /ping /actions /command /queue /logs /token/rotate
    studio.js           /studio/handshake /poll /result /log
    mcp.js              /mcp (JSON-RPC 2.0)
public/                 Web-Dashboard (kein Build nötig)
roblox/                 Roblox-Studio-Plugin (Luau)
scripts/                PowerShell-Launcher, CLI, Mock-Studio
tests/                  node:test Suite
start-bridge.bat        Windows-Launcher
```

### Sicherheitshinweise

* Die Bridge bindet standardmäßig nur an `127.0.0.1` und ist damit nicht aus dem Netz erreichbar.
* `.runtime/` und `logs/` sind gitignored — der Token darf nie im Repository landen.
* Wird die Bridge bewusst auf `0.0.0.0` gebunden, schützt allein der Token — dann unbedingt
  `--token-bytes 32` verwenden und den Port per Firewall einschränken.
* Der Token erlaubt Codeausführung in Studio. Niemals in Screenshots, Issues oder Chats teilen;
  im Zweifel `POST /token/rotate` aufrufen oder die Bridge neu starten.

---

## Lizenz

MIT
