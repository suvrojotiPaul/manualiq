// Ingest new or changed files from data/inbox/manuals (PDF) and data/inbox/databases (.sqlite/.db/.sql).
//   npm run ingest-inbox
// Unchanged files (same SHA-256 as last time) are skipped. Same pipeline as uploads in the UI.
// Run it while the server is stopped, or let the server do it on start (it scans the inbox too).
import { scanInbox } from '../server/sources.js';
import { config } from '../server/config.js';

console.log(`scanning ${config.inboxDir}`);
const results = await scanInbox({ onProgress: p => console.log(`  ${p.file}: ${p.stage}${p.detail ? ` (${p.detail})` : ''}`) });
for (const r of results) console.log(`${r.action.padEnd(9)} ${r.file}${r.error ? `  ${r.error}` : ''}`);
if (!results.length) console.log('inbox is empty');
const { stopEmbedder } = await import('../server/embed.js');
stopEmbedder();
process.exit(results.some(r => r.action === 'error') ? 1 : 0);
