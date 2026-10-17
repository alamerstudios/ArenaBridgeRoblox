import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLUGIN_FILE = 'ArenaStudioConnecter.rbxmx';
const LEGACY_FILES = [
  'NexusAIPlugin.server.lua',
  'NexusAIPlugin.rbxmx',
  'ArenaStudioConnecter.server.lua',
];

function cdata(value) {
  return String(value).replace(/]]>/g, ']]]]><![CDATA[>');
}

export function buildPluginModel(luaSource) {
  return `<?xml version="1.0" encoding="utf-8"?>
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="4">
  <External>null</External>
  <External>nil</External>
  <Item class="Script" referent="RBX0">
    <Properties>
      <bool name="Disabled">false</bool>
      <Content name="LinkedSource"><null /></Content>
      <string name="Name">Arena Studio Connecter</string>
      <ProtectedString name="Source"><![CDATA[${cdata(luaSource)}]]></ProtectedString>
    </Properties>
  </Item>
</roblox>
`;
}

export function resolvePluginsDirectory(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    return localAppData ? path.join(localAppData, 'Roblox', 'Plugins') : null;
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
  return null;
}

/** Install/update the local Roblox Studio plugin without touching user plugins. */
export function installStudioPlugin({ sourcePath, source, pluginsDirectory = resolvePluginsDirectory() }) {
  if (!pluginsDirectory) {
    return { status: 'unsupported', installed: false, message: 'Automatische Plugin-Installation ist nur unter Windows verfügbar.' };
  }

  try {
    const luaSource = typeof source === 'string' ? source : fs.readFileSync(sourcePath, 'utf8');
    const model = buildPluginModel(luaSource);
    fs.mkdirSync(pluginsDirectory, { recursive: true });
    const destination = path.join(pluginsDirectory, PLUGIN_FILE);
    const previous = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null;
    const updated = previous !== model;

    if (updated) {
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, model, 'utf8');
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        // Windows can reject an atomic rename when the destination already
        // exists. Only replace our exact managed filename, then retry.
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
      }
    }

    for (const legacyName of LEGACY_FILES) {
      const legacyPath = path.join(pluginsDirectory, legacyName);
      if (legacyPath !== destination) {
        try { fs.rmSync(legacyPath, { force: true }); } catch { /* leave unrelated filesystem errors non-fatal */ }
      }
    }

    return {
      status: 'installed',
      installed: true,
      updated,
      path: destination,
      message: updated
        ? 'Plugin wurde installiert. Ein bereits geöffnetes Roblox Studio bitte einmal neu starten.'
        : 'Plugin ist installiert und aktuell.',
    };
  } catch (error) {
    return {
      status: 'error',
      installed: false,
      path: pluginsDirectory,
      message: `Plugin konnte nicht installiert werden: ${error.message}`,
    };
  }
}

export { PLUGIN_FILE };
