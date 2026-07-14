import { getSystemDb } from '../db/index.js';

const DEFAULT_PROVIDER = 'fish';

export function getDjVoices() {
  const db = getSystemDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'dj_voices'`).get();
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    // Voices saved before the provider field existed default to 'fish' — a
    // read-time hot migration, no DB migration script needed.
    return parsed.map(v => ({ provider: DEFAULT_PROVIDER, ...v }));
  } catch {
    return [];
  }
}

export function setDjVoices(voices) {
  const db = getSystemDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('dj_voices', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(voices), Date.now());
}

// Returns the full voice object ({id, name, provider, ref}), not just the
// ref string — the TTS layer needs `provider` to pick fish vs minimax.
export function resolveVoice(voiceId) {
  const voices = getDjVoices();
  if (!voices.length) {
    return process.env.FISH_TTS_VOICE
      ? { id: null, name: null, provider: DEFAULT_PROVIDER, ref: process.env.FISH_TTS_VOICE }
      : null;
  }
  return (voiceId && voices.find(v => v.id === voiceId)) || voices[0];
}

// TTS voice follows the language the listener actually used, not a fixed
// per-user preference — users.dj_voice is no longer read at runtime (column
// kept in the schema, just unused). Falls back to the 'zh' voice when
// nothing matches (missing lang tag, or that language has no configured voice).
export function resolveVoiceByLang(lang) {
  const voices = getDjVoices();
  if (!voices.length) {
    return process.env.FISH_TTS_VOICE
      ? { id: null, name: null, provider: DEFAULT_PROVIDER, lang: 'zh', ref: process.env.FISH_TTS_VOICE }
      : null;
  }
  return voices.find(v => v.lang === lang) || voices.find(v => v.lang === 'zh') || voices[0];
}

export function getAiSettings() {
  const db = getSystemDb();
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN ('ai_provider', 'ai_model')`).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    provider: map.ai_provider || 'anthropic',
    model: map.ai_model || process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
  };
}

export function setAiSettings({ provider, model }) {
  const db = getSystemDb();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const now = Date.now();
  if (provider !== undefined) stmt.run('ai_provider', provider, now);
  if (model !== undefined) stmt.run('ai_model', model, now);
}
