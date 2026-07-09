import { getSystemDb } from '../db/index.js';
import { verifyToken } from './auth.js';

export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  try {
    const payload = verifyToken(token);
    const db = getSystemDb();
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(payload.uid);
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = payload;
    req.token = token;
    next();
  } catch (e) {
    if (e.code === 'SESSION_REVOKED') return res.status(401).json({ error: 'session revoked', code: 'SESSION_REVOKED' });
    if (e.code === 'ACCOUNT_DISABLED') return res.status(403).json({ error: 'account disabled' });
    res.status(401).json({ error: 'Unauthorized' });
  }
}
