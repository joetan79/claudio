import { Router, raw } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUserDb } from '../db/index.js';
import { djDecision, getTimeOfDay, detectLang, detectProfileLang, normalizeDecideMessage } from '../modules/claude.js';
import { synthesize } from '../modules/tts.js';
import { transcribe } from '../modules/asr.js';
import { resolveSong, getSongUrl } from '../modules/ncm.js';
import { searchYouTube, resolveSongVideoBudgeted } from '../modules/youtube.js';
import { resolveVoiceByLang, resolveVoiceForLang, resolveVoiceForUser } from '../modules/settings.js';

const router = Router();
// Accept 'application/octet-stream' too — some WebViews/browsers report a
// generic or empty Content-Type on the recorded blob rather than 'audio/*'.
const parseAudioBody = raw({ type: ['audio/*', 'application/octet-stream'], limit: '2mb' });

// Per-song resolution budget for /decide's early-exit orchestration below —
// named constants so they're easy to tune without hunting through the logic.
const SONG_BUDGET_MS = 10000;
const TARGET_SONG_COUNT = 5;
const MIN_ACCEPTABLE_SONGS = 3;
const SONG_TIMED_OUT = Symbol('song-timed-out');

// Resolves one song end-to-end: NCM lookup -> budgeted YT resolution ->
// display-name assembly -> generic fallback retry if still unresolved — all
// within one overall SONG_BUDGET_MS ceiling (a hard Promise.race — the
// internal tier3 budget-gating in resolveSongVideoBudgeted only prevents
// *starting* a tier unlikely to finish in time, it doesn't cap an
// already-in-flight network call running long). Returns the finished song
// object, or null if the song couldn't be resolved — a drop, not an error,
// since radio.js's 7-song over-provisioning expects some drops.
async function resolveOneSong(song, decision) {
  const tStart = Date.now();
  const remaining = () => SONG_BUDGET_MS - (Date.now() - tStart);

  const work = (async () => {
    const tNcm = Date.now();
    const ncm = await resolveSong(song.query).catch(() => null);
    const title = ncm?.name || song.title || '';
    const artist0 = ncm?.artist || song.artist || '';
    const query = ncm ? `${ncm.name} ${ncm.artist}` : song.query;
    console.log(`[timing] song="${song.title}" ncm_ms=${Date.now() - tNcm}`);

    const tYt = Date.now();
    let yt = await resolveSongVideoBudgeted({ query, title, artist: artist0 }, SONG_BUDGET_MS - (Date.now() - tStart)).catch(() => null);
    console.log(`[timing] song="${song.title}" yt_ms=${Date.now() - tYt} source=${yt?.source ?? 'none'}`);

    // Double-insurance (log-only, not a filter): when the listener explicitly
    // asked for Cantonese, a matched video whose own title reads as an
    // explicit Mandarin version (e.g. "国语版") is a likely wrong-version
    // pick — trusts the AI's own per-song `lang` tag as the source of truth
    // rather than building real language detection here.
    if (decision.request_lang === 'yue' && yt?.title && /国语|Mandarin/i.test(yt.title)) {
      console.warn(`[radio] request_lang=yue but matched video looks Mandarin: song="${song.title}" artist="${song.artist}" matched title="${yt.title}"`);
    }

    // Display name trusts YT Music's own catalog metadata (clean, verified
    // against the request via the correlation check in youtube.js) — but for
    // the general-search/ytsr fallback tiers, yt.title/yt.channel are a raw
    // video title and uploader name, which can be anything (a reposting
    // channel's own branding, an OST clip stuffed with hashtags, episode
    // titles, etc.). Never display those — Claude's own title/artist (or
    // NCM's, if it matched) are clean and stay the source of truth for what's
    // shown/stored, even though the video's own title decided the search.
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

    // Generic fallback retry — only attempted if there's still meaningful
    // budget left; a fresh search here is pointless if we're already at the ceiling.
    if (!yt?.videoId && remaining() > 500) {
      const mood = decision.mood || '';
      const fallbacks = [
        artist ? `${artist} popular song` : null,
        artist ? `${artist} music` : null,
        mood ? `${mood} music popular` : null,
      ].filter(Boolean);
      for (const q of fallbacks) {
        if (remaining() <= 300) break;
        const fbYt = await searchYouTube(q).catch(() => null);
        if (fbYt?.videoId) {
          // Same distrust of raw video titles/channels as above — only trust
          // yt.title when it's YT Music's own clean catalog metadata, which a
          // generic fallback query can still hit.
          const useYtTitle = fbYt.source === 'ytmusic' && fbYt.title;
          if (useYtTitle) {
            song_name = fbYt.title;
            artist = fbYt.artist || artist;
          } else if (fbYt.title) {
            console.log(`[radio] fallback-retry (${fbYt.source}) display name kept as "${song_name}" — actual video title was "${fbYt.title}"${fbYt.channel ? ` (channel: "${fbYt.channel}")` : ''}`);
          }
          yt = fbYt;
          break;
        }
      }
    }

    if (!yt?.videoId) return null;

    const displayQuery = artist ? `${song_name} - ${artist}` : song_name;
    return { ...song, query: displayQuery, song_name, artist, ncm, yt };
  })();

  const timeout = new Promise(resolve => setTimeout(() => resolve(SONG_TIMED_OUT), SONG_BUDGET_MS));
  const result = await Promise.race([work, timeout]);
  if (result === SONG_TIMED_OUT) {
    console.warn(`[radio] song "${song.title}" (${song.artist}) exceeded ${SONG_BUDGET_MS}ms budget — dropped`);
    return null;
  }
  return result;
}

