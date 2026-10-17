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
| 502 | — | Studio hat einen Fehler zurückgemeldet |
| 504 | — | Studio hat nicht rechtzeitig geantwortet |

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
| `POST /studio/handshake` | Plugin meldet Client-, Place-, Studio- und Account-Metadaten an |
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
| `get_place_info` | — | `placeId`, `gameId`, `name`, `placeVersion`, … |
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
