import ytsr from 'ytsr';

export async function searchYouTube(query) {
  try {
    const results = await ytsr(`${query} official audio`, { limit: 3 });
    const videos = results.items.filter(i => i.type === 'video');
    if (!videos.length) return null;

    const best = videos.find(v =>
      (v.author?.name || '').toLowerCase().includes('official') ||
      (v.author?.name || '').toLowerCase().includes('music') ||
      (v.author?.name || '').toLowerCase().includes('vevo') ||
      (v.title || '').toLowerCase().includes('official')
    ) || videos[0];

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
