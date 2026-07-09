import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getSystemDb } from '../db/index.js';

// Verifies the JWT, then checks it against the single-session table and the
// account's status. Shared by requireAuth and requireAdmin so both
// middlewares enforce session revocation and disabled accounts the same way.
export function verifyToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const db = getSystemDb();

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!session || session.expires_at < Date.now()) {
    throw Object.assign(new Error('session revoked'), { code: 'SESSION_REVOKED' });
  }

  const user = db.prepare('SELECT status FROM users WHERE id = ?').get(payload.uid);
  if (!user || user.status === 'disabled') {
    throw Object.assign(new Error('account disabled'), { code: 'ACCOUNT_DISABLED' });
  }

  return payload;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    req.user = { uid: payload.uid, username: payload.username };
    req.token = token;
    next();
  } catch (e) {
    if (e.code === 'SESSION_REVOKED') return res.status(401).json({ error: 'session revoked', code: 'SESSION_REVOKED' });
    if (e.code === 'ACCOUNT_DISABLED') return res.status(403).json({ error: 'account disabled' });
    res.status(401).json({ error: 'Unauthorized' });
  }
}
