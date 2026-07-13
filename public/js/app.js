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

// Purely visual: toggles the DJ orb's "speaking" pulse and the frequency
// ring (Phase 6C) to the TTS audio's play/pause/ended state. Does not affect
// playback in any way.
function attachDjOrbPulseHooks(audio) {
  const toggle = on => {
    document.getElementById('dj-orb')?.classList.toggle('speaking', on);
    freqRingTtsPlaying = on;
    updateFreqRingActive();
  };
  audio.addEventListener('play', () => toggle(true));
  audio.addEventListener('pause', () => toggle(false));
  audio.addEventListener('ended', () => toggle(false));
}

function playDJAudio(audioUrl) {
  if (!audioUrl) return;
  if (!currentAudio) { currentAudio = new Audio(); attachDjOrbPulseHooks(currentAudio); }
  currentAudio.src = audioUrl;
  currentAudio.load();
  currentAudio.play().catch(e => console.log('replay failed:', e.message));
}

window.playDJAudio = playDJAudio;

// ── Voice input (push-to-talk / click-to-toggle) ────────────────────────────
const MIC_HOLD_THRESHOLD_MS = 300; // press-release shorter than this = "click" (toggle mode)
const MIC_MAX_DURATION_MS = 60000; // hard cap, mirrors the server's own limit
const MIC_SVG = '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';

const MIC_TOAST_DURATION_MS = 3000;

const mic = {
  recording: false,
  transcribing: false,
  starting: false,
  toggleMode: false,
  recorder: null,
  stream: null,
  chunks: [],
  mimeType: '',
  startTs: 0,
  pressStartTs: 0,
  timerId: null,
  autoStopId: null,
  toastMessage: null,
  toastTimer: null,
};

// Same silent-clip unlock runDecision() does, extracted so it can also run
// synchronously inside the pointerup handler (still a real user gesture) —
// the auto-send path calls runDecision() ~300ms + a network round-trip
// later, well outside any gesture, so the unlock must happen earlier here
// to be safe on gesture-strict browsers (notably iOS Safari). Idempotent:
// a currentAudio already unlocked by an earlier click/tap makes this a no-op.
function ensureAudioUnlocked() {
  if (currentAudio) return;
  currentAudio = new Audio();
  attachDjOrbPulseHooks(currentAudio);
  currentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  currentAudio.play().catch(() => {});
}

function showMicToast(message) {
  if (mic.toastTimer) clearTimeout(mic.toastTimer);
  mic.toastMessage = message;
  renderMicToast();
  mic.toastTimer = setTimeout(() => {
    mic.toastMessage = null;
    mic.toastTimer = null;
    renderMicToast();
  }, MIC_TOAST_DURATION_MS);
}

function renderMicToast() {
  const el = document.getElementById('mic-toast');
  if (!el) return;
  el.textContent = mic.toastMessage || '';
  el.style.display = mic.toastMessage ? '' : 'none';
}

// Maps a differentiated transcribe() failure (see api.js's `stage` tag) to a
// user-facing message. 'network' gets a purpose-written message since the
// raw browser error ("Failed to fetch" etc.) isn't useful to show; 'server'
// and 'parse' already carry a clear message from the backend/api.js itself.
function micErrorMessage(err) {
  if (err?.stage === 'network') return i18n.t('micErrorNetwork');
  return err?.message || i18n.t('micError');
}

function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

function pickMicMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const c of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
  }
  return ''; // let the browser pick a default (e.g. iOS Safari)
}

