#!/usr/bin/env node
// Generates a language's prompt set (spec §9.1) from its manifest with ElevenLabs text-to-speech:
//
//   ELEVENLABS_API_KEY=… node scripts/generate-prompts.mjs <language> [prompt ...]
//
// `images/asterisk/prompts/<language>.json` maps each prompt the core can play in that language
// (packages/core/src/calls/promptSet.ts) to its text, said whole; a [bracketed] part is cut out
// of the whole, so a piece joined to others keeps its mid-sentence intonation. The API's
// character timestamps only place a cut roughly; each end moves to the quietest point nearby,
// which a word starting with a stop (p, t) right after the part makes a clean one. `aliases`
// respells words the voice says wrong. Each utterance is brought to one loudness, each clip
// trimmed of silence and written as 8 kHz `.wav` and `.g722` into
// `images/asterisk/prompts/<language>/`; `beep` is a tone. Named prompts regenerate alone.
/* eslint-disable camelcase -- the ElevenLabs API's field names */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fade,
  normalize,
  quietest,
  RATE,
  trim,
  write
} from './prompt-audio.mjs';

// One voice (Joanna), model and settings for every language, so no set mixes voices.
const VOICE_ID = 'H3IcxEgdFxIEJAqMc0Bc';
const MODEL_ID = 'eleven_v4';
const SEED = 1;
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, speed: 1.0 };

// Where a cut's ends are looked for, around the timestamps: its start from a little before its
// first character; its end from just before its last character's end until a little past the
// next word's start, whose stop's closure is the quiet point; timestamps run late as well as
// early.
const CUT_START = { beforeS: 0.06, afterS: 0.01 };
const CUT_END = { beforeS: 0.02, afterS: 0.15 };
const BEEP = { hz: 1000, seconds: 0.25, amplitude: 0.15, fadeS: 0.01 };
const TAU = Math.PI + Math.PI;
const EXIT_USAGE = 2;
const FIRST_ARG = 2;
const INT16_SCALE = 32768;
const BYTES_PER_SAMPLE = 2;

/** @typedef {{ aliases: Record<string, string>, prompts: Record<string, string> }} Manifest */
/** @typedef {{ characters: string[], character_start_times_seconds: number[],
 *   character_end_times_seconds: number[] }} Alignment */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [language, ...only] = process.argv.slice(FIRST_ARG);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (language === undefined || !apiKey) {
  console.error(
    'usage: ELEVENLABS_API_KEY=… generate-prompts.mjs <language> [prompt ...]'
  );
  process.exit(EXIT_USAGE);
}

// JSON.parse is necessarily `any`; each caller names the shape it reads.
/* eslint-disable @typescript-eslint/no-unsafe-return */
/** @template T @param {string} text @returns {T} */
function parseJson(text) {
  return JSON.parse(text);
}
/* eslint-enable @typescript-eslint/no-unsafe-return */

const promptsDir = join(root, 'images/asterisk/prompts');
/** @type {Manifest} */
const manifest = parseJson(
  readFileSync(join(promptsDir, `${language}.json`), 'utf8')
);
const outDir = join(promptsDir, language);

/** @param {string} text @returns {string} */
function applyAliases(text) {
  return Object.entries(manifest.aliases).reduce(
    (said, [word, spoken]) =>
      said.replace(new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'gu'), spoken),
    text
  );
}

/**
 * The text to send and the character range to keep, `null` for all of it.
 * @param {string} text
 * @returns {{ said: string, cut: { start: number, end: number } | null }}
 */
function parse(text) {
  const match =
    /^(?<before>[^[\]]*)\[(?<part>[^[\]]+)\](?<after>[^[\]]*)$/u.exec(text);
  if (match?.groups === undefined) {
    if (/[[\]]/u.test(text)) {
      throw new Error(`unbalanced brackets: ${text}`);
    }
    return { said: applyAliases(text), cut: null };
  }
  const before = applyAliases(match.groups.before ?? '');
  const part = applyAliases(match.groups.part ?? '');
  const after = applyAliases(match.groups.after ?? '');
  const start = before.length + (part.length - part.trimStart().length);
  const end = before.length + part.trimEnd().length;
  return { said: before + part + after, cut: { start, end } };
}

