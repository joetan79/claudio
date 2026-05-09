# Claudio — Project Summary

生成日期：2026-05-09
URL：https://claudio.abai.cloud
VPS 路径：/home/claudeProj/claudio/

---

## 1. 项目概述

Claudio 是一个多用户个人 AI 电台平台（SaaS），用户注册后拥有自己的私人电台——每次告诉 Claudio 自己的心情或想法，AI DJ 就会根据用户的音乐品味档案、日常习惯、播放历史和当前环境，选出 3–5 首歌曲并生成一段 TTS 语音播报，同时通过 YouTube Iframe 实现在线收听；目标用户是希望获得个性化、自动化音乐体验而不想手动维护播放列表的普通听众。

---

## 2. 技术栈

| 层级 | 技术 | 备注 |
|------|------|------|
| Runtime | Node.js v22+ | ES Modules (`"type": "module"`)，无 `require` |
| Framework | Express 4 | 路由模块化，无 ORM |
| Database | SQLite (better-sqlite3) | WAL 模式，系统库 + 每用户独立库 |
| AI / DJ | Anthropic API | 默认 `claude-haiku-4-5`，可通过 `CLAUDE_MODEL` 覆盖 |
| Auth | JWT (jsonwebtoken) + bcryptjs | Bearer token，7 天有效期 |
| TTS | Fish Audio API | 结果以 MD5 哈希命名缓存到磁盘 |
| Music 搜索 | NCM (NeteaseCloudMusicApi) | 外部 Node 服务，`:3002` |
| Music 播放 | YouTube IFrame Player API | `ytsr` 负责搜索 videoId |
| Frontend | Vanilla JS SPA | 无构建步骤，无框架 |
| PWA | Service Worker + manifest.json | Cache-first，keepalive ping |
| i18n | 内建 LANGS 对象 | 中英文切换，持久化到 localStorage |

---

## 3. 系统架构

### 用户端（PWA Web App）

`public/` 目录下的纯 Vanilla JS SPA。无编译流程，浏览器直接加载三个 JS 文件（`i18n.js` → `api.js` → `app.js`）。支持 PWA 安装、离线启动（Service Worker cache-first）、MediaSession（锁屏/耳机控制）。Admin 后台为独立的 `admin.html`，不属于 SPA。

### API 层（Express）

`src/server.js` 启动 Express，挂载五个路由前缀：

```
/api/auth    → src/routes/auth.js
/api/radio   → src/routes/radio.js
/api/profile → src/routes/profile.js
/api/tts     → src/routes/tts.js
/api/admin   → src/routes/admin.js
/api/health  → 内联健康检查
```

静态文件从 `public/` 提供，`/admin` 路由单独处理，`*` 通配符兜底返回 `index.html`（SPA fallback）。

### 核心引擎

- **Claude DJ** (`src/modules/claude.js`)：读取用户 taste.md + routines.md + DB 记忆 + 播放历史，拼装多段 prompt，调用 Anthropic API，返回结构化 JSON（say / play / mood / segue）。
- **TTS** (`src/modules/tts.js`)：将 DJ 旁白合成为 MP3（Fish Audio），MD5 缓存到 `data/tts/`，后续请求直接命中缓存。
- **YouTube** (`src/modules/youtube.js`)：`ytsr` 搜索 `"query official audio"`，优先选 official/music/vevo 频道。
- **NCM** (`src/modules/ncm.js`)：向 `NCM_API_URL`（本机 `:3002`）查询歌曲元数据和播放 URL；播放 URL 由 YouTube 提供，NCM 仅用于歌名/歌手规范化。
- **Scheduler** (`src/modules/scheduler.js`)：服务启动时注册两个 setTimeout 循环，08:00 生成早间播单，22:00 生成夜间播单，写入每用户 `memory` 表。

### 数据层（SQLite per-user）

```
data/
  system.db              # 全局用户表 + sessions 表
  tts/                   # TTS MP3 缓存文件
  users/
    <uid>/
      state.db           # plays / memory / plan 三张表
      taste.md           # 用户可编辑的音乐口味档案
      routines.md        # 用户可编辑的日常习惯描述
```

---

## 4. 已实现功能清单

