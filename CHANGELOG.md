# Claudio — Development Changelog

Personal AI Radio SaaS. Node.js v22+ · Express · SQLite (better-sqlite3) · Vanilla JS SPA · PWA.

---

## Phase 1 — Project Bootstrap

**Goal:** Minimal working server with auth.

- Initialized Node.js v22 project with `"type": "module"` (ES Modules throughout; no `require`)
- Express 4 server on port 3001 (`src/server.js`)
- SQLite system database (`data/system.db`) via `better-sqlite3`
  - `users` table: `id TEXT PK`, `email UNIQUE`, `password_hash`, `username UNIQUE`, `created_at`, `last_login`
  - `sessions` table (created but JWT-based auth used instead of DB sessions)
- WAL mode enabled on all SQLite databases for concurrency
- `dotenv/config` auto-loaded; `.env.example` documents all required vars

---

## Phase 2 — Authentication Routes (`src/routes/auth.js`)

**Endpoints:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Returns JWT |
| GET | `/api/auth/me` | JWT | Returns current user |

**Details:**
- Email validated with `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- Username: 3–20 alphanumeric (`/^[a-zA-Z0-9]{3,20}$/`)
- Password: min 8 characters, bcrypt-hashed (cost 10)
- JWT signed with `JWT_SECRET`, 7-day expiry, payload `{ uid, username }`
- On register: `initUserDir(uid)` creates per-user SQLite + markdown files
- On login: updates `last_login` timestamp

**Middleware — `src/middleware/auth.js`:**
- `requireAuth`: verifies Bearer JWT, attaches `req.user = { uid, username }`

---

## Phase 3 — Per-User Data Isolation (`src/db/index.js`)

Each user gets:
- `data/users/<uid>/state.db` — SQLite with tables:
  - `plays (id, song_id, song_name, artist, played_at, source)` — play history
  - `memory (key, value, updated_at)` — key-value store for DJ state, plans
  - `plan (date, content, generated_at)` — daily plan (legacy; now stored in `memory`)
- `data/users/<uid>/taste.md` — music taste profile (editable by user)
- `data/users/<uid>/routines.md` — daily routines (editable by user)

`getUserDb(uid)` caches open DB handles in a `Map` to avoid repeated opens.

---

## Phase 4 — Claude AI DJ Engine (`src/modules/claude.js`)

**Function:** `djDecision(uid, userMessage, context)`

**Anthropic API call:**
- Model: `CLAUDE_MODEL` env var, defaults to `claude-haiku-4-5`
- Max tokens: 1024
- Single `user` message containing multi-section prompt

**Prompt sections (joined with `---`):**
1. DJ persona + JSON-only response instruction
2. Listener's `taste.md` + `routines.md`
3. Time of day, weather, mood, memory key-value store
4. Recent play history (last 20 plays from DB)
5. Avoid-repeat instruction (lists songs played this session)
6. Listener's message
7. Output format + language rules

**Language rules:**
- English-only input → English songs
- Chinese-only input → Mandarin/Cantonese songs
- Mixed input → ~2 Chinese + ~3 English, `say` field in dominant language

**Output JSON:**
```json
{
  "say": "DJ commentary",
  "play": [{ "query": "song artist", "reason": "why" }],
  "mood": "keyword",
  "segue": "transition thought"
}
```
- Parses JSON; strips markdown code fences as fallback
- Returns `FALLBACK` constant on API error

**Helper:** `getTimeOfDay(hour)` → `morning|afternoon|evening|night`

---

## Phase 5 — Music Resolution Pipeline (`src/routes/radio.js`)

**POST `/api/radio/decide`** (auth required):

1. Builds context: `timeOfDay`, `weather`, `mood`, last 20 plays from user DB
2. Calls `djDecision(uid, message, context)`
3. In parallel via `Promise.all`:
   - `synthesize(decision.say)` → Fish Audio TTS → returns `/api/tts/<hash>.mp3` URL
   - For each song: `resolveSong(query)` (NCM) + `searchYouTube(query)` in parallel
4. Stores full result in `memory` table under key `last_decision`
5. Returns enriched JSON with `audioUrl`, `play[].ncm`, `play[].yt`

**GET `/api/radio/now`** (auth required):
- Returns `last_decision` from memory, or empty state if none

**POST `/api/radio/played`** (auth required):
- Inserts into `plays` table: `song_id`, `song_name`, `artist`, `played_at`

**GET `/api/radio/song-url/:id`** (no auth):
- Proxies NCM `getSongUrl(id)` — used by `<audio>` to refresh expired NCM links

---

## Phase 6 — NCM Integration (`src/modules/ncm.js`)

**Dependencies:** External NetEase Cloud Music API server (`NCM_API_URL`, default `http://localhost:3002`)

