// ── Audio ──────────────────────────────────────────────────────────────────
let currentAudio = null;

function playDJAudio(audioUrl) {
  if (!audioUrl) return;
  if (!currentAudio) currentAudio = new Audio();
  currentAudio.src = audioUrl;
  currentAudio.load();
  currentAudio.play().catch(e => console.log('replay failed:', e.message));
}

window.playDJAudio = playDJAudio;

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  user: null,
  view: 'auth',       // 'auth' | 'player' | 'profile'
  authTab: 'login',   // 'login' | 'register'
  profileTab: 'taste', // 'taste' | 'routines' | 'history'
  nowPlaying: null,
  loading: false,
  profileData: { taste: '', routines: '', history: [] },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(i18n.current === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Root render ────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('app');
  if (state.view === 'auth') {
    root.innerHTML = renderAuth();
  } else {
    root.innerHTML = renderShell();
    if (state.view === 'player') fillPlayer();
    else fillProfile();
  }
  attachEvents();
}

// ── Shell (topbar + bottomnav + view slot) ─────────────────────────────────
function renderShell() {
  const username = state.user ? esc(state.user.username) : '';
  return `
<div class="topbar">
  <span class="topbar-title">${esc(i18n.t('appName'))}</span>
  <div style="display:flex;align-items:center;gap:12px">
    ${username ? `<span class="topbar-user">${username}</span>` : ''}
    <button class="btn-lang" id="btn-lang">${esc(i18n.t('langToggle'))}</button>
  </div>
</div>
<div class="view" id="view-content"></div>
<nav class="bottomnav">
  <button class="nav-btn ${state.view === 'player' ? 'active' : ''}" id="nav-player">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16"/></svg>
    ${esc(i18n.t('player'))}
  </button>
  <button class="nav-btn ${state.view === 'profile' ? 'active' : ''}" id="nav-profile">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
    ${esc(i18n.t('profile'))}
  </button>
</nav>`;
}

// ── Auth view ──────────────────────────────────────────────────────────────
function renderAuth() {
  const isLogin = state.authTab === 'login';
  return `
<div class="view auth-view">
  <div class="topbar">
    <span class="topbar-title">${esc(i18n.t('appName'))}</span>
    <button class="btn-lang" id="btn-lang">${esc(i18n.t('langToggle'))}</button>
  </div>
  <div class="auth-logo">
    <h1>${esc(i18n.t('appName'))}</h1>
    <p>${esc(i18n.t('tagline'))}</p>
  </div>
  <div class="auth-tabs">
    <button class="auth-tab ${isLogin ? 'active' : ''}" id="tab-login">${esc(i18n.t('login'))}</button>
    <button class="auth-tab ${!isLogin ? 'active' : ''}" id="tab-register">${esc(i18n.t('register'))}</button>
  </div>
  ${isLogin ? renderLoginForm() : renderRegisterForm()}
</div>`;
}

function renderLoginForm() {
  return `
<form id="form-login" novalidate>
  <div class="form-group">
    <label>${esc(i18n.t('email'))}</label>
    <input type="email" id="login-email" autocomplete="email" />
  </div>
  <div class="form-group">
    <label>${esc(i18n.t('password'))}</label>
    <input type="password" id="login-password" autocomplete="current-password" />
  </div>
  <p class="error-msg" id="login-error" style="display:none"></p>
  <button type="submit" class="btn-primary" id="btn-login">${esc(i18n.t('loginBtn'))}</button>
</form>`;
}

function renderRegisterForm() {
  return `
<form id="form-register" novalidate>
  <div class="form-group">
    <label>${esc(i18n.t('username'))}</label>
    <input type="text" id="reg-username" autocomplete="username" />
    <div class="hint">${esc(i18n.t('usernameHint'))}</div>
  </div>
  <div class="form-group">
    <label>${esc(i18n.t('email'))}</label>
    <input type="email" id="reg-email" autocomplete="email" />
  </div>
  <div class="form-group">
    <label>${esc(i18n.t('password'))}</label>
    <input type="password" id="reg-password" autocomplete="new-password" />
    <div class="hint">${esc(i18n.t('passwordHint'))}</div>
  </div>
  <p class="error-msg" id="reg-error" style="display:none"></p>
  <button type="submit" class="btn-primary" id="btn-register">${esc(i18n.t('registerBtn'))}</button>
</form>`;
}

