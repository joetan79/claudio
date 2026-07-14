import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getSystemDb } from '../db/index.js';
import { requireAdmin } from '../middleware/admin.js';
import { getDjVoices, setDjVoices, getAiSettings, setAiSettings } from '../modules/settings.js';

const router = Router();
router.use(requireAdmin);

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

router.get('/users', (req, res) => {
  const db = getSystemDb();
  const users = db.prepare(
    'SELECT id, username, email, role, status, created_at, last_login, anthropic_key, fish_key, ai_policy FROM users ORDER BY created_at DESC'
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
    ai_policy: u.ai_policy || 'global',
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
  // Driven by `usage`, not `users` — a user LEFT JOIN would silently drop usage
  // rows belonging to since-deleted accounts, while /usage/daily (which reads
  // `usage` directly) would still count them, making the two charts disagree.
  // cache_creation/cache_read are raw token counts from Anthropic's prompt-cache
  // usage fields — NOT cost-adjusted. Cache reads bill at ~0.1x normal input
  // cost and cache writes at ~1.25x; that multiplier is intentionally not
  // applied here, so these columns are token counts, not comparable $ cost.
  const rows = db.prepare(`
    SELECT
      us.uid AS uid,
      COALESCE(u.username, '(deleted user)') AS username,
      SUM(CASE WHEN us.type = 'claude' THEN us.input_tokens ELSE 0 END) AS claude_input,
      SUM(CASE WHEN us.type = 'claude' THEN us.output_tokens ELSE 0 END) AS claude_output,
      SUM(CASE WHEN us.type = 'claude' THEN us.cache_creation_input_tokens ELSE 0 END) AS claude_cache_creation,
      SUM(CASE WHEN us.type = 'claude' THEN us.cache_read_input_tokens ELSE 0 END) AS claude_cache_read,
      SUM(CASE WHEN us.type = 'tts' THEN us.chars ELSE 0 END) AS tts_chars,
      SUM(CASE WHEN us.own_key = 1 THEN 1 ELSE 0 END) AS own_key_calls,
      COUNT(*) AS total_calls
    FROM usage us
    LEFT JOIN users u ON u.id = us.uid
    WHERE us.ts >= ?
    GROUP BY us.uid
    ORDER BY (claude_input + claude_output) DESC
  `).all(since);
  res.json({ days, users: rows });
});

router.get('/usage/daily', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = getSystemDb();
  // claude_cache_read/claude_cache_creation are raw token counts (see the
  // billing-multiplier note on /usage/summary above) — not cost-adjusted.
  const rows = db.prepare(`
    SELECT
      date(ts / 1000, 'unixepoch', 'localtime') AS date,
      COALESCE(SUM(CASE WHEN type = 'claude' THEN input_tokens + output_tokens ELSE 0 END), 0) AS claude_tokens,
      COALESCE(SUM(CASE WHEN type = 'claude' THEN cache_creation_input_tokens ELSE 0 END), 0) AS claude_cache_creation,
      COALESCE(SUM(CASE WHEN type = 'claude' THEN cache_read_input_tokens ELSE 0 END), 0) AS claude_cache_read,
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

router.put('/users/:uid/ai-policy', (req, res) => {
  const { policy } = req.body ?? {};
  if (!['global', 'own_only'].includes(policy))
    return res.status(400).json({ error: "policy must be 'global' or 'own_only'" });
  if (req.params.uid === req.user.uid)
    return res.status(400).json({ error: 'Cannot change your own AI policy' });
  const db = getSystemDb();
  const result = db.prepare('UPDATE users SET ai_policy = ? WHERE id = ?').run(policy, req.params.uid);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

router.get('/ai-settings', (req, res) => {
  res.json(getAiSettings());
});

router.put('/ai-settings', (req, res) => {
  const { provider, model } = req.body ?? {};
  if (provider !== undefined && !['anthropic', 'openrouter'].includes(provider))
    return res.status(400).json({ error: "provider must be 'anthropic' or 'openrouter'" });
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    return res.status(400).json({ error: 'model must be a non-empty string' });
  setAiSettings({ provider, model: model !== undefined ? model.trim() : undefined });
  res.json({ ok: true });
});

router.get('/voices', (req, res) => {
  res.json({ voices: getDjVoices() });
});

router.put('/voices', (req, res) => {
  const { voices } = req.body ?? {};
  if (!Array.isArray(voices) || voices.length === 0 || voices.length > 4)
    return res.status(400).json({ error: 'voices must be an array of 1 to 4 entries' });

  for (const v of voices) {
    if (!v || typeof v.id !== 'string' || !v.id.trim() ||
        typeof v.name !== 'string' || !v.name.trim() ||
        typeof v.ref !== 'string' || !v.ref.trim()) {
      return res.status(400).json({ error: 'each voice needs id, name, and ref' });
    }
    if (v.provider !== undefined && !['fish', 'minimax'].includes(v.provider))
      return res.status(400).json({ error: "provider must be 'fish' or 'minimax'" });
    if ((v.provider === 'minimax') && !process.env.MINIMAX_API_KEY)
      return res.status(400).json({ error: `voice "${v.name}" uses provider 'minimax' but MINIMAX_API_KEY is not configured on this server` });
  }
  const ids = new Set(voices.map(v => v.id));
  if (ids.size !== voices.length)
    return res.status(400).json({ error: 'voice ids must be unique' });

  setDjVoices(voices);
  res.json({ ok: true });
});

export default router;