**Functions:**
- `searchSong(query)` → returns `{ id, name, artist, album }` for top result
- `getSongUrl(songId)` → returns playback URL (time-limited CDN link)
- `resolveSong(query)` → `searchSong` then `getSongUrl`, returns full song object with URL

NCM results used for display normalization (canonical name/artist) only; YouTube used for actual playback.

---

## Phase 7 — YouTube Integration (`src/modules/youtube.js`)

**Dependency:** `ytsr` package

**Function:** `searchYouTube(query)`
- Searches `"${query} official audio"`, limit 3 results
- Prefers results from channels named `official`, `music`, or `vevo`
- Returns `{ videoId, title, channel }`

**In the frontend:** YouTube videos embedded as iframes with `autoplay=1&enablejsapi=1&controls=0`. The `enablejsapi=1` flag enables postMessage commands (`playVideo`, `pauseVideo`) and state change events.

---

## Phase 8 — Fish Audio TTS (`src/modules/tts.js`)

**Function:** `synthesize(text)`
- Requires `FISH_TTS_KEY` env var; returns `null` if missing
- MD5 hash of text used as cache key → `data/tts/<hash>.mp3`
- Cache-first: returns existing file URL without re-calling API
- Calls `https://api.fish.audio/v1/tts` with `reference_id` from `FISH_TTS_VOICE` env
- Saves MP3 to disk, returns `/api/tts/<hash>.mp3` path

**TTS route (`src/routes/tts.js`):** Serves cached MP3 files with `Content-Type: audio/mpeg`.

---

## Phase 9 — Profile API (`src/routes/profile.js`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profile` | Returns `{ uid, username, email }` |
| GET | `/api/profile/taste` | Returns `{ content }` from taste.md |
| PUT | `/api/profile/taste` | Writes taste.md |
| GET | `/api/profile/routines` | Returns `{ content }` from routines.md |
| PUT | `/api/profile/routines` | Writes routines.md |
| GET | `/api/profile/history` | Returns last 50 plays from `plays` table |

---

## Phase 10 — Daily Scheduler (`src/modules/scheduler.js`)

- Runs on server start via `startScheduler()`
- Generates morning plan at **08:00** (key: `plan_morning`)
- Generates evening plan at **22:00** (key: `plan_night`)
- Iterates all users; calls `djDecision` with time-appropriate message
- Synthesizes TTS for each plan's `say` text
- Stores result in user `memory` table via `INSERT OR REPLACE`
- `POST /api/radio/plan/generate` for manual on-demand generation
- `GET /api/radio/plan` returns `{ morning, night }` objects

---

## Phase 11 — Frontend SPA (`public/`)

Vanilla JS, no build step, no framework.

### File structure
```
public/
  index.html          # SPA shell — loads css/app.css + js/i18n.js + js/api.js + js/app.js
  admin.html          # Standalone admin dashboard (not SPA)
  manifest.json       # PWA manifest
  icon.svg            # PWA icon (gold "C" on dark background)
  sw.js               # Service Worker (cache-first, claudio-v8)
  css/app.css         # All app styles (dark theme, CSS variables)
  js/
    i18n.js           # LANGS object, i18n.t(), i18n.toggle()
    api.js            # fetch wrappers for all API endpoints
    app.js            # SPA logic: state, render, event wiring
```

### State machine (app.js)
```
state.view: 'auth' → 'player' | 'profile'
state.authTab: 'login' | 'register'
state.profileTab: 'taste' | 'routines' | 'history'
state.nowPlaying: { say, play[], mood, audioUrl }
state.loading: boolean
```

### Rendering pipeline
```
render() → renderShell() + fillPlayer() / fillProfile()
fillPlayer() → renderPlayerContent() → renderSong(s, idx) per song
```