function formatMicDuration() {
  if (!mic.recording) return '0:00';
  const secs = Math.floor((Date.now() - mic.startTs) / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function updateMicUI() {
  const btn = document.getElementById('btn-mic');
  if (!btn) return;
  btn.classList.toggle('recording', mic.recording);
  btn.classList.toggle('transcribing', mic.transcribing);
  btn.title = mic.transcribing ? i18n.t('transcribing') : (mic.recording ? i18n.t('micRecording') : i18n.t('micHint'));
  const durEl = document.getElementById('mic-duration');
  if (durEl) {
    durEl.style.display = mic.recording ? '' : 'none';
    durEl.textContent = formatMicDuration();
  }
}

async function micPointerDown(e) {
  e.preventDefault();
  if (mic.transcribing || mic.recording || mic.starting || state.loading) return;

  if (!micSupported()) {
    mlog('[mic] unsupported', 'getUserMedia=' + !!navigator.mediaDevices?.getUserMedia, 'MediaRecorder=' + !!window.MediaRecorder);
    showMicToast(i18n.t('micNotSupported'));
    return;
  }

  // Clear any leftover toast from a previous failed attempt so it doesn't
  // linger, confusingly, over a fresh recording.
  if (mic.toastTimer) { clearTimeout(mic.toastTimer); mic.toastTimer = null; }
  if (mic.toastMessage) { mic.toastMessage = null; renderMicToast(); }

  mic.pressStartTs = Date.now();
  mic.starting = true;

  // Stage 1: permission + stream acquisition. Kept in its own try/catch so a
  // getUserMedia rejection (permission denied, no mic, etc.) is never
  // conflated with a MediaRecorder construction/start failure below — they
  // need different user-facing messages and different fixes.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    mic.starting = false;
    mlog('[mic] getUserMedia failed', `${err.name}: ${err.message}`);
    console.error('mic permission error:', err);
    showMicToast(i18n.t('micPermissionDenied'));
    return;
  }
  mic.stream = stream;

  // Stage 2: MediaRecorder construction + start. Separate from stage 1 so a
  // codec/constructor failure surfaces as "recorder error", not "permission
  // denied" — the two have historically been conflated into one catch block.
  try {
    mic.mimeType = pickMicMimeType();
    const recorder = mic.mimeType ? new MediaRecorder(stream, { mimeType: mic.mimeType }) : new MediaRecorder(stream);
    mic.recorder = recorder;
    mic.chunks = [];
    recorder.ondataavailable = ev => { if (ev.data?.size) mic.chunks.push(ev.data); };
    recorder.onstop = handleMicStop;
    recorder.start();
    mlog('[mic] recording started', `requestedMimeType=${mic.mimeType || '(default)'}`, `recorder.mimeType=${recorder.mimeType || '(none)'}`);

    mic.recording = true;
    mic.starting = false;
    mic.toggleMode = false;
    mic.startTs = Date.now();
    updateMicUI();
    mic.timerId = setInterval(updateMicUI, 500);
    mic.autoStopId = setTimeout(stopMicRecording, MIC_MAX_DURATION_MS);
  } catch (err) {
    mic.starting = false;
    mlog('[mic] MediaRecorder start failed', `${err.name}: ${err.message}`);
    console.error('mic recorder error:', err);
    stream.getTracks().forEach(t => t.stop());
    mic.stream = null;
    showMicToast(i18n.t('micRecorderError'));
  }
}

function micPointerUp(e) {
  e.preventDefault();
  if (mic.starting || !mic.recording) return;

  // pointerup is still a real user gesture — unlock audio playback here so
  // it's guaranteed to be within a gesture stack, since the auto-send path
  // calls runDecision() ~300ms + a network round-trip after this returns,
  // well outside any gesture on stricter browsers (see ensureAudioUnlocked).
  ensureAudioUnlocked();

  const heldMs = Date.now() - mic.pressStartTs;
  if (heldMs < MIC_HOLD_THRESHOLD_MS && !mic.toggleMode) {
    // Quick click (not a hold): switch to click-to-toggle mode — keep
    // recording until the button is clicked again. Desktop-friendly
    // alternative to holding the button down for the whole utterance.
    mic.toggleMode = true;
    updateMicUI();
    return;
  }
  stopMicRecording();
}

function stopMicRecording() {
  if (mic.timerId) { clearInterval(mic.timerId); mic.timerId = null; }
  if (mic.autoStopId) { clearTimeout(mic.autoStopId); mic.autoStopId = null; }
  if (!mic.recording || !mic.recorder) return;
  mic.recording = false;
  try { mic.recorder.stop(); } catch (e) { console.error('mic stop error:', e); }
  mic.stream?.getTracks().forEach(t => t.stop());
  mic.stream = null;
}

async function handleMicStop() {
  // Prefer the recorder's own reported mimeType over the one we requested —
  // some browsers/WebViews silently pick a different codec than asked for,
  // and the Blob's type is what becomes the upload's Content-Type header.
  const actualMimeType = mic.recorder?.mimeType || mic.mimeType || 'audio/webm';
  const blob = new Blob(mic.chunks, { type: actualMimeType });
  mlog('[mic] recording stopped', `requestedMimeType=${mic.mimeType || '(default)'}`, `recorderMimeType=${mic.recorder?.mimeType || '(n/a)'}`, `blob.type=${blob.type}`, `blob.size=${blob.size}`, `chunks=${mic.chunks.length}`);
  mic.chunks = [];
  mic.toggleMode = false;
  if (!blob.size) {
    mlog('[mic] empty blob — nothing to upload');
    updateMicUI();
    return;
  }

  mic.transcribing = true;
  updateMicUI();
  try {
    const result = await api.transcribe(blob);
    const text = (result.text || '').trim();

    if (!text) {
      mlog('[mic] empty transcription result');
      showMicToast(i18n.t('micEmptyResult'));
      return;
    }

    // Fill the input so the user sees what was recognized and can edit it,
    // then leave sending to the user via the manual "Tell Claudio" button.
    const input = document.getElementById('ask-input');
    if (input) {
      input.value = text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    mlog('[mic] transcription filled', `text="${text.slice(0, 60)}"`);
  } catch (err) {
    console.error('transcribe failed:', 'stage=' + (err.stage || 'unknown'), err);
    mlog('[mic] transcribe failed', `stage=${err.stage || 'unknown'}`, `status=${err.status ?? 'n/a'}`, err.message);
    showMicToast(micErrorMessage(err));
  } finally {
    mic.transcribing = false;
    // Deliberately NOT calling fillPlayer() here — it rebuilds the whole
    // player view from a value-less <textarea> template, which would wipe
    // the text we just filled in (or the empty draft the user was mid-typing
    // if this fires for a stray/late recording). updateMicUI() is a targeted
    // DOM update that only touches the mic button/duration, leaving the
    // textarea's live value untouched.
    updateMicUI();
  }
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  user: null,
  view: 'auth',       // 'auth' | 'player' | 'profile' | 'onboarding'
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
  onboarding: null,
};

// ── Onboarding ─────────────────────────────────────────────────────────────
const ONBOARDING_FIRST_MESSAGE = '根据我的档案来一组见面礼歌单';

const ONBOARDING_STEPS = [
  {
    key: 'languages',
    type: 'multi',
    questionKey: 'obQ1',
    options: [
      { value: 'mandarin', labelKey: 'obLangMandarin' },
      { value: 'cantonese', labelKey: 'obLangCantonese' },
      { value: 'english', labelKey: 'obLangEnglish' },
      { value: 'japanese_korean', labelKey: 'obLangJpKr' },
      { value: 'mixed', labelKey: 'obLangMixed' },
    ],
  },
  {
    key: 'artists',
    type: 'text',
    questionKey: 'obQ2',
    placeholderKey: 'obQ2Placeholder',
  },
  {
    key: 'scenarios',
    type: 'multi',
    questionKey: 'obQ3',
    options: [
      { value: 'commute', labelKey: 'obSceneCommute' },
      { value: 'work_study', labelKey: 'obSceneWork' },
      { value: 'workout', labelKey: 'obSceneWorkout' },
      { value: 'chores', labelKey: 'obSceneChores' },
      { value: 'before_sleep', labelKey: 'obSceneSleep' },
      { value: 'driving', labelKey: 'obSceneDriving' },
    ],
  },
  {
    key: 'schedule',
    type: 'single',
    questionKey: 'obQ4',
    options: [
      { value: 'early_bird', labelKey: 'obSchedEarly' },
      { value: 'night_owl', labelKey: 'obSchedNight' },
      { value: 'irregular', labelKey: 'obSchedIrregular' },
    ],
  },
  {
    key: 'style',
    type: 'single',
    questionKey: 'obQ5',
    options: [
      { value: 'energetic', labelKey: 'obStyleEnergetic' },
      { value: 'warm', labelKey: 'obStyleWarm' },
      { value: 'witty', labelKey: 'obStyleWitty' },
      { value: 'concise', labelKey: 'obStyleConcise' },
    ],
  },
];

const ONBOARDING_REPLY_KEYS = {
  languages: 'obReplyLanguages',
  artists: 'obReplyArtists',
  scenarios: 'obReplyScenarios',
  schedule: 'obReplySchedule',
  style: 'obReplyStyle',
};

function findOnboardingOptionLabel(step, value) {
  const opt = step.options.find(o => o.value === value);
  return opt ? i18n.t(opt.labelKey) : value;
}

function formatOnboardAnswerText(step, answer) {
  if (step.type === 'text') return answer || i18n.t('obSkippedAnswer');
  const sep = i18n.current === 'zh' ? '、' : ', ';
  if (step.type === 'single') return findOnboardingOptionLabel(step, answer);
  return (answer || []).map(v => findOnboardingOptionLabel(step, v)).join(sep) || i18n.t('obSkippedAnswer');
}

function onboardReplyText(step, answer) {
  if (step.key === 'artists' && !answer) return i18n.t('obReplyArtistsEmpty');
  const sep = i18n.current === 'zh' ? '、' : ', ';
  let v;
  if (step.type === 'text') v = answer;
  else if (step.type === 'single') v = findOnboardingOptionLabel(step, answer);
  else v = (answer || []).map(val => findOnboardingOptionLabel(step, val)).join(sep);
  return i18n.t(ONBOARDING_REPLY_KEYS[step.key]).replace('{v}', v);
}

function startOnboarding(returnView = 'player') {
  state.view = 'onboarding';
  state.onboarding = {
    step: 0,
    answers: { languages: [], artists: '', scenarios: [], schedule: '', style: '' },
    messages: [],
    typing: true,
    returnView,
  };
  setTimeout(() => {
    if (!state.onboarding) return;
    state.onboarding.typing = false;
    state.onboarding.messages.push({ who: 'dj', text: i18n.t('obWelcomeGreeting') });
    state.onboarding.messages.push({ who: 'dj', text: i18n.t(ONBOARDING_STEPS[0].questionKey) });
    render();
    scrollOnboardChat();
  }, 500);
}

async function submitOnboardingAnswer(stepKey, answer) {
  const st = state.onboarding;
  const step = ONBOARDING_STEPS.find(s => s.key === stepKey);
  st.answers[stepKey] = answer;
  st.messages.push({ who: 'user', text: formatOnboardAnswerText(step, answer) });
  st.step++;
  st.typing = true;
  render();
  scrollOnboardChat();

  await new Promise(r => setTimeout(r, 500));
  if (!state.onboarding) return;
  st.typing = false;
  st.messages.push({ who: 'dj', text: onboardReplyText(step, answer) });
  if (st.step < ONBOARDING_STEPS.length) {
    st.messages.push({ who: 'dj', text: i18n.t(ONBOARDING_STEPS[st.step].questionKey) });
    render();
    scrollOnboardChat();
  } else {
    render();
    scrollOnboardChat();
    await finalizeOnboarding();
  }
}

async function finalizeOnboarding() {
  const st = state.onboarding;
  st.typing = true;
  render();
  scrollOnboardChat();
  try {
    await api.submitOnboarding(st.answers);
  } catch (err) {
    console.error(err);
  }
  if (!state.onboarding) return;
  st.typing = false;
  st.messages.push({ who: 'dj', text: i18n.t('obWelcomeDone') });
  render();
  scrollOnboardChat();

  await new Promise(r => setTimeout(r, 900));
  state.view = 'player';
  state.onboarding = null;
  render();
  await runDecision(ONBOARDING_FIRST_MESSAGE);
}

function scrollOnboardChat() {
  const el = document.querySelector('.onboarding-view');
  if (el) el.scrollTop = el.scrollHeight;
}

async function routeAfterAuth() {
  let needsOnboarding = false;
  try {
    const profile = await api.getProfile();
    needsOnboarding = !!profile.needs_onboarding;
  } catch { /* ignore — fall through to player */ }

  if (needsOnboarding) {
    startOnboarding('player');
  } else {
    state.view = 'player';
    await loadNowPlaying();
  }
}

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
  } else if (state.view === 'onboarding') {
    root.innerHTML = renderOnboarding();
  } else {
    root.innerHTML = renderShell();
    if (state.view === 'player') fillPlayer();
    else fillProfile();
  }
  // Bounded-height shell only for the player view (6C-fix) — needed so
  // .now-playing-panel's overflow-y:auto has a definite box to scroll
  // within; other views keep the normal body-scrolling min-height:100vh.
  root.classList.toggle('app--player-shell', state.view === 'player');
  if (state.view === 'player') startNowPlayingSync();
  else stopNowPlayingSync();
  attachEvents();
}

