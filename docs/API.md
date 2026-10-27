# Arena Studio Connecter — API-Referenz

Basis-URL: die `url` aus der `---BRIDGE---` Box beim Start (z. B. `http://127.0.0.1:8787`).

## Authentifizierung

Alle Endpoints außer `/health`, `/agent/guide` und `/dashboard` benötigen den **dynamischen Session-Token**.
Der Token wird bei jedem Bridge-Start neu erzeugt — es gibt keinen festen Token.

Unterstützte Varianten:

```http
Authorization: Bearer asc_...
X-Bridge-Token: asc_...
X-Api-Key: asc_...
GET /status?token=asc_...
```

Für Arena Agent soll ausschließlich der `Authorization`-Header verwendet werden. Der Token
gehört nie in die Tunnel- oder Guide-URL; Query-Authentifizierung bleibt nur für das lokale
Legacy-Dashboard erhalten. Die Prüfung erfolgt konstant-zeitlich (SHA-256 + `timingSafeEqual`).

### Fehlercodes

| HTTP | Code | Bedeutung |
|------|------|-----------|
| 401 | `TOKEN_MISSING` | Kein Token mitgeschickt |
| 403 | `TOKEN_INVALID` | Token falsch oder veraltet (Bridge neu gestartet / rotiert) |
| 429 | `TOO_MANY_AUTH_FAILURES` | 20 Fehlversuche von derselben IP |
| 429 | `RATE_LIMITED` | Mehr als 600 Requests/Minute |
| 400 | `INVALID_BODY`, `MISSING_ACTION`, `UNKNOWN_ACTION`, `INVALID_PARAMS`, `INVALID_TARGET`, `TARGET_REQUIRED` | Ungültige Eingabe/Zielauswahl |
| 404 | `NOT_FOUND`, `COMMAND_NOT_FOUND` | Route bzw. Befehl unbekannt |
| 409 | `STUDIO_CLIENT_OFFLINE`, `WRONG_STUDIO_CLIENT` | Ziel-Place getrennt oder falscher Plugin-Client |
| 200 | `STUDIO_ACTION_FAILED`, `LOCAL_ACTION_FAILED` | Aktion wurde ausgeführt und ist mit detailliertem Fehler fehlgeschlagen (`ok: false`) |
| 504 | `COMMAND_TIMEOUT` | Studio hat nicht rechtzeitig geantwortet |

Fehlerformat:

```json
{
  "ok": false,
  "error": { "code": "TOKEN_INVALID", "message": "...", "details": { "hint": "..." } },
  "timestamp": "2026-09-12T14:06:24.066Z"
}
```

---

## Endpoints

### `GET /health` — öffentlich

Liveness ohne Token. Verrät keinerlei Token-Material.

```json
{ "ok": true, "service": "arena-studio-connecter", "status": "running",
  "sessionId": "1ea57a7e12a7d5f5", "uptimeSeconds": 42, "authRequired": true }
```

### `GET /agent/guide?clientId=…` — öffentlich

Secret-freie, aktuelle Markdown-Anleitung für Arena Agent. Die Route erklärt Authentifizierung,
Workflow, Aktionen und die ausgewählte Studio-Client-ID, enthält aber niemals den Token.

### `GET /status`

Vollständiger Status: Session, Statistik, verbundene Clients, Queue, Endpoint-Katalog.
Der Roh-Token wird **nie** zurückgegeben, nur `tokenMasked`.

### `GET /ping`

Authentifizierter Liveness-Check: `{ "ok": true, "pong": true, ... }`

### `GET /actions`

Katalog aller Studio-Aktionen inkl. Parameterbeschreibung.

### `POST /command`

Schickt einen Befehl an Roblox Studio und wartet auf das Ergebnis.

```jsonc
// Request
{
  "action": "run_luau",
  "params": { "code": "return 1+1" },
  "targetClientId": "CLIENT_ID_DER_PLACE",
  "timeoutMs": 30000,
  "async": false
}
```

```jsonc
// Response 200
{ "ok": true, "command": {
    "id": "986ff1b0951c", "action": "run_luau", "state": "completed",
    "durationMs": 7, "ok": true, "result": { "returned": 2, "output": [] }, "error": null } }
```

