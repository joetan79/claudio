import { Router, raw } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUserDb } from '../db/index.js';
import { djDecision, getTimeOfDay, detectLang } from '../modules/claude.js';
import { synthesize } from '../modules/tts.js';
import { transcribe } from '../modules/asr.js';
import { resolveSong, getSongUrl } from '../modules/ncm.js';
import { searchYouTube, resolveSongVideos } from '../modules/youtube.js';
import { resolveVoiceForUser } from '../modules/settings.js';

const router = Router();
// Accept 'application/octet-stream' too — some WebViews/browsers report a
// generic or empty Content-Type on the recorded blob rather than 'audio/*'.
const parseAudioBody = raw({ type: ['audio/*', 'application/octet-stream'], limit: '2mb' });

// No auth — used by <audio> elements to refresh expired NCM links
router.get('/song-url/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const url = await getSongUrl(id).catch(() => null);
  res.json({ url: url ?? null });
});

router.use(requireAuth);

router.post('/decide', async (req, res) => {
  const tRequestStart = Date.now();
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

  let decision;
  const tAiStart = Date.now();
  try {
    decision = await djDecision(uid, message, context);
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID' || e.code === 'AI_KEY_REQUIRED')
      return res.status(e.status || 401).json({ error: e.message, code: e.code });
    throw e;
  }
  console.log(`[timing] dj_decision_ms=${Date.now() - tAiStart}`);

  // TTS is started the instant `say` is known and runs in parallel with the
  // *entire* song-resolution chain below (NCM lookup → YouTube resolution →
  // fallback retry), not just the NCM step — it's only joined at the end.
  // NCM first (best-effort) → normalized name+artist becomes the YouTube query.
  // YT Music is the source of truth for display metadata when it resolves the song.
  // All songs' candidates are checked for embeddability in as few batched Data API
  // calls as possible (resolveSongVideos), rather than one call per song.
  const tTtsStart = Date.now();
  const audioUrlPromise = synthesize({ text: decision.say, uid, voice: resolveVoiceForUser(uid) });
  audioUrlPromise.catch(() => {}); // observed early so a later throw below can't cause an unhandled rejection

  let playWithUrls;
  try {
    const songs = decision.play || [];
    const tNcmStart = Date.now();
    const ncmResults = await Promise.all(songs.map(song => resolveSong(song.query).catch(() => null)));
    console.log(`[timing] ncm_ms=${Date.now() - tNcmStart}`);

    const ytRequests = songs.map((song, i) => {
      const ncm = ncmResults[i];
      const title = ncm?.name || song.title || '';
      const artist = ncm?.artist || song.artist || '';
      const query = ncm ? `${ncm.name} ${ncm.artist}` : song.query;
      return { query, title, artist };
    });
    const tYtStart = Date.now();
    const ytResults = await resolveSongVideos(ytRequests);
    console.log(`[timing] yt_resolve_ms=${Date.now() - tYtStart}`);

    // Display name always follows the actual matched video's metadata, never
    // Claude's original guess — otherwise what's shown/stored can name a
    // different song than what's actually embedded and played.
    playWithUrls = songs.map((song, i) => {
      const ncm = ncmResults[i];
      const yt = ytResults[i];

      let song_name, artist;
      if (yt?.title) {
        song_name = yt.title;
        artist = yt.source === 'ytmusic' ? (yt.artist || '') : (ncm?.artist || song.artist || '');
      } else {
        song_name = ncm?.name || song.title || song.query;
        artist = ncm?.artist || song.artist || '';
      }
      const query = artist ? `${song_name} - ${artist}` : song_name;
      return { ...song, query, song_name, artist, ncm, yt };
    });
  } catch (e) {
    throw e;
  }

  // Retry YouTube for songs missing videoId using artist/mood alternative queries
  const tFallbackStart = Date.now();
  const play = await Promise.all(
    playWithUrls.map(async (song) => {
      if (song.yt?.videoId) return song;
      const artist = song.ncm?.artist || song.artist || '';
      const mood = decision.mood || '';
      const fallbacks = [
        artist ? `${artist} popular song` : null,
        artist ? `${artist} music` : null,
        mood ? `${mood} music popular` : null,
      ].filter(Boolean);
      for (const q of fallbacks) {
        const yt = await searchYouTube(q).catch(() => null);
        if (yt?.videoId) {
          // The fallback query is generic (e.g. "<artist> popular song"), so it
          // can land on a different track than the original request — recompute
          // the displayed name from the actual match rather than keeping the
          // stale song_name/query computed against the discarded lookup.
          const song_name = yt.title || song.song_name;
          const query = artist ? `${song_name} - ${artist}` : song_name;
          return { ...song, yt, song_name, query };
        }
      }
      return song;
    })
  );
  console.log(`[timing] yt_fallback_retry_ms=${Date.now() - tFallbackStart} missing=${playWithUrls.filter(s => !s.yt?.videoId).length}`);

  let audioUrl;
  try {
    audioUrl = await audioUrlPromise;
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') return res.status(e.status || 401).json({ error: e.message, code: 'OWN_KEY_INVALID' });
    throw e;
  }
  console.log(`[timing] tts_join_ms=${Date.now() - tTtsStart} (elapsed since TTS started, includes wait for song resolution)`);

  const result = { ...decision, audioUrl: audioUrl ?? null, play };

  db.prepare(
    'INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run('last_decision', JSON.stringify(result), Date.now());

  console.log(`[timing] decide_total_ms=${Date.now() - tRequestStart}`);
  res.json(result);
});

router.post('/transcribe', (req, res, next) => {
  parseAudioBody(req, res, (err) => {
    if (err) return res.status(413).json({ error: 'Audio too large (max 2MB)' });
    next();
  });
}, async (req, res) => {
  const uid = req.user.uid;
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'No audio received' });
  }

  try {
    const text = await transcribe(req.body, { uid, mimeType: req.headers['content-type'] });
    // detectLang() returns exactly one of 'zh' | 'en' | 'yue' — pass it straight through.
    const language = detectLang(text);
    res.json({ text, language });
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID') return res.status(e.status || 401).json({ error: e.message, code: e.code });
    res.status(e.status || 500).json({ error: e.message || 'Transcription failed' });
  }
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

router.get('/ytsr', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'missing query' });
  const yt = await searchYouTube(q).catch(() => null);
  res.json({ yt: yt ?? null });
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
  let decision, audioUrl;
  try {
    decision = await djDecision(uid, message, context);
    audioUrl = await synthesize({ text: decision.say, uid, voice: resolveVoiceForUser(uid) }).catch(e => {
      if (e.code === 'OWN_KEY_INVALID') throw e;
      return null;
    });
  } catch (e) {
    if (e.code === 'OWN_KEY_INVALID' || e.code === 'AI_KEY_REQUIRED')
      return res.status(e.status || 401).json({ error: e.message, code: e.code });
    throw e;
  }
  const result = { ...decision, audioUrl: audioUrl ?? null };

  const db = getUserDb(uid);
  db.prepare(
    'INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(planKey, JSON.stringify(result), Date.now());

  res.json(result);
});

export default router;
