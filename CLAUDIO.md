# CLAUDIO.md — Claudio AI Radio SaaS

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Location:** `/home/claudeProj/claudio/`  
**URL:** https://claudio.abai.cloud (proxied by Nginx → port 3001)  
**Running:** screen session `claudio`  
**Last updated:** 2026-05-08

---

## What is Claudio?

Claudio is a multi-user personal AI radio platform. Each registered user gets their own AI DJ ("Claudio") that knows their music taste and daily routines. The DJ decides what to say and what songs to play, delivers a TTS voice message, and surfaces music via NCM (NetEase Cloud Music) and YouTube. Two daily playlists (morning 08:00, night 22:00) are auto-generated for all users.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js v22+ (ES Modules only — `import/export`, no `require`) |
| Framework | Express 4 |
| Database | SQLite via `better-sqlite3` — one system DB + one per-user DB |
| AI | Anthropic Claude (`claude-haiku-4-5` default) via raw `fetch` to API |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) |
| TTS | Fish Audio API (`FISH_TTS_KEY`) — MP3 cached by MD5 hash |
| Music | NCM API (`NCM_API_URL`, self-hosted NeteaseCloudMusicApi on port 3002) |
| YouTube | `ytsr` package — fallback song search |
| PWA | `manifest.json` + `sw.js` service worker |
| i18n | `public/js/i18n.js` — frontend string translations |

---

## Run & Restart

```bash
# Production (inside screen claudio)
screen -r claudio
# Ctrl+C to stop, then:
npm start
# Ctrl+A D to detach

# Development (hot reload)
npm run dev

# Logs
tail -f logs/app.log

# Port check
lsof -i :3001
kill -9 $(lsof -t -i:3001)
```

Port: **3001** (both dev and prod). Nginx proxies `claudio.abai.cloud` → `127.0.0.1:3001`.

---

## File Structure

```
src/
  server.js               # Entry point: Express setup, routes mount, getSystemDb(), startScheduler()
  middleware/
    auth.js               # requireAuth — JWT Bearer token verification
  db/
    index.js              # getSystemDb(), getUserDb(uid), initUserDir(uid)
  modules/
    claude.js             # djDecision() — builds DJ prompt, calls Anthropic API, returns JSON
    tts.js                # synthesize(text) — Fish Audio API, MD5 cache, returns /api/tts/<hash>.mp3
    ncm.js                # resolveSong(query), getSongUrl(id) — NetEase Cloud Music API
    youtube.js            # searchYouTube(query) — ytsr, prefers official/VEVO channels
    scheduler.js          # startScheduler() — setTimeout-based daily plans at 08:00 and 22:00
  routes/
    auth.js               # POST /api/auth/register, POST /api/auth/login, GET /api/auth/me
    radio.js              # POST /api/radio/decide, GET /api/radio/now, POST /api/radio/played,
                          #   GET /api/radio/plan, POST /api/radio/plan/generate
                          #   GET /api/radio/song-url/:id  (no auth — for <audio> refresh)
    profile.js            # GET/PUT /api/profile/taste, GET/PUT /api/profile/routines,
                          #   GET /api/profile/history, GET /api/profile/me
    tts.js                # GET /api/tts/:hash.mp3 — serves cached TTS audio files

public/
  index.html              # SPA shell (all routing done client-side)
  js/
    app.js                # Main frontend app logic
    api.js                # API client helpers
    i18n.js               # Frontend string translations
  css/
    app.css               # All styles
  manifest.json           # PWA manifest
  sw.js                   # Service worker

data/                     # Runtime data (gitignored)
  system.db               # Users + sessions tables
  tts/                    # TTS MP3 cache (MD5-named files)
  users/
    <uid>/
      state.db            # Per-user: plays, memory, plan tables
      taste.md            # User's music taste description (free text, up to 5000 chars)
      routines.md         # User's daily routines description (free text, up to 5000 chars)
```

---

