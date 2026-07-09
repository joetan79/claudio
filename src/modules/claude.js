import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUserDb, getSystemDb } from '../db/index.js';
import { decrypt, isEncryptionEnabled } from './crypto.js';
import { recordUsage } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../data');

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
      result.play.push(last ? { ...last } : { query: 'something good', reason: '' });
    }
  }
  result.play = result.play.slice(0, 5);
  return result;
}

function detectLang(text) {
  if (!text || !text.trim()) return 'zh';
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return chineseChars === 0 && totalChars > 0 ? 'en' : 'zh';
}

function getUserAnthropicKey(uid) {
  if (!isEncryptionEnabled()) return null;
  const db = getSystemDb();
  const row = db.prepare('SELECT anthropic_key FROM users WHERE id = ?').get(uid);
  if (!row?.anthropic_key) return null;
  try {
    return decrypt(row.anthropic_key);
  } catch {
    console.warn('[claude] failed to decrypt stored user key');
    return null;
  }
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

  const prompt = [
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
"累了就累了，不用撑着。这首歌……就当是给自己一点空间，什么都不用做，听着就好。"`,

    // ⑥ Output format + language rules
    `Respond with this exact JSON structure:\n{\n  "say": "What Claudio says (1-3 sentences, plain conversational text only, no XML or SSML tags)",\n  "play": [\n    {"query": "song name artist", "reason": "why this song fits right now"}\n  ],\n  "mood": "detected mood keyword",\n  "segue": "brief transition thought for next song"\n}\nplay array MUST contain EXACTLY 5 songs. No more, no less.\n\nSong selection rules:\n- Never repeat songs from the recently played list above\n- Each session should feel fresh and different\n\nLanguage rules:\n- Listener message in English only → recommend English songs\n- Listener message in Chinese only → recommend Chinese/Mandarin songs\n- Listener message mixed Chinese+English → mix naturally (~2 Chinese, ~3 English, or adjust to mood)\n  - Chinese songs: Mandarin pop, Cantopop, Chinese indie, etc.\n  - English songs: whatever fits the mood\nFor the "say" field language:
- Listener writes entirely in English → "say" must be in English
- Listener writes entirely in Chinese → "say" must be in Chinese
- Listener writes in mixed or ambiguous language → "say" in Chinese`,
  ].join('\n\n---\n\n');

  const lang = detectLang(message);
  const langInstruction = lang === 'en'
    ? 'CRITICAL OVERRIDE: The listener wrote in English only. Your "say" field MUST be written entirely in English. Do not use any Chinese characters in "say".'
    : 'The listener wrote in Chinese. Your "say" field must be in Chinese.';

  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: langInstruction + '\n\n' + prompt }],
  });

  const userKey = getUserAnthropicKey(uid);
  const apiKey = userKey || process.env.ANTHROPIC_API_KEY;
  const ownKey = !!userKey;

  let response;
  const retryDelays = [3000, 8000, 15000];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const delay = retryDelays[attempt - 1] ?? 15000;
      console.warn(`[DJ] API overloaded, retry ${attempt}/3 in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
    if (response.status !== 529) break;
  }

  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic API error:', response.status, err);
    if (ownKey && (response.status === 401 || response.status === 403)) {
      throw Object.assign(new Error('Your API Key is invalid. Please check your key in Profile > API Keys.'), {
        code: 'OWN_KEY_INVALID',
        status: response.status,
      });
    }
    return FALLBACK;
  }

  const data = await response.json();
  if (data.usage) {
    recordUsage({
      uid,
      type: 'claude',
      model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      ownKey,
    });
  }
  const text = data.content?.[0]?.text ?? '';

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

export { getTimeOfDay };