// Fires as soon as the first TARGET_SONG_COUNT songs — in the AI's priority
// order, skipping drops — are confirmed playable, or once every song has
// settled, whichever comes first. Still-pending songs at that point are left
// running to their own natural conclusion; their eventual results only get
// logged, never awaited or used (nothing after "responded" flips affects the
// response that's already been decided).
async function resolveSongsWithEarlyExit(songs, decision) {
  const settled = new Array(songs.length).fill(undefined); // undefined=pending, null=dropped, object=confirmed
  let responded = false;
  let fireEarlyExit;
  const earlyExit = new Promise(resolve => { fireEarlyExit = resolve; });

  function computeReturnable() {
    const confirmed = [];
    for (let i = 0; i < settled.length; i++) {
      if (settled[i] === undefined) break; // unknown outcome — can't safely count past this yet
      if (settled[i] !== null) {
        confirmed.push(settled[i]);
        if (confirmed.length >= TARGET_SONG_COUNT) return confirmed;
      }
    }
    return null;
  }

  const songPromises = songs.map((song, i) =>
    resolveOneSong(song, decision).then(result => {
      if (responded) {
        console.log(`[radio] song[${i}] "${song.title}" settled after response was already decided (${result ? 'confirmed' : 'dropped'}) — logged only`);
        return result;
      }
      settled[i] = result;
      const returnable = computeReturnable();
      if (returnable) fireEarlyExit(returnable);
      return result;
    })
  );

  // Fallback for when 5-in-priority-order is never reached: once every song
  // has settled one way or another, return whatever confirmed set exists
  // (even if under TARGET_SONG_COUNT — the caller enforces MIN_ACCEPTABLE_SONGS).
  Promise.all(songPromises).then(() => {
    if (!responded) fireEarlyExit(settled.filter(s => s !== null && s !== undefined));
  });

  const finalPlay = await earlyExit;
  responded = true;
  const stats = {
    confirmed: settled.filter(s => s !== null && s !== undefined).length,
    dropped: settled.filter(s => s === null).length,
    pending: settled.filter(s => s === undefined).length,
  };
  return { finalPlay: finalPlay.slice(0, TARGET_SONG_COUNT), stats };
}

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
    // fallback retry, one independent chain per song), not just the NCM step
    // — it's only joined at the end. Voice follows the language the listener actually wrote in — same
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
    // re-verifying it (see the yue/Mandarin sanity-check log inside resolveOneSong).
    const requestLang = decision.request_lang || null;
    const rawSongs = decision.play || [];
    const songs = requestLang ? rawSongs.filter(s => s.lang === requestLang) : rawSongs;
    if (requestLang && songs.length < rawSongs.length) {
      console.warn(`[radio] request_lang=${requestLang}: ${rawSongs.length} candidates -> ${songs.length} after language filter`);
    }
    if (requestLang && songs.length < MIN_ACCEPTABLE_SONGS) {
      console.warn(`[radio] request_lang=${requestLang}: only ${songs.length} candidate(s) survived the language filter (below ${MIN_ACCEPTABLE_SONGS}) — returning as-is`);
    }

    // Early-exit orchestration: each song runs its own independent, budgeted
    // resolution chain (NCM -> YT tier1/2/3 -> generic fallback retry) in
    // parallel. As soon as the first TARGET_SONG_COUNT songs — in the AI's
    // priority order, skipping drops — are confirmed playable, this returns
    // immediately; any still-running songs are left to finish on their own,
    // logged only, never awaited further.
    const tResolveStart = Date.now();
    const { finalPlay, stats } = await resolveSongsWithEarlyExit(songs, decision);
    console.log(`[timing] yt_resolve_ms=${Date.now() - tResolveStart} confirmed=${stats.confirmed} dropped=${stats.dropped} pending=${stats.pending} returning=${finalPlay.length}`);

    if (finalPlay.length < MIN_ACCEPTABLE_SONGS) {
      console.warn(`[radio] decide: only ${finalPlay.length} playable song(s) found (below minimum ${MIN_ACCEPTABLE_SONGS}) — returning error`);
      return res.status(502).json({
        error: 'Could not find enough playable songs this time — try rephrasing your request.',
        code: 'INSUFFICIENT_SONGS',
      });
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
