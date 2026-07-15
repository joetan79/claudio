// One-off/rerunnable songbook builder (Phase 8I) — not loaded by the running
// service. Run with: node scripts/build-songbook.js
// Generates candidate songs per category via the configured AI model,
// validates each against YT Music + embeddability, and writes data/songbook.json.
import 'dotenv/config';
import { buildSongbook } from '../src/modules/songbook.js';

const report = await buildSongbook({ onProgress: msg => console.log(`[build-songbook] ${msg}`) });

console.log('\n=== Songbook build report ===');
for (const [cat, stats] of Object.entries(report.categories)) {
  console.log(
    `${cat}: generated=${stats.generated} verified=${stats.verified} rejection_rate=${(stats.rejectionRate * 100).toFixed(1)}%`
  );
}
console.log(`Total time: ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s`);
