import ytsr from 'ytsr';

const PREFERRED = ['official', 'music', 'vevo', 'topic'];

function pickBest(videos) {
  return videos.find(v => {
    const ch = (v.author?.name || '').toLowerCase();
    return PREFERRED.some(kw => ch.includes(kw)) ||
      (v.title || '').toLowerCase().includes('official');
  }) || videos[0];
}

async function searchVideos(q) {
  const results = await ytsr(q, { limit: 5 });
  return results.items.filter(i => i.type === 'video' && !i.isLive);
}

export async function searchYouTube(query) {
  try {
    let videos = await searchVideos(`${query} official audio`);
    if (!videos.length) videos = await searchVideos(`${query} audio`);
    if (!videos.length) return null;

    const best = pickBest(videos);
    return {
      videoId: best.id,
      title: best.title,
      channel: best.author?.name || '',
    };
  } catch (e) {
    console.error('YouTube search failed:', e.message);
    return null;
  }
}