// ── Player view ────────────────────────────────────────────────────────────
function fillPlayer() {
  window._currentSongs = state.nowPlaying?.play || [];
  document.getElementById('view-content').innerHTML = renderPlayerContent();
  restorePlayerButtons();
}

function renderPlayerContent() {
  const np = state.nowPlaying;
  const djBlock = np
    ? `<div class="dj-card">
        <div class="dj-label">${esc(i18n.t('djSays'))}</div>
        <div class="dj-say">${esc(np.say || '')}</div>
        ${np.audioUrl ? `
          <button class="btn-replay" onclick="playDJAudio('${esc(np.audioUrl)}')">
            &#9654; ${i18n.t('replay')}
          </button>
        ` : ''}
        ${np.mood ? `<div class="dj-mood">mood: ${esc(np.mood)}</div>` : ''}
      </div>
      ${np.play && np.play.length ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <div class="songs-label">${esc(i18n.t('songs'))}</div>
          ${np.play.some(s => s.yt?.videoId) ? `<button class="btn-queue" id="btn-play-all" onclick="playAll()">&#9654; ${esc(i18n.t('playAll'))}</button>` : ''}
        </div>
        ${np.play.map((s, i) => renderSong(s, i)).join('')}
      ` : ''}`
    : `<div class="dj-card">
        <div class="dj-say" style="color:var(--muted)">${esc(i18n.t('noDecision'))}</div>
      </div>`;

  return `
<div class="ask-form">
  <textarea class="ask-input" id="ask-input" rows="1"
    placeholder="${esc(i18n.t('inputPlaceholder'))}"
  ></textarea>
  <button class="btn-ask" id="btn-ask" ${state.loading ? 'disabled' : ''}>
    ${state.loading ? esc(i18n.t('loading')) : esc(i18n.t('send'))}
  </button>
</div>
${state.loading ? `<div class="loading-text">${esc(i18n.t('loading'))}</div>` : djBlock}`;
}

function renderSong(s, idx) {
  const name = s.ncm?.name ? esc(s.ncm.name) : esc(s.song || s.query || '');
  const artist = s.ncm?.artist ? esc(s.ncm.artist) : esc(s.artist || '');
  const displayName = artist ? `${name} · ${artist}` : name;
  const rawName = s.ncm?.name || s.song || s.query || '';
  const rawArtist = s.ncm?.artist || s.artist || '';
  const rawQuery = rawArtist ? `${rawName} - ${rawArtist}` : rawName;

  let playerHtml;
  if (s.yt?.videoId) {
    const vid = esc(s.yt.videoId);
    const ch = esc(s.yt.channel || '');
    playerHtml = `
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
        <button class="btn-yt-play" id="yt-btn-${idx}" onclick="toggleYT(${idx}, '${vid}')">&#9654; Play</button>
        <span id="yt-indicator-${idx}" style="display:none;color:#e55;font-size:1rem;line-height:1">⏸</span>
        ${ch ? `<span style="font-size:0.8rem;color:#555">${ch}</span>` : ''}
      </div>`;
  } else {
    playerHtml = `<button style="margin-top:8px;font-size:0.78rem;padding:3px 8px;border:1px solid #444;background:transparent;color:#888;border-radius:4px;cursor:pointer"
      onclick="openYoutube('${esc(s.query || '')}')">YouTube &#8599;</button>`;
  }

  return `
<div class="song-item" style="flex-direction:column;align-items:stretch">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
    <div class="song-info">
      <div class="song-query">${displayName}</div>
      ${s.reason ? `<div class="song-reason"><span>${esc(i18n.t('whyThis'))}</span> ${esc(s.reason)}</div>` : ''}
    </div>
    <button class="btn-played" data-query="${esc(rawQuery)}"
      onclick="event.stopPropagation();markPlayed(this)">${esc(i18n.t('markPlayed'))}</button>
  </div>
  ${playerHtml}
</div>`;
}

// ── Profile view ───────────────────────────────────────────────────────────
function fillProfile() {
  document.getElementById('view-content').innerHTML = renderProfileContent();
}

function renderProfileContent() {
  const u = state.user || {};
  return `
<div class="profile-header">
  <div class="profile-username">${esc(u.username || '')}</div>
  <div class="profile-email">${esc(u.email || '')}</div>
  <button class="btn-logout" id="btn-logout">${esc(i18n.t('logout'))}</button>
</div>
<div class="profile-tabs">
  <button class="profile-tab ${state.profileTab === 'taste' ? 'active' : ''}" data-tab="taste">${esc(i18n.t('taste'))}</button>
  <button class="profile-tab ${state.profileTab === 'routines' ? 'active' : ''}" data-tab="routines">${esc(i18n.t('routines'))}</button>
  <button class="profile-tab ${state.profileTab === 'history' ? 'active' : ''}" data-tab="history">${esc(i18n.t('history'))}</button>
</div>
${renderProfileTab()}`;
}

