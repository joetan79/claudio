import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSystemDb } from '../db/index.js';
import { decrypt, isEncryptionEnabled } from './crypto.js';
import { recordUsage } from './usage.js';

const CACHE_DIR = '/home/claudeProj/claudio/data/tts';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function hashText(text) {
  return crypto.createHash('md5').update(text).digest('hex');
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
  const { uid } = options;
  const userKey = getUserFishKey(uid);
  const apiKey = userKey || process.env.FISH_TTS_KEY;
  const ownKey = !!userKey;

  if (!text || !apiKey) return null;

  const hash = hashText(text);
  const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(filePath)) return `/api/tts/${hash}.mp3`;

  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: process.env.FISH_TTS_VOICE,
        format: 'mp3',
        latency: 'normal',
      }),
    });

    if (!res.ok) {
      console.error('TTS error:', res.status, await res.text());
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
    return `/api/tts/${hash}.mp3`;
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') throw e;
    console.error('TTS failed:', e.message);
    return null;
  }
}
