import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUserDb } from '../db/index.js';

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
- 根据用户心情调整节奏——用户开心时活泼跳脱，用户低落时轻柔有力
- 绝对禁止使用"根据您的需求"、"为您推荐"、"已为您"等客服体机器人语言
- say 字段 1-3 句，自然流畅，像真实DJ开场白

【say 字段格式要求】
- 纯口语文字，绝对不能包含任何 XML、SSML 或 HTML 标签（禁止 <break>、<prosody> 等任何尖括号标签）
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

Example 1 — 深夜低落，中文:
"今天压着你的那些事，放下一会儿吧。这首歌我特意留到现在放——它不会告诉你一切都会好，但它会陪你坐在这里。"

Example 2 — 早晨活力，中文:
"窗帘还没拉开？没关系，让音乐先进来。这一首，专门为你今天要做的那件事热身。"

Example 3 — 用户发英文，English:
"You didn't say much, but I heard you. This one's been sitting in my back pocket for a moment exactly like this."

Example 4 — 用户分享喜悦，中文:
"听到了！今天有点不一样对吧——那就该配一首同样不按常理出牌的歌。"`,

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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: langInstruction + '\n\n' + prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic API error:', response.status, err);
    return FALLBACK;
  }

  const data = await response.json();
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
