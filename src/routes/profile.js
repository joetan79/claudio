import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { getSystemDb, getUserDb } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

const router = Router();
router.use(requireAuth);

const MAX_LEN = 5000;

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

router.get('/me', (req, res) => {
  const db = getSystemDb();
  const user = db.prepare(
    'SELECT id, username, email, created_at FROM users WHERE id = ?'
  ).get(req.user.uid);

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ uid: user.id, username: user.username, email: user.email, created_at: user.created_at });
});

export default router;