### 用户系统
- ✅ 注册（邮箱 + 用户名 + 密码，bcrypt hash）
- ✅ 登录（JWT，7 天有效）
- ✅ 自动登录（token 存 localStorage，刷新页面恢复会话）
- ✅ 注销
- ✅ 邮箱唯一性 + 用户名唯一性校验
- ✅ 用户名规则：3–20 字母数字；密码最少 8 位
- ✅ 每用户独立数据目录（注册时 `initUserDir` 自动创建）
- ✅ 管理员角色（role 字段，自动迁移，首次启动自动创建 admin 账号）

### DJ 决策引擎
- ✅ 根据用户消息 + 品味档案 + 日常习惯 + 记忆 + 播放历史生成推荐
- ✅ 时段感知（morning / afternoon / evening / night）
- ✅ 语言感知（英文 → 英文歌；中文 → 中文歌；混合 → 混合推荐）
- ✅ 避免重复最近播放的歌曲（last 20 plays 传入 prompt）
- ✅ 输出结构化 JSON（say / play / mood / segue）
- ✅ Markdown code fence 容错解析
- ✅ API 错误时返回 FALLBACK 常量，不崩溃
- ✅ 结果存入 `memory` 表（`last_decision`）供 `/api/radio/now` 复用

### 音乐播放
- ✅ NCM 搜索（歌名规范化）+ YouTube 搜索（videoId 获取）并行执行
- ✅ YouTube IFrame Player API 嵌入播放
- ✅ 单首播放（▶ Play / ⏸ Pause 切换）
- ✅ 播放互斥（切歌时销毁上一个 YT.Player 实例）
- ✅ Play All 队列顺序播放（1→N 首）
- ✅ Next 跳下一首
- ✅ 自动跳过无 `yt.videoId` 的歌曲
- ✅ 视频结束后自动推进队列（onStateChange ENDED）
- ✅ Mark as Played 按钮（记录到 `plays` 表）
- ✅ NCM 无版权时回退显示"YouTube ↗"外链按钮
- ✅ NCM 播放 URL 刷新端点（无鉴权，供 `<audio>` 元素使用）

### TTS 语音
- ✅ DJ 旁白自动合成（Fish Audio）
- ✅ MD5 磁盘缓存（相同文本复用，不重复调用 API）
- ✅ DJ 旁白在决策返回后自动播放（audio unlock 在 click 事件栈内完成）
- ✅ Replay DJ 按钮（可重播 TTS）
- ✅ TTS 文件通过 `/api/tts/<hash>.mp3` 提供，带 `Cache-Control: 86400`

### 调度器
- ✅ 08:00 自动为所有用户生成早间播单（`plan_morning`）
- ✅ 22:00 自动为所有用户生成夜间播单（`plan_night`）
- ✅ 调度播单同时合成 TTS 语音并缓存
- ✅ `GET /api/radio/plan` 读取当天早/夜播单
- ✅ `POST /api/radio/plan/generate` 手动按需触发生成

### 前端 PWA
- ✅ 三视图 SPA（auth / player / profile）
- ✅ 中英文切换（zh/en，持久化 localStorage）
- ✅ 深色主题（CSS 变量，金色 `#c8a96e` 强调色）
- ✅ MediaSession API（锁屏元数据、nexttrack/play/pause 操作）
- ✅ Service Worker（cache-first，keepalive ping，controllerchange 自动刷新）
- ✅ PWA 安装支持（manifest.json + icon.svg）
- ✅ 播放器页：DJ 说话卡片 + 歌曲列表 + Play All 队列控制
- ✅ Profile 页：Taste / Routines / History 三个子标签页
- ✅ 历史播放记录展示（最近 20 条）

### Admin 后台
- ✅ 独立页面 `/admin`，不依赖 SPA（`admin.html`）
- ✅ 用户总数 / 活跃（30 天）/ 非活跃统计卡片
- ✅ 用户列表（用户名、邮箱、角色、注册时间、最后登录、状态）
- ✅ 重置任意用户密码
- ✅ 删除用户（不能删除自己，前后端双重限制）
- ✅ token 存 sessionStorage（标签关闭自动登出）
- ✅ 登录后验证 admin 角色（用 `/api/admin/users` 确认）

---

## 5. 所有 API 端点