/**
 * The utterance as samples in [-1, 1] at `RATE`, and its character timestamps.
 * @param {string} text
 * @returns {Promise<{ samples: Float32Array, alignment: Alignment }>}
 */
async function speak(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=pcm_${RATE}`;
  const body = JSON.stringify({
    text,
    model_id: MODEL_ID,
    language_code: language,
    seed: SEED,
    voice_settings: VOICE_SETTINGS
  });
  const headers = {
    'xi-api-key': String(apiKey),
    'content-type': 'application/json'
  };
  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  }
  /** @type {{ audio_base64: string, alignment: Alignment }} */
  const json = parseJson(await response.text());
  const bytes = Buffer.from(json.audio_base64, 'base64');
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.length / BYTES_PER_SAMPLE
  );
  return {
    samples: Float32Array.from(pcm, sample => sample / INT16_SCALE),
    alignment: json.alignment
  };
}

/**
 * Where a cut starting at character `index` begins: the text's start, or the quietest point just
 * before the character.
 * @param {Float32Array} samples @param {Alignment} alignment @param {number} index
 */
function cutStart(samples, alignment, index) {
  const start = alignment.character_start_times_seconds[index] ?? 0;
  if (!/\p{L}/u.test(alignment.characters.slice(0, index).join(''))) {
    return 0;
  }
  return quietest(samples, start - CUT_START.beforeS, start + CUT_START.afterS);
}

/**
 * Where a cut ending before character `index` ends: the quietest point from its last character's
 * end until a little past the next word's start, or the utterance's end.
 * @param {Float32Array} samples @param {Alignment} alignment @param {number} index
 */
function cutEnd(samples, alignment, index) {
  const end = alignment.character_end_times_seconds[index - 1] ?? 0;
  const next = alignment.characters.findIndex(
    (character, at) => at >= index && /\p{L}/u.test(character)
  );
  const nextStart =
    next === -1
      ? samples.length / RATE
      : (alignment.character_start_times_seconds[next] ?? end) + CUT_END.afterS;
  return quietest(samples, end - CUT_END.beforeS, nextStart);
}

/** @param {string} name @param {string} text */
async function generate(name, text) {
  const { said, cut } = parse(text);
  const { samples, alignment } = await speak(said);
  if (alignment.characters.join('') !== said) {
    throw new Error(`${name}: the timestamps do not follow the text`);
  }
  let clip = normalize(samples);
  if (cut !== null) {
    const from = cutStart(clip, alignment, cut.start);
    const to = cutEnd(clip, alignment, cut.end);
    clip = clip.slice(Math.round(from * RATE), Math.round(to * RATE));
  }
  write(join(outDir, name), trim(clip));
  console.log(
    `${name}: ${cut === null ? said : said.slice(cut.start, cut.end)}`
  );
}

function beep() {
  const samples = Float32Array.from(
    { length: Math.round(BEEP.seconds * RATE) },
    (_unused, index) =>
      BEEP.amplitude * Math.sin((TAU * BEEP.hz * index) / RATE)
  );
  write(join(outDir, 'beep'), fade(samples, BEEP.fadeS));
}

const names =
  only.length > 0 ? only : ['beep', ...Object.keys(manifest.prompts)];
for (const name of names) {
  const text = manifest.prompts[name];
  if (name === 'beep') {
    beep();
  } else if (text === undefined) {
    throw new Error(`not in the manifest: ${name}`);
  } else {
    // eslint-disable-next-line no-await-in-loop -- one request at a time, within the plan's concurrency
    await generate(name, text);
  }
}
