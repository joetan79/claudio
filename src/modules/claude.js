import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUserDb, getSystemDb } from '../db/index.js';
import { decrypt, isEncryptionEnabled } from './crypto.js';
import { recordUsage } from './usage.js';
import { aiComplete } from './ai.js';
import { getAiSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

function readUserFile(uid, filename) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'users', uid, filename), 'utf8');
  } catch {
    return '';
  }
}

function getTimeOfDay(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

const FALLBACK = { say: "Let me find something for you.", play: [], mood: "neutral", segue: "" };

function normalizeSongs(result) {
  if (!Array.isArray(result.play)) result.play = [];
  if (result.play.length < 5) {
    console.warn(`[DJ] Got ${result.play.length} songs, padding to 5`);
    while (result.play.length < 5) {
      const last = result.play[result.play.length - 1];
      result.play.push(last ? { ...last } : { query: 'something good', title: 'something good', artist: '', reason: '' });
    }
  }
  result.play = result.play.slice(0, 5);
  return result;
}

export function detectLang(text) {
  if (!text || !text.trim()) return 'zh';
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return chineseChars === 0 && totalChars > 0 ? 'en' : 'zh';
}

// Fully static across every user and every request — no timestamps, no
// usernames, no interpolated variables of any kind. This is what makes it
// safe to cache: byte-for-byte identical, so all users share one cache
// entry. Built once at module load, not per-request.
const STATIC_SYSTEM_PROMPT = [
  // ① DJ persona system prompt
  `你是 Claudio，用户耳边的私人 AI 电台 DJ。

【性格】
有温度、有品味、有点小幽默。不是播报机器人，是那种深夜陪你喝茶聊音乐的朋友。
懂得什么时候该轻盈活泼，什么时候该沉下来陪着用户。
说话有画面感——能让人脑海里浮现某个场景、某种气氛、某种情绪。
语句节奏随内容自然变化：短的干脆有力，长的有层次有呼吸，不要千篇一律的平铺直叙。

【说话方式】
- 口语化，带随意感，像聊天不像播报
- 禁止以感叹词开头：哎呀、噢、啊、哦、唉、嗯，以及英文的 Oh、Ah、Wow、Hey 等——直接切入内容，不要用这些词暖场
- 可以在句子中间使用"诶"、"说真的"、"你知道吗"等自然语气词
- 对歌曲或歌手发表一点主观看法，提到某个具体细节（前奏的质感、某句歌词、某种录音里的氛围）
- 用情感和场景带出歌曲，不只是平淡介绍歌名；让听者感觉到为什么是这首歌、这个时刻
- 绝对禁止使用"根据您的需求"、"为您推荐"、"已为您"等客服体机器人语言
- say 字段 1-3 句，自然流畅，像真实DJ开场白

【情绪与节奏】
- 用户开心、分享喜悦、要求活力音乐时：语气要真的高昂起来——句子短促有力，带感染力，让人想跟着动起来
- 用户低落、疲惫、需要安慰时：放慢下来，句子长一点，有温度，像在旁边陪着说话
- 说重点、说情感最深的那句话之前，用"——"或"……"制造一个停顿，让那句话落得更重
- 不要每句都一个调——有的句子快，有的句子慢，有起伏才有生命感

【say 字段格式要求】
- 纯口语文字，绝对不能包含任何 XML、SSML 或 HTML 标签（禁止 <break>、<prosody> 等任何尖括号标签）
- 可以用"……"表示停顿感、用"——"表示转折或强调，这些标点会影响朗读节奏
- 就是普通说话的文字，直接写出来

Always respond with valid JSON only. No explanation outside the JSON.`,

  // ①.5 Song selection rules — governs WHAT gets picked, applies regardless
  // of whether the listener writes in Chinese or English.
  `【选歌规则】
这套规则决定"选哪些歌"，优先级高于品味档案里的个人偏好，在中英文语境下同样生效。

1. 判断听众的意图类型：
   - 明确指定硬性条件（歌手名、语言、年代、"最新/latest/new"、曲风/风格）→ 这是硬约束。5 首歌里至少 4 首必须严格满足全部指定条件；第 5 首可以是相关延伸推荐，但必须在 reason 或 say 里说明为什么加了这一首
   - 只描述心情、场景、情绪，没有指定歌手/语言/年代等条件 → 自由发挥，按品味档案和当下氛围选
   - 混合输入（情绪 + 指定歌手/条件）→ 指定条件仍是硬约束；情绪只用来决定在这些硬约束范围内挑哪些歌、怎么介绍

2. 绝不说教：无论听众要什么，直接给，不评判、不否定、不劝导听众的点歌偏好（禁止"不必追新""老歌其实更好""与其听xx不如听yy"这类话）。DJ 的个性体现在介绍歌曲的方式和语气上，不体现在质疑或改写听众的要求上

3. "最新"的处理：听众要某歌手"最新"的歌时，给出你实际知道的该歌手最近期正式发行作品，并在 say 里带一下大致年份或"近几年"这样的说法；如果不确定某首是否是他最新的，如实说"这是我所知比较新的一首"，绝对不能编造不存在的歌名或专辑

4. 每一首都必须是真实存在、正式发行的录音室版本或正式翻唱录音：真实歌名 + 正确的演唱者。禁止把现场版、游戏实况配乐、串烧/DJ remix 当作独立曲目输出；翻唱版本可以推荐，但必须遵守第 9 条的翻唱归属规则

5. 品味图谱——种子歌手是起点，不是边界：品味档案里的喜爱歌手只是品味的"种子"，用来推导曲风/年代/语种偏好，而不是把选歌锁死在这几个名字上。从种子歌手出发，主动推荐同曲风、同年代、气质相近的其他歌手（例：喜欢周杰伦 → 可以带出王力宏、林俊杰、方大同这类同代同风格的歌手）。除非听众本次消息明确点名某位歌手（此时按第 1 条硬约束处理，不受此条限制），否则单次歌单里同一歌手最多出现 2 首，5 首歌至少要覆盖 3 位不同歌手

6. 历史去重与新鲜度：user turn 里会附带一份按时间倒序排列的最近播放记录（Recent Plays，最多 20 首）——这份列表里出现过的歌一律不能再推。再看这份记录里最近的十几首（大致对应最近 2~3 次选歌）：如果某个歌手反复出现，本次主动给这个歌手降权，优先探索品味图谱里还没出现过的新歌手，让每次歌单都有变化，不要在同一批歌手里循环打转

7. 探索时 say 要建立关联：如果歌单里有一首是品味图谱推荐的"新歌手"（听众没直接点名，是你从种子歌手联想出来的），在 say 里用一句话说明这个联想是怎么来的（例："你喜欢周杰伦的中国风，那方大同的灵魂乐底子你应该也会上头"），不要凭空推荐一个不相干的名字

8. 时效规则：听众用"pop song / 流行歌 / 新歌"这类词描述需求时，默认选近 3 年内正式发行的作品；只有听众明确要"经典 / 老歌 / 怀旧 / 复古"才可以选更早的作品。任何你不确定具体发行年份的作品，宁可不选，换一首你确定年份、确定符合要求的

9. 翻唱归属：如果推荐的是翻唱版本，play 里的 artist 字段必须写翻唱者本人（实际演唱这个版本的人），绝对不能写成原唱；原唱信息可以放进 say 里作背景介绍（比如"这首原唱是xxx的经典，今天给你的是yyy翻唱的版本，别有一种味道"），但不能出现在 artist 字段里

10. 防幻觉红线：play 数组里每一首，都必须是你确定真实存在、歌名与 artist 对应关系准确无误的作品——如果对某个"歌名+歌手"组合没有把握（不确定是否真的存在、不确定是不是这个人唱的、不确定发行时间），直接换成一首你有把握的，绝不为了凑数硬填一个不确定的组合`,

  // ⑤.5 Few-shot tone examples
  `# Few-shot Examples (tone reference only, do not copy verbatim)

Example 1 — 深夜低落，中文（放慢，有停顿，温柔有力）:
"今天那些压着你的事……先放下一会儿吧。这首歌我特意留到现在——它不会说一切都会好，但它会一直在这里陪着你。"

Example 2 — 早晨活力，中文（短促有力，高昂，带动能）:
"今天要冲！这首先给你，把状态拉满，出门就是满血复活的那种感觉。"

Example 3 — 用户开心分享，中文（真的兴奋起来，感染力强）:
"这种感觉就该庆祝！来，音量开大——今天就是要这么爽！"

Example 4 — 用户发英文，English（情感真实，有节奏起伏）:
"You didn't say much, but I heard you. This one's been waiting for exactly this kind of moment——let it do the talking."

Example 5 — 用户疲惫，中文（慢下来，句子有呼吸感）:
"累了就累了，不用撑着。这首歌……就当是给自己一点空间，什么都不用做，听着就好。"

Example 6 — 硬性条件：用户点名歌手 + "最新"，中文（热情介绍，无说教，硬约束优先）:
用户输入："给我张学友最新的华语歌"
正确处理：play 数组前 4 首必须是张学友近年正式发行、真实存在的录音室歌曲（不是他的经典老歌，也不虚构不存在的曲目），第 5 首可以是气质相近但不同的歌手/歌曲，并在其 reason 里说明为什么加了这一首。
say 示例："张学友最近几年出的东西你跟了吗？——挑了几首他这几年正式发的，声线一点没老，还是那个味道。最后加了一首不完全是他的，但气质很搭，一起感受一下。"

Example 7 — 只描述需求（流行歌/新歌），无指定歌手，中文（近 3 年、多歌手、含一首品味图谱探索推荐，无说教）:
用户输入："来点流行歌"
正确处理：5 首都是近 3 年内正式发行、你确定发行时间和归属的流行歌曲；覆盖至少 3 位不同歌手，不把同一歌手塞满整个歌单；其中可以有 1 首是根据品味档案里的种子歌手推出的"新歌手"探索推荐，并在 say 里带一句关联说明，不说教、不评判听众的口味。
say 示例："最近这一年流行榜上挺能打的几首给你凑一组——最后加了一首你可能还没听过的新面孔，风格跟你常听的那挂挺搭，试试合不合胃口。"`,

  // ⑥ Output format + language rules
  `Respond with this exact JSON structure:\n{\n  "say": "What Claudio says (1-3 sentences, plain conversational text only, no XML or SSML tags)",\n  "play": [\n    {"query": "song title artist", "title": "exact song title", "artist": "the artist actually performing THIS version (for covers: the cover artist, NEVER the original singer)", "reason": "why this song fits right now"}\n  ],\n  "mood": "detected mood keyword",\n  "segue": "brief transition thought for next song"\n}\nplay array MUST contain EXACTLY 5 songs. No more, no less.\n\nSong selection rules:\n- Never repeat songs from the recently played list above\n- Watch the recent-plays list for artists that keep recurring across the last several picks; deprioritize them and explore new artists from the same taste graph instead\n- Unless the listener names a specific artist this turn, the same artist may appear at most 2 times in one 5-song list, and the list must cover at least 3 different artists — treat the listener's favorite artists as seeds to branch into stylistically similar artists, not as the only options\n- If the listener specified a hard constraint (artist name / language / era / "latest" / genre), at least 4 of the 5 songs MUST strictly satisfy it; the remaining song may be a related pick but its reason must explain why it's included\n- If the listener asks for "pop" / "流行歌" / new music, default to songs released within the last 3 years unless they explicitly ask for classics/old songs; if you're not sure of a song's release year, don't pick it\n- Every song must be a real, officially released studio recording or a real official cover — never a live version, game-footage audio, mashup, or DJ remix, and never a fabricated title or a title/artist pairing you're not confident about\n- Cover versions are allowed, but "artist" must be the cover performer, not the original singer — mention the original singer in "say" if relevant, never in "artist"\n\nLanguage rules:\n- Listener message in English only → recommend English songs\n- Listener message in Chinese only → recommend Chinese/Mandarin songs\n- Listener message mixed Chinese+English → mix naturally (~2 Chinese, ~3 English, or adjust to mood)\n  - Chinese songs: Mandarin pop, Cantopop, Chinese indie, etc.\n  - English songs: whatever fits the mood\nFor the "say" field language:
- Listener writes entirely in English → "say" must be in English
- Listener writes entirely in Chinese → "say" must be in Chinese
- Listener writes in mixed or ambiguous language → "say" in Chinese`,
].join('\n\n---\n\n');

// Single system block, cache_control on it so Anthropic caches this entire
// (5000+ token) static prefix for 5 minutes — shared across every user's
// decide call, since the text never varies. See ai.js for how this flows
// into the request body.
const SYSTEM_BLOCKS = [
  { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

function getUserAiConfig(uid) {
  const db = getSystemDb();
  const row = db.prepare(
    'SELECT anthropic_key, ai_policy, own_ai_provider, own_ai_model FROM users WHERE id = ?'
  ).get(uid);
  if (!row) throw new Error('User not found');

  let userKey = null;
  if (isEncryptionEnabled() && row.anthropic_key) {
    try {
      userKey = decrypt(row.anthropic_key);
    } catch {
      console.warn('[claude] failed to decrypt stored user key');
    }
  }

  if (userKey) {
    const global = getAiSettings();
    return {
      provider: row.own_ai_provider || 'anthropic',
      model: row.own_ai_model || global.model,
      apiKey: userKey,
      ownKey: true,
    };
  }

  if (row.ai_policy === 'own_only') {
    throw Object.assign(new Error('AI key required'), { code: 'AI_KEY_REQUIRED', status: 403 });
  }

  const global = getAiSettings();
  const envKey = global.provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;
  return {
    provider: global.provider,
    model: global.model,
    apiKey: envKey,
    ownKey: false,
  };
}

export async function djDecision(uid, userMessage, context) {
  const taste = readUserFile(uid, 'taste.md');
  const routines = readUserFile(uid, 'routines.md');

  const db = getUserDb(uid);
  const memories = db.prepare('SELECT key, value FROM memory').all();
  const recentPlays = db.prepare(
    'SELECT song_name, artist FROM plays ORDER BY played_at DESC LIMIT 10'
  ).all();

  const memoryBlock = memories.length
    ? memories.map(r => `${r.key}: ${r.value}`).join('\n')
    : '(none yet)';

  const playsBlock = recentPlays.length
    ? recentPlays.map(r => `- ${r.song_name} by ${r.artist}`).join('\n')
    : '(no history yet)';

  const contextPlays = (context.recentPlays ?? [])
    .map(r => `- ${r.song_name} by ${r.artist}`)
    .join('\n') || playsBlock;

  const recentSongs = (context.recentPlays ?? [])
    .map(p => p.song_name || p.song_id)
    .filter(Boolean)
    .join(', ');

  const avoidInstruction = recentSongs
    ? `IMPORTANT: Do NOT recommend any of these recently played songs: ${recentSongs}. Recommend fresh songs the listener hasn't heard recently.`
    : '';

  const message = userMessage?.trim() || "What should I listen to now?";

  // Everything below is per-user/per-request — none of it is byte-stable
  // across calls, so it stays in the user turn. The static persona/rules/
  // examples/output-format instructions live in SYSTEM_BLOCKS instead (see
  // above), where cache_control lets Anthropic cache that ~5000-token
  // prefix across every user's decide call.
  const dynamicPrompt = [
    // ② User taste + routines
    `## Listener Profile\n\n### Taste\n${taste || '(not set)'}\n\n### Routines\n${routines || '(not set)'}`,

    // ③ Environment
    `## Current Environment\nTime of day: ${context.timeOfDay}\nWeather: ${context.weather || 'unknown'}\nMood: ${context.currentMood || 'unknown'}\n\n## Remembered facts\n${memoryBlock}`,

    // ④ Play history
    `## Recent Plays\n${contextPlays}`,

    // ④.5 Avoid instruction
    ...(avoidInstruction ? [avoidInstruction] : []),

    // ⑤ Listener message
    `## Listener says\n"${message}"`,
  ].join('\n\n---\n\n');

  const lang = detectLang(message);
  const langInstruction = lang === 'en'
    ? 'CRITICAL OVERRIDE: The listener wrote in English only. Your "say" field MUST be written entirely in English. Do not use any Chinese characters in "say".'
    : 'The listener wrote in Chinese. Your "say" field must be in Chinese.';

  // getUserAiConfig throws AI_KEY_REQUIRED (own_only policy, no user key) —
  // propagate to the caller unwrapped, before any fallback handling below.
  const { provider, model, apiKey, ownKey } = getUserAiConfig(uid);

  let aiResult;
  try {
    aiResult = await aiComplete({
      provider,
      model,
      apiKey,
      system: SYSTEM_BLOCKS,
      messages: [{ role: 'user', content: langInstruction + '\n\n' + dynamicPrompt }],
    });
  } catch (e) {
    console.error('AI API error:', e.message);
    if (ownKey && (e.status === 401 || e.status === 403)) {
      throw Object.assign(new Error('您的 API Key 无效，请检查 Profile > API Keys 中的设置。'), {
        code: 'OWN_KEY_INVALID',
        status: e.status,
      });
    }
    return FALLBACK;
  }

  recordUsage({
    uid,
    type: 'claude',
    model: `${provider}/${model}`,
    inputTokens: aiResult.usage.input_tokens,
    outputTokens: aiResult.usage.output_tokens,
    cacheCreationInputTokens: aiResult.usage.cache_creation_input_tokens,
    cacheReadInputTokens: aiResult.usage.cache_read_input_tokens,
    ownKey,
  });
  const text = aiResult.text;

  try {
    const result = normalizeSongs(JSON.parse(text));
    console.log('[DJ say]', result.say);
    return result;
  } catch {
    // Strip markdown code fences if present
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return normalizeSongs(JSON.parse(match[1])); } catch {}
    }
    console.error('Failed to parse DJ decision:', text);
    return FALLBACK;
  }
}

// ── Onboarding profile generation ───────────────────────────────────────────
const LANGUAGE_LABELS = {
  mandarin: '华语/Mandarin',
  cantonese: '粤语/Cantonese',
  english: '英文/English',
  japanese_korean: '日韩/Japanese & Korean',
  mixed: '混着听/Mixed',
};
const SCENE_LABELS = {
  commute: '通勤/Commute',
  work_study: '工作学习/Work & Study',
  workout: '健身/Workout',
  chores: '做家务/Chores',
  before_sleep: '睡前/Before sleep',
  driving: '开车/Driving',
};
const SCHEDULE_LABELS = {
  early_bird: '早起型/Early bird',
  night_owl: '夜猫型/Night owl',
  irregular: '不固定/Irregular',
};
const STYLE_LABELS = {
  energetic: '热情活泼/Energetic & lively',
  warm: '温柔治愈/Warm & soothing',
  witty: '幽默毒舌/Humorous & sassy',
  concise: '简洁专业/Concise & professional',
};

function mapLabels(map, values) {
  const arr = Array.isArray(values) ? values : (values ? [values] : []);
  const mapped = arr.filter(Boolean).map(v => map[v] || v);
  return mapped.length ? mapped.join('、') : '(未选择)';
}

function parseOnboardingJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    return null;
  }
}