function renderProfileTab() {
  if (state.profileTab === 'taste') {
    return `
<div>
  <div class="section-title">${esc(i18n.t('myTaste'))}</div>
  <div class="section-desc">${esc(i18n.t('tasteDesc'))}</div>
  <textarea class="profile-textarea" id="taste-input">${esc(state.profileData.taste)}</textarea>
  <div>
    <button class="btn-save" id="btn-save-taste">${esc(i18n.t('save'))}</button>
    <span class="save-confirm" id="taste-confirm" style="display:none">${esc(i18n.t('saved'))}</span>
  </div>
</div>`;
  }
  if (state.profileTab === 'routines') {
    return `
<div>
  <div class="section-title">${esc(i18n.t('myRoutines'))}</div>
  <div class="section-desc">${esc(i18n.t('routinesDesc'))}</div>
  <textarea class="profile-textarea" id="routines-input">${esc(state.profileData.routines)}</textarea>
  <div>
    <button class="btn-save" id="btn-save-routines">${esc(i18n.t('save'))}</button>
    <span class="save-confirm" id="routines-confirm" style="display:none">${esc(i18n.t('saved'))}</span>
  </div>
</div>`;
  }
  // history
  const plays = state.profileData.history;
  if (!plays || plays.length === 0) {
    return `<div class="no-history">${esc(i18n.t('noHistory'))}</div>`;
  }
  return `<div class="history-list">
    ${plays.map(p => `
    <div class="history-item">
      <div>
        <div class="history-song">${esc(p.song_name || '—')}</div>
        <div class="history-artist">${esc(p.artist || '')}</div>
      </div>
      <div class="history-time">${fmtTime(p.played_at)}</div>
    </div>`).join('')}
  </div>`;
}

// ── Event wiring ───────────────────────────────────────────────────────────
function attachEvents() {
  // Language toggle (exists in both auth and shell)
  const btnLang = document.getElementById('btn-lang');
  if (btnLang) {
    btnLang.addEventListener('click', () => {
      i18n.toggle();
      render();
    });
  }

  if (state.view === 'auth') {
    attachAuthEvents();
  } else {
    // Nav
    document.getElementById('nav-player')?.addEventListener('click', () => {
      state.view = 'player';
      render();
    });
    document.getElementById('nav-profile')?.addEventListener('click', async () => {
      state.view = 'profile';
      await loadProfileData();
      render();
    });

    if (state.view === 'player') attachPlayerEvents();
    if (state.view === 'profile') attachProfileEvents();
  }
}

function attachAuthEvents() {
  document.getElementById('tab-login')?.addEventListener('click', () => {
    state.authTab = 'login';
    render();
  });
  document.getElementById('tab-register')?.addEventListener('click', () => {
    state.authTab = 'register';
    render();
  });

  document.getElementById('form-login')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('btn-login');

    if (!email || !password) {
      showError(errEl, i18n.t('errorRequired'));
      return;
    }
    btn.disabled = true;
    errEl.style.display = 'none';
    try {
      const data = await api.login(email, password);
      api.setToken(data.token);
      state.user = { uid: data.uid, username: data.username };
      state.view = 'player';
      await loadNowPlaying();
      render();
    } catch (err) {
      showError(errEl, err.message || i18n.t('errorServer'));
      btn.disabled = false;
    }
  });

  document.getElementById('form-register')?.addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl = document.getElementById('reg-error');
    const btn = document.getElementById('btn-register');

    if (!username || !email || !password) {
      showError(errEl, i18n.t('errorRequired'));
      return;
    }
    btn.disabled = true;
    errEl.style.display = 'none';
    try {
      await api.register(email, password, username);
      // auto-login after register
      const data = await api.login(email, password);
      api.setToken(data.token);
      state.user = { uid: data.uid, username: data.username };
      state.view = 'player';
      await loadNowPlaying();
      render();
    } catch (err) {
      showError(errEl, err.message || i18n.t('errorServer'));
      btn.disabled = false;
    }
  });
}

