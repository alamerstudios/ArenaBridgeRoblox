/**
 * Build the text that is copied from a Place card into a fresh Arena Agent
 * conversation. The bridge token is deliberately kept out of every URL and is
 * only documented as an Authorization header value.
 */

function cleanBaseUrl(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

function display(value, fallback = 'Unbekannt') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

/**
 * @param {{ tunnelUrl: string, token: string, client: object }} options
 */
export function buildAgentPrompt({ tunnelUrl, token, client }) {
  const baseUrl = cleanBaseUrl(tunnelUrl);
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('A secure Cloudflare tunnel URL is required.');
  if (typeof token !== 'string' || token.length < 20) throw new Error('A valid bridge token is required.');
  if (!client || typeof client.id !== 'string' || !client.id) throw new Error('A connected Studio client is required.');

  const guideUrl = `${baseUrl}/agent/guide?clientId=${encodeURIComponent(client.id)}`;
  const placeName = display(client.placeName, client.place ? display(client.place) : 'Unbekannte Place');
  const placeId = display(client.placeId, client.place ?? 'nicht veröffentlicht');
  const universeId = display(client.gameId, 'nicht verfügbar');
  const accountName = display(client.accountName, 'unbekannter Account');

  return [
    'Verbinde dich über Arena Studio Connecter mit meiner aktuell geöffneten Roblox-Studio-Place.',
    '',
    'VERBINDUNG',
    `Cloudflare-Tunnel: ${baseUrl}`,
    `Bridge-Token: ${token}`,
    `Studio-Client-ID: ${client.id}`,
    `Place: ${placeName}`,
    `Place-ID: ${placeId}`,
    `Universe-ID: ${universeId}`,
    `Studio-Account: ${accountName}`,
    '',
    'ERSTER SCHRITT (unbedingt ausführen)',
    `Lies zuerst die vollständige, aktuelle Anleitung unter ${guideUrl}`,
    'Die URL enthält absichtlich keinen Token. Falls dein Web-Lesewerkzeug keine Header unterstützt, nutze curl im Terminal.',
    `Beispiel: curl -sS -H "Authorization: Bearer ${token}" "${guideUrl}"`,
    '',
    'SICHERHEIT UND ZIELAUSWAHL',
    '- Sende den Bridge-Token ausschließlich im HTTP-Header "Authorization: Bearer <token>".',
    '- Hänge den Token niemals als Query-Parameter an eine URL und schreibe ihn nicht in Dateien, Logs oder Quellcode.',
    `- Setze bei jedem POST /command exakt "targetClientId": "${client.id}", damit nur diese Place verändert wird.`,
    '- Untersuche zuerst die vorhandene Place-Struktur, bevor du etwas änderst.',
    '- Prüfe jede ausgeführte Änderung anschließend über die Read-/Get-Aktionen der Bridge.',
    '- Nutze play_game, get_play_state und stop_game für Playtests. Nach stop_game keine weiteren Build-Befehle senden, bis Studio wieder im Edit-Modus ist.',
    '- Für lokale Blender-Meshes stehen get_blender_status und create_blender_mesh zur Verfügung; anschließend insert_model mit der zurückgegebenen Asset-ID. Der Open-Cloud-Key bleibt ausschließlich auf meinem PC und wird niemals angefordert.',
    '',
    'Wenn ich in dieser Nachricht noch keine konkrete Aufgabe für die Place genannt habe, bestätige kurz die Verbindung und frage mich, was du bauen oder ändern sollst. Führe danach die Aufgabe selbstständig über die Bridge aus und fasse das Ergebnis zusammen.',
  ].join('\n');
}

export function buildGuideUrl(tunnelUrl, clientId) {
  const baseUrl = cleanBaseUrl(tunnelUrl);
  return `${baseUrl}/agent/guide?clientId=${encodeURIComponent(clientId)}`;
}
