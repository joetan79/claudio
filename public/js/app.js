// ── Debug overlay ──────────────────────────────────────────────────────────
const _debugMode = new URLSearchParams(window.location.search).get('debug') === '1';
const _debugLines = [];
let _debugEl = null;

if (_debugMode) {
  _debugEl = document.createElement('div');
  _debugEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.75);color:#0f0;font-size:11px;font-family:monospace;max-height:200px;overflow-y:scroll;padding:4px 8px;line-height:1.4;white-space:pre-wrap;word-break:break-all';
  document.body.appendChild(_debugEl);
}

function mlog(...args) {
  console.log(...args);
  if (!_debugMode) return;
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  _debugLines.push(ts + ' ' + msg);
  if (_debugLines.length > 10) _debugLines.shift();
  if (_debugEl) {
    _debugEl.textContent = _debugLines.join('\n');
    _debugEl.scrollTop = _debugEl.scrollHeight;
  }
}

{
  const ytScript = document.querySelector('script[src*="youtube.com/iframe_api"]');
  if (ytScript) ytScript.addEventListener('load', () => mlog('YT script injected'));
}

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
  profileTab: 'taste', // 'taste' | 'routines' | 'history' | 'keys' | 'voice'
  nowPlaying: null,
  loading: false,
  error: null,
  profileData: {
    taste: '', routines: '', history: [],
    keys: { key: null, provider: 'anthropic', model: '' },
    voices: { voices: [], current: null },
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const stripSSML = s => s.replace(/<[^>]*>/g, '');

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
    <button class="btn-download-app" id="btn-download-app" title="${esc(i18n.t('downloadApp'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
    </button>
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
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-download-app" id="btn-download-app" title="${esc(i18n.t('downloadApp'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
      </button>
      <button class="btn-lang" id="btn-lang">${esc(i18n.t('langToggle'))}</button>
    </div>
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
  window._currentSongs = (state.nowPlaying?.play || []).filter(s => s.yt?.videoId);
  document.getElementById('view-content').innerHTML = renderPlayerContent();
  restorePlayerButtons();
  if (isIOS && !localStorage.getItem('ios_hint_shown')) {
    const djCard = document.querySelector('.dj-card');
    if (djCard) djCard.insertAdjacentHTML('afterend', `<div id="ios-hint" style="background:#c8a96e22;border:1px solid #c8a96e;border-radius:8px;padding:10px 14px;margin:8px 0;color:#c8a96e;font-size:13px;display:flex;justify-content:space-between;align-items:center;"><span>💡 iOS tip: tap Play twice to start a song</span><button onclick="document.getElementById('ios-hint').remove();localStorage.setItem('ios_hint_shown','1')" style="background:none;border:none;color:#c8a96e;font-size:18px;cursor:pointer">×</button></div>`);
  }
}

function renderPlayerContent() {
  const np = state.nowPlaying;
  const djBlock = np
    ? `<div class="dj-card">
        <div class="dj-label">${esc(i18n.t('djSays'))}</div>
        <div class="dj-say">${esc(stripSSML(np.say || ''))}</div>
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
${state.error ? `<div class="dj-error">${esc(state.error)}</div>` : ''}
${state.loading ? `<div class="loading-text">${esc(i18n.t('loading'))}</div>` : djBlock}`;
}

function renderSong(s, idx) {
  const rawName = s.song_name || s.ncm?.name || s.song || s.query || '';
  const rawArtist = s.artist || s.ncm?.artist || '';
  const name = esc(rawName);
  const artist = esc(rawArtist);
  const displayName = artist ? `${name} · ${artist}` : name;

  mlog('song', idx, 'videoId:', s.yt?.videoId);
  let playerHtml;
  if (s.yt?.videoId) {
    const vid = esc(s.yt.videoId);
    const ch = esc(s.yt.channel || '');
    playerHtml = `
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
        <button class="btn-yt-play" id="yt-btn-${idx}" onclick="toggleYT(${idx}, '${vid}')">&#9654; Play</button>
        <span id="yt-indicator-${idx}" style="display:none;color:#e55;font-size:1rem;line-height:1">⏸</span>
        ${ch ? `<span style="font-size:0.8rem;color:#555">${ch}</span>` : ''}
      </div>
`;
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
    <button class="btn-played" id="played-btn-${idx}" data-name="${esc(rawName)}" data-artist="${esc(rawArtist)}"
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
  <button class="profile-tab ${state.profileTab === 'keys' ? 'active' : ''}" data-tab="keys">${esc(i18n.t('apiKeys'))}</button>
  <button class="profile-tab ${state.profileTab === 'voice' ? 'active' : ''}" data-tab="voice">${esc(i18n.t('djVoice'))}</button>
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
  if (state.profileTab === 'keys') {
    const k = state.profileData.keys || {};
    const provider = k.provider || 'anthropic';
    return `
<div>
  <div class="section-title">${esc(i18n.t('apiKeys'))}</div>
  <div class="section-desc">${esc(i18n.t('apiKeysDesc'))}</div>

  <div class="form-group">
    <label>${esc(i18n.t('aiProvider'))}</label>
    <select id="ai-provider-select">
      <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
      <option value="openrouter" ${provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
    </select>
  </div>
  <div class="form-group">
    <label>${esc(i18n.t('aiKey'))}</label>
    <div class="key-current">${esc(i18n.t('keyCurrentLabel'))} ${k.key ? esc(k.key) : esc(i18n.t('keyNotSet'))}</div>
    <input type="text" id="ai-key-input" placeholder="sk-..." autocomplete="off" spellcheck="false" />
  </div>
  <div class="form-group">
    <label>${esc(i18n.t('aiModel'))}</label>
    <input type="text" id="ai-model-input" placeholder="${esc(i18n.t('aiModelPlaceholder'))}"
      value="${esc(k.model || '')}" autocomplete="off" spellcheck="false" />
  </div>
  <div class="key-row">
    <button class="btn-save" id="btn-save-ai-key">${esc(i18n.t('save'))}</button>
    <button class="btn-clear" id="btn-clear-ai-key">${esc(i18n.t('clearKey'))}</button>
    <span class="save-confirm" id="ai-key-confirm" style="display:none"></span>
  </div>
</div>`;
  }
  if (state.profileTab === 'voice') {
    const v = state.profileData.voices || { voices: [], current: null };
    return `
<div>
  <div class="section-title">${esc(i18n.t('djVoice'))}</div>
  <div class="section-desc">${esc(i18n.t('djVoiceDesc'))}</div>
  <div class="voice-list">
    ${v.voices.map(voice => `
    <div class="voice-option">
      <label class="voice-radio-label">
        <input type="radio" name="dj-voice" value="${esc(voice.id)}" ${voice.id === v.current ? 'checked' : ''} />
        <span>${esc(voice.name)}</span>
      </label>
      <button class="btn-preview" data-voice="${esc(voice.id)}">${esc(i18n.t('preview'))}</button>
    </div>`).join('')}
  </div>
  <span class="save-confirm" id="voice-confirm" style="display:none">${esc(i18n.t('saved'))}</span>
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

  // Download app (exists in both auth and shell)
  document.getElementById('btn-download-app')?.addEventListener('click', () => {
    window.open('/download.html', '_blank');
  });

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
    state.error = null;
    fillPlayer();
    attachPlayerEvents();
    try {
      const decision = await api.decide(msg);
      if (decision.play?.some(s => !s.yt?.videoId)) {
        decision.play = await ensureVideoIds(decision.play, decision.mood);
      }
      state.nowPlaying = decision;
      if (input) input.value = '';
    } catch (err) {
      console.error(err);
      if (err.code === 'OWN_KEY_INVALID') state.error = i18n.t('ownKeyInvalid');
      else if (err.code === 'AI_KEY_REQUIRED') state.error = i18n.t('aiKeyRequired');
      else state.error = err.message || i18n.t('errorServer');
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
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try { await api.logout(); } catch {}
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
      if (state.profileTab === 'keys') await loadKeys();
      if (state.profileTab === 'voice') await loadVoices();
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

  document.getElementById('btn-save-ai-key')?.addEventListener('click', async () => {
    const key = document.getElementById('ai-key-input')?.value.trim() || '';
    const provider = document.getElementById('ai-provider-select')?.value || 'anthropic';
    const model = document.getElementById('ai-model-input')?.value.trim() || '';
    const btn = document.getElementById('btn-save-ai-key');
    btn.disabled = true;
    try {
      const payload = { provider, model };
      if (key) payload.key = key;
      await api.saveKeys(payload);
      await loadKeys();
      fillProfile();
      attachProfileEvents();
      const confirm = document.getElementById('ai-key-confirm');
      if (confirm) {
        confirm.textContent = i18n.t('keySaved');
        confirm.style.display = 'inline-block';
        setTimeout(() => { confirm.style.display = 'none'; }, 2000);
      }
    } catch (err) {
      alert(err.message || i18n.t('errorServer'));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-clear-ai-key')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-clear-ai-key');
    btn.disabled = true;
    try {
      await api.saveKeys({ key: '' });
      await loadKeys();
      fillProfile();
      attachProfileEvents();
    } catch (err) {
      alert(err.message || i18n.t('errorServer'));
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('input[name="dj-voice"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const voiceId = radio.value;
      try {
        await api.saveVoice(voiceId);
        state.profileData.voices.current = voiceId;
        const confirm = document.getElementById('voice-confirm');
        if (confirm) {
          confirm.style.display = 'inline-block';
          setTimeout(() => { confirm.style.display = 'none'; }, 2000);
        }
      } catch (err) {
        alert(err.message || i18n.t('errorServer'));
      }
    });
  });

  document.querySelectorAll('.btn-preview').forEach(btn => {
    btn.addEventListener('click', async () => {
      const voiceId = btn.dataset.voice;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = i18n.t('previewing');
      try {
        const data = await api.previewVoice(voiceId);
        if (data.audioUrl) playDJAudio(data.audioUrl);
      } catch (err) {
        alert(err.message || i18n.t('errorServer'));
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Data loading ───────────────────────────────────────────────────────────
async function ensureVideoIds(songs, mood) {
  if (!songs?.length) return [];
  const result = await Promise.all(songs.map(async (song) => {
    if (song.yt?.videoId) return song;
    const artist = song.ncm?.artist || song.artist || '';
    const fallbacks = [
      artist ? `${artist} popular` : null,
      artist ? `${artist} music` : null,
      mood ? `${mood} playlist` : null,
    ].filter(Boolean);
    for (const q of fallbacks) {
      try {
        const data = await api.request('GET', '/api/radio/ytsr?q=' + encodeURIComponent(q));
        if (data.yt?.videoId) return { ...song, yt: data.yt };
      } catch (_) {}
    }
    return null;
  }));
  return result.filter(Boolean);
}

async function loadNowPlaying() {
  try {
    const data = await api.now();
    if (data.play?.some(s => !s.yt?.videoId)) {
      data.play = await ensureVideoIds(data.play, data.mood);
    }
    state.nowPlaying = data;
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

async function loadKeys() {
  try {
    const data = await api.getKeys();
    state.profileData.keys = { key: data.key || null, provider: data.provider || 'anthropic', model: data.model || '' };
  } catch (err) {
    console.error(err);
  }
}

async function loadVoices() {
  try {
    const data = await api.getVoices();
    state.profileData.voices = { voices: data.voices || [], current: data.current || null };
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
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

window.onYouTubeIframeAPIReady = function() {
  mlog('YT API ready');
  ytApiReady = true;
};

// ── Native background audio bridge (Capacitor shell only; no-op on web/PWA) ─
const isNativeApp = !!window.Capacitor;
let bgAudioStopTimer = null;

function bgAudioStart() {
  if (!isNativeApp) return;
  if (bgAudioStopTimer) { clearTimeout(bgAudioStopTimer); bgAudioStopTimer = null; }
  const plugin = window.Capacitor?.Plugins?.BackgroundAudio;
  mlog('[bgAudio] start() called, plugin found:', !!plugin);
  if (!plugin) return;
  plugin.start()
    .then(() => mlog('[bgAudio] native start() resolved'))
    .catch(e => mlog('[bgAudio] native start() failed:', e.message));
}

function bgAudioStopNow() {
  if (!isNativeApp) return;
  if (bgAudioStopTimer) { clearTimeout(bgAudioStopTimer); bgAudioStopTimer = null; }
  const plugin = window.Capacitor?.Plugins?.BackgroundAudio;
  mlog('[bgAudio] stop() called, plugin found:', !!plugin);
  if (!plugin) return;
  plugin.stop()
    .then(() => mlog('[bgAudio] native stop() resolved'))
    .catch(e => mlog('[bgAudio] native stop() failed:', e.message));
}

function bgAudioScheduleStop() {
  if (!isNativeApp) return;
  if (bgAudioStopTimer) clearTimeout(bgAudioStopTimer);
  bgAudioStopTimer = setTimeout(() => {
    bgAudioStopTimer = null;
    bgAudioStopNow();
  }, 60000);
}

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
  bgAudioStopNow();
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
    bgAudioStopNow();
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
  if (isIOS) {
    const qIdx = playQueueIndex;
    const playAllBtn = document.getElementById('btn-play-all');
    if (playAllBtn) {
      playAllBtn.innerHTML = i18n.t('tapAgain');
      playAllBtn.onclick = () => window.toggleYT(qIdx, videoId);
    }
  }
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

function markYTUnavailable(btn, songName, artist, index) {
  if (!btn) return;
  btn.textContent = '⚠ Unavailable';
  btn.disabled = true;
  if (btn.nextElementSibling?.tagName !== 'A') {
    const searchUrl = 'https://www.youtube.com/results?search_query=' +
      encodeURIComponent((songName + ' ' + artist).trim());
    const link = document.createElement('a');
    link.href = searchUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Search on YouTube ↗';
    link.style.cssText = 'font-size:0.78rem;color:#888;text-decoration:underline';
    btn.insertAdjacentElement('afterend', link);
  }
  // Advance queue if this song was playing in sequence
  if (playQueue.length > 0 && playQueueIndex === index) {
    setTimeout(() => { playQueueIndex++; playFromQueue(); }, 800);
  }
}

function createYTPlayer(index, videoId, songName, artist, altIndex = 0) {
  if (!ytApiReady) {
    setTimeout(() => createYTPlayer(index, videoId, songName, artist, altIndex), 500);
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
        mlog('onReady fired for:', videoId);
        window._ytPlayerReady = true;
        const btn = document.getElementById('yt-btn-' + index);
        if (btn && btn.textContent === '⏳ Loading...') btn.textContent = '⏸ Pause';
        e.target.playVideo();
        const song = window._currentSongs?.[index];
        updateMediaSession(
          song?.song_name || song?.ncm?.name || song?.song || song?.query || '',
          song?.artist || song?.ncm?.artist || ''
        );
      },
      onError: function(e) {
        mlog('onError:', e.data, 'altIndex:', altIndex);
        const btn = document.getElementById('yt-btn-' + index);
        if (e.data === 150 || e.data === 101 || e.data === 100) {
          const song = window._currentSongs?.[index];
          const altIds = song?.yt?.altIds || [];
          const nextIndex = altIndex + 1;
          const nextId = altIds[nextIndex];
          if (nextId) {
            console.log(`[yt] onError ${e.data} on ${videoId} (song ${index}) → switching to ${nextId} (altIndex ${nextIndex})`);
            mlog('switching source:', videoId, '->', nextId);
            if (btn) btn.textContent = '⏳ Loading...';
            createYTPlayer(index, nextId, songName, artist, nextIndex);
          } else {
            console.log(`[yt] onError ${e.data} on ${videoId} (song ${index}) → no more candidates, marking unavailable`);
            markYTUnavailable(btn, songName, artist, index);
          }
        } else {
          if (btn) btn.textContent = '⚠ Error ' + e.data;
        }
      },
      onStateChange: function(e) {
        mlog('stateChange:', e.data);
        const btn = document.getElementById('yt-btn-' + index);
        const indicator = document.getElementById('yt-indicator-' + index);
        if (e.data === YT.PlayerState.PLAYING) {
          bgAudioStart();
          if (btn) btn.textContent = '⏸ Pause';
          if (indicator) indicator.style.display = 'none';
          const playedBtn = document.getElementById('played-btn-' + index);
          if (playedBtn && !playedBtn.disabled) window.markPlayed(playedBtn);
          if (isIOS && playQueue.length > 0) {
            const playAllBtn = document.getElementById('btn-play-all');
            if (playAllBtn) {
              playAllBtn.innerHTML = i18n.t('next') + ' ▶';
              playAllBtn.onclick = () => window.playNext();
            }
          }
        }
        if (e.data === YT.PlayerState.PAUSED) {
          if (btn) btn.textContent = '▶ Play';
          if (indicator) indicator.style.display = 'inline';
          bgAudioScheduleStop();
        }
        if (e.data === YT.PlayerState.ENDED) {
          if (btn) btn.textContent = '▶ Play';
          if (indicator) indicator.style.display = 'none';
          currentPlayingIndex = null;
          if (playQueueIndex === index) {
            setTimeout(() => { playQueueIndex++; playFromQueue(); }, 800);
          } else {
            bgAudioStopNow();
          }
        }
      },
    },
  });
  mlog('YT.Player constructor called');
}

window.toggleYT = function(index, videoId) {
  mlog('toggleYT called, YT exists: ' + (typeof YT !== 'undefined'));
  mlog('videoId value:', videoId);
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
  if (btn) btn.textContent = '⏳ Loading...';
  if (indicator) indicator.style.display = 'none';
  window._ytPlayerReady = false;
  const _song = window._currentSongs?.[index];
  const _songName = _song?.song_name || _song?.ncm?.name || _song?.song || _song?.query || '';
  const _artist = _song?.artist || _song?.ncm?.artist || '';
  createYTPlayer(index, videoId, _songName, _artist);
  if (isIOS && btn && playQueue.length === 0) btn.innerHTML = i18n.t('tapAgain');
};

window.markPlayed = async function(btn) {
  mlog('played btn clicked');
  btn.disabled = true;
  btn.textContent = '✓';
  btn.style.opacity = '0.4';
  const song_name = btn.dataset.name || '';
  const artist = btn.dataset.artist || '';
  try {
    const res = await api.played(song_name, artist, '');
    mlog('played API done: ' + JSON.stringify(res));
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