// ── Onboarding view ────────────────────────────────────────────────────────
function renderOnboarding() {
  const st = state.onboarding;
  const msgsHtml = st.messages.map(renderOnboardMsg).join('');
  const typingHtml = st.typing ? renderOnboardTyping() : '';
  const current = ONBOARDING_STEPS[st.step];
  const inputHtml = (!st.typing && current) ? renderOnboardInput(current, st) : '';
  return `
<div class="view onboarding-view">
  <div class="topbar">
    <span class="topbar-title">${esc(i18n.t('appName'))}</span>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-lang" id="btn-lang">${esc(i18n.t('langToggle'))}</button>
      <button class="btn-skip-onboarding" id="btn-onboarding-skip">${esc(i18n.t('skip'))}</button>
    </div>
  </div>
  <div class="onboard-chat" id="onboard-chat">
    ${msgsHtml}
    ${typingHtml}
  </div>
  ${inputHtml}
</div>`;
}

function renderOnboardMsg(m) {
  const avatarLetter = m.who === 'dj' ? 'C' : esc((state.user?.username || '?')[0]?.toUpperCase() || '?');
  return `
<div class="onboard-msg ${m.who}">
  <div class="onboard-avatar">${avatarLetter}</div>
  <div class="onboard-bubble">${esc(m.text)}</div>
</div>`;
}

