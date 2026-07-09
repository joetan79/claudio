import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getSystemDb } from '../db/index.js';
import { requireAdmin } from '../middleware/admin.js';

const router = Router();
router.use(requireAdmin);

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

router.get('/users', (req, res) => {
  const db = getSystemDb();
  const users = db.prepare(
    'SELECT id, username, email, role, status, created_at, last_login, anthropic_key, fish_key FROM users ORDER BY created_at DESC'
  ).all();
  const now = Date.now();
  const withActivity = users.map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
    last_login: u.last_login,
    has_own_key: !!(u.anthropic_key || u.fish_key),
    activity: u.last_login && (now - u.last_login) < THIRTY_DAYS ? 'active' : 'inactive',
  }));
  res.json({
    total: users.length,
    active: withActivity.filter(u => u.activity === 'active').length,
    inactive: withActivity.filter(u => u.activity === 'inactive').length,
    users: withActivity,
  });
});

router.get('/usage/summary', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = getSystemDb();
  const rows = db.prepare(`
    SELECT
      u.id AS uid,
      u.username AS username,
      COALESCE(SUM(CASE WHEN us.type = 'claude' THEN us.input_tokens ELSE 0 END), 0) AS claude_input,
      COALESCE(SUM(CASE WHEN us.type = 'claude' THEN us.output_tokens ELSE 0 END), 0) AS claude_output,
      COALESCE(SUM(CASE WHEN us.type = 'tts' THEN us.chars ELSE 0 END), 0) AS tts_chars,
      COALESCE(SUM(CASE WHEN us.own_key = 1 THEN 1 ELSE 0 END), 0) AS own_key_calls,
      COUNT(us.id) AS total_calls
    FROM users u
    LEFT JOIN usage us ON us.uid = u.id AND us.ts >= ?
    GROUP BY u.id
    ORDER BY (claude_input + claude_output) DESC
  `).all(since);
  res.json({ days, users: rows });
});

router.get('/usage/daily', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = getSystemDb();
  const rows = db.prepare(`
    SELECT
      date(ts / 1000, 'unixepoch', 'localtime') AS date,
      COALESCE(SUM(CASE WHEN type = 'claude' THEN input_tokens + output_tokens ELSE 0 END), 0) AS claude_tokens,
      COALESCE(SUM(CASE WHEN type = 'tts' THEN chars ELSE 0 END), 0) AS tts_chars
    FROM usage
    WHERE ts >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(since);
  res.json({ days, daily: rows });
});

router.post('/users/:uid/reset-password', (req, res) => {
  const { newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = bcrypt.hashSync(newPassword, 10);
  const db = getSystemDb();
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.put('/users/:uid/status', (req, res) => {
  const { status } = req.body ?? {};
  if (!['active', 'disabled'].includes(status))
    return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
  if (req.params.uid === req.user.uid)
    return res.status(400).json({ error: 'Cannot change your own status' });
  const db = getSystemDb();
  const result = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.put('/users/:uid/role', (req, res) => {
  const { role } = req.body ?? {};
  if (!['user', 'admin'].includes(role))
    return res.status(400).json({ error: "role must be 'user' or 'admin'" });
  if (req.params.uid === req.user.uid && role !== 'admin')
    return res.status(400).json({ error: 'Cannot demote yourself' });
  const db = getSystemDb();
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.delete('/users/:uid', (req, res) => {
  if (req.params.uid === req.user.uid)
    return res.status(400).json({ error: 'Cannot delete yourself' });
  const db = getSystemDb();
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

export default router;
