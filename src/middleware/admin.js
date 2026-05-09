import jwt from 'jsonwebtoken';
import { getSystemDb } from '../db/index.js';

export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const db = getSystemDb();
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(payload.uid);
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
