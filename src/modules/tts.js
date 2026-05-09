import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = '/home/claudeProj/claudio/data/tts';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function hashText(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

export async function synthesize(text) {
  if (!text || !process.env.FISH_TTS_KEY) return null;

  const hash = hashText(text);
  const filePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(filePath)) return `/api/tts/${hash}.mp3`;

  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FISH_TTS_KEY}`,
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
      return null;
    }

    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return `/api/tts/${hash}.mp3`;
  } catch (e) {
    console.error('TTS failed:', e.message);
    return null;
  }
}
