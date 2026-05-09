import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getSystemDb, initUserDir } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9]{3,20}$/;

router.post('/register', async (req, res) => {
  const { email, password, username } = req.body ?? {};

  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Invalid email' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!username || !USERNAME_RE.test(username))
    return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters' });

  const db = getSystemDb();

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email already registered' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.status(409).json({ error: 'Username taken' });

  const uid = uuidv4();
  const password_hash = await bcrypt.hash(password, 10);
  const now = Date.now();

  db.prepare(
    'INSERT INTO users (id, email, password_hash, username, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uid, email, password_hash, username, now);

  initUserDir(uid);

  res.json({ ok: true, uid, username });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  const db = getSystemDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { uid: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);

  res.json({ ok: true, token, uid: user.id, username: user.username });
});

router.get('/me', requireAuth, (req, res) => {
  const db = getSystemDb();
  const user = db.prepare('SELECT id, email, username FROM users WHERE id = ?').get(req.user.uid);

  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({ uid: user.id, username: user.username, email: user.email });
});

export default router;
