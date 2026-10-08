/**
 * Imports the bundled hold music: the five opsound tracks Asterisk ships (§10.2 "Hold music"),
 * from the 16 kHz G.722 set the product installs, as MP3 for the mockup's audio library.
 * CC BY-SA 3.0; the credits are in src/lib/assets/audio/CREDITS.md.
 *
 * Usage:
 *   curl -O https://downloads.asterisk.org/pub/telephony/sounds/asterisk-moh-opsound-g722-current.tar.gz
 *   tar xzf asterisk-moh-opsound-g722-current.tar.gz -C <dir>
 *   node scripts/moh/import.mjs <dir>
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { outDir, peaksOf, probe, updateManifest } from '../audio-manifest.mjs';

/** The basenames packages/api seeds (MOH_TRACK_BASENAMES in seedMoh.ts). */
const TRACKS = [
  'macroform-cold_day',
  'macroform-robot_dity',
  'macroform-the_simplicity',
  'manolo_camp-morning_coffee',
  'reno_project-system'
];

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node scripts/moh/import.mjs <directory with the .g722 files>');
  process.exit(1);
}

const entries = {};
for (const track of TRACKS) {
  const file = join(outDir, `moh-${track}.mp3`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'g722', '-i', join(source, `${track}.g722`),
    '-ac', '1', '-ar', '16000', '-b:a', '40k', file
  ]);
  entries[`moh-${track}`] = { kind: 'music', channels: 1, durationS: Math.round(probe(file)), peaks: peaksOf(file) };
  console.log(`moh-${track}: ${entries[`moh-${track}`].durationS}s`);
}
updateManifest(entries);
