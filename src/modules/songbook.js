import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aiComplete } from './ai.js';
import { getAiSettings } from './settings.js';
import { resolveSongVideoBudgeted } from './youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SONGBOOK_PATH = path.resolve(__dirname, '../../data/songbook.json');

// Five seed categories (Phase 8I) — lang drives which one(s) a live decide
// request samples from (see pickSongbookSample); era ('new'/'classic'/null)
// lets English stay a single pool since "new vs classic" isn't a request
// pattern for it the way "新潮粤语" vs "经典粤语" is.
const CATEGORIES = {
  'yue-new': {
    lang: 'yue', target: 100,
    seed: '近3年内活跃的新世代Cantopop歌手/组合，例如MIRROR系成员(姜濤、陳卓賢、呂爵安、Anson Lo等)、林家谦、张天赋、Serrini、Gareth.T、moon tang、Cloud 雲浩影、COLLAR、Dear Jane、泳兒近期作品等。要真实存在、正式发行的粤语录音室歌曲。',
  },
  'yue-classic': {
    lang: 'yue', target: 100,
    seed: '经典粤语金曲，涵盖80年代至2015年左右的Cantopop代表作，例如张国荣、谭咏麟、梅艳芳、Beyond、陈奕迅早期作品、许冠杰、容祖儿、古巨基、郑秀文、谢霆锋等歌手的经典录音室歌曲。',
  },
  'zh-pop': {
    lang: 'zh', target: 100,
    seed: '近3-5年内发行的华语流行歌曲，涵盖周杰伦、林俊杰、五月天、邓紫棋、田馥甄、华晨宇、单依纯、告五人等歌手/乐队风格的流行金曲，要真实存在、正式发行的国语录音室歌曲。',
  },
  'zh-classic': {
    lang: 'zh', target: 100,
    seed: '经典华语金曲，涵盖80年代至2015年左右的Mandopop代表作，例如邓丽君、张学友、周华健、齐秦、王菲、张信哲、刘若英、莫文蔚、任贤齐、孙燕姿等歌手的经典录音室歌曲。',
  },
  'en-pop': {
    lang: 'en', target: 100,
    seed: '当代英文流行歌曲，涵盖Taylor Swift、Ed Sheeran、Dua Lipa、Bruno Mars、The Weeknd、Billie Eilish、Ariana Grande等歌手的正式发行录音室歌曲，可以是近几年的新歌也可以是过去10-15年内的流行金曲。',
  },
};

const BATCHES_PER_CATEGORY = 4;
const SONGS_PER_BATCH = 30;
const VERIFY_CONCURRENCY = 3;
const VERIFY_DELAY_MS = 150;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseSongLines(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('|'))
    .map(l => {
      const [name, artist, year, lang] = l.split('|').map(p => p.trim());
      if (!name || !artist) return null;
      return { name, artist, year: year || '', lang: lang || '' };
    })
    .filter(Boolean);
}

function dedupeKey(s) {
  return `${s.name}|${s.artist}`.toLowerCase().replace(/\s+/g, '');
}

async function generateBatch(cfg, alreadyGenerated) {
  const avoidList = alreadyGenerated.length
    ? `\n\n已生成过的歌曲(避免重复，不要再输出这些)：\n${alreadyGenerated.map(s => `${s.name}|${s.artist}`).join('\n')}`
    : '';
  const prompt = `你是音乐数据库整理助手。请列出 ${SONGS_PER_BATCH} 首符合以下描述的真实存在、正式发行的歌曲：

${cfg.seed}

每首歌一行，严格按格式：歌名|歌手|年份|lang
- lang 固定填 "${cfg.lang}"
- 只填你非常确定真实存在的歌名与歌手对应关系，不确定的不要编造凑数
- 歌手字段：如果这位歌手在 YouTube 上通常也以英文艺名标注（例如张国荣=Leslie Cheung、谭咏麟=Alan Tam、梅艳芳=Anita Mui、陈奕迅=Eason Chan），把中文名和英文名都写上，用"、"分隔，例如"张国荣、Leslie Cheung"；只有中文名的歌手正常只写中文名即可
- 不要输出编号、标题、解释文字，只输出 ${SONGS_PER_BATCH} 行数据${avoidList}`;

  const { provider, model } = getAiSettings();
  const apiKey = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;
  const result = await aiComplete({ provider, model, apiKey, messages: [{ role: 'user', content: prompt }] });
  return parseSongLines(result.text);
}