```jsonc
// Response 200: Die Aktion lief, ist aber in Studio fehlgeschlagen.
{ "ok": false, "command": { "id": "986ff1b0951c", "action": "run_luau", "state": "failed", "ok": false },
  "error": {
    "code": "STUDIO_ACTION_FAILED",
    "message": "Luau runtime failed: Workspace.Script:2: example error\nstack traceback: ...",
    "details": { "action": "run_luau", "commandId": "986ff1b0951c", "pluginVersion": "2.1.1" }
  } }
```

Ein Aktionsfehler ist ausdrücklich **kein** pauschaler HTTP-`502`. Synchrone Responses,
`GET /command/:id` und MCP verwenden denselben Fehler mit `code`, eigentlicher `message` und
`details`. Bei MCP ist zusätzlich `isError: true`. Nur ein echter Warte-Timeout liefert HTTP
`504` mit `COMMAND_TIMEOUT`.

`targetClientId` wählt die exakte offene Place. Bei mehr als einer verbundenen Studio-Session
ist das Feld Pflicht; unbekannte oder getrennte Clients werden abgewiesen. Mit `"async": true`
antwortet die Bridge sofort mit `202` und einer `commandId`, das Ergebnis wird später über
`GET /command/:id` abgeholt.

### `GET /command/:id`

Einzelnen Befehl nachschlagen (pending, in-flight oder aus der Historie).

### `GET /queue`

Momentaufnahme: `{ pending, inFlight, history[] }`

### `GET /logs?limit=100&level=info`

Letzte Logeinträge aus dem Ringpuffer. Tokens sind in Logs immer maskiert.

### `POST /token/rotate`

Erzeugt sofort einen neuen Token; der alte wird augenblicklich ungültig.
Die Antwort ist die **einzige** Stelle, an der der neue Token im Klartext erscheint.

```json
{ "ok": true, "rotated": true, "token": "asc_...", "rotations": 1 }
```

---

## MCP — `GET/POST /mcp`

JSON-RPC 2.0 nach Model-Context-Protocol-Form (Protokollversion `2024-11-05`).
`GET` liefert einen Deskriptor, `POST` verarbeitet Requests und Batches.

Unterstützte Methoden: `initialize`, `notifications/initialized`, `ping`,
`tools/list`, `tools/call`, `resources/list`, `resources/read`.

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Studio-Client-Id: CLIENT_ID_DER_PLACE" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"run_luau","arguments":{"code":"return 1+1"}}}'
```

Ressourcen: `arena-studio://status`, `arena-studio://logs`.

---

## Studio-Endpoints (Plugin)

Roblox Studio kann keine eingehenden Verbindungen annehmen, daher **pollt** das Plugin.

| Endpoint | Zweck |
|----------|-------|
| `POST /studio/handshake` | Plugin meldet Client-, Place-, Studio-, Account- und Playtest-Metadaten (`dataModelRole`, `editClientId`) an |
| `GET /studio/poll` | Long-Poll; liefert den nächsten Befehl oder nach ~25 s `{ command: null, idle: true }` |
| `POST /studio/result` | Plugin liefert `{ id, ok, result, error }` zurück |
| `POST /studio/log` | Plugin leitet Studio-Output in das Bridge-Log weiter |

Ablauf eines Befehls:

```
Client --POST /command--> Bridge --(Queue)--> Plugin (GET /studio/poll)
                                                     |
Client <--Ergebnis-- Bridge <--POST /studio/result---+
```

---

## Studio-Aktionen

| Aktion | Parameter | Rückgabe |
|--------|-----------|----------|
| `ping` | — | `pong`, Plugin-Version, `placeId` |
| `run_luau` | `code`, `timeoutMs?` | `returned`, `output[]`, `durationMs` |
| `get_place_info` | — | `placeId`, `gameId`, tatsächlicher `name`, `placeVersion`, … |
| `play_game` | `mode?`: `play` (Standard) oder `run` | Start angenommen, Modus und aktueller Playtest-Status |
| `get_play_state` | — | `playtestActive`, `starting`, `isRunning`, `editModeActive`, `reporterReady`, Fehlerstatus |
| `stop_game` | — | `accepted/ending`; Stop wurde vom Playtest-Plugin übernommen |
| `insert_model` | `assetId`, `parent?`, `name?`, `position?` | Eingefügte Asset-/Instanzpfade |
| `list_instances` | `path`, `depth?` (0–5) | Baum aus `name`/`className`/`path`/`children` |
| `get_instance` | `path` | `className`, `properties`, `childCount` |
| `create_instance` | `className`, `parent`, `properties?` | `created`, `path` |
| `set_property` | `path`, `property`, `value` | `updated`, `path` |
| `delete_instance` | `path` | `deleted`, `path` |
| `get_script_source` | `path` | `source` |
| `set_script_source` | `path`, `source` | `updated`, `length` |
| `get_selection` | — | `count`, `selection[]` |
| `set_selection` | `paths[]` | `selected`, `missing[]` |
| `get_output` | `limit?` | Zuletzt von Studio geloggte Meldungen |

