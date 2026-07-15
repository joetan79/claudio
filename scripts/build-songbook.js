// One-off/rerunnable songbook builder (Phase 8I) — not loaded by the running
// service. Generates candidate songs per category via the configured AI
// model, validates each against the live YT resolution chain + embeddability,
// and writes data/songbook.json.
//
// Full rebuild (every category, from scratch):
//   node scripts/build-songbook.js
//
// Targeted top-up (keeps existing entries, appends newly verified ones):
//   node scripts/build-songbook.js --categories=yue-new --batches=10
//   node scripts/build-songbook.js --categories=yue-new,zh-pop
import 'dotenv/config';
import { buildSongbook } from '../src/modules/songbook.js';

function parseArgs(argv) {
  const args = { categories: undefined, batches: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--categories=')) {
      args.categories = arg.slice('--categories='.length).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--batches=')) {
      args.batches = parseInt(arg.slice('--batches='.length), 10);
    }
  }
  return args;
}

const { categories, batches } = parseArgs(process.argv.slice(2));
const report = await buildSongbook({
  onProgress: msg => console.log(`[build-songbook] ${msg}`),
  categories,
  batches,
});

console.log('\n=== Songbook build report ===');
for (const [cat, stats] of Object.entries(report.categories)) {
  const added = stats.newlyAdded !== undefined ? ` newly_added=${stats.newlyAdded} total_now=${stats.totalNow}` : ` verified=${stats.verified}`;
  console.log(
    `${cat}: generated=${stats.generated}${added} rejection_rate=${(stats.rejectionRate * 100).toFixed(1)}%`
  );
}
console.log(`Total time: ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s`);