function attachPlayerEvents() {
  const input = document.getElementById('ask-input');
  const btn = document.getElementById('btn-ask');

  // Auto-resize textarea
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Submit on Enter (Shift+Enter = newline)
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btn?.click();
    }
  });

  btn?.addEventListener('click', async () => {
    const msg = input?.value.trim() || '';
    if (state.loading) return;

    // Unlock audio in the synchronous click stack — must happen before any await
    if (!currentAudio) {
      currentAudio = new Audio();
      currentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      currentAudio.play().catch(() => {});
    }

    state.loading = true;
    fillPlayer();
    attachPlayerEvents();
    try {
      const decision = await api.decide(msg);
      state.nowPlaying = decision;
      if (input) input.value = '';
    } catch (err) {
      console.error(err);
    } finally {
      state.loading = false;
      resetPlayerState();
      fillPlayer();
      attachPlayerEvents();
      // Play on the already-unlocked Audio object
      if (state.nowPlaying?.audioUrl && currentAudio) {
        currentAudio.src = state.nowPlaying.audioUrl;
        currentAudio.load();
        currentAudio.play().catch(e => console.log('play failed:', e.message));
      }
    }
  });

}

function attachProfileEvents() {
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    api.clearToken();
    state.user = null;
    state.nowPlaying = null;
    state.view = 'auth';
    state.authTab = 'login';
    render();
  });

  document.querySelectorAll('.profile-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      state.profileTab = tab.dataset.tab;
      if (state.profileTab === 'history') await loadHistory();
      fillProfile();
      attachProfileEvents();
    });
  });

  document.getElementById('btn-save-taste')?.addEventListener('click', async () => {
    const content = document.getElementById('taste-input')?.value || '';
    const btn = document.getElementById('btn-save-taste');
    const confirm = document.getElementById('taste-confirm');
    btn.disabled = true;
    try {
      await api.saveTaste(content);
      state.profileData.taste = content;
      confirm.style.display = 'inline-block';
      setTimeout(() => { confirm.style.display = 'none'; }, 2000);
    } catch (err) {
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-save-routines')?.addEventListener('click', async () => {
    const content = document.getElementById('routines-input')?.value || '';
    const btn = document.getElementById('btn-save-routines');
    const confirm = document.getElementById('routines-confirm');
    btn.disabled = true;
    try {
      await api.saveRoutines(content);
      state.profileData.routines = content;
      confirm.style.display = 'inline-block';
      setTimeout(() => { confirm.style.display = 'none'; }, 2000);
    } catch (err) {
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadNowPlaying() {
  try {
    state.nowPlaying = await api.now();
  } catch {
    state.nowPlaying = null;
  }
}

async function loadProfileData() {
  try {
    const [taste, routines, profile] = await Promise.all([
      api.getTaste(),
      api.getRoutines(),
      api.getProfile(),
    ]);
    state.profileData.taste = taste.content || '';
    state.profileData.routines = routines.content || '';
    if (profile) {
      state.user = { ...state.user, email: profile.email, username: profile.username };
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadHistory() {
  try {
    const data = await api.getHistory();
    state.profileData.history = data.plays || [];
  } catch (err) {
    console.error(err);
  }
}

// ── Global handlers (survive DOM re-renders) ───────────────────────────────
window.openYoutube = function(query) {
  window.open('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), '_blank');
};

let currentPlayingIndex = null;
let currentIframePaused = false;
let ytApiReady = false;
const ytPlayers = {};

window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
};

// ── Queue ──────────────────────────────────────────────────────────────────
let playQueue = [];
let playQueueIndex = -1;

function stopAllPlayers() {
  if (currentPlayingIndex !== null) {
    stopAudio(currentPlayingIndex);
    currentPlayingIndex = null;
    currentIframePaused = false;
  }
}

function resetPlayerState() {
  Object.keys(ytPlayers).forEach(idx => {
    try { ytPlayers[idx].destroy(); } catch(e) {}
    delete ytPlayers[idx];
  });
  document.querySelectorAll('[id^="yt-container-"]').forEach(el => el.remove());
  playQueue = [];
  playQueueIndex = -1;
  currentPlayingIndex = null;
  currentIframePaused = false;
  window._currentSongs = [];
  updateQueueButtons();
}

function updateQueueButtons() {
  const btn = document.getElementById('btn-play-all');
  if (btn) {
    const queueActive = playQueue.length > 0 && playQueueIndex >= 0;
    const hasNext = queueActive && playQueueIndex < playQueue.length - 1;
    btn.textContent = queueActive ? i18n.t('next') + ' ▶' : '▶ ' + i18n.t('playAll');
    btn.disabled = queueActive && !hasNext;
    btn.style.opacity = (queueActive && !hasNext) ? '0.4' : '1';
  }
}

function playFromQueue() {
  if (playQueueIndex < 0 || playQueueIndex >= playQueue.length) {
    playQueue = [];
    playQueueIndex = -1;
    updateQueueButtons();
    return;
  }
  const song = playQueue[playQueueIndex];
  const videoId = song?.yt?.videoId;
  if (!videoId) {
    playQueueIndex++;
    playFromQueue();
    return;
  }
  updateQueueButtons();
  window.toggleYT(playQueueIndex, videoId);
}

window.playAll = function() {
  const songs = window._currentSongs;
  if (!songs?.length) return;
  // Queue already active → treat button click as Next
  if (playQueue.length > 0 && playQueueIndex >= 0) {
    window.playNext();
    return;
  }
  if (!ytApiReady) { setTimeout(window.playAll, 500); return; }
  Object.keys(ytPlayers).forEach(idx => {
    try { ytPlayers[idx].destroy(); } catch(e) {}
    delete ytPlayers[idx];
  });
  document.querySelectorAll('button[id^="yt-btn-"]').forEach(b => { b.textContent = '▶ Play'; });
  document.querySelectorAll('span[id^="yt-indicator-"]').forEach(s => { s.style.display = 'none'; });
  currentPlayingIndex = null;
  playQueue = songs.slice();
  playQueueIndex = 0;
  playFromQueue();
};

window.playNext = function() {
  if (playQueue.length === 0) {
    console.log('[Next] No queue active');
    return;
  }
  console.log('[Next] Current index:', playQueueIndex, '→', playQueueIndex + 1);
  if (currentPlayingIndex !== null && ytPlayers[currentPlayingIndex]) {
    try { ytPlayers[currentPlayingIndex].destroy(); } catch(e) {}
    delete ytPlayers[currentPlayingIndex];
    const oldBtn = document.getElementById('yt-btn-' + currentPlayingIndex);
    if (oldBtn) oldBtn.textContent = '▶ Play';
    currentPlayingIndex = null;
  }
  playQueueIndex++;
  playFromQueue();
};

// ── MediaSession ───────────────────────────────────────────────────────────
function updateMediaSession(title, artist) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: 'Claudio' });
  navigator.mediaSession.setActionHandler('nexttrack', () => window.playNext());
  navigator.mediaSession.setActionHandler('pause', () => {
    if (currentPlayingIndex !== null && ytPlayers[currentPlayingIndex]) {
      try { ytPlayers[currentPlayingIndex].pauseVideo(); } catch(e) {}
    }
  });
  navigator.mediaSession.setActionHandler('play', () => {
    if (currentPlayingIndex !== null && ytPlayers[currentPlayingIndex]) {
      try { ytPlayers[currentPlayingIndex].playVideo(); } catch(e) {}
    }
  });
}

function stopAudio(index) {
  if (ytPlayers[index]) {
    try { ytPlayers[index].destroy(); } catch(e) {}
    delete ytPlayers[index];
  }
  const div = document.getElementById('yt-container-' + index);
  if (div) div.remove();
  const btn = document.getElementById('yt-btn-' + index);
  const indicator = document.getElementById('yt-indicator-' + index);
  if (btn) btn.textContent = '▶ Play';
  if (indicator) indicator.style.display = 'none';
}

function restorePlayerButtons() {
  if (currentPlayingIndex === null || !ytPlayers[currentPlayingIndex]) return;
  const btn = document.getElementById('yt-btn-' + currentPlayingIndex);
  const indicator = document.getElementById('yt-indicator-' + currentPlayingIndex);
  try {
    const s = ytPlayers[currentPlayingIndex].getPlayerState();
    const playing = ytApiReady && s === YT.PlayerState.PLAYING;
    if (btn) btn.textContent = playing ? '⏸ Pause' : '▶ Play';
    if (indicator) indicator.style.display = playing ? 'none' : 'inline';
  } catch(e) {}
}

function createYTPlayer(index, videoId) {
  if (!ytApiReady) {
    setTimeout(() => createYTPlayer(index, videoId), 500);
    return;
  }
  const container = document.getElementById('audio-container');
  if (!container) return;
  if (ytPlayers[index]) {
    try { ytPlayers[index].destroy(); } catch(e) {}
    delete ytPlayers[index];
  }
  const oldDiv = document.getElementById('yt-container-' + index);
  if (oldDiv) oldDiv.remove();
  const div = document.createElement('div');
  div.id = 'yt-container-' + index;
  container.appendChild(div);
  ytPlayers[index] = new YT.Player('yt-container-' + index, {
    height: '180',
    width: '320',
    videoId: videoId,
    playerVars: { autoplay: 1, controls: 0, modestbranding: 1, rel: 0, playsinline: 1 },
    events: {
      onReady: function(e) {
        e.target.playVideo();
        const song = window._currentSongs?.[index];
        updateMediaSession(
          song?.ncm?.name || song?.song || song?.query || '',
          song?.ncm?.artist || song?.artist || ''
        );
      },
      onStateChange: function(e) {
        const btn = document.getElementById('yt-btn-' + index);
        const indicator = document.getElementById('yt-indicator-' + index);
        if (e.data === YT.PlayerState.PLAYING) {
          if (btn) btn.textContent = '⏸ Pause';
          if (indicator) indicator.style.display = 'none';
        }
        if (e.data === YT.PlayerState.PAUSED) {
          if (btn) btn.textContent = '▶ Play';
          if (indicator) indicator.style.display = 'inline';
        }
        if (e.data === YT.PlayerState.ENDED) {
          if (btn) btn.textContent = '▶ Play';
          if (indicator) indicator.style.display = 'none';
          currentPlayingIndex = null;
          if (playQueueIndex === index) {
            setTimeout(() => { playQueueIndex++; playFromQueue(); }, 800);
          }
        }
      },
    },
  });
}

window.toggleYT = function(index, videoId) {
  const btn = document.getElementById('yt-btn-' + index);
  const indicator = document.getElementById('yt-indicator-' + index);
  if (currentPlayingIndex === index && ytPlayers[index]) {
    try {
      const s = ytPlayers[index].getPlayerState();
      if (s === YT.PlayerState.PLAYING) {
        ytPlayers[index].pauseVideo();
        if (btn) btn.textContent = '▶ Play';
        if (indicator) indicator.style.display = 'inline';
      } else {
        ytPlayers[index].playVideo();
        if (btn) btn.textContent = '⏸ Pause';
        if (indicator) indicator.style.display = 'none';
      }
    } catch(e) {}
    return;
  }
  Object.keys(ytPlayers).forEach(idx => {
    const i = parseInt(idx);
    if (i !== index) {
      try { ytPlayers[i].destroy(); } catch(e) {}
      delete ytPlayers[i];
      const oldDiv = document.getElementById('yt-container-' + i);
      if (oldDiv) oldDiv.remove();
      const oldBtn = document.getElementById('yt-btn-' + i);
      const oldInd = document.getElementById('yt-indicator-' + i);
      if (oldBtn) oldBtn.textContent = '▶ Play';
      if (oldInd) oldInd.style.display = 'none';
    }
  });
  currentPlayingIndex = index;
  currentIframePaused = false;
  if (btn) btn.textContent = '⏸ Pause';
  if (indicator) indicator.style.display = 'none';
  createYTPlayer(index, videoId);
};

window.markPlayed = async function(btn) {
  btn.disabled = true;
  btn.textContent = '✓';
  btn.style.opacity = '0.4';
  const query = btn.dataset.query || '';
  const dashIdx = query.indexOf(' - ');
  const song_name = dashIdx !== -1 ? query.slice(0, dashIdx).trim() : query;
  const artist = dashIdx !== -1 ? query.slice(dashIdx + 3).trim() : '';
  try {
    await api.played(song_name, artist, '');
  } catch (e) {
    // silent fail — button stays disabled
  }
};

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  const token = api.getToken();
  if (token) {
    try {
      const me = await api.me();
      state.user = { uid: me.uid, username: me.username, email: me.email };
      state.view = 'player';
      await loadNowPlaying();
    } catch {
      api.clearToken();
      state.view = 'auth';
    }
  }
  render();
}

// Service Worker registration — auto-reload when new SW takes over
if ('serviceWorker' in navigator) {
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!swRefreshing) {
      swRefreshing = true;
      window.location.reload();
    }
  });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.ready.then(reg => {
    setInterval(() => reg.active?.postMessage({ type: 'keepalive' }), 25000);
  });
}

boot();
