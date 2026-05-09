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
    'SELECT id, username, email, role, created_at, last_login FROM users ORDER BY created_at DESC'
  ).all();
  const now = Date.now();
  const withStatus = users.map(u => ({
    ...u,
    status: u.last_login && (now - u.last_login) < THIRTY_DAYS ? 'active' : 'inactive',
  }));
  res.json({
    total: users.length,
    active: withStatus.filter(u => u.status === 'active').length,
    inactive: withStatus.filter(u => u.status === 'inactive').length,
    users: withStatus,
  });
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

router.delete('/users/:uid', (req, res) => {
  if (req.params.uid === req.user.uid)
    return res.status(400).json({ error: 'Cannot delete yourself' });
  const db = getSystemDb();
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

export default router;