### 认证 (`/api/auth`)

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| POST | `/api/auth/register` | — | 注册新用户，返回 `{ ok, uid, username }` |
| POST | `/api/auth/login` | — | 登录，返回 `{ ok, token, uid, username }` |
| GET | `/api/auth/me` | JWT | 返回当前用户 `{ uid, username, email }` |

### 电台 (`/api/radio`)

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | `/api/radio/song-url/:id` | — | 获取 NCM 歌曲播放 URL（无鉴权，供 audio 元素刷新链接）|
| POST | `/api/radio/decide` | JWT | 调用 DJ 决策，返回 `{ say, play[], mood, segue, audioUrl }` |
| GET | `/api/radio/now` | JWT | 获取最近一次 DJ 决策（`last_decision`）|
| POST | `/api/radio/played` | JWT | 记录一首歌为已播放 |
| GET | `/api/radio/plan` | JWT | 获取今日早/夜播单 `{ morning, night }` |
| POST | `/api/radio/plan/generate` | JWT | 手动生成当前时段播单 |

### 个人档案 (`/api/profile`)

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | `/api/profile/me` | JWT | 返回 `{ uid, username, email, created_at }` |
| GET | `/api/profile/taste` | JWT | 读取 taste.md 内容 |
| PUT | `/api/profile/taste` | JWT | 写入 taste.md（最多 5000 字符）|
| GET | `/api/profile/routines` | JWT | 读取 routines.md 内容 |
| PUT | `/api/profile/routines` | JWT | 写入 routines.md（最多 5000 字符）|
| GET | `/api/profile/history` | JWT | 返回最近 20 条播放记录 |

### TTS 音频 (`/api/tts`)

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | `/api/tts/:hash.mp3` | — | 提供缓存 TTS MP3 文件（hash 须为 32 位十六进制）|

### Admin (`/api/admin`)

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | `/api/admin/users` | Admin JWT | 列出所有用户及状态统计 |
| POST | `/api/admin/users/:uid/reset-password` | Admin JWT | 重置指定用户密码 |
| DELETE | `/api/admin/users/:uid` | Admin JWT | 删除指定用户（不能删自己）|

### 系统

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | `/api/health` | — | 健康检查，返回 `{ status: 'ok', service: 'claudio', ts }` |

---

## 6. 数据库结构

### `data/system.db`（全局系统库）

**表：`users`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `email` | TEXT UNIQUE NOT NULL | 邮箱 |
| `password_hash` | TEXT NOT NULL | bcrypt hash（cost 10）|
| `username` | TEXT UNIQUE NOT NULL | 3–20 字母数字 |
| `role` | TEXT NOT NULL DEFAULT 'user' | `'user'` 或 `'admin'`（ALTER TABLE 热迁移）|
| `created_at` | INTEGER NOT NULL | Unix 毫秒时间戳 |
| `last_login` | INTEGER | Unix 毫秒时间戳，可为 NULL |

**表：`sessions`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `token_hash` | TEXT PK | — |
| `user_id` | TEXT NOT NULL | — |
| `created_at` | INTEGER NOT NULL | — |
| `expires_at` | INTEGER NOT NULL | — |

> 注：`sessions` 表已创建但未使用，当前认证完全基于 JWT（无服务端 session 状态）。

### `data/users/<uid>/state.db`（每用户库）

**表：`plays`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | — |
| `song_id` | TEXT | NCM 歌曲 ID（可为 NULL）|
| `song_name` | TEXT | 歌曲名称 |
| `artist` | TEXT | 艺人 |
| `played_at` | INTEGER | Unix 毫秒时间戳 |
| `source` | TEXT | 来源标识（目前写入时未填充）|

**表：`memory`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | TEXT PK | 键名（如 `last_decision`、`plan_morning`、`plan_night`）|
| `value` | TEXT | JSON 序列化字符串 |
| `updated_at` | INTEGER | Unix 毫秒时间戳 |

**表：`plan`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | TEXT PK | — |
| `content` | TEXT | — |
| `generated_at` | INTEGER | — |

> 注：`plan` 表为历史遗留（CHANGELOG 标注"legacy"），当前播单已改为存入 `memory` 表（`plan_morning` / `plan_night`），此表未被任何路由写入或读取。

### 每用户 Markdown 文件

