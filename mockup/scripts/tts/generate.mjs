/**
 * Generates the demo's voicemail and call-recording audio from scripts/tts/clips.json with
 * OpenAI's `gpt-audio-1.5` (chat completions with audio output), one request per spoken line.
 *
 * Recordings follow Zamfono's stereo mapping (spec §10.2 "Channels and stereo mapping"): left is
 * the recorded user's voice, right is everything they heard. Lines sit on a timeline, so callers
 * overlap and interrupt: `gap` (seconds, negative overlaps) places a line after the previous one,
 * `cut` cuts the previous speaker off where this line starts, `over` (0–1) drops a short
 * back-channel ("mhm") into the previous line without moving the timeline. The recorded user's
 * side is wideband (their own device), the far side band-limited like the phone network.
 * Voicemails are mono, band-limited.
 *
 * Output: src/lib/assets/audio/<key>.mp3 and manifest.json (durations). Spoken lines are cached in
 * scripts/tts/.cache/ by content hash, so editing the timing re-mixes without new requests.
 *
 * Usage: OPENAI_API_KEY=… node scripts/tts/generate.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const outDir = join(root, 'src/lib/assets/audio');
const cacheDir = join(root, 'scripts/tts/.cache');
const { cast, voicemails, recordings } = JSON.parse(
  readFileSync(join(root, 'scripts/tts/clips.json'), 'utf8')
);
const apiKey = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-audio-1.5';
const DEFAULT_GAP_S = 0.35;
const CUT_TAIL_S = 0.35;
const FADE_S = 0.12;
/** Bumped when the prompt changes, so cached lines are spoken again. */
const PROMPT_VERSION = 3;

const normalise = value =>
  value.replace(/[«»]/gu, '').toLowerCase().replace(/[^a-zäöüß]/gu, '');

if (!apiKey) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(1);
}

const systemPrompt = direction =>
  'Du bist Sprecherin oder Sprecher in einem Hörspiel. Lies den Text des Nutzers exakt vor, Wort für Wort, ' +
  'ohne etwas hinzuzufügen, wegzulassen oder zu kommentieren. Sprich natürliches Deutsch wie in einem echten ' +
  `Telefonat, mit natürlichen Pausen und Betonung, keine Ansagerstimme. Rolle: ${direction}.`;

async function speak(who, text) {
  const person = cast[who];
  const hash = createHash('sha256').update(`${MODEL}|${PROMPT_VERSION}|${person.voice}|${person.direction}|${text}`).digest('hex').slice(0, 16);
  const file = join(cacheDir, `${hash}.wav`);
  if (existsSync(file)) {
    return file;
  }
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        modalities: ['text', 'audio'],
        audio: { voice: person.voice, format: 'wav' },
        messages: [
          { role: 'system', content: systemPrompt(person.direction) },
          { role: 'user', content: `Lies genau diesen Text vor, sonst nichts:\n«${text}»` }
        ]
      })
    });
    if (!response.ok) {
      console.warn(`  ${who}: HTTP ${response.status}, retrying`);
      continue;
    }
    const audio = (await response.json()).choices[0].message.audio;
    const said = normalise(audio.transcript ?? '');
    const meant = normalise(text);
    const edge = Math.min(12, meant.length);
    if (
      !said.startsWith(meant.slice(0, edge)) ||
      !said.endsWith(meant.slice(-edge)) ||
      Math.abs(said.length - meant.length) > Math.max(4, meant.length * 0.08)
    ) {
      console.warn(`  ${who}: transcript drifted, retrying: ${audio.transcript}`);
      continue;
    }
    writeFileSync(file, Buffer.from(audio.data, 'base64'));
    return file;
  }
  throw new Error(`could not speak line of ${who}: ${text}`);
}

const probe = file =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString()
  );

