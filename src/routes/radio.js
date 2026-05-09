import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUserDb } from '../db/index.js';
import { djDecision, getTimeOfDay } from '../modules/claude.js';
import { synthesize } from '../modules/tts.js';
import { resolveSong, getSongUrl } from '../modules/ncm.js';
import { searchYouTube } from '../modules/youtube.js';

const router = Router();

// No auth — used by <audio> elements to refresh expired NCM links
router.get('/song-url/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const url = await getSongUrl(id).catch(() => null);
  res.json({ url: url ?? null });
});

router.use(requireAuth);

router.post('/decide', async (req, res) => {
  const uid = req.user.uid;
  const { message, weather, mood } = req.body ?? {};

  const hour = new Date().getHours();
  const timeOfDay = getTimeOfDay(hour);

  const db = getUserDb(uid);
  const recentPlays = db.prepare(
    'SELECT song_name, artist FROM plays ORDER BY played_at DESC LIMIT 20'
  ).all();

  const context = {
    weather: weather ?? '',
    timeOfDay,
    recentPlays,
    currentMood: mood ?? '',
  };

  const decision = await djDecision(uid, message, context);

  // TTS runs in parallel with song resolution.
  // Per song: NCM first → use normalized name+artist as YouTube query for accuracy.
  const [audioUrl, playWithUrls] = await Promise.all([
    synthesize(decision.say).catch(() => null),
    Promise.all(
      (decision.play || []).map(async (song) => {
        const ncm = await resolveSong(song.query).catch(() => null);
        const ytQuery = ncm ? `${ncm.name} ${ncm.artist}` : song.query;
        const yt = await searchYouTube(ytQuery).catch(() => null);
        const query = ncm ? `${ncm.name} - ${ncm.artist}` : song.query;
        return { ...song, query, ncm, yt };
      })
    ),
  ]);

  const result = { ...decision, audioUrl: audioUrl ?? null, play: playWithUrls };

  db.prepare(
    'INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run('last_decision', JSON.stringify(result), Date.now());

  res.json(result);
});

router.get('/now', (req, res) => {
  const db = getUserDb(req.user.uid);
  const row = db.prepare('SELECT value FROM memory WHERE key = ?').get('last_decision');

  if (!row) {
    return res.json({ say: "Tell me what you're in the mood for.", play: [], mood: 'neutral', audioUrl: null });
  }

  try {
    res.json(JSON.parse(row.value));
  } catch {
    res.json({ say: "Tell me what you're in the mood for.", play: [], mood: 'neutral', audioUrl: null });
  }
});

router.post('/played', (req, res) => {
  const { song_id, song_name, artist } = req.body ?? {};
  const db = getUserDb(req.user.uid);

  db.prepare(
    'INSERT INTO plays (song_id, song_name, artist, played_at) VALUES (?, ?, ?, ?)'
  ).run(song_id ?? null, song_name ?? '', artist ?? '', Date.now());

  res.json({ ok: true });
});

router.get('/plan', (req, res) => {
  const db = getUserDb(req.user.uid);

  function readPlan(key) {
    const row = db.prepare('SELECT value FROM memory WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  res.json({ morning: readPlan('plan_morning'), night: readPlan('plan_night') });
});

router.post('/plan/generate', async (req, res) => {
  const uid = req.user.uid;
  const hour = new Date().getHours();
  const timeOfDay = getTimeOfDay(hour);
  const isNight = hour >= 18;

  const message = isNight
    ? 'Wind down time, something for late night.'
    : 'Good morning, what should I start my day with?';
  const planKey = isNight ? 'plan_night' : 'plan_morning';

  const context = { weather: '', timeOfDay, recentPlays: [], currentMood: '' };
  const decision = await djDecision(uid, message, context);
  const audioUrl = await synthesize(decision.say).catch(() => null);
  const result = { ...decision, audioUrl: audioUrl ?? null };

  const db = getUserDb(uid);
  db.prepare(
    'INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(planKey, JSON.stringify(result), Date.now());

  res.json(result);
});

export default router;
