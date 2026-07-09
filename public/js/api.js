const api = {
  getToken() { return localStorage.getItem('claudio_token'); },
  setToken(t) { localStorage.setItem('claudio_token', t); },
  clearToken() { localStorage.removeItem('claudio_token'); },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      mlog('fetch error: ' + err.message);
      throw err;
    }
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401 && data.code === 'SESSION_REVOKED') {
        this.clearToken();
        alert(i18n.t('sessionRevoked'));
        if (typeof state !== 'undefined') {
          state.user = null;
          state.nowPlaying = null;
          state.view = 'auth';
          state.authTab = 'login';
        }
        if (typeof render === 'function') render();
      }
      throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, code: data.code });
    }
    return data;
  },

  // Auth
  register(email, password, username) {
    return this.request('POST', '/api/auth/register', { email, password, username });
  },
  login(email, password) {
    return this.request('POST', '/api/auth/login', { email, password });
  },
  me() {
    return this.request('GET', '/api/auth/me');
  },
  logout() {
    return this.request('POST', '/api/auth/logout');
  },

  // Radio
  decide(message) {
    return this.request('POST', '/api/radio/decide', { message });
  },
  now() {
    return this.request('GET', '/api/radio/now');
  },
  played(song_name, artist, song_id) {
    return this.request('POST', '/api/radio/played', { song_name, artist, song_id: song_id || null });
  },

  // Profile
  getTaste() { return this.request('GET', '/api/profile/taste'); },
  saveTaste(content) { return this.request('PUT', '/api/profile/taste', { content }); },
  getRoutines() { return this.request('GET', '/api/profile/routines'); },
  saveRoutines(content) { return this.request('PUT', '/api/profile/routines', { content }); },
  getHistory() { return this.request('GET', '/api/profile/history'); },
  getProfile() { return this.request('GET', '/api/profile/me'); },
  getKeys() { return this.request('GET', '/api/profile/keys'); },
  saveKeys(payload) { return this.request('PUT', '/api/profile/keys', payload); },
  getVoices() { return this.request('GET', '/api/profile/voices'); },
  saveVoice(voice) { return this.request('PUT', '/api/profile/voice', { voice }); },
  previewVoice(voice) { return this.request('POST', '/api/profile/voice/preview', { voice }); },
};