async function generateCategoryCandidates(cfg, onProgress) {
  const seen = new Set();
  const all = [];
  for (let b = 0; b < BATCHES_PER_CATEGORY; b++) {
    const batch = await generateBatch(cfg, all);
    for (const s of batch) {
      const key = dedupeKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }
    onProgress?.(`batch ${b + 1}/${BATCHES_PER_CATEGORY} -> ${all.length} unique candidates so far`);
  }
  return all;
}

// Verifies every candidate through the SAME tier1->2->3 resolution chain a
// live decide request uses (resolveSongVideoBudgeted), not just a YT-Music
// -only check — an earlier version only tried tier1 and rejected nearly
// everything (including definitely-real songs like Beyond's "海阔天空"),
// because tier1's own embeddability pass rate is near-zero by itself (see
// youtube.js's note on regionRestriction) and the live pipeline always
// relies on falling through to tier2/3. A songbook entry should mean
// "actually resolves to a playable video," which is exactly what the full
// chain checks. Light concurrency + a per-call delay avoid burst-hitting
// search endpoints (spec: "加轻限速避免触发限制"). The rejection rate here
// is a real measurement of the current model's song-hallucination rate for
// this category, not just a filter — worth logging/reporting, not hiding.
async function verifyCandidates(candidates, onProgress) {
  const verified = [];
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const my = idx++;
      const c = candidates[my];
      // Search query uses only the primary (first) artist name — a combined
      // "张国荣、Leslie Cheung" string as the literal search query would
      // confuse relevance ranking; the full multi-name string still goes
      // into `artist` so the correlation check's OR-match (splitArtists)
      // accepts either name, since these classic artists are often
      // catalogued on YouTube under the English name alone.
      const primaryArtist = c.artist.split(/[、,，]/)[0].trim();
      const winner = await resolveSongVideoBudgeted({ query: `${c.name} ${primaryArtist}`, title: c.name, artist: c.artist }).catch(() => null);
      if (winner) {
        // Store the AI-generated name/artist as-is (not winner.title/artist)
        // — this exact text is what gets shown to Claude in the "参考曲库"
        // block (see pickSongbookSample), so it's also what Claude is most
        // likely to echo back in a future play[] pick. Storing the verified
        // catalog title instead would risk it never matching that echo,
        // silently losing the videoId fast-path (radio.js's
        // lookupSongbookVideoId). Only the videoId itself comes from the
        // resolution result.
        verified.push({ name: c.name, artist: c.artist, year: c.year, lang: c.lang, videoId: winner.videoId });
      }
      await sleep(VERIFY_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, () => worker()));
  onProgress?.(`verified ${verified.length}/${candidates.length} (rejected ${(100 * (1 - verified.length / candidates.length)).toFixed(1)}%)`);
  return verified;
}

// Full rebuild — generates candidates per category (AI, batched with a
// running avoid-list to reduce cross-batch duplicates), then validates every
// candidate against YT Music before it's allowed into the songbook. Not run
// automatically; invoked by scripts/build-songbook.js (CLI, one-off/rerunnable)
// or the admin "重建曲库" button (async job, see admin.js).
export async function buildSongbook({ onProgress } = {}) {
  const startedAt = Date.now();
  const categories = {};
  const report = { categories: {} };

  for (const [catKey, cfg] of Object.entries(CATEGORIES)) {
    onProgress?.(`[${catKey}] generating candidates...`);
    const candidates = await generateCategoryCandidates(cfg, msg => onProgress?.(`[${catKey}] ${msg}`));
    onProgress?.(`[${catKey}] verifying ${candidates.length} candidates against YT Music...`);
    const verified = await verifyCandidates(candidates, msg => onProgress?.(`[${catKey}] ${msg}`));
    categories[catKey] = verified;
    report.categories[catKey] = {
      generated: candidates.length,
      verified: verified.length,
      rejectionRate: candidates.length ? 1 - verified.length / candidates.length : 0,
    };
  }

  const finishedAt = Date.now();
  const songbook = { categories, builtAt: finishedAt };
  fs.mkdirSync(path.dirname(SONGBOOK_PATH), { recursive: true });
  fs.writeFileSync(SONGBOOK_PATH, JSON.stringify(songbook, null, 2), 'utf8');
  cachedSongbook = songbook;
  cachedMtime = fs.statSync(SONGBOOK_PATH).mtimeMs;

  report.startedAt = startedAt;
  report.finishedAt = finishedAt;
  return report;
}

