import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSystemDb } from '../db/index.js';
import { decrypt, isEncryptionEnabled } from './crypto.js';
import { recordUsage } from './usage.js';
import { resolveVoiceRef } from './settings.js';

const CACHE_DIR = '/home/claudeProj/claudio/data/tts';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function hashText(text, voiceRef) {
  return crypto.createHash('md5').update(`${text}|${voiceRef || ''}`).digest('hex');
}

function getUserFishKey(uid) {
  if (!uid || !isEncryptionEnabled()) return null;
  const db = getSystemDb();
  const row = db.prepare('SELECT fish_key FROM users WHERE id = ?').get(uid);
  if (!row?.fish_key) return null;
  try {
    return decrypt(row.fish_key);
  } catch {
    console.warn('[tts] failed to decrypt stored user key');
    return null;
  }
}

export async function synthesize(text, options = {}) {
  const { uid, voiceRef } = options;
  const userKey = getUserFishKey(uid);
  const apiKey = userKey || process.env.FISH_TTS_KEY;
  const ownKey = !!userKey;

  if (!text || !apiKey) return null;

  const ref = voiceRef || resolveVoiceRef(null);
  const hash = hashText(text, ref);
  const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(filePath)) {
    console.log(`[timing] tts_ms=0 (cache hit) chars=${text.length}`);
    return `/api/tts/${hash}.mp3`;
  }

  const t0 = Date.now();
  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: ref,
        format: 'mp3',
        latency: 'normal',
      }),
    });

    if (!res.ok) {
      console.error('TTS error:', res.status, await res.text());
      console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length} status=${res.status}(error)`);
      if (ownKey && (res.status === 401 || res.status === 403)) {
        throw Object.assign(new Error('Your API Key is invalid. Please check your key in Profile > API Keys.'), {
          code: 'OWN_KEY_INVALID',
          status: res.status,
        });
      }
      return null;
    }

    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    recordUsage({ uid, type: 'tts', chars: text.length, ownKey });
    console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length}`);
    return `/api/tts/${hash}.mp3`;
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') throw e;
    console.error('TTS failed:', e.message);
    console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length} status=error(${e.message})`);
    return null;
  }
}
