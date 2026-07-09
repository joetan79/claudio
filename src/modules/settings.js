import { getSystemDb } from '../db/index.js';

export function getDjVoices() {
  const db = getSystemDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'dj_voices'`).get();
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
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

export function resolveVoiceRef(voiceId) {
  const voices = getDjVoices();
  if (!voices.length) return process.env.FISH_TTS_VOICE || null;
  const voice = (voiceId && voices.find(v => v.id === voiceId)) || voices[0];
  return voice?.ref ?? null;
}

export function getUserVoiceId(uid) {
  const db = getSystemDb();
  const row = db.prepare('SELECT dj_voice FROM users WHERE id = ?').get(uid);
  return row?.dj_voice ?? null;
}

export function resolveVoiceRefForUser(uid) {
  return resolveVoiceRef(getUserVoiceId(uid));
}