| 文件 | 说明 |
|------|------|
| `data/users/<uid>/taste.md` | 音乐口味档案，用户可自由编辑，最多 5000 字符 |
| `data/users/<uid>/routines.md` | 日常习惯描述，用户可自由编辑，最多 5000 字符 |

---

## 7. 环境变量

从 `.env.example` 读取：

| 变量名 | 用途 | 是否必填 | 默认值 |
|--------|------|----------|--------|
| `PORT` | HTTP 监听端口 | 否 | `3001` |
| `ANTHROPIC_API_KEY` | Claude API 密钥 | **是** | — |
| `CLAUDE_MODEL` | 使用的 Claude 模型 ID | 否 | `claude-haiku-4-5` |
| `JWT_SECRET` | JWT 签名密钥 | **是** | — |
| `NCM_API_URL` | NetEase Cloud Music API 地址 | 否 | `http://localhost:3002` |
| `FISH_TTS_KEY` | Fish Audio TTS API 密钥 | **是** | — |
| `FISH_TTS_VOICE` | Fish Audio 声音 reference_id | 否 | `073ff47193eb4f179da0d62e250bfd82` |
| `YOUTUBE_API_KEY` | YouTube Data API 密钥 | 否 | — |
| `ADMIN_PASSWORD` | 首次启动自动创建 admin 账号的密码 | 否 | `claudio-admin-2026` |

> `YOUTUBE_API_KEY` 已在 `.env.example` 保留但实际 **未使用**，YouTube 搜索通过 `ytsr`（HTML 解析）实现，不调用 YouTube Data API。

---

## 8. 前端功能说明

### 三个视图

| 视图 | 触发条件 | 内容 |
|------|----------|------|
| `auth` | 未登录 / 初始状态 | Login / Register 两个子标签，顶部语言切换 |
| `player` | 登录后默认 / 底部导航"电台" | DJ 说话卡片 + 歌曲列表 + 输入框 |
| `profile` | 底部导航"我的" | 用户信息 + Taste / Routines / History 三个子标签 |

### 语言切换（zh / en）

- `i18n.current` 从 `localStorage` 读取，默认 `'en'`
- 点击顶部按钮调用 `i18n.toggle()`，写回 localStorage，触发 `render()` 全量重渲染
- 按钮文字始终显示**当前语言对应的另一种语言**（en 显示"中文"，zh 显示"English"）
- DJ 的歌曲语言选择由 Claude prompt 中的 Language Rules 控制，与前端语言设置独立

### 播放器功能

**单首播放（▶ Play / ⏸ Pause）**

每首歌对应一个 `#yt-btn-<idx>` 按钮，点击调用 `toggleYT(index, videoId)`：
- 若当前歌曲已在播放 → 调用 `YT.Player.pauseVideo()` / `playVideo()` 切换
- 若点击其他歌曲 → 销毁当前 `YT.Player` 实例，创建新实例

**播放互斥（切歌停止上一首）**

`toggleYT` 在创建新播放器前，遍历所有 `ytPlayers` 对象，调用 `destroy()` 并清理 DOM 节点和按钮状态，确保任意时刻只有一个视频在播放。

**Play All（顺序播放 1→N 首）**

- 点击"▶ Play All"：将 `window._currentSongs` 复制为 `playQueue`，从 index 0 开始 `playFromQueue()`
- 队列激活后按钮变为"Next ▶"，再次点击调用 `playNext()`
- 自动跳过无 `yt.videoId` 的歌曲（递归调用 `playFromQueue`）
- 当前歌曲 `ENDED` 时（`YT.PlayerState.ENDED`），延迟 800ms 自动推进队列
- 队列播完后 `btn.disabled = true`，`opacity: 0.4`

**Next（跳下一首）**

`window.playNext()` 销毁当前 YT.Player，`playQueueIndex++`，再调用 `playFromQueue()`。

**Mark as Played**

每首歌右上角有"Played"按钮，点击后：
1. 按钮 disabled + 文字变"✓" + opacity 0.4
2. 调用 `api.played(song_name, artist, '')` 写入 `plays` 表
3. 失败静默处理（按钮保持 disabled 状态）

### TTS 自动播放机制

iOS / 浏览器要求 Audio 对象必须在用户手势事件栈内创建并调用过 `play()`。实现方式：

