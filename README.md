# ArenaBridgeRoblox

Eine lokale Bridge zwischen Arena AI und Roblox Studio – mit dynamischen Tokens, Dashboard, Command‑Sender, Logs und vollständiger Session‑Verwaltung.

---

## 📥 Download

**[⬇️ ZIP herunterladen](https://github.com/alamerstudios/ArenaBridgeRoblox/archive/refs/heads/main.zip)**  
*(Text‑Button, kein echter Button)*

---

## 🚀 Installation

### 1. ZIP herunterladen
Lade die ZIP-Datei über den Button oben herunter.

### 2. ZIP entpacken
Entpacke die Datei an einen beliebigen Ort auf deinem PC.

### 3. Bridge starten
Starte die Datei:
start_bridge.bat


Die Bridge generiert automatisch:

- eine lokale URL
- einen dynamischen Token (ändert sich bei jedem Start)
- eine Session‑ID
- ein Dashboard

Beispiel‑Ausgabe:
============================================================
ArenaBridge: LAEUFT
============================================================
---BRIDGE---
url: Generierte URL
token: <GENERATED_TOKEN>
---END---

---

## 🔗 Verbindung zu Arena AI
Arena AI verbindet sich automatisch, wenn du ihm **nur diesen Block** sendest:
Verbinde dich mit meiner ArenaBridge und teste die Endpoints.
---BRIDGE---
url: Generierte URL
token: <TOKEN>
---END---



Arena erkennt die Bridge, öffnet einen Tunnel und testet alle Endpoints.

---

## 🧩 Roblox Studio Plugin

1. Öffne Roblox Studio  
2. Gehe oben im Menü auf **Plugins**  
3. Klicke dort auf **Plugin‑Ordner öffnen**  
   → Roblox Studio öffnet automatisch den lokalen Plugin‑Ordner  
4. Öffne im ArenaBridgeRoblox‑Ordner den Ordner **Roblox**  
5. Ziehe die Datei **NexusAIPlugin.server.lua** per Drag & Drop in den Plugin‑Ordner, den Studio geöffnet hat  
6. Starte Roblox Studio neu  
7. Öffne das Plugin und trage **URL + Token** ein  
8. Klicke auf **Verbinden**

Das Plugin zeigt danach:

- Session‑Status  
- Logs  
- Verbundene Clients  
- Command‑Sender  
- Statistik  
- Token‑Rotation

---

## ⚠️ Hinweise

### 🔒 Cloudflare‑Tunnel
Arena AI öffnet automatisch einen Tunnel, um deine Bridge zu testen.  
Wenn du fertig bist → **Ctrl+C** im cloudflared‑Fenster drücken.

### 👻 Phantom‑Client
Ein leerer Handshake (`{}`) kann kurz einen Fake‑Client erzeugen.  
Harmlos, verschwindet automatisch.

### 🌐 Roblox HTTP Requests
Falls du später HTTP aus Studio nutzen willst:  
Aktiviere in **Game Settings → Security → Allow HTTP Requests**.

---

## 📚 Features

- Dynamische Token‑Generierung  
- Token‑Rotation  
- Dashboard mit Logs  
- Command‑Sender (JSON)  
- MCP‑Support  
- Session‑Management  
- Statistik‑Panel  
- Verbundene Clients‑Liste  
- Roblox Plugin Integration  

---

## 🛠️ Entwicklung

Die Bridge ist in Node.js gebaut.  
Arena AI kann automatisch:

- Dateien erstellen  
- Struktur optimieren  
- Endpoints erweitern  
- Dashboard verbessern  
- Plugin‑Code generieren  

---

Arena AI verbindet sich automatisch, wenn du ihm **nur diesen Block** sendest:

