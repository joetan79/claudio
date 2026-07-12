import { getUserFishKey } from './tts.js';
import { recordUsage } from './usage.js';

const ASR_MAX_BYTES = 2 * 1024 * 1024;

export async function transcribe(audioBuffer, options = {}) {
  const { uid, mimeType } = options;
  const userKey = getUserFishKey(uid);
  const apiKey = userKey || process.env.FISH_TTS_KEY;
  const ownKey = !!userKey;

  if (!audioBuffer || !audioBuffer.length) {
    throw Object.assign(new Error('No audio received'), { status: 400 });
  }
  if (audioBuffer.length > ASR_MAX_BYTES) {
    throw Object.assign(new Error('Audio too large (max 2MB)'), { status: 413 });
  }
  if (!apiKey) {
    throw Object.assign(new Error('Voice input is not configured on this server.'), { status: 503 });
  }

  const t0 = Date.now();
  const form = new FormData();
  form.append('audio', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), 'audio.webm');
  form.append('ignore_timestamps', 'true');

  let res;
  try {
    res = await fetch('https://api.fish.audio/v1/asr', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    console.log(`[timing] asr_ms=${Date.now() - t0} status=error(${e.message})`);
    throw Object.assign(new Error('Voice recognition request failed.'), { status: 502 });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('ASR error:', res.status, errText);
    console.log(`[timing] asr_ms=${Date.now() - t0} status=${res.status}(error)`);
    if (ownKey && (res.status === 401 || res.status === 403)) {
      throw Object.assign(new Error('Your API Key is invalid. Please check your key in Profile > API Keys.'), {
        code: 'OWN_KEY_INVALID',
        status: res.status,
      });
    }
    throw Object.assign(new Error('Voice recognition failed. Please try again or type instead.'), { status: 502 });
  }

  const data = await res.json();
  const text = (data.text || '').trim();
  console.log(`[timing] asr_ms=${Date.now() - t0} chars=${text.length}`);

  recordUsage({ uid, type: 'asr', chars: text.length, ownKey });
  return text;
}
