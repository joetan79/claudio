import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { getSystemDb, getUserDb, DEFAULT_TASTE_MD } from '../db/index.js';
import { encrypt, decrypt, isEncryptionEnabled, maskKey } from '../modules/crypto.js';
import { getDjVoices, getUserVoiceId } from '../modules/settings.js';
import { synthesize } from '../modules/tts.js';
import { generateOnboardingProfile } from '../modules/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

const router = Router();
router.use(requireAuth);

const MAX_LEN = 5000;
const VOICE_PREVIEW_TEXT = '你好，我是你的 DJ';

function userFilePath(uid, filename) {
  return path.join(DATA_DIR, 'users', uid, filename);
}

router.get('/taste', (req, res) => {
  try {
    const content = fs.readFileSync(userFilePath(req.user.uid, 'taste.md'), 'utf8');
    res.json({ content });
  } catch {
    res.json({ content: '' });
  }
});

router.put('/taste', (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'content must be a string' });
  if (content.length > MAX_LEN)
    return res.status(400).json({ error: `content exceeds ${MAX_LEN} character limit` });

  fs.writeFileSync(userFilePath(req.user.uid, 'taste.md'), content, 'utf8');
  res.json({ ok: true });
});

router.get('/routines', (req, res) => {
  try {
    const content = fs.readFileSync(userFilePath(req.user.uid, 'routines.md'), 'utf8');
    res.json({ content });
  } catch {
    res.json({ content: '' });
  }
});

router.put('/routines', (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'content must be a string' });
  if (content.length > MAX_LEN)
    return res.status(400).json({ error: `content exceeds ${MAX_LEN} character limit` });

  fs.writeFileSync(userFilePath(req.user.uid, 'routines.md'), content, 'utf8');
  res.json({ ok: true });
});

router.get('/history', (req, res) => {
  const db = getUserDb(req.user.uid);
  const plays = db.prepare(
    'SELECT id, song_id, song_name, artist, played_at, source FROM plays ORDER BY played_at DESC LIMIT 20'
  ).all();
  res.json({ plays });
});

router.get('/keys', (req, res) => {
  const db = getSystemDb();
  const user = db.prepare(
    'SELECT anthropic_key, own_ai_provider, own_ai_model FROM users WHERE id = ?'
  ).get(req.user.uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  function maskStored(ciphertext) {
    if (!ciphertext || !isEncryptionEnabled()) return null;
    try { return maskKey(decrypt(ciphertext)); } catch { return null; }
  }

  res.json({
    key: maskStored(user.anthropic_key),
    provider: user.own_ai_provider || 'anthropic',
    model: user.own_ai_model || null,
  });
});

router.put('/keys', (req, res) => {
  if (!isEncryptionEnabled())
    return res.status(503).json({ error: 'BYO key feature is not enabled on this server' });

  const { key, provider, model } = req.body ?? {};
  if (key === undefined && provider === undefined && model === undefined)
    return res.status(400).json({ error: 'key, provider, or model required' });
  if (provider !== undefined && !['anthropic', 'openrouter'].includes(provider))
    return res.status(400).json({ error: "provider must be 'anthropic' or 'openrouter'" });

  const db = getSystemDb();
  if (key !== undefined) {
    const value = key === '' ? null : encrypt(key);
    db.prepare('UPDATE users SET anthropic_key = ? WHERE id = ?').run(value, req.user.uid);
  }
  if (provider !== undefined) {
    db.prepare('UPDATE users SET own_ai_provider = ? WHERE id = ?').run(provider, req.user.uid);
  }
  if (model !== undefined) {
    const value = model === '' ? null : model;
    db.prepare('UPDATE users SET own_ai_model = ? WHERE id = ?').run(value, req.user.uid);
  }
  res.json({ ok: true });
});

// The DJ still auto-routes voice by the language the listener writes in
// (radio.js) — but when the listener's preferred voice matches that
// language, it wins over plain language routing. This lists the configured
// language voices plus the listener's current preference for the Profile UI.
router.get('/voices', (req, res) => {
  const voices = getDjVoices().map(v => ({ id: v.id, name: v.name, lang: v.lang }));
  const current = getUserVoiceId(req.user.uid) || null;
  res.json({ voices, current });
});

router.put('/voice', (req, res) => {
  const { voice } = req.body ?? {};
  if (!voice || typeof voice !== 'string')
    return res.status(400).json({ error: 'voice is required' });

  const voices = getDjVoices();
  if (!voices.some(v => v.id === voice))
    return res.status(400).json({ error: 'unknown voice id' });

  const db = getSystemDb();
  db.prepare('UPDATE users SET dj_voice = ? WHERE id = ?').run(voice, req.user.uid);
  res.json({ ok: true });
});

router.post('/voice/preview', async (req, res) => {
  const { voice } = req.body ?? {};
  const voices = getDjVoices();
  const entry = voice ? voices.find(v => v.id === voice) : voices[0];
  if (!entry) return res.status(400).json({ error: 'unknown voice id' });

  try {
    const audioUrl = await synthesize({ text: VOICE_PREVIEW_TEXT, uid: req.user.uid, voice: entry });
    if (!audioUrl) return res.status(502).json({ error: 'TTS failed' });
    res.json({ audioUrl });
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') return res.status(e.status || 401).json({ error: e.message, code: 'OWN_KEY_INVALID' });
    throw e;
  }
});

router.get('/me', (req, res) => {
  const db = getSystemDb();
  const user = db.prepare(
    'SELECT id, username, email, created_at FROM users WHERE id = ?'
  ).get(req.user.uid);

  if (!user) return res.status(404).json({ error: 'User not found' });

  let needsOnboarding = true;
  try {
    const taste = fs.readFileSync(userFilePath(req.user.uid, 'taste.md'), 'utf8');
    needsOnboarding = !taste.trim() || taste === DEFAULT_TASTE_MD;
  } catch {
    needsOnboarding = true;
  }

  res.json({
    uid: user.id, username: user.username, email: user.email, created_at: user.created_at,
    needs_onboarding: needsOnboarding,
  });
});

router.post('/onboarding', async (req, res) => {
  const { languages, artists, scenarios, schedule, style } = req.body ?? {};

  const answers = {
    languages: Array.isArray(languages) ? languages : (languages ? [languages] : []),
    artists: typeof artists === 'string' ? artists.slice(0, 500) : '',
    scenarios: Array.isArray(scenarios) ? scenarios : (scenarios ? [scenarios] : []),
    schedule: typeof schedule === 'string' ? schedule : '',
    style: typeof style === 'string' ? style : '',
  };

  const result = await generateOnboardingProfile(req.user.uid, answers);
  res.json({ ok: true, taste: result.taste, routines: result.routines });
});

export default router;
