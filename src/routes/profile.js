import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { getSystemDb, getUserDb } from '../db/index.js';
import { encrypt, decrypt, isEncryptionEnabled, maskKey } from '../modules/crypto.js';
import { getDjVoices, getUserVoiceId } from '../modules/settings.js';
import { synthesize } from '../modules/tts.js';

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
  const user = db.prepare('SELECT anthropic_key, fish_key FROM users WHERE id = ?').get(req.user.uid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  function maskStored(ciphertext) {
    if (!ciphertext || !isEncryptionEnabled()) return null;
    try { return maskKey(decrypt(ciphertext)); } catch { return null; }
  }

  res.json({
    anthropic: maskStored(user.anthropic_key),
    fish: maskStored(user.fish_key),
  });
});

router.put('/keys', (req, res) => {
  if (!isEncryptionEnabled())
    return res.status(503).json({ error: 'BYO key feature is not enabled on this server' });

  const { anthropic, fish } = req.body ?? {};
  if (anthropic === undefined && fish === undefined)
    return res.status(400).json({ error: 'anthropic or fish required' });

  const db = getSystemDb();
  if (anthropic !== undefined) {
    const value = anthropic === '' ? null : encrypt(anthropic);
    db.prepare('UPDATE users SET anthropic_key = ? WHERE id = ?').run(value, req.user.uid);
  }
  if (fish !== undefined) {
    const value = fish === '' ? null : encrypt(fish);
    db.prepare('UPDATE users SET fish_key = ? WHERE id = ?').run(value, req.user.uid);
  }
  res.json({ ok: true });
});

router.get('/voices', (req, res) => {
  const voices = getDjVoices().map(v => ({ id: v.id, name: v.name }));
  const current = getUserVoiceId(req.user.uid) || voices[0]?.id || null;
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
    const audioUrl = await synthesize(VOICE_PREVIEW_TEXT, { uid: req.user.uid, voiceRef: entry.ref });
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
  res.json({ uid: user.id, username: user.username, email: user.email, created_at: user.created_at });
});

export default router;