// ── Runtime read path ───────────────────────────────────────────────────────

let cachedSongbook = null;
let cachedMtime = 0;

function loadSongbook() {
  try {
    const stat = fs.statSync(SONGBOOK_PATH);
    if (cachedSongbook && stat.mtimeMs === cachedMtime) return cachedSongbook;
    cachedSongbook = JSON.parse(fs.readFileSync(SONGBOOK_PATH, 'utf8'));
    cachedMtime = stat.mtimeMs;
    return cachedSongbook;
  } catch {
    return null;
  }
}

// "新/潮流/最新" -> the -new pool; "经典/老歌/怀旧/复古" -> the -classic
// pool; neither mentioned -> blend both (English has no new/classic split,
// so this only affects zh/yue category selection).
const NEW_KEYWORDS = /新|潮流|最新|latest|new\b/i;
const CLASSIC_KEYWORDS = /经典|老歌|怀旧|复古|classic|old\b/i;

function detectEra(message) {
  if (NEW_KEYWORDS.test(message)) return 'new';
  if (CLASSIC_KEYWORDS.test(message)) return 'classic';
  return null;
}

function sampleN(arr, n) {
  if (arr.length <= n) return [...arr];
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

const SAMPLE_COUNT = 50; // within the spec's 40-60 target range

// Random per-request sample (Phase 8I task 3/5) for prompt injection — a
// fresh draw every call so repeat requests don't always see the same slice
// of the pool. Returns null when no songbook has been built yet, or the
// language has no verified entries — callers should treat that as "no
// reference pool available this turn," not an error.
export function pickSongbookSample(lang, message) {
  const songbook = loadSongbook();
  if (!songbook) return null;

  let catKeys;
  if (lang === 'en') {
    catKeys = ['en-pop'];
  } else {
    const prefix = lang === 'yue' ? 'yue' : 'zh';
    const era = detectEra(message);
    catKeys = era ? [`${prefix}-${era}`] : [`${prefix}-new`, `${prefix}-classic`];
  }

  const pools = catKeys.map(k => songbook.categories[k] || []).filter(p => p.length);
  if (!pools.length) return null;

  const perPool = Math.ceil(SAMPLE_COUNT / pools.length);
  const picked = pools.flatMap(p => sampleN(p, perPool)).slice(0, SAMPLE_COUNT);
  if (!picked.length) return null;

  const text = picked.map(s => `${s.name}|${s.artist}|${s.year}`).join('\n');
  return { text, count: picked.length, categories: catKeys };
}

function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Cross-references a DJ-picked {title, artist} against the loaded songbook
// to find its pre-verified videoId, if any — lets radio.js skip the YT
// search chain entirely for songbook-sourced picks (Phase 8I task 4). Exact
// normalized title match required; artist match is lenient (substring
// either direction) since Claude sometimes echoes a slightly different
// artist string (e.g. a dropped featured artist) than the songbook entry.
export function lookupSongbookVideoId(title, artist) {
  const songbook = loadSongbook();
  if (!songbook) return null;
  const tKey = normalizeKey(title);
  if (!tKey) return null;
  const aKey = normalizeKey(artist);
  for (const entries of Object.values(songbook.categories)) {
    for (const entry of entries) {
      if (!entry.videoId || normalizeKey(entry.name) !== tKey) continue;
      const entryAKey = normalizeKey(entry.artist);
      if (!aKey || entryAKey.includes(aKey) || aKey.includes(entryAKey)) return entry;
    }
  }
  return null;
}

export function getSongbookStats() {
  const songbook = loadSongbook();
  if (!songbook) return null;
  const categories = {};
  for (const [k, v] of Object.entries(songbook.categories)) categories[k] = v.length;
  return { builtAt: songbook.builtAt, categories };
}
