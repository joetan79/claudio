import ytsr from 'ytsr';
import { Innertube, YTNodes } from 'youtubei.js';

const PREFERRED = ['official', 'music', 'vevo', 'topic'];
const BLOCKED_TITLE = /cover|翻唱|remix|live|现场|伴奏|instrumental|karaoke/i;
const MAX_CANDIDATES = 5;
const MAX_ALT_IDS = 3;
const EMBED_CACHE_LIMIT = 500;
const DATA_API_TIMEOUT_MS = 4000;
const DATA_API_BATCH_SIZE = 50;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Anti-pollution filters for the normal-search and ytsr fallback tiers only —
// YT Music's `type: song` results are already clean and skip these.
const MIN_FALLBACK_DURATION_SEC = 90;
const MAX_FALLBACK_DURATION_SEC = 600;
const BLOCKED_FALLBACK_TITLE = /gameplay|实况|攻略|直播|教程|tutorial|reaction|合集|串烧|mix|全集|8d|倍速|sped\s*up|slowed/i;

function parseDurationToSeconds(text) {
  if (!text) return null;
  const parts = text.split(':').map(n => parseInt(n, 10));
  if (!parts.length || parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase();
}

function extractTokens(query) {
  return (query || '')
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(t => t.length >= 2);
}

// Simple includes-based relevance check: the title must contain at least one
// meaningful token from the song/artist query (case-insensitive for Latin script,
// direct match for CJK since case doesn't apply there).
function titleMatchesQuery(title, query) {
  const tokens = extractTokens(query);
  if (!tokens.length) return true;
  const normTitle = normalizeForMatch(title);
  return tokens.some(tok => normTitle.includes(normalizeForMatch(tok)));
}

function passesFallbackFilters(title, durationSeconds, query) {
  if (durationSeconds == null || durationSeconds < MIN_FALLBACK_DURATION_SEC || durationSeconds > MAX_FALLBACK_DURATION_SEC) return false;
  if (BLOCKED_FALLBACK_TITLE.test(title)) return false;
  if (!titleMatchesQuery(title, query)) return false;
  return true;
}

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) innertubePromise = Innertube.create();
  return innertubePromise;
}

// FIFO-evicted cache: videoId -> boolean (embeddable per YouTube Data API)
const embedCache = new Map();

function cacheGet(videoId) {
  return embedCache.get(videoId);
}

function cacheSet(videoId, value) {
  if (!embedCache.has(videoId) && embedCache.size >= EMBED_CACHE_LIMIT) {
    const oldestKey = embedCache.keys().next().value;
    embedCache.delete(oldestKey);
  }
  embedCache.set(videoId, value);
}

