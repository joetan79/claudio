import ytsr from 'ytsr';
import { Innertube, YTNodes } from 'youtubei.js';

const PREFERRED = ['official', 'music', 'vevo', 'topic'];
const BLOCKED_TITLE = /cover|翻唱|remix|live|现场|伴奏|instrumental|karaoke/i;
const MAX_CANDIDATES = 5;
const EMBED_CHECK_TIMEOUT_MS = 4000;
const EMBED_CACHE_LIMIT = 500;

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) innertubePromise = Innertube.create();
  return innertubePromise;
}

// FIFO-evicted cache: videoId -> boolean (embeddable & playable)
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

export async function checkEmbeddable(videoId) {
  const cached = cacheGet(videoId);
  if (cached !== undefined) return cached;

  let ok = false;
  try {
    const yt = await getInnertube();
    const info = await Promise.race([
      yt.getInfo(videoId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getInfo timeout')), EMBED_CHECK_TIMEOUT_MS)),
    ]);
    const status = info.playability_status;
    ok = status?.status === 'OK' && status?.embeddable !== false;
  } catch (e) {
    ok = false;
  }

  cacheSet(videoId, ok);
  return ok;
}

// Concurrently checks all candidates, then returns the first one (in original order)
// that passed the embeddability check.
async function pickEmbeddable(candidates, sourceLabel, query) {
  if (!candidates.length) return null;
  const results = await Promise.all(
    candidates.map(async (c) => ({ candidate: c, ok: await checkEmbeddable(c.videoId) }))
  );
  const picked = results.find(r => r.ok)?.candidate ?? null;
  const skipped = results.filter(r => !r.ok).length;
  console.log(`[youtube] ${sourceLabel} "${query}": selected ${picked?.videoId ?? 'none'}, skipped ${skipped} not-embeddable`);
  return picked;
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

async function searchVideosInnertube(yt, q) {
  const search = await yt.search(q, { type: 'video' });
  return search.results
    .filterType(YTNodes.Video)
    .filter(v => !v.is_live)
    .map(v => ({ videoId: v.video_id, title: v.title?.text || '', channel: v.author?.name || '' }));
}

async function searchYouTubeInnertube(query) {
  const yt = await getInnertube();
  let videos = await searchVideosInnertube(yt, `${query} official audio`);
  if (!videos.length) videos = await searchVideosInnertube(yt, `${query} audio`);
  if (!videos.length) return [];
  return orderByPreference(videos).slice(0, MAX_CANDIDATES).map(v => ({ ...v, source: 'search' }));
}

async function searchVideosYtsr(q) {
  const results = await ytsr(q, { limit: 5 });
  return results.items
    .filter(i => i.type === 'video' && !i.isLive)
    .map(i => ({ videoId: i.id, title: i.title, channel: i.author?.name || '' }));
}

async function searchYouTubeYtsr(query) {
  let videos = await searchVideosYtsr(`${query} official audio`);
  if (!videos.length) videos = await searchVideosYtsr(`${query} audio`);
  if (!videos.length) return null;
  return { ...pickBest(videos), source: 'ytsr' };
}

export async function searchYouTube(query) {
  try {
    const candidates = await searchYTMusic(query);
    if (candidates.length) {
      const picked = await pickEmbeddable(candidates, 'ytmusic', query);
      if (picked) return picked;
      console.warn(`[youtube] all YT Music candidates for "${query}" failed embeddability check, falling back to youtubei.js search`);
    } else {
      console.warn(`[youtube] YT Music returned no results for "${query}", falling back to youtubei.js search`);
    }
  } catch (e) {
    console.warn(`[youtube] YT Music search failed for "${query}" (${e.message}), falling back to youtubei.js search`);
  }

  try {
    const candidates = await searchYouTubeInnertube(query);
    if (candidates.length) {
      const picked = await pickEmbeddable(candidates, 'search', query);
      if (picked) return picked;
      console.warn(`[youtube] all youtubei.js candidates for "${query}" failed embeddability check, falling back to ytsr`);
    } else {
      console.warn(`[youtube] youtubei.js returned no results for "${query}", falling back to ytsr`);
    }
  } catch (e) {
    console.warn(`[youtube] youtubei.js search failed for "${query}" (${e.message}), falling back to ytsr`);
  }

  try {
    return await searchYouTubeYtsr(query);
  } catch (e) {
    console.error('YouTube search failed:', e.message);
    return null;
  }
}
