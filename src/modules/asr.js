import { spawn } from 'child_process';
import { getUserFishKey } from './tts.js';
import { recordUsage } from './usage.js';

const ASR_MAX_BYTES = 2 * 1024 * 1024;

// Root cause (confirmed from production logs): Android WebView's MediaRecorder
// output hit Fish ASR's decoder with "unsupported codec" — the container was
// recognized but the codec inside wasn't one Fish's decoder handles, unlike
// desktop Chrome/Safari's webm/opus or mp4/aac output. Rather than chase every
// browser/WebView's exact codec quirks client-side, transcode server-side to
// one universally-accepted format (16kHz mono WAV) before sending to Fish.
// ffmpeg auto-detects the input container/codec from the byte stream itself,
// so this is robust regardless of what MediaRecorder actually produced or
// what Content-Type the client reported.
function transcodeToWav(inputBuffer, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1']);
    const outChunks = [];
    const errChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ff.kill('SIGKILL');
      reject(Object.assign(new Error('Audio transcode timed out'), { status: 502 }));
    }, timeoutMs);

    ff.stdout.on('data', d => outChunks.push(d));
    ff.stderr.on('data', d => errChunks.push(d));
    ff.stdin.on('error', () => {}); // EPIPE when ffmpeg exits early on bad input — the 'close' handler below reports the real error
    ff.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`ffmpeg unavailable: ${err.message}`), { status: 500 }));
    });
    ff.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || !outChunks.length) {
        const errText = Buffer.concat(errChunks).toString('utf8').trim().slice(0, 300);
        reject(Object.assign(new Error(`Audio transcode failed: ${errText || 'unrecognized audio data'}`), { status: 400 }));
        return;
      }
      resolve(Buffer.concat(outChunks));
    });

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

export async function transcribe(audioBuffer, options = {}) {
  const { uid } = options;
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

  const tTranscode = Date.now();
  let wavBuffer;
  try {
    wavBuffer = await transcodeToWav(audioBuffer);
  } catch (e) {
    console.error('ASR transcode error:', e.message);
    console.log(`[timing] asr_transcode_ms=${Date.now() - tTranscode} status=error`);
    throw Object.assign(new Error('Could not process the recorded audio. Please try again.'), { status: e.status === 400 ? 400 : 502 });
  }
  console.log(`[timing] asr_transcode_ms=${Date.now() - tTranscode} in_bytes=${audioBuffer.length} out_bytes=${wavBuffer.length}`);

  const t0 = Date.now();
  const form = new FormData();
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
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