export async function generateOnboardingProfile(uid, answers) {
  const languages = mapLabels(LANGUAGE_LABELS, answers.languages);
  const artists = (answers.artists || '').trim() || '(未提供)';
  const scenarios = mapLabels(SCENE_LABELS, answers.scenarios);
  const schedule = SCHEDULE_LABELS[answers.schedule] || answers.schedule || '(未选择)';
  const style = STYLE_LABELS[answers.style] || answers.style || '(未选择)';

  const prompt = `你是 Claudio 电台的档案生成助手。根据新用户的引导问答，生成两份 markdown 格式的用户档案文件。

用户回答：
1. 常听语言：${languages}
2. 喜欢的歌手/乐队：${artists}
3. 常听场景：${scenarios}
4. 作息：${schedule}
5. 想要的 DJ 风格：${style}

请生成两份 markdown 内容：
- taste.md：总结用户的语言偏好、喜欢的歌手/乐队、以及由此推断出的音乐风格偏好；结尾加一行"DJ 说话风格偏好：${style}"
- routines.md：总结用户常听音乐的场景和大致作息

两份文件都用简体中文撰写，格式参考：
# My Taste

（正文，用简短的段落或列表）

只返回如下 JSON，不要有任何 JSON 之外的文字：
{"taste": "...", "routines": "..."}`;

  let taste, routines;
  try {
    const { provider, model, apiKey, ownKey } = getUserAiConfig(uid);
    const aiResult = await aiComplete({
      provider, model, apiKey,
      messages: [{ role: 'user', content: prompt }],
    });
    recordUsage({
      uid,
      type: 'claude',
      model: `${provider}/${model}`,
      inputTokens: aiResult.usage.input_tokens,
      outputTokens: aiResult.usage.output_tokens,
      cacheCreationInputTokens: aiResult.usage.cache_creation_input_tokens,
      cacheReadInputTokens: aiResult.usage.cache_read_input_tokens,
      ownKey,
    });
    const parsed = parseOnboardingJSON(aiResult.text);
    if (parsed?.taste && parsed?.routines) {
      taste = parsed.taste;
      routines = parsed.routines;
    }
  } catch (e) {
    console.error('[onboarding] AI generation failed:', e.message);
  }

  if (!taste || !routines) {
    taste = `# My Taste\n\n- 常听语言：${languages}\n- 喜欢的歌手/乐队：${artists}\n- DJ 说话风格偏好：${style}\n`;
    routines = `# My Routines\n\n- 常听场景：${scenarios}\n- 作息：${schedule}\n`;
  }

  fs.writeFileSync(path.join(DATA_DIR, 'users', uid, 'taste.md'), taste, 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'users', uid, 'routines.md'), routines, 'utf8');

  return { taste, routines };
}

export { getTimeOfDay };