## Environment Variables (.env)

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port | `3001` |
| `ANTHROPIC_API_KEY` | Claude API key | required |
| `CLAUDE_MODEL` | Model to use | `claude-haiku-4-5` |
| `JWT_SECRET` | JWT signing secret | required |
| `NCM_API_URL` | NetEase Cloud Music API base URL | `http://localhost:3002` |
| `FISH_TTS_KEY` | Fish Audio API key | required for TTS |
| `FISH_TTS_VOICE` | Fish Audio voice reference ID | `073ff47193eb4f179da0d62e250bfd82` |
| `YOUTUBE_API_KEY` | YouTube (unused in current code — ytsr doesn't need it) | optional |

---

## Database Schema

### `data/system.db`

```sql
users (
  id           TEXT PRIMARY KEY,   -- UUID v4
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  username     TEXT UNIQUE NOT NULL,  -- 3-20 alphanumeric
  created_at   INTEGER NOT NULL,
  last_login   INTEGER
)

sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
)
```

### `data/users/<uid>/state.db`

```sql
plays (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id   TEXT,
  song_name TEXT,
  artist    TEXT,
  played_at INTEGER,
  source    TEXT
)

memory (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
)

plan (
  date         TEXT PRIMARY KEY,
  content      TEXT,
  generated_at INTEGER
)
```

`memory` table stores the last DJ decision under key `last_decision` (JSON), plus any other per-user facts.  
`plan_morning` and `plan_night` are also stored in `memory` (not `plan` table).

---

## API Routes

### Auth (`/api/auth`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/register` | None | Register — creates user + initializes user dir with `taste.md`, `routines.md`, `state.db` |
| POST | `/login` | None | Login — returns JWT (7-day expiry) |
| GET | `/me` | Bearer | Current user info |

### Radio (`/api/radio`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/decide` | Bearer | Main DJ decision — Claude picks songs + say text; TTS + NCM + YouTube resolved in parallel |
| GET | `/now` | Bearer | Last decision from user's `memory` table |
| POST | `/played` | Bearer | Record a song play |
| GET | `/plan` | Bearer | Get `plan_morning` and `plan_night` from memory |
| POST | `/plan/generate` | Bearer | Manually generate a plan (morning or night based on current hour) |
| GET | `/song-url/:id` | None | Refresh NCM song URL (called by `<audio>` element on expiry) |

### Profile (`/api/profile`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET/PUT | `/taste` | Bearer | Read/write `taste.md` (max 5000 chars) |
| GET/PUT | `/routines` | Bearer | Read/write `routines.md` (max 5000 chars) |
| GET | `/history` | Bearer | Last 20 plays from `state.db` |
| GET | `/me` | Bearer | User profile |

### TTS (`/api/tts`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/:hash.mp3` | None | Serve cached TTS MP3 (MD5 hash validated, 24h browser cache) |

---

## Core Logic: DJ Decision (`src/modules/claude.js`)

`djDecision(uid, userMessage, context)` builds a structured prompt and calls Anthropic:

**Prompt sections (in order):**
1. DJ persona — "You are Claudio, a personal AI DJ…"
2. Listener's `taste.md` + `routines.md` (read from filesystem)
3. Current environment — time of day, weather, mood, `memory` table facts
4. Recent plays (last 10 from DB)
5. Avoid instruction — do not repeat recently played songs
6. Listener's message
7. Output format + language rules

**Language rules:**
- English message only → English songs
- Chinese message only → Chinese/Mandarin songs
- Mixed → ~2 Chinese + ~3 English (or adjust to mood)
- `say` field responds in same language as listener

**Response format (JSON):**
```json
{
  "say": "1-2 warm sentences from Claudio",
  "play": [{"query": "song name artist", "reason": "why this fits"}],
  "mood": "detected mood keyword",
  "segue": "brief transition thought"
}
```
3–5 songs per decision. On parse failure, strips markdown code fences and retries JSON.parse. Falls back to neutral FALLBACK object if all else fails.

**After `djDecision` in `/decide` route:**  
TTS synthesis + NCM resolution + YouTube search all run in `Promise.all` (parallel). NCM result normalizes display name; YouTube provides iframe-embeddable fallback. Result saved to `memory` table under key `last_decision`.

---

## Scheduler (`src/modules/scheduler.js`)

Uses `setTimeout` (not APScheduler or cron). On startup `startScheduler()` is called:
- Calculates ms until next 08:00 → fires morning plan generation, then reschedules itself every 24h
- Calculates ms until next 22:00 → fires night plan generation, then reschedules itself every 24h

`generateDailyPlan()` iterates all users in `system.db`, calls `djDecision()` + `synthesize()` for each, saves result to `memory` table under `plan_morning` or `plan_night`.

---

## TTS Cache (`src/modules/tts.js`)

- `synthesize(text)` hashes text with MD5, checks `data/tts/<hash>.mp3` first (cache hit = instant return)
- Cache miss → POST to Fish Audio API with `FISH_TTS_VOICE` reference ID, format `mp3`
- Returns URL path `/api/tts/<hash>.mp3` served by `routes/tts.js`
- Returns `null` if `FISH_TTS_KEY` not set (graceful degradation — app still works without audio)

---

## Music Sources (`src/modules/ncm.js` + `src/modules/youtube.js`)

**NCM** (NetEase Cloud Music API, self-hosted at `NCM_API_URL`):
- `searchSong(query)` → returns first result: `{id, name, artist, album}`
- `getSongUrl(songId)` → returns streamable URL (expires — refreshed via `/song-url/:id`)
- `resolveSong(query)` → search + URL in one call

**YouTube** (`ytsr`):
- `searchYouTube(query)` → searches `"<query> official audio"`, prefers official/VEVO/music channels
- Returns `{videoId, title, channel}` — used as iframe embed fallback

In `/decide` route, both NCM and YouTube are resolved in parallel for each song in `decision.play`.

---

## Auth Flow

Register → bcrypt hash password (10 rounds) → UUID v4 uid → insert `users` row → `initUserDir(uid)` creates `data/users/<uid>/` with `state.db`, `taste.md`, `routines.md`.

Login → bcrypt compare → `jwt.sign({uid, username}, JWT_SECRET, {expiresIn: '7d'})` → token returned to client.

`requireAuth` middleware verifies Bearer token, attaches `{uid, username}` to `req.user`.

---

## Development Conventions

- **ES Modules only** — all files use `import/export`. No `require()` anywhere.
- **Router files** export a default Express Router.
- **DB operations** are in `src/db/` or inline in routes — no raw SQL in business logic modules.
- **Errors** returned as `{ error: "message" }` with appropriate HTTP status.
- **No WebSocket active** — `ws` is in `package.json` but not wired up in `server.js` (reserved for future use).

---

## Development History

Claudio has no git history (no `.git` folder in project directory). The following is reconstructed from code state and the existing `CLAUDE.md`:

### Initial Build
- Express + SQLite architecture with per-user database isolation (`data/users/<uid>/state.db`)
- JWT auth with bcrypt, UUID v4 user IDs
- `djDecision()` in `claude.js` — AI DJ prompt with taste/routines/memory/history context
- Fish Audio TTS integration with MD5 file cache
- NCM (NetEase Cloud Music API) for song resolution
- Daily scheduler (setTimeout-based) for morning (08:00) and night (22:00) plans

### Added YouTube Fallback
- `src/modules/youtube.js` — `ytsr` search with official/VEVO channel preference
- `/decide` route resolves NCM + YouTube in parallel for each song
- YouTube `videoId` available as iframe-embeddable fallback when NCM URL expires

### Song URL Refresh
- `GET /api/radio/song-url/:id` (no auth) — allows `<audio>` elements to refresh expired NCM links without re-auth

### Plan System
- `GET /api/radio/plan` — reads `plan_morning` / `plan_night` from user memory
- `POST /api/radio/plan/generate` — on-demand plan generation (determines morning/night by current hour)
- Scheduler saves plans to `memory` table under `plan_morning` / `plan_night` keys

### PWA + i18n
- `public/manifest.json` + `sw.js` service worker for PWA install support
- `public/js/i18n.js` frontend i18n strings

### Profile Routes
- `GET/PUT /api/profile/taste` and `/routines` — free-text markdown files per user (max 5000 chars)
- `GET /api/profile/history` — last 20 plays
- These files are injected directly into the `djDecision` prompt — editing them changes DJ behavior immediately

---

## Key Notes for Future Development

- **`taste.md` and `routines.md` are the primary personalization mechanism** — the DJ prompt reads these files directly. Editing them (via profile API) immediately changes recommendations.
- **No WebSocket currently wired up** — `ws` package installed but `server.js` does not create a WebSocket server. Can be added for real-time playback sync.
- **TTS is optional** — `synthesize()` returns `null` gracefully if `FISH_TTS_KEY` is missing. All routes handle `audioUrl: null`.
- **NCM song URLs expire** — the frontend must call `/song-url/:id` to refresh before playback fails. This route intentionally has no auth to work inside `<audio src>` attributes.
- **Scheduler does not persist** — if server restarts mid-day, the next plan generation will happen at the next scheduled hour (not immediately). No recovery mechanism currently.
- **Per-user DB isolation** — each user's play history, memory, and plans are in their own SQLite file. No cross-user queries needed.
- **`FISH_TTS_VOICE`** default `073ff47193eb4f179da0d62e250bfd82` is the reference voice ID for Fish Audio. Change in `.env` to use a different voice.