function renderOnboardTyping() {
  return `
<div class="onboard-msg dj onboard-typing">
  <div class="onboard-avatar">C</div>
  <div class="onboard-bubble"><span class="onboard-dot"></span><span class="onboard-dot"></span><span class="onboard-dot"></span></div>
</div>`;
}

function renderOnboardInput(step, st) {
  if (step.type === 'text') {
    return `
<div class="onboard-text-row">
  <input type="text" id="onboard-text-input" placeholder="${esc(i18n.t(step.placeholderKey))}" autocomplete="off" />
  <button class="btn-ask" id="onboard-text-submit">${esc(i18n.t('obSend'))}</button>
</div>`;
  }
  const selected = st.answers[step.key];
  const isMulti = step.type === 'multi';
  const optsHtml = step.options.map(opt => {
    const isSel = isMulti ? selected.includes(opt.value) : selected === opt.value;
    return `<button class="onboard-option-btn ${isSel ? 'selected' : ''}" data-value="${esc(opt.value)}">${esc(i18n.t(opt.labelKey))}</button>`;
  }).join('');
  const confirmHtml = isMulti
    ? `<div class="onboard-confirm-row"><button class="btn-ask" id="onboard-multi-confirm" ${selected.length ? '' : 'disabled'}>${esc(i18n.t('obNext'))}</button></div>`
    : '';
  return `<div class="onboard-options">${optsHtml}</div>${confirmHtml}`;
}