### Audio architecture
- `currentAudio` — single `Audio` object for DJ TTS narration
- YouTube iframes (`#yt-audio-<idx>`) in persistent `#audio-container` div (outside view slot)
- `currentPlayingIndex` / `currentIframePaused` track iframe state across re-renders
- `toggleYT(index, videoId)` — plays/pauses, stops previous, creates new iframe
- `ytMsg(index, func)` — sends postMessage commands to YouTube iframe

### i18n
- `LANGS.en` and `LANGS.zh` objects in `i18n.js`
- Language persisted to `localStorage` key `claudio_lang`
- Toggle button shows current opposite language label
- Song language selection driven by user message language (handled in Claude prompt)

---

## Phase 12 — PWA & Service Worker

### manifest.json
```json
{
  "name": "Claudio",
  "short_name": "Claudio",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#c8a96e",
  "icons": [{ "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }]
}
```

### icon.svg
SVG with 192×192 viewBox, dark rounded-rect background (`#0a0a0a`), gold serif "C" (`#c8a96e`).

### Service Worker (`sw.js`) — claudio-v8
- **Install**: pre-caches `['/', '/css/app.css', '/js/i18n.js', '/js/api.js', '/js/app.js']`, calls `skipWaiting()`
- **Activate**: deletes all old cache versions, calls `clients.claim()`
- **Fetch**: cache-first with network update for non-API GET requests; API paths bypass cache
- **Message**: responds to `{ type: 'keepalive' }` messages (prevents SW from sleeping during playback)
- App pings SW every 25 seconds via `navigator.serviceWorker.ready` + `setInterval`
- `controllerchange` event triggers `window.location.reload()` for seamless SW updates

---

## Phase 13 — Admin Backend

### Role column migration (`src/db/index.js`)
```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
```
Wrapped in `try/catch` — idempotent, no-op if column already exists.

### Auto-admin creation (`src/db/index.js`)
On first server start (no admin user found in DB):
- Creates user `admin@claudio.local` / username `admin` with role `admin`
- Password from `ADMIN_PASSWORD` env var, falls back to `claudio-admin-2026`
- Uses `bcrypt.hashSync` (sync) and `randomUUID` from Node.js built-in `crypto`
- Logs: `[DB] Admin created: admin@claudio.local / password from ADMIN_PASSWORD env`

### Admin middleware (`src/middleware/admin.js`)
`requireAdmin`:
1. Extracts Bearer token from `Authorization` header
2. Verifies JWT with `JWT_SECRET`
3. Queries `users.role` from DB — rejects with 403 if not `admin`
4. Attaches `req.user = payload`

### Admin routes (`src/routes/admin.js`) — all protected by `requireAdmin`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all users with active/inactive status |
| POST | `/api/admin/users/:uid/reset-password` | Reset any user's password |
| DELETE | `/api/admin/users/:uid` | Delete user (cannot delete self) |

Active status = `last_login` within 30 days. Response includes `{ total, active, inactive, users[] }`.

### Admin dashboard (`public/admin.html`)
Standalone HTML (not part of SPA):
- Deep dark theme matching main app, all CSS inline
- `sessionStorage` for token (clears on tab close)
- Login: POST `/api/auth/login` → verify admin access with GET `/api/admin/users`
- Stats cards: Total Users / Active (30 days) / Inactive
- Users table: Username · Email · Role · Registered · Last Login · Status · Actions
- Reset Password: `window.prompt()` → POST reset endpoint
- Delete User: `confirm()` → DELETE endpoint → reload users
- Clean URL: `/admin` (Express route before SPA catch-all)
- Cannot delete own account (server enforces; button hidden for current user)

---

## Phase 14 — Bug Fixes & UX Polish

### markPlayed button fix (app.js / renderSong)
- **Bug**: `markPlayed` button was not rendered in `renderSong()` output
- **Fix**: Added `rawName`, `rawArtist`, `rawQuery` variables using ` - ` separator (matching `markPlayed()` parser which splits on ` - `)
- Button rendered in flex row with `song-info` div, `event.stopPropagation()` prevents accidental navigation

### Play All / Next queue (app.js)

