const NCM_BASE = process.env.NCM_API_URL || 'http://localhost:3002';

export async function searchSong(query) {
  try {
    const res = await fetch(`${NCM_BASE}/search?keywords=${encodeURIComponent(query)}&limit=5`);
    const data = await res.json();
    const songs = data.result?.songs;
    if (!songs || songs.length === 0) return null;
    const song = songs[0];
    return {
      id: song.id,
      name: song.name,
      artist: song.artists?.map(a => a.name).join(', ') || '',
      album: song.album?.name || '',
    };
  } catch (e) {
    console.error('NCM search failed:', e.message);
    return null;
  }
}

export async function getSongUrl(songId) {
  try {
    const res = await fetch(`${NCM_BASE}/song/url/v1?id=${songId}&level=standard`);
    const data = await res.json();
    const url = data.data?.[0]?.url;
    return url || null;
  } catch (e) {
    console.error('NCM url failed:', e.message);
    return null;
  }
}

export async function resolveSong(query) {
  const song = await searchSong(query);
  if (!song) return null;
  const url = await getSongUrl(song.id);
  return { ...song, url };
}
