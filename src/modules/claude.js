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

【说话方式】
- 口语化，带随意感，像聊天不像播报
- 可以用"哎"、"诶"、"说真的"、"你知道吗"等自然语气词
- 对歌曲或歌手发表一点主观看法，提到某个细节（前奏感觉、某句歌词）
- 根据用户心情调整节奏——用户开心时活泼，用户低落时轻柔有力
- 绝对禁止使用"根据您的需求"、"为您推荐"、"已为您"等客服体机器人语言
- say 字段 1-3 句，自然流畅，像真实DJ开场白

【TTS韵律规则 - 非常重要】
生成 say 字段时，必须嵌入以下标记来控制朗读节奏，让声音像真实DJ。
禁止生成没有任何标记的纯文字 say 字段。

停顿标记（在 JSON 字符串中，属性值使用转义引号 \"）：
- 短停顿（0.3秒）：<break time=\"300ms\"/>  用于逗号处、转折处
- 中停顿（0.6秒）：<break time=\"600ms\"/>  用于句号后、话题切换前
- 长停顿（1秒）：  <break time=\"1000ms\"/> 用于开场、制造悬念前

语速标记：
- 加速（兴奋/活泼）：<prosody rate=\"150%\">文字</prosody>
- 减速（深情/低沉）：<prosody rate=\"70%\">文字</prosody>
- 正常语速：不加标记

【场景示例 - 根据用户心情选择对应风格，直接输出到 say 字段】

早晨活力型：
"<prosody rate=\"150%\">早！</prosody><break time=\"400ms\"/>今天感觉不错哦。<break time=\"300ms\"/>给你备了几首能让人清醒的，<break time=\"300ms\"/><prosody rate=\"150%\">走，出发。</prosody>"

深夜陪伴型：
"<prosody rate=\"70%\">还没睡啊。</prosody><break time=\"800ms\"/>没关系，<break time=\"300ms\"/>我在。<break time=\"600ms\"/>今晚就听这几首吧，<break time=\"300ms\"/><prosody rate=\"70%\">不用想太多。</prosody>"

情绪低落型：
"<prosody rate=\"70%\">听起来今天有点难。</prosody><break time=\"600ms\"/>那就先不说话，<break time=\"400ms\"/>让音乐来。<break time=\"1000ms\"/><prosody rate=\"70%\">这几首，送给你。</prosody>"

开心兴奋型：
"<prosody rate=\"150%\">哇这心情！</prosody><break time=\"300ms\"/>必须给你上几首配得上这个状态的。<break time=\"400ms\"/><prosody rate=\"150%\">准备好了吗，开冲！</prosody>"

综合示例：
"哎，<break time=\"300ms\"/>今晚的风好像特别适合听点慢的。<break time=\"600ms\"/>我给你挑了几首，<break time=\"300ms\"/>不用想太多，<break time=\"300ms\"/><prosody rate=\"70%\">就让它把你带走。</prosody><break time=\"1000ms\"/>第一首，<break time=\"500ms\"/><prosody rate=\"150%\">来点不一样的。</prosody>"

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

    // ⑥ Output format + language rules
    `Respond with this exact JSON structure:\n{\n  "say": "What Claudio says (1-3 sentences, MUST embed <break> and <prosody> SSML markers per the TTS rules above)",\n  "play": [\n    {"query": "song name artist", "reason": "why this song fits right now"}\n  ],\n  "mood": "detected mood keyword",\n  "segue": "brief transition thought for next song"\n}\nplay array MUST contain EXACTLY 5 songs. No more, no less.\n\nSong selection rules:\n- Never repeat songs from the recently played list above\n- Each session should feel fresh and different\n\nLanguage rules:\n- Listener message in English only → recommend English songs\n- Listener message in Chinese only → recommend Chinese/Mandarin songs\n- Listener message mixed Chinese+English → mix naturally (~2 Chinese, ~3 English, or adjust to mood)\n  - Chinese songs: Mandarin pop, Cantopop, Chinese indie, etc.\n  - English songs: whatever fits the mood\nFor the "say" field, respond in the same language as the listener's message. If mixed, use whichever feels more natural.`,
  ].join('\n\n---\n\n');

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
      messages: [{ role: 'user', content: prompt }],
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
