import ytsr from 'ytsr';
import { Innertube, YTNodes } from 'youtubei.js';

const PREFERRED = ['official', 'music', 'vevo', 'topic'];

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) innertubePromise = Innertube.create();
  return innertubePromise;
}

function pickBest(candidates) {
  return candidates.find(v => {
    const ch = (v.channel || '').toLowerCase();
    return PREFERRED.some(kw => ch.includes(kw)) ||
      (v.title || '').toLowerCase().includes('official');
  }) || candidates[0];
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
  if (!videos.length) return null;
  return pickBest(videos);
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
  return pickBest(videos);
}

export async function searchYouTube(query) {
  try {
    const result = await searchYouTubeInnertube(query);
    if (result) return result;
    console.warn(`[youtube] youtubei.js returned no results for "${query}", falling back to ytsr`);
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