1. 用户点击"Tell Claudio"按钮（同步栈内）：立即创建 `currentAudio = new Audio()` 并播放一个空白 WAV，完成"unlock"
2. `await api.decide(msg)` 等待 API 响应（异步，但 Audio 对象已解锁）
3. 决策返回后：`currentAudio.src = decision.audioUrl`，`currentAudio.play()`
4. Replay DJ 按钮调用 `playDJAudio(audioUrl)` 复用同一 `currentAudio` 对象

### MediaSession 支持

播放新歌时调用 `updateMediaSession(title, artist)`：
- 设置 `MediaMetadata`（title、artist、album: 'Claudio'）
- 注册 `nexttrack` → `window.playNext()`
- 注册 `pause` → `YT.Player.pauseVideo()`
- 注册 `play` → `YT.Player.playVideo()`

锁屏界面和蓝牙耳机的媒体控件生效。

### PWA 安装支持

- `public/manifest.json`：`display: standalone`，`start_url: /`，黑底金字 SVG 图标
- `public/sw.js`：缓存版本 `claudio-v10`，预缓存 `/`、`/css/app.css`、`/js/i18n.js`、`/js/api.js`、`/js/app.js`
- app.js 注册 SW 并每 25 秒发送 `keepalive` 消息防止 SW 休眠（维持后台播放稳定性）
- `controllerchange` 事件触发 `window.location.reload()` 实现无感 SW 更新

---

## 9. 运维说明

### 启动和重启

```bash
# 开发模式（文件变更自动重启）
npm run dev

# 生产模式
npm start
```

### Screen 会话

```bash
# 查看所有 screen 会话
screen -ls

# 进入 claudio 会话
screen -r claudio

# 新建 claudio 会话
screen -S claudio
npm start

# 从会话中分离（不停止服务）
Ctrl+A, D
```

### 日志查看

当前版本无文件日志，所有输出通过 `console.log` / `console.error` 到 stdout：

```bash
# 若在 screen 内，进入会话直接查看输出
screen -r claudio

# 若用 PM2 或重定向启动
tail -f /path/to/app.log
```

> 注：CLAUDE.md 中提到 `tail -f logs/app.log`，但代码中实际**没有文件日志写入逻辑**，日志仅输出到 stdout。

### Nginx 配置

Nginx 将 `claudio.abai.cloud` 反代到本机 `:3001`。配置示意：

```nginx
server {
    server_name claudio.abai.cloud;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### SSL 证书

通过 Certbot (Let's Encrypt) 管理：

```bash
# 续期所有证书
certbot renew

