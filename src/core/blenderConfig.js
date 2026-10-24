const DEFAULT_BLENDER_CONFIG = Object.freeze({
  blenderPath: '',
  creatorType: 'user',
  creatorId: '',
});

/** Validate and normalize the non-secret Blender/Open Cloud settings. */
export function normalizeBlenderConfig(input = {}, previous = {}) {
  const base = { ...DEFAULT_BLENDER_CONFIG, ...(previous ?? {}) };
  const blenderPath = String(input.blenderPath ?? base.blenderPath ?? '').trim();
  const creatorType = String(input.creatorType ?? base.creatorType ?? 'user').toLowerCase();
  const creatorId = String(input.creatorId ?? base.creatorId ?? '').trim();

  if (blenderPath.includes('\0')) throw new Error('Der Blender-Pfad enthält ein ungültiges Zeichen.');
  if (blenderPath.length > 1024) throw new Error('Der Blender-Pfad ist zu lang.');
  if (!['user', 'group'].includes(creatorType)) throw new Error('Creator-Typ muss "user" oder "group" sein.');
  if (creatorId && !/^[1-9]\d{0,19}$/.test(creatorId)) {
    throw new Error('Die Creator-ID muss eine positive numerische Roblox-User- oder Group-ID sein.');
  }

  return { blenderPath, creatorType, creatorId };
}

export { DEFAULT_BLENDER_CONFIG };