// Batched YouTube Data API v3 embeddability check. Not bound by the VPS's IP
// reputation the way youtubei.js's getInfo() is — this is an official, key-authed
// endpoint. Fails open (treats ids as embeddable) when the key is missing or the
// call errors, so a Data API outage never blocks a decision.
export async function checkEmbeddableBatch(videoIds) {
  const t0 = Date.now();
  const uniqueIds = [...new Set(videoIds.filter(Boolean))];
  const result = new Map();
  if (!uniqueIds.length) return result;

  const uncached = [];
  for (const id of uniqueIds) {
    const cached = cacheGet(id);
    if (cached !== undefined) result.set(id, cached);
    else uncached.push(id);
  }
  if (!uncached.length) {
    console.log(`[timing] embed_check_ms=${Date.now() - t0} ids=${uniqueIds.length} uncached=0 (all cached)`);
    return result;
  }

  if (!YOUTUBE_API_KEY) {
    console.warn(`[youtube] YOUTUBE_API_KEY not configured, skipping embeddability check for ${uncached.length} video(s)`);
    for (const id of uncached) result.set(id, true);
    return result;
  }

  for (let i = 0; i < uncached.length; i += DATA_API_BATCH_SIZE) {
    const batch = uncached.slice(i, i + DATA_API_BATCH_SIZE);
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails&id=${batch.join(',')}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(DATA_API_TIMEOUT_MS) });
      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[youtube] Data API videos.list failed (${res.status}): ${errText}, skipping check for this batch`);
        for (const id of batch) result.set(id, true);
        continue;
      }
      const data = await res.json();
      const found = new Set();
      for (const item of data.items || []) {
        found.add(item.id);
        const embeddable = item.status?.embeddable === true;
        const isPublic = item.status?.privacyStatus === 'public';
        const hasRegionRestriction = !!item.contentDetails?.regionRestriction;
        const ok = embeddable && isPublic && !hasRegionRestriction;
        result.set(item.id, ok);
        cacheSet(item.id, ok);
      }
      // ids the API didn't return at all (deleted/private/not found) count as not-ok
      for (const id of batch) {
        if (!found.has(id)) {
          result.set(id, false);
          cacheSet(id, false);
        }
      }
    } catch (e) {
      console.warn(`[youtube] Data API videos.list error: ${e.message}, skipping check for this batch`);
      for (const id of batch) result.set(id, true);
    }
  }

  console.log(`[timing] embed_check_ms=${Date.now() - t0} ids=${uniqueIds.length} uncached=${uncached.length}`);
  return result;
}

function orderByPreference(candidates) {
  return candidates
    .map((v, i) => {
      const ch = (v.channel || '').toLowerCase();
      const preferred = PREFERRED.some(kw => ch.includes(kw)) || (v.title || '').toLowerCase().includes('official');
      return { v, i, preferred };
    })
    .sort((a, b) => (b.preferred - a.preferred) || (a.i - b.i))
    .map(s => s.v);
}

function pickBest(candidates) {
  return orderByPreference(candidates)[0] || candidates[0];
}

export async function searchYTMusic(query) {
  const yt = await getInnertube();
  const search = await yt.music.search(query, { type: 'song' });
  const shelves = search.contents?.filterType(YTNodes.MusicShelf) || [];
  const items = shelves.flatMap(shelf => shelf.contents || []);
  const candidates = [];
  for (const item of items) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (item.item_type !== 'song') continue;
    const title = item.title || '';
    if (BLOCKED_TITLE.test(title)) continue;
    const videoId = item.id;
    const artist = item.artists?.[0]?.name || '';
    if (!videoId || !title) continue;
    candidates.push({ videoId, title, artist, source: 'ytmusic' });
  }
  return candidates;
}

async function searchVideosInnertube(yt, q, originalQuery) {
  const search = await yt.search(q, { type: 'video' });
  return search.results
    .filterType(YTNodes.Video)
    .filter(v => !v.is_live)
    .filter(v => passesFallbackFilters(v.title?.text || '', v.duration?.seconds ?? null, originalQuery))
    .map(v => ({ videoId: v.video_id, title: v.title?.text || '', channel: v.author?.name || '' }));
}

async function searchYouTubeInnertube(query) {
  const yt = await getInnertube();
  let videos = await searchVideosInnertube(yt, `${query} official audio`, query);
  if (!videos.length) videos = await searchVideosInnertube(yt, `${query} audio`, query);
  if (!videos.length) return [];
  return orderByPreference(videos).slice(0, MAX_CANDIDATES).map(v => ({ ...v, source: 'search' }));
}

async function searchVideosYtsr(q, originalQuery) {
  const results = await ytsr(q, { limit: 5 });
  return results.items
    .filter(i => i.type === 'video' && !i.isLive)
    .filter(i => passesFallbackFilters(i.title, parseDurationToSeconds(i.duration), originalQuery))
    .map(i => ({ videoId: i.id, title: i.title, channel: i.author?.name || '' }));
}

async function searchYouTubeYtsr(query) {
  let videos = await searchVideosYtsr(`${query} official audio`, query);
  if (!videos.length) videos = await searchVideosYtsr(`${query} audio`, query);
  if (!videos.length) return null;
  const best = pickBest(videos);
  return { ...best, source: 'ytsr', altIds: [best.videoId] };
}

// Picks the first embeddable candidate (in original order) for each still-unresolved
// song, using ONE batched Data API call across every candidate in this tier.
async function resolveTier(candidatesPerSong, winners, queries, tierLabel) {
  const allIds = [];
  candidatesPerSong.forEach((cands, i) => {
    if (winners[i]) return;
    cands.forEach(c => allIds.push(c.videoId));
  });
  if (!allIds.length) return;

  const embedMap = await checkEmbeddableBatch(allIds);

  candidatesPerSong.forEach((cands, i) => {
    if (winners[i] || !cands.length) return;
    const passing = cands.filter(c => embedMap.get(c.videoId) === true);
    const skipped = cands.length - passing.length;
    if (passing.length) {
      const altIds = passing.slice(0, MAX_ALT_IDS).map(c => c.videoId);
      winners[i] = { ...passing[0], altIds };
      console.log(`[youtube] ${tierLabel} "${queries[i]}": candidates=${cands.length} passed=${passing.length} skipped=${skipped} selected=${winners[i].videoId}`);
    } else {
      console.log(`[youtube] ${tierLabel} "${queries[i]}": candidates=${cands.length} passed=0 skipped=${skipped}, falling through`);
    }
  });
}

// Resolves one videoId per query, batching every tier's Data API embeddability
// checks across the whole decision (all songs at once) to minimize quota usage.
export async function resolveSongVideos(queries) {
  const tTotal = Date.now();
  const n = queries.length;
  const winners = new Array(n).fill(null);

  let t = Date.now();
  const tier1 = await Promise.all(queries.map(q => searchYTMusic(q).catch(() => [])));
  console.log(`[timing] yt_tier1_search_ms=${Date.now() - t} songs=${n}`);
  await resolveTier(tier1, winners, queries, 'ytmusic');

  const needTier2 = winners.map((w, i) => (w ? -1 : i)).filter(i => i !== -1);
  if (needTier2.length) {
    t = Date.now();
    const tier2Results = await Promise.all(needTier2.map(i => searchYouTubeInnertube(queries[i]).catch(() => [])));
    console.log(`[timing] yt_tier2_search_ms=${Date.now() - t} songs=${needTier2.length}`);
    const tier2 = new Array(n).fill(null).map(() => []);
    needTier2.forEach((songIdx, k) => { tier2[songIdx] = tier2Results[k]; });
    await resolveTier(tier2, winners, queries, 'search');
  }

  const needTier3 = winners.map((w, i) => (w ? -1 : i)).filter(i => i !== -1);
  if (needTier3.length) {
    t = Date.now();
    const tier3Results = await Promise.all(needTier3.map(i => searchYouTubeYtsr(queries[i]).catch(() => null)));
    console.log(`[timing] yt_tier3_search_ms=${Date.now() - t} songs=${needTier3.length}`);
    needTier3.forEach((songIdx, k) => {
      winners[songIdx] = tier3Results[k];
      console.log(`[youtube] ytsr "${queries[songIdx]}": selected=${winners[songIdx]?.videoId ?? 'none'} (unchecked fallback)`);
    });
  }

  console.log(`[timing] yt_resolve_total_ms=${Date.now() - tTotal} songs=${n}`);
  return winners;
}

export async function searchYouTube(query) {
  const [result] = await resolveSongVideos([query]);
  return result;
}