# 查看证书状态
certbot certificates
```

---

## 10. 已知问题和限制

| 问题 | 说明 |
|------|------|
| **iOS 背景播放限制** | iOS Safari 在页面进入后台后可能暂停 YouTube iframe 播放，SW keepalive 只能部分缓解 |
| **ytsr 稳定性风险** | `ytsr` v3 依赖 YouTube HTML 解析，YouTube 页面结构变更可能导致搜索失败，且包长期未更新 |
| **NCM 区域封锁** | 部分歌曲因版权原因无法播放（返回 null URL），此时仅显示 YouTube 外链按钮 |
| **NCM 登录态** | 当前 NCM API 以匿名方式调用，无 cookie/token 注入，无版权曲目比已登录状态更多 |
| **YOUTUBE_API_KEY 未使用** | 环境变量保留但无实现，YouTube 搜索完全依赖 `ytsr` HTML 解析 |
| **调度器无持久化** | Scheduler 使用 `setTimeout` 实现，服务重启后下次触发时间重新计算，不会补跑错过的任务 |
| **TTS 缓存无上限** | `data/tts/` 目录持续增长，无清理/过期策略 |
| **sessions 表废弃** | `system.db` 中的 `sessions` 表已建立但从未被写入或查询 |
| **plan 表废弃** | 每用户 `state.db` 中的 `plan` 表为历史遗留，当前播单存入 `memory` 表 |
| **单管理员** | 无界面将普通用户提升为 admin，只能直接操作 SQLite |
| **无文件日志** | 生产环境日志仅 stdout，重启 screen 会话后历史日志丢失 |
| **source 字段未填充** | `plays` 表的 `source` 字段在所有写入路径（`/api/radio/played` 和调度器）中均未填充 |

---

## 11. 下一步建议

### 短期（可立即做）

- **补全文件日志**：在 `server.js` 中接管 `console.log` 输出到文件（如 `winston` 或简单 `fs.createWriteStream`），解决 screen 会话丢失历史的问题
- **清理废弃表**：`plan` 表和 `sessions` 表可在下次迁移时移除，减少混淆
- **填充 `source` 字段**：在 `markPlayed` 路径写入 `'user'`，在调度器写入 `'scheduler'`，便于统计分析
- **更新 SW 版本号文档**：`sw.js` 中实际是 `claudio-v10`，CHANGELOG 记录的是 `v8`，需同步
- **admin 升级 UI**：在 admin 后台增加"Set as Admin"按钮（一个 PUT 端点 + 前端按钮即可）

### 中期（需要一定工作量）

- **TTS 缓存清理**：实现 LRU 或按时间过期的缓存清理，防止磁盘无限增长
- **调度器持久化**：用 `node-cron` 替换 `setTimeout`，或记录最后执行时间到 DB，重启后判断是否需要补跑
- **YouTube 搜索替代方案**：评估 `yt-search`、`ytdl-core` 或 YouTube Data API v3（需配置 `YOUTUBE_API_KEY`）作为 `ytsr` 的备选，增强稳定性
- **NCM cookie 注入**：在 NCM API 服务启动时配置登录 cookie，提高可播放率
- **播放历史分页**：当前 history 固定返回 20 条，可增加 `?limit&offset` 参数支持翻页
- **天气 API 接入**：`djDecision` context 中 `weather` 字段当前始终为空字符串，可接入免费天气 API（如 Open-Meteo）完善上下文

### 长期（需要较大改动）

- **WebSocket 实时推送**：`package.json` 中已包含 `ws` 依赖但未实现，可用于调度器完成后实时推送播单到前端（目前用户需手动刷新）
- **多 Admin 支持**：完整的角色权限体系，支持在 UI 中管理角色
- **播放数据分析**：基于 `plays` 表做用户口味自动分析，反馈到 DJ prompt（当前需用户手动写 taste.md）
- **移动端原生应用**：PWA 已支持安装，但背景播放在 iOS 受限，可考虑 Capacitor/React Native 封装

---

## 12. VPS 共存说明

当前 VPS（abai.cloud 系列域名）上运行以下服务：

### 服务一览

| 服务 | 技术 | 端口 | 进程方式 | 域名 |
|------|------|------|----------|------|
| **ainews** | Python / uvicorn | `:8000` | screen ainews | news.abai.cloud |
| **agentbot** | Python worker | — | screen（无 HTTP）| — |
| **ia_bot** | Python worker | — | screen（无 HTTP）| — |
| **ncm** | NeteaseCloudMusicApi (Node.js) | `:3002` | screen ncm | 仅内网访问 |
| **claudio** | Node.js / Express | `:3001` | screen claudio | claudio.abai.cloud |
| **claude** | Claude Code CLI | — | 开发用，交互式 | — |

### 端口分配

| 端口 | 服务 | 备注 |
|------|------|------|
| `80` / `443` | Nginx | 反代入口，SSL 终止 |
| `3001` | claudio | Node.js Express 服务 |
| `3002` | ncm | NeteaseCloudMusicApi，仅 claudio 内部调用 |
| `8000` | ainews | uvicorn，对外通过 Nginx 反代 |

### Nginx 域名配置

| 域名 | 后端 | 备注 |
|------|------|------|
| `claudio.abai.cloud` | `127.0.0.1:3001` | 本项目 |
| `news.abai.cloud` | `127.0.0.1:8000` | ainews（2026-04-17 从 abai.cloud 迁移）|

### 共用 Anthropic API Key 说明

`ANTHROPIC_API_KEY` 在 VPS 上被多个服务共享：
- **claudio**：调用 `claude-haiku-4-5`（每次 DJ 决策 + 调度器）
- **agentbot / ia_bot**：各自独立调用（具体模型按各自配置）

注意事项：
- 共享同一 Key 意味着共享同一速率限制（RPM / TPM）和月度用量上限
- claudio 调度器每天为所有注册用户各调用两次 Claude，用户增多后调度器 token 消耗线性增长
- 建议在 Anthropic Console 的 Usage 页面设置用量告警

---

*本文档由 Claude Code 根据源代码自动生成，2026-05-09。*