function attachOnboardingEvents() {
  document.getElementById('btn-onboarding-skip')?.addEventListener('click', async () => {
    const target = state.onboarding?.returnView || 'player';
    state.onboarding = null;
    state.view = target;
    if (target === 'player' && !state.nowPlaying) await loadNowPlaying();
    render();
  });

  const st = state.onboarding;
  const step = ONBOARDING_STEPS[st?.step];
  if (!step || st.typing) return;

  if (step.type === 'text') {
    const input = document.getElementById('onboard-text-input');
    const submit = document.getElementById('onboard-text-submit');
    const doSubmit = () => {
      const val = input?.value.trim() || '';
      submitOnboardingAnswer(step.key, val);
    };
    submit?.addEventListener('click', doSubmit);
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doSubmit(); }
    });
    input?.focus();
    return;
  }

  document.querySelectorAll('.onboard-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value;
      if (step.type === 'single') {
        submitOnboardingAnswer(step.key, value);
      } else {
        const arr = st.answers[step.key];
        const idx = arr.indexOf(value);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
        render();
        scrollOnboardChat();
      }
    });
  });

  document.getElementById('onboard-multi-confirm')?.addEventListener('click', () => {
    submitOnboardingAnswer(step.key, st.answers[step.key]);
  });
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
  const viewEl = document.getElementById('view-content');
  viewEl.classList.add('player-view');
  viewEl.innerHTML = renderPlayerContent();
  restorePlayerButtons();
  syncNowPlayingUI();
  if (isIOS && !localStorage.getItem('ios_hint_shown')) {
    const djCard = document.querySelector('.dj-card');
    if (djCard) djCard.insertAdjacentHTML('afterend', `<div id="ios-hint" style="background:#c8a96e22;border:1px solid #c8a96e;border-radius:8px;padding:10px 14px;margin:8px 0;color:#c8a96e;font-size:13px;display:flex;justify-content:space-between;align-items:center;"><span>💡 iOS tip: tap Play twice to start a song</span><button onclick="document.getElementById('ios-hint').remove();localStorage.setItem('ios_hint_shown','1')" style="background:none;border:none;color:#c8a96e;font-size:18px;cursor:pointer">×</button></div>`);
  }
}

// SVG chevrons (6C-fix) — line style matches the existing stroke-based nav
// icons elsewhere in the shell. Expanded state shows chevron-up (in the
// region's own corner); collapsed state shows chevron-down (in the strip).
// Each button only ever displays one fixed icon since only one of the two
// is ever visible at a time — no dynamic glyph-swapping needed.
const CHEVRON_UP_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
const CHEVRON_DOWN_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

// Now Playing region (video slot / DJ orb / title / transport controls) sits
// above a scrollable panel that reuses the exact same dj-card/songs-label/
// btn-play-all/renderSong markup as before — only its container moved.
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
<div class="player-columns">
  <div class="now-playing-region ${npCollapsed ? 'collapsed' : ''}" id="now-playing-region">
    <div class="now-playing-visual" id="now-playing-visual">
      <div class="now-playing-video-slot" id="now-playing-video-slot"></div>
      <div class="dj-orb" id="dj-orb">
        <div class="dj-orb-ring"></div>
        <div class="dj-orb-ring"></div>
        <div class="dj-orb-core"></div>
      </div>
    </div>
    <div class="now-playing-title-block">
      <div class="now-playing-song" id="now-playing-song">${esc(i18n.t('noSongPlaying'))}</div>
      <div class="now-playing-artist" id="now-playing-artist"></div>
    </div>
    <div class="now-playing-controls">
      <button class="np-ctrl-btn np-ctrl-prev" id="np-btn-prev" disabled>◀◀</button>
      <div class="np-playpause-wrap">
        <div class="np-freq-ring" id="np-freq-ring">${buildFreqRingHtml()}</div>
        <button class="np-ctrl-btn np-ctrl-playpause" id="np-btn-playpause">▶</button>
      </div>
      <button class="np-ctrl-btn np-ctrl-next" id="np-btn-next" disabled>▶▶</button>
    </div>
    <button class="np-collapse-btn np-collapse-btn--region" id="np-collapse-toggle" aria-label="Collapse Now Playing">${CHEVRON_UP_SVG}</button>
    <div class="now-playing-strip" id="now-playing-strip">
      <span class="now-playing-strip-note">♪</span>
      <span class="now-playing-strip-text" id="now-playing-strip-text"></span>
      <button class="np-collapse-btn np-collapse-btn--strip" id="np-collapse-toggle-strip" aria-label="Expand Now Playing">${CHEVRON_DOWN_SVG}</button>
    </div>
  </div>
  <div class="now-playing-panel" id="now-playing-panel">
    ${state.error ? `<div class="dj-error">${esc(state.error)}</div>` : ''}
    ${state.loading ? `<div class="loading-text">${esc(i18n.t('loading'))}</div>` : djBlock}
  </div>
</div>
<div class="mic-toast" id="mic-toast" style="display:${mic.toastMessage ? '' : 'none'}">${esc(mic.toastMessage || '')}</div>
<div class="ask-form">
  <textarea class="ask-input" id="ask-input" rows="1"
    placeholder="${esc(i18n.t('inputPlaceholder'))}"
  ></textarea>
  <button class="btn-mic ${mic.recording ? 'recording' : ''} ${mic.transcribing ? 'transcribing' : ''}" id="btn-mic"
    type="button" title="${esc(mic.transcribing ? i18n.t('transcribing') : (mic.recording ? i18n.t('micRecording') : i18n.t('micHint')))}">
    ${MIC_SVG}
    <span class="mic-duration" id="mic-duration" style="display:${mic.recording ? '' : 'none'}">${formatMicDuration()}</span>
  </button>
  <button class="btn-ask" id="btn-ask" ${state.loading ? 'disabled' : ''}>
    ${state.loading ? esc(i18n.t('loading')) : esc(i18n.t('send'))}
  </button>