State vars added:
```javascript
let playQueueIndex = -1;   // index in _currentSongs currently playing
```

Functions:
- `stopAllPlayers()` — stops current iframe, resets `currentPlayingIndex`
- `updateQueueButtons()` — updates `#btn-play-all` label (Play All ↔ Next ▶)
- `playFromQueue(index)` — skips non-YT songs recursively, calls `toggleYT`
- `window.playAll()` — starts from index 0, or advances if queue already active
- `window.playNext()` — advances to next song in queue

`fillPlayer()` sets `window._currentSongs = state.nowPlaying?.play || []` before render.

Play All button rendered in `renderPlayerContent()` only when at least one song has a `yt.videoId`. Styled with `.btn-queue` (accent border + dim background).

YouTube ended → auto-advance:
```javascript
window.addEventListener('message', e => {
  // origin: 'https://www.youtube.com'
  // data: { event: 'onStateChange', info: 0 }  (0 = ENDED)
  // action: playFromQueue(playQueueIndex + 1)
});
```

i18n strings added: `playAll` (`Play All` / `全部播放`), `next` (`Next` / `下一首`).

### MediaSession API (app.js)

`updateMediaSession(title, artist)` sets lock-screen / OS media controls:
- `MediaMetadata({ title, artist, album: 'Claudio' })`
- Action handlers: `nexttrack` → `playNext()`, `pause` → pause iframe, `play` → resume iframe
- Called from `toggleYT` when starting a new song (not on pause/resume)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP port |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `CLAUDE_MODEL` | No | `claude-haiku-4-5` | Model ID |
| `JWT_SECRET` | Yes | — | JWT signing secret |
| `NCM_API_URL` | No | `http://localhost:3002` | NetEase API base URL |
| `FISH_TTS_KEY` | Yes | — | Fish Audio API key |
| `FISH_TTS_VOICE` | No | `073ff47193eb4f179da0d62e250bfd82` | Fish Audio voice ID |
| `YOUTUBE_API_KEY` | No | — | Reserved (unused; ytsr used instead) |
| `ADMIN_PASSWORD` | No | `claudio-admin-2026` | Admin account password |

---

## API Endpoints Summary

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Register new user |
| POST | `/api/auth/login` | — | Login, returns JWT |
| GET | `/api/auth/me` | JWT | Current user info |

### Radio
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/radio/decide` | JWT | Ask DJ for playlist |
| GET | `/api/radio/now` | JWT | Get last DJ decision |
| POST | `/api/radio/played` | JWT | Log a played song |
| GET | `/api/radio/song-url/:id` | — | Get NCM song URL |
| GET | `/api/radio/plan` | JWT | Get daily plans |
| POST | `/api/radio/plan/generate` | JWT | Generate plan on demand |

### Profile
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/profile` | JWT | Get user profile |
| GET | `/api/profile/taste` | JWT | Get taste.md content |
| PUT | `/api/profile/taste` | JWT | Update taste.md |
| GET | `/api/profile/routines` | JWT | Get routines.md content |
| PUT | `/api/profile/routines` | JWT | Update routines.md |
| GET | `/api/profile/history` | JWT | Get last 50 plays |

### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | Admin JWT | List all users |
| POST | `/api/admin/users/:uid/reset-password` | Admin JWT | Reset user password |
| DELETE | `/api/admin/users/:uid` | Admin JWT | Delete user |

### System
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | — | Health check |
| GET | `/api/tts/:filename` | — | Serve cached TTS audio |

---

## Known Limitations

- **NCM availability**: Some songs may not be playable due to regional licensing
- **YouTube iframe autoplay**: Browsers may block autoplay; the app unlocks audio on user click
- **ytsr deprecation risk**: `ytsr` v3 relies on YouTube HTML parsing; may break on YouTube changes
- **TTS cache unbounded**: `data/tts/` grows indefinitely; no eviction policy
- **Single admin**: No UI to grant admin role to other users (requires direct DB edit)
- **SW caching**: Static assets cached aggressively; version bump required to force update after JS/CSS changes

---

## Running the Server

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start

# In a persistent screen session
screen -S claudio
npm start
```

Default port: **3001**. Nginx reverse-proxied to `claudio.abai.cloud`.
