import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSystemDb } from '../db/index.js';
import { decrypt, isEncryptionEnabled } from './crypto.js';
import { recordUsage } from './usage.js';
import { resolveVoice } from './settings.js';

const CACHE_DIR = '/home/claudeProj/claudio/data/tts';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Domestic endpoint — confirmed reachable and authenticating with this
// account's key using just the Bearer token (no GroupId query param; passing
// one actually fails with "token not match group" for this account/key).
const MINIMAX_ENDPOINT = 'https://api.minimaxi.com/v1/t2a_v2';
const MINIMAX_MODEL = 'speech-2.8-turbo';

function hashText(text, provider, ref) {
  return crypto.createHash('md5').update(`${text}|${provider}|${ref || ''}`).digest('hex');
}

export function getUserFishKey(uid) {
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

async function synthesizeFish(text, ref, uid) {
  const userKey = getUserFishKey(uid);
  const apiKey = userKey || process.env.FISH_TTS_KEY;
  const ownKey = !!userKey;
  if (!apiKey) return null;

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
    const errText = await res.text();
    console.error('TTS error (fish):', res.status, errText);
    if (ownKey && (res.status === 401 || res.status === 403)) {
      throw Object.assign(new Error('Your API Key is invalid. Please check your key in Profile > API Keys.'), {
        code: 'OWN_KEY_INVALID',
        status: res.status,
      });
    }
    return null;
  }

  return { buffer: Buffer.from(await res.arrayBuffer()), ownKey };
}

async function synthesizeMinimax(text, ref) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.error('[tts] MINIMAX_API_KEY not configured, cannot synthesize with minimax provider');
    return null;
  }

  const res = await fetch(MINIMAX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      text,
      voice_setting: { voice_id: ref, speed: 1.0 },
      audio_setting: { format: 'mp3' },
      // Covers both Mandarin and Cantonese DJ voices without per-call branching.
      language_boost: 'Chinese,Yue',
    }),
  });

  if (!res.ok) {
    console.error('TTS error (minimax):', res.status, await res.text());
    return null;
  }

  // MiniMax reports errors inside a 200 response via base_resp.status_code,
  // not via HTTP status — must check both.
  const data = await res.json();
  if (data.base_resp?.status_code !== 0) {
    console.error('TTS error (minimax):', data.base_resp);
    return null;
  }

  const audioHex = data.data?.audio;
  if (!audioHex) return null;
  return { buffer: Buffer.from(audioHex, 'hex'), ownKey: false };
}

// `voice` is the full {id, name, provider, ref} object from settings.js —
// falls back to the default configured voice when omitted.
export async function synthesize({ text, uid, voice } = {}) {
  if (!text) return null;
  const v = voice || resolveVoice(null);
  if (!v?.ref) return null;

  const provider = v.provider || 'fish';
  const hash = hashText(text, provider, v.ref);
  const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(filePath)) {
    console.log(`[timing] tts_ms=0 (cache hit) chars=${text.length} provider=${provider}`);
    return `/api/tts/${hash}.mp3`;
  }

  const t0 = Date.now();
  try {
    const result = provider === 'minimax'
      ? await synthesizeMinimax(text, v.ref)
      : await synthesizeFish(text, v.ref, uid);

    if (!result) {
      console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length} provider=${provider} status=error`);
      return null;
    }

    fs.writeFileSync(filePath, result.buffer);
    recordUsage({ uid, type: 'tts', chars: text.length, ownKey: result.ownKey, model: provider });
    console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length} provider=${provider}`);
    return `/api/tts/${hash}.mp3`;
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') throw e;
    console.error('TTS failed:', e.message);
    console.log(`[timing] tts_ms=${Date.now() - t0} chars=${text.length} provider=${provider} status=error(${e.message})`);
    return null;
  }
}