`play_game` meldet den angenommenen Start sofort zurück; die Testerzeugung läuft asynchron. Die
zweite Instanz desselben Plugins im Playtest-Datenmodell verbindet sich selbst mit derselben
Bridge. Die Bridge leitet `stop_game` von der Editor-Client-ID an deren `play-server`-Reporter
weiter. Ein Stop während des Startübergangs wird für diese bekannte ID eingereiht. Der Reporter
ist in `/status` nicht als zweite Place sichtbar und akzeptiert nur `ping`, `get_play_state` und
`stop_game`. Eine erfolgreiche Stop-Antwort bedeutet `accepted/ending`; das endgültige Ende wird
mit `get_play_state` geprüft.

Beispiel für den Upload-Ablauf nach `create_blender_mesh`:

```json
{
  "action": "insert_model",
  "targetClientId": "CLIENT_ID_DER_PLACE",
  "params": { "assetId": "987654321", "parent": "game.Workspace" }
}
```

### Lokale Desktop-Aktionen

Diese Aktionen laufen in der Windows-Desktop-App und nicht im Studio-Plugin. Sie sind ebenfalls
als MCP-Tools verfügbar, synchron und benötigen keine Studio-Warteschlange:

| Aktion | Parameter | Rückgabe |
|--------|-----------|----------|
| `get_blender_status` | — | Blender-Pfad/-Version, Open-Cloud-/Creator-Konfiguration ohne Secret |
| `create_blender_mesh` | `name?`, `description?`, `format?` (`fbx`/`glb`), `upload?`, `objects[]`, optional `creatorType`/`creatorId` | Lokaler Export, bei Upload `assetId`, `assetUrl`, Moderationsstatus |

Ein Primitive-Beispiel:

```json
{
  "action": "create_blender_mesh",
  "targetClientId": "CLIENT_ID_DER_PLACE",
  "params": {
    "name": "Arena Sockel",
    "format": "fbx",
    "upload": true,
    "objects": [{
      "name": "Sockel",
      "primitive": "cylinder",
      "radius": 3,
      "depth": 0.5,
      "segments": 48,
      "material": { "color": [0.2, 0.35, 1, 1], "roughness": 0.35 }
    }]
  }
}
```

Statt `primitive` kann ein Objekt `vertices` (`[[x,y,z], …]`) und `faces`
(`[[indexA,indexB,indexC], …]`) enthalten. Indizes sind nullbasiert. Pro Auftrag gelten enge
Limits für Objekte, Vertices, Faces und Zahlenwerte. `upload: false` erzeugt nur die lokale Datei.
Der Open-Cloud-Key wird ausschließlich von der Desktop-App aus dem DPAPI-Speicher gelesen und ist
weder ein Aktionsparameter noch Teil einer Antwort.

### Werte-Serialisierung

Roblox-Typen werden über ein `__type`-Feld transportiert und in beide Richtungen konvertiert:

```jsonc
{ "__type": "Vector3", "x": 0, "y": 10, "z": 0 }
{ "__type": "Color3", "r": 1, "g": 0, "b": 0 }
{ "__type": "UDim2", "xScale": 0.5, "xOffset": 0, "yScale": 0.5, "yOffset": 0 }
{ "__type": "EnumItem", "enum": "Enum.Material", "name": "Neon" }
{ "__type": "Instance", "path": "game.Workspace.Part" }
{ "__type": "BrickColor", "name": "Bright red" }
{ "__type": "CFrame", "components": [0,0,0, 1,0,0, 0,1,0, 0,0,1] }
```

Beispiel:

```json
{ "action": "create_instance",
  "params": { "className": "Part", "parent": "game.Workspace",
    "properties": { "Name": "ArenaPart", "Anchored": true,
      "Position": { "__type": "Vector3", "x": 0, "y": 10, "z": 0 },
      "Material":  { "__type": "EnumItem", "enum": "Enum.Material", "name": "Neon" } } } }
```