</div>`;
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
  <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
    <button class="btn-redo-onboarding" id="btn-redo-onboarding">${esc(i18n.t('redoOnboarding'))}</button>
    <button class="btn-logout" id="btn-logout">${esc(i18n.t('logout'))}</button>
  </div>
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
  } else if (state.view === 'onboarding') {
    attachOnboardingEvents();
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
      await routeAfterAuth();
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
      await routeAfterAuth();
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
    await runDecision(msg, { onSuccessClearInput: input });
  });

  // Mic: pointerdown starts recording (works for mouse + touch). A quick
  // release (< MIC_HOLD_THRESHOLD_MS) switches into click-to-toggle mode
  // instead of stopping — see micPointerUp for the hold-vs-click logic.
  const micBtn = document.getElementById('btn-mic');
  micBtn?.addEventListener('pointerdown', micPointerDown);
  micBtn?.addEventListener('pointerup', micPointerUp);
  micBtn?.addEventListener('pointercancel', () => { if (mic.recording) stopMicRecording(); });
  micBtn?.addEventListener('pointerleave', () => { if (mic.recording && !mic.toggleMode) stopMicRecording(); });

  // Now Playing transport controls — call straight into the existing,
  // untouched playAll/toggleYT/playNext/playPrevious functions.
  document.getElementById('np-btn-playpause')?.addEventListener('click', handleNowPlayingPlayPause);
  document.getElementById('np-btn-prev')?.addEventListener('click', () => window.playPrevious());
  document.getElementById('np-btn-next')?.addEventListener('click', () => window.playNext());

  // Collapse/expand toggle (6C-fix). Corner button collapses; the strip
  // (button or anywhere on it) expands. stopPropagation on the strip's own
  // button so its click doesn't also bubble into the strip's row handler
  // and fire a second, redundant toggle.
  document.getElementById('np-collapse-toggle')?.addEventListener('click', () => {
    setNowPlayingCollapsed(true);
  });
  document.getElementById('np-collapse-toggle-strip')?.addEventListener('click', e => {
    e.stopPropagation();
    setNowPlayingCollapsed(false);
  });
  document.getElementById('now-playing-strip')?.addEventListener('click', () => {
    setNowPlayingCollapsed(false);
  });

  // Queue row click = jump-play. Delegates to the row's own existing Play
  // button (already wired to toggleYT) rather than duplicating its logic.
  document.querySelectorAll('.song-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.btn-yt-play, .btn-played')) return;
      row.querySelector('.btn-yt-play')?.click();
    });
  });
}

async function runDecision(message, { onSuccessClearInput } = {}) {
  if (state.loading) return;

  // Unlock audio in the synchronous click stack — must happen before any
  // await. No-op if already unlocked (e.g. by micPointerUp for the voice
  // auto-send path — see ensureAudioUnlocked).
  ensureAudioUnlocked();

  state.loading = true;
  state.error = null;
  fillPlayer();
  attachPlayerEvents();
  try {
    const decision = await api.decide(message);
    if (decision.play?.some(s => !s.yt?.videoId)) {
      decision.play = await ensureVideoIds(decision.play, decision.mood);
    }
    state.nowPlaying = decision;
    if (onSuccessClearInput) onSuccessClearInput.value = '';
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

  document.getElementById('btn-redo-onboarding')?.addEventListener('click', () => {
    if (!confirm(i18n.t('redoOnboardingConfirm'))) return;
    startOnboarding('profile');
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

// Mirrors playNext() above (same queue primitives, decrementing instead of
// incrementing) — added for the Now Playing transport's Prev button.
window.playPrevious = function() {
  if (playQueue.length === 0) {
    console.log('[Prev] No queue active');
    return;
  }
  if (playQueueIndex <= 0) {
    console.log('[Prev] Already at first track');
    return;
  }
  console.log('[Prev] Current index:', playQueueIndex, '→', playQueueIndex - 1);
  if (currentPlayingIndex !== null && ytPlayers[currentPlayingIndex]) {
    try { ytPlayers[currentPlayingIndex].destroy(); } catch(e) {}
    delete ytPlayers[currentPlayingIndex];
    const oldBtn = document.getElementById('yt-btn-' + currentPlayingIndex);
    if (oldBtn) oldBtn.textContent = '▶ Play';
    currentPlayingIndex = null;
  }
  playQueueIndex--;
  playFromQueue();
};

// ── Now Playing sync (Phase 6B, visual layer only) ──────────────────────────
// Polls the existing, untouched queue/player globals (currentPlayingIndex,
// ytPlayers, playQueue, playQueueIndex) and reflects them onto the new Now
// Playing region. Never calls into or mutates YT.Player/queue internals —
// read-only against that layer. The one exception is repositioning the
// pre-existing #audio-container element via inline style to visually overlay
// .now-playing-video-slot's rect; the element itself is never reparented or
// recreated, so playback continuity across view switches is unaffected.
let nowPlayingSyncTimer = null;
let lastNpTitleKey = null;

function startNowPlayingSync() {
  if (nowPlayingSyncTimer) return;
  syncNowPlayingUI();
  nowPlayingSyncTimer = setInterval(syncNowPlayingUI, 400);
}

function stopNowPlayingSync() {
  if (nowPlayingSyncTimer) {
    clearInterval(nowPlayingSyncTimer);
    nowPlayingSyncTimer = null;
  }
  positionAudioContainerOffscreen();
  // Leaving the player view — collapse state is in-memory only (point 4).
  npCollapsed = false;
}

// ── Now Playing collapse/expand (6C-fix, visual layer only) ────────────────
// In-memory only (not persisted); reset to expanded on song change (below)
// and on leaving the player view (stopNowPlayingSync above). Pure CSS
// collapse now (no mini-window, no FLIP transform) — toggling the
// "collapsed" class drives every visual change via the CSS rules on
// .now-playing-visual/.now-playing-title-block/.now-playing-controls/
// .now-playing-strip. The two collapse buttons are static (chevron-up only
// ever shown expanded, chevron-down only ever shown collapsed), so there's
// no glyph-swapping to do here either.
let npCollapsed = false;

// Auto-reset (no user-facing toggle animation needed — this fires on
// background events like auto-advancing to the next queued song).
function resetNowPlayingCollapse() {
  if (!npCollapsed) return;
  npCollapsed = false;
  document.getElementById('now-playing-region')?.classList.remove('collapsed');
}

// Briefly re-runs the existing, untouched syncNowPlayingUI() on every frame
// for the duration of the collapse/expand transition, so the real embedded
// video iframe (resized by that function to match .now-playing-video-slot's
// shrinking/growing rect) visually keeps pace with the CSS animation instead
// of jumping to its final size only once the next 400ms poll tick happens.
function runCollapseTransitionSync(durationMs) {
  const start = performance.now ? performance.now() : Date.now();
  function tick() {
    syncNowPlayingUI();
    const now = performance.now ? performance.now() : Date.now();
    if (now - start < durationMs) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function setNowPlayingCollapsed(collapsed) {
  if (npCollapsed === collapsed) return;
  npCollapsed = collapsed;
  document.getElementById('now-playing-region')?.classList.toggle('collapsed', collapsed);
  runCollapseTransitionSync(350);
}

function toggleNowPlayingCollapse() {
  setNowPlayingCollapsed(!npCollapsed);
}

// ── Frequency ring (Phase 6C, visual layer only) ────────────────────────────
// Purely decorative CSS animation. Two independent "is something audible
// playing" signals feed the same ring: YT video state (read-only, via the
// existing syncNowPlayingUI poll below — onStateChange itself is untouched)
// and the DJ TTS currentAudio play/pause/ended events (attachDjOrbPulseHooks
// above, same hook that already drives the 6B orb pulse).
const FREQ_RING_BAR_COUNT = 20;
let freqRingYtPlaying = false;
let freqRingTtsPlaying = false;

function buildFreqRingHtml() {
  let html = '';
  for (let i = 0; i < FREQ_RING_BAR_COUNT; i++) {
    const angle = (360 / FREQ_RING_BAR_COUNT) * i;
    const duration = (0.7 + Math.random() * 0.6).toFixed(2);
    const delay = (Math.random() * 1.2).toFixed(2);
    html += `<div class="np-freq-bar" style="transform:rotate(${angle}deg)">` +
      `<div class="np-freq-bar-inner" style="animation-duration:${duration}s;animation-delay:-${delay}s"></div>` +
      `</div>`;
  }
  return html;
}

function updateFreqRingActive() {
  document.getElementById('np-freq-ring')?.classList.toggle('active', freqRingYtPlaying || freqRingTtsPlaying);
}

function positionAudioContainerOffscreen() {
  const el = document.getElementById('audio-container');
  if (!el) return;
  el.classList.remove('audio-container-active');
  el.style.position = 'fixed';
  el.style.top = '-9999px';
  el.style.left = '-9999px';
  el.style.width = '1px';
  el.style.height = '1px';
}

function updateNowPlayingTitle(song) {
  const titleEl = document.getElementById('now-playing-song');
  const artistEl = document.getElementById('now-playing-artist');
  const stripTextEl = document.getElementById('now-playing-strip-text');
  if (!titleEl || !artistEl) return;
  const name = song?.song_name || song?.ncm?.name || song?.song || song?.query || '';
  const artist = song?.artist || song?.ncm?.artist || '';
  const key = name + '|' + artist;
  if (key === lastNpTitleKey) return;
  lastNpTitleKey = key;
  resetNowPlayingCollapse(); // song changed — point 5: reset to expanded
  titleEl.textContent = name || i18n.t('noSongPlaying');
  artistEl.textContent = artist;
  if (stripTextEl) stripTextEl.textContent = name ? (artist ? `${name} – ${artist}` : name) : i18n.t('noSongPlaying');
  [titleEl, artistEl].forEach(el => {
    el.classList.remove('np-fade-in');
    void el.offsetWidth; // restart the animation
    el.classList.add('np-fade-in');
  });
}

function syncNowPlayingUI() {
  if (state.view !== 'player') return;

  const slot = document.getElementById('now-playing-video-slot');
  const orb = document.getElementById('dj-orb');
  const audioEl = document.getElementById('audio-container');
  const hasActiveVideo = currentPlayingIndex !== null && !!ytPlayers[currentPlayingIndex];

  if (slot && orb && audioEl) {
    if (hasActiveVideo) {
      // Always applied, including 0-size rects — .now-playing-visual's own
      // max-height genuinely collapses to 0 (6C-fix point 3), and the real
      // iframe needs to shrink to match exactly rather than staying at its
      // last (pre-collapse) size, which a "skip if 0" guard would cause.
      const rect = slot.getBoundingClientRect();
      audioEl.classList.add('audio-container-active');
      audioEl.style.position = 'fixed';
      audioEl.style.top = rect.top + 'px';
      audioEl.style.left = rect.left + 'px';
      audioEl.style.width = rect.width + 'px';
      audioEl.style.height = rect.height + 'px';
      slot.style.display = '';
      orb.style.display = 'none';
    } else {
      positionAudioContainerOffscreen();
      slot.style.display = 'none';
      orb.style.display = '';
    }
  }

  const songs = state.nowPlaying?.play || [];
  const activeIdx = currentPlayingIndex !== null ? currentPlayingIndex : (playQueueIndex >= 0 ? playQueueIndex : null);
  updateNowPlayingTitle(activeIdx !== null ? songs[activeIdx] : null);

  const btnPlayPause = document.getElementById('np-btn-playpause');
  const btnPrev = document.getElementById('np-btn-prev');
  const btnNext = document.getElementById('np-btn-next');
  if (btnPlayPause) {
    let playing = false;
    if (hasActiveVideo) {
      try { playing = ytApiReady && ytPlayers[currentPlayingIndex].getPlayerState() === YT.PlayerState.PLAYING; } catch (e) {}
    }
    // '⏸' (U+23F8) renders as a missing-glyph box in some environments — '||'
    // is plain ASCII, guaranteed to render everywhere, same fix class as the
    // ◀◀/▶▶ prev/next glyphs above.
    btnPlayPause.textContent = playing ? '||' : '▶';
    freqRingYtPlaying = playing;
    updateFreqRingActive();
  }
  if (btnPrev) btnPrev.disabled = !(playQueue.length > 0 && playQueueIndex > 0);
  if (btnNext) btnNext.disabled = !(playQueue.length > 0 && playQueueIndex < playQueue.length - 1);

  document.querySelectorAll('.song-item').forEach(row => {
    const playBtn = row.querySelector('.btn-yt-play');
    const rowIdx = playBtn ? parseInt((playBtn.id || '').replace('yt-btn-', ''), 10) : NaN;
    if (Number.isNaN(rowIdx)) return;
    row.classList.toggle('is-current', rowIdx === currentPlayingIndex);
    const playedBtn = document.getElementById('played-btn-' + rowIdx);
    row.classList.toggle('is-played', !!playedBtn?.disabled && rowIdx !== currentPlayingIndex);
  });
}

// Central Play/Pause: toggles the active song if one is loaded, otherwise
// starts the queue from the top — both via the existing, untouched functions.
function handleNowPlayingPlayPause() {
  if (currentPlayingIndex !== null && ytPlayers[currentPlayingIndex]) {
    const song = (state.nowPlaying?.play || [])[currentPlayingIndex];
    const videoId = song?.yt?.videoId;
    if (videoId) window.toggleYT(currentPlayingIndex, videoId);
  } else {
    window.playAll();
  }
}

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

function createYTPlayer(index, videoId, songName, artist, altIndex = 0, resumeSeconds = 0) {
  if (!ytApiReady) {
    setTimeout(() => createYTPlayer(index, videoId, songName, artist, altIndex, resumeSeconds), 500);
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
        if (resumeSeconds > 0) {
          try { e.target.seekTo(resumeSeconds, true); } catch (err) {}
        }
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
        // Defensive guard: on some devices playVideo() after a pause can silently no-op.
        // Only kicks in if playback genuinely didn't resume — zero effect on the normal path.
        setTimeout(() => {
          const player = ytPlayers[index];
          if (!player) return;
          try {
            if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
              mlog('resume stuck for index', index, '- rebuilding player');
              let seekSeconds = 0;
              try { seekSeconds = player.getCurrentTime() || 0; } catch (err) {}
              const song = window._currentSongs?.[index];
              const rebuildName = song?.song_name || song?.ncm?.name || song?.song || song?.query || '';
              const rebuildArtist = song?.artist || song?.ncm?.artist || '';
              createYTPlayer(index, videoId, rebuildName, rebuildArtist, 0, seekSeconds);
            }
          } catch (err) {}
        }, 1500);
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
      await routeAfterAuth();
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
