import { getSystemDb } from '../db/index.js';

export function recordUsage({ uid, type, model, inputTokens, outputTokens, chars, ownKey }) {
  try {
    const db = getSystemDb();
    db.prepare(`
      INSERT INTO usage (uid, type, model, input_tokens, output_tokens, chars, own_key, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid, type, model ?? null, inputTokens ?? 0, outputTokens ?? 0, chars ?? 0, ownKey ? 1 : 0, Date.now());
  } catch (e) {
    console.warn('[usage] failed to record:', e.message);
  }
}
