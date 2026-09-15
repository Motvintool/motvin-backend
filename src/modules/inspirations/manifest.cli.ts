/**
 * CLI for the manifest builder: `npm run build:inspirations`.
 *
 * Shares its implementation with the admin API, so a rebuild from the terminal
 * and a rebuild triggered by an upload produce byte-identical output.
 */

import { join, relative } from 'path';
import { buildInspirationsManifest } from './manifest.builder';

const root = join(process.env.DATA_ROOT || './data', 'inspirations');
const report = buildInspirationsManifest(root);

console.log('Inspirations manifest');
console.log(`  apps          ${report.counts.apps}`);
console.log(`  screens       ${report.counts.screens}`);
console.log(`  flows         ${report.counts.flows}`);
console.log(`  patterns      ${report.counts.patterns}`);
console.log(`  ui elements   ${report.counts['ui-elements']}`);
console.log(`  written to    ${relative(process.cwd(), report.manifestPath)}`);

if (report.skipped.length) {
  console.log('\nHeld back by the licensing gate:');
  for (const s of report.skipped) {
    console.log(`  ${s.platform}/${s.appId} — ${s.count} image(s): ${s.reason}`);
  }
}
if (report.warnings.length) {
  console.log('\nWarnings:');
  for (const w of report.warnings) console.log(`  ${w}`);
}
if (report.problems.length) {
  console.log('\nProblems:');
  for (const p of report.problems) console.log(`  ${p}`);
}
if (report.counts.screens === 0) {
  console.log('\nNo screens published yet. Add images under data/inspirations/screens/<platform>/<app>/,');
  console.log('list the app in apps.json, approve it in sources.json, then run this again.');
}

process.exit(report.problems.length === 0 ? 0 : 1);
