import { getSystemDb, getUserDb } from '../db/index.js';
import { djDecision, detectProfileLang } from './claude.js';
import { synthesize } from './tts.js';
import { resolveVoiceByLang } from './settings.js';

function getNextTriggerMs(hour) {
  const now = new Date();
  const target = new Date();
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

async function generateDailyPlan(timeLabel, message, timeOfDay) {
  const db = getSystemDb();
  const users = db.prepare("SELECT id, username FROM users WHERE role != 'admin'").all();
  console.log(`[Scheduler] ${timeLabel} — generating for ${users.length} users`);

  for (const user of users) {
    try {
      const context = { weather: '', timeOfDay, recentPlays: [], currentMood: '' };
      const decision = await djDecision(user.id, message, context);

      const userDb = getUserDb(user.id);
      userDb.prepare(
        'INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, ?)'
      ).run(`plan_${timeLabel}`, JSON.stringify(decision), Date.now());

      // No live listener message for a scheduler-triggered plan — pick the
      // voice from the user's taste profile's primary language instead.
      if (decision.say) await synthesize({ text: decision.say, uid: user.id, voice: resolveVoiceByLang(detectProfileLang(user.id)) });

      console.log(`[Scheduler] Done for ${user.username}`);
    } catch (e) {
      console.error(`[Scheduler] Failed for ${user.username}:`, e.message);
    }
  }
}

export function startScheduler() {
  const morningDelay = getNextTriggerMs(8);
  console.log(`[Scheduler] Morning plan in ${Math.round(morningDelay / 1000 / 60)} minutes`);
  setTimeout(function scheduleMorning() {
    generateDailyPlan('morning', 'Good morning, what should I start my day with?', 'morning');
    setTimeout(scheduleMorning, 24 * 60 * 60 * 1000);
  }, morningDelay);

  const nightDelay = getNextTriggerMs(22);
  console.log(`[Scheduler] Night plan in ${Math.round(nightDelay / 1000 / 60)} minutes`);
  setTimeout(function scheduleNight() {
    generateDailyPlan('night', 'Wind down time, something for late night.', 'night');
    setTimeout(scheduleNight, 24 * 60 * 60 * 1000);
  }, nightDelay);
}
