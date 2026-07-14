import { Router, raw } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUserDb } from '../db/index.js';
import { djDecision, getTimeOfDay, detectLang, detectProfileLang, normalizeDecideMessage } from '../modules/claude.js';
import { synthesize } from '../modules/tts.js';
import { transcribe } from '../modules/asr.js';
import { resolveSong, getSongUrl } from '../modules/ncm.js';
import { searchYouTube, resolveSongVideos } from '../modules/youtube.js';
import { resolveVoiceByLang, resolveVoiceForLang, resolveVoiceForUser } from '../modules/settings.js';

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

  // Wraps the whole handler, including the synchronous DB calls (getUserDb,
  // db.prepare(...).run/.all) that aren't otherwise guarded — Express 4 does
  // not catch a rejected promise from an async handler, so without this an
  // uncaught throw here becomes an unhandled rejection that crashes the
  // whole process, not just this request (see server.js's global backstop
  // for anything that still slips past a route-level catch).
  try {
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
    // Voice follows the language the listener actually wrote in — same
    // detectLang() call djDecision uses internally for the "say" language
    // instruction, on the same normalized message, so they can't disagree.
    // The listener's preferred Profile voice wins if it's tagged with that
    // same language (resolveVoiceForLang); otherwise plain language routing.
    const tTtsStart = Date.now();
    const lang = detectLang(normalizeDecideMessage(message));
    const audioUrlPromise = synthesize({ text: decision.say, uid, voice: resolveVoiceForLang(lang, uid) });
    audioUrlPromise.catch(() => {}); // observed early so a later throw below can't cause an unhandled rejection

    // Language hard-constraint server-side filter: request_lang is set when
    // the listener explicitly asked for a specific sung language this turn.
    // Drop non-matching candidates BEFORE spending NCM/YouTube/embed-check
    // calls on them — the 7-song over-provisioning exists partly for this.
    // Trusts the AI's own per-song `lang` tag as-is rather than independently
    // re-verifying it (see the yue/Mandarin sanity-check log further below).
    const requestLang = decision.request_lang || null;
    const rawSongs = decision.play || [];
    const songs = requestLang ? rawSongs.filter(s => s.lang === requestLang) : rawSongs;
    if (requestLang && songs.length < rawSongs.length) {
      console.warn(`[radio] request_lang=${requestLang}: ${rawSongs.length} candidates -> ${songs.length} after language filter`);
    }
    if (requestLang && songs.length < 3) {
      console.warn(`[radio] request_lang=${requestLang}: only ${songs.length} candidate(s) survived the language filter (below 3) — returning as-is`);
    }

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

    // Double-insurance (log-only, not a filter): when the listener explicitly
    // asked for Cantonese, a matched video whose own title reads as an
    // explicit Mandarin version (e.g. "国语版") is a likely wrong-version
    // pick — same-melody dual-language releases (富士山下 vs 爱情转移-style)
    // are hard to catch generically, so this trusts the AI's own per-song
    // `lang` tag as the source of truth rather than building real language
    // detection here; it just logs the suspicious case for observation.
    if (requestLang === 'yue') {
      songs.forEach((song, i) => {
        const yt = ytResults[i];
        if (yt?.title && /国语|Mandarin/i.test(yt.title)) {
          console.warn(`[radio] request_lang=yue but matched video looks Mandarin: song="${song.title}" artist="${song.artist}" matched title="${yt.title}"`);
        }
      });
    }

    // Display name trusts YT Music's own catalog metadata (clean, verified
    // against the request via the correlation check in youtube.js) — but for
    // the general-search/ytsr fallback tiers, yt.title/yt.channel are a raw
    // video title and uploader name, which can be anything (a reposting
    // channel's own branding, an OST clip stuffed with hashtags, episode
    // titles, etc.). Never display those — Claude's own title/artist (or
    // NCM's, if it matched) are clean and stay the source of truth for what's
    // shown/stored, even though the video's own title decided the search.
    const playWithUrls = songs.map((song, i) => {
      const ncm = ncmResults[i];
      const yt = ytResults[i];

      let song_name, artist;
      if (yt?.source === 'ytmusic' && yt.title) {
        song_name = yt.title;
        artist = yt.artist || '';
      } else {
        song_name = ncm?.name || song.title || song.query;
        artist = ncm?.artist || song.artist || '';
        if (yt?.title) {
          console.log(`[radio] fallback-tier (${yt.source}) display name kept as "${song_name}" — actual video title was "${yt.title}"${yt.channel ? ` (channel: "${yt.channel}")` : ''}`);
        }
      }
      const query = artist ? `${song_name} - ${artist}` : song_name;
      return { ...song, query, song_name, artist, ncm, yt };
    });

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
            // Same distrust of raw video titles/channels as the primary pass
            // above — only trust yt.title when it's YT Music's own clean
            // catalog metadata, which a generic fallback query can still hit.
            const useYtTitle = yt.source === 'ytmusic' && yt.title;
            const song_name = useYtTitle ? yt.title : song.song_name;
            if (yt.title && !useYtTitle) {
              console.log(`[radio] fallback-retry (${yt.source}) display name kept as "${song_name}" — actual video title was "${yt.title}"${yt.channel ? ` (channel: "${yt.channel}")` : ''}`);
            }
            const query = artist ? `${song_name} - ${artist}` : song_name;
            return { ...song, yt, song_name, query };
          }
        }
        return song;
      })
    );
    console.log(`[timing] yt_fallback_retry_ms=${Date.now() - tFallbackStart} missing=${playWithUrls.filter(s => !s.yt?.videoId).length}`);

    // Server-side "unavailable" filter: djDecision over-provisions 7
    // candidates specifically so losing a few to failed search/embeddability
    // checks still leaves 5 good ones — take the first 5 (in the AI's given
    // priority order) that actually resolved to a playable videoId. Return
    // fewer only if the pipeline genuinely couldn't find 5 (≥3 still acceptable).
    const playableCandidates = play.filter(s => s.yt?.videoId);
    const finalPlay = playableCandidates.slice(0, 5);
    if (finalPlay.length < play.length) {
      console.warn(`[radio] decide: ${play.length} candidates, ${playableCandidates.length} playable, returning ${finalPlay.length}${finalPlay.length < 5 ? ' (BELOW target of 5)' : ''}`);
    }

    let audioUrl;
    try {
      audioUrl = await audioUrlPromise;
    } catch (e) {
      if (e.code === 'OWN_KEY_INVALID') return res.status(e.status || 401).json({ error: e.message, code: 'OWN_KEY_INVALID' });
      throw e;
    }
    console.log(`[timing] tts_join_ms=${Date.now() - tTtsStart} (elapsed since TTS started, includes wait for song resolution)`);

    const result = { ...decision, audioUrl: audioUrl ?? null, play: finalPlay };

    db.prepare(
      'INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run('last_decision', JSON.stringify(result), Date.now());

    console.log(`[timing] decide_total_ms=${Date.now() - tRequestStart}`);
    res.json(result);
  } catch (e) {
    console.error('[radio] /decide failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate DJ decision. Please try again.' });
  }
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

  // Same reasoning as /decide above: wraps the getUserDb/db.prepare calls
  // too, not just the djDecision/synthesize block, so nothing here can
  // become an unhandled rejection.
  try {
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
      // No live listener message here (scheduler-triggered plan) — use the
      // listener's preferred Profile voice if they've set one; only fall
      // back to inferring a language from their taste profile when they haven't.
      const planVoice = resolveVoiceForUser(uid) || resolveVoiceByLang(detectProfileLang(uid));
      audioUrl = await synthesize({ text: decision.say, uid, voice: planVoice }).catch(e => {
        if (e.code === 'OWN_KEY_INVALID') throw e;
        return null;
      });
    } catch (e) {
      if (e.code === 'OWN_KEY_INVALID' || e.code === 'AI_KEY_REQUIRED')
        return res.status(e.status || 401).json({ error: e.message, code: e.code });
      throw e;
    }
    // This route doesn't run the YT/NCM resolution pipeline (unlike /decide),
    // so there's no availability filter to apply here — just trim djDecision's
    // 7 over-provisioned candidates back down to the 5 the plan is meant to hold.
    const result = { ...decision, play: (decision.play || []).slice(0, 5), audioUrl: audioUrl ?? null };

    const db = getUserDb(uid);
    db.prepare(
      'INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(planKey, JSON.stringify(result), Date.now());

    res.json(result);
  } catch (e) {
    console.error('[radio] /plan/generate failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate plan. Please try again.' });
  }
});

export default router;