/** Places a recording's lines on a timeline: start, length (after a cut) and channel. */
async function timeline(recording) {
  const placed = [];
  let lastMain = null;
  for (const line of recording.lines) {
    const file = await speak(line.who, line.text);
    const length = probe(file);
    const side = line.who === recording.left ? 'left' : 'right';
    if (line.over !== undefined && lastMain !== null) {
      placed.push({ file, side, start: lastMain.start + line.over * lastMain.length, length, cut: false });
      continue;
    }
    const start = Math.max(0, (lastMain === null ? 0 : lastMain.start + lastMain.length) + (line.gap ?? DEFAULT_GAP_S));
    if (line.cut === true && lastMain !== null) {
      lastMain.length = Math.min(lastMain.length, start + CUT_TAIL_S - lastMain.start);
      lastMain.cut = true;
    }
    const entry = { file, side, start, length, cut: false };
    placed.push(entry);
    lastMain = entry;
  }
  return placed;
}

function segmentFilter(segment, index) {
  const fade = segment.cut ? `,afade=t=out:st=${(segment.length - FADE_S).toFixed(3)}:d=${FADE_S}` : '';
  return `[${index}:a]aresample=24000,aformat=channel_layouts=mono,atrim=end=${segment.length.toFixed(3)}${fade},adelay=${Math.round(segment.start * 1000)}:all=1[s${index}]`;
}

function mixSide(segments, label) {
  const inputs = segments.map(({ index }) => `[s${index}]`).join('');
  return `${inputs}amix=inputs=${segments.length}:normalize=0:dropout_transition=0[${label}raw]`;
}

async function buildRecording(key, recording) {
  const placed = await timeline(recording);
  const indexed = placed.map((segment, index) => ({ ...segment, index }));
  const left = indexed.filter(segment => segment.side === 'left');
  const right = indexed.filter(segment => segment.side === 'right');
  const total = Math.max(...placed.map(segment => segment.start + segment.length)) + 0.4;
  const graph = [
    ...indexed.map(segmentFilter),
    mixSide(left, 'L'),
    mixSide(right, 'R'),
    `[Lraw]apad=whole_dur=${total.toFixed(3)},highpass=f=90,lowpass=f=7000[L]`,
    `[Rraw]apad=whole_dur=${total.toFixed(3)},highpass=f=300,lowpass=f=3400[R]`,
    '[L][R]join=inputs=2:channel_layout=stereo,loudnorm=I=-18:TP=-2[out]'
  ].join(';');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...placed.flatMap(segment => ['-i', segment.file]),
    '-filter_complex', graph,
    '-map', '[out]', '-ar', '16000', '-b:a', '40k', join(outDir, `${key}.mp3`)
  ]);
}

async function buildVoicemail(key, lines) {
  const files = [];
  for (const line of lines) {
    files.push(await speak(line.who, line.text));
  }
  const graph = `${files.map((_, index) => `[${index}:a]aresample=24000,aformat=channel_layouts=mono[v${index}]`).join(';')};${files
    .map((_, index) => `[v${index}]`)
    .join('')}concat=n=${files.length}:v=0:a=1,highpass=f=300,lowpass=f=3400,loudnorm=I=-18:TP=-2[out]`;
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...files.flatMap(file => ['-i', file]),
    '-filter_complex', graph,
    '-map', '[out]', '-ac', '1', '-ar', '16000', '-b:a', '24k', join(outDir, `${key}.mp3`)
  ]);
}

mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const manifest = {};
for (const [key, lines] of Object.entries(voicemails)) {
  await buildVoicemail(key, lines);
  manifest[key] = { kind: 'voicemail', channels: 1, durationS: Math.round(probe(join(outDir, `${key}.mp3`))) };
  console.log(`${key}: ${manifest[key].durationS}s`);
}
for (const [key, recording] of Object.entries(recordings)) {
  await buildRecording(key, recording);
  manifest[key] = { kind: 'recording', channels: 2, durationS: Math.round(probe(join(outDir, `${key}.mp3`))) };
  console.log(`${key}: ${manifest[key].durationS}s`);
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
