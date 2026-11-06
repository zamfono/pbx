#!/usr/bin/env node
// Generates a language's prompt set (spec §9.1) from its manifest with ElevenLabs text-to-speech:
//
//   ELEVENLABS_API_KEY=… node scripts/generate-prompts.mjs <language> <voice> [prompt ...]
//
// `images/asterisk/prompts/<language>.json` maps each prompt the core can play in that language
// (packages/core/src/calls/promptSet.ts) to its text. Where a [bracketed] part is a piece the core
// joins to others, only the part is spoken, with the text around it sent as context that shapes
// its intonation (mid-sentence, or falling at the end) without being spoken, so nothing is cut.
// Every clip is transcribed and, where it does not read back as its text, spoken again with
// another seed; the ones that never do are listed at the end for a native speaker's ear. `voices` names the ElevenLabs voice of each of the language's sets
// (`female`, `male`) and, in `seeds`, the seed a listener picked for a prompt that voice got wrong
// (spoken with it and kept unchecked), `aliases` respells words they say wrong. Each clip is brought to one
// loudness, trimmed of silence and written as 8 kHz `.wav` and `.g722` into
// `images/asterisk/prompts/<language>/<voice>/`; `beep` is a tone. Named prompts regenerate alone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { elevenLabs, parseJson, plain } from './elevenlabs.mjs';
import { fade, normalize, RATE, trim, wav, write } from './prompt-audio.mjs';

// How many times a prompt is spoken, each with its own seed, for speech-to-text to hear it right.
const SEEDS = 3;
const BEEP = { hz: 1000, seconds: 0.25, amplitude: 0.15, fadeS: 0.01 };
// The silence a clip too short for speech-to-text is heard with.
const PAD_S = 1;
const TAU = Math.PI + Math.PI;
const EXIT_USAGE = 2;
const FIRST_ARG = 2;
const INT16_SCALE = 32768;
const BYTES_PER_SAMPLE = 2;

/** @typedef {{ voices: Record<string, { name: string, id: string, seeds?: Record<string, number> }>,
 *   aliases: Record<string, string>, prompts: Record<string, string> }} Manifest */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [language, voiceName, ...only] = process.argv.slice(FIRST_ARG);
const apiKey = process.env.ELEVENLABS_API_KEY;
if (language === undefined || voiceName === undefined || !apiKey) {
  console.error(
    'usage: ELEVENLABS_API_KEY=… generate-prompts.mjs <language> <voice> [prompt ...]'
  );
  process.exit(EXIT_USAGE);
}

const promptsDir = join(root, 'images/asterisk/prompts');
/** @type {Manifest} */
const manifest = parseJson(
  readFileSync(join(promptsDir, `${language}.json`), 'utf8')
);
const voice = manifest.voices[voiceName];
if (voice === undefined) {
  throw new Error(`no ${voiceName} voice in ${language}.json`);
}
const voiceId = voice.id;
const seeds = voice.seeds ?? {};
const outDir = join(promptsDir, language, voiceName);
const api = elevenLabs({
  apiKey,
  cacheDir: join(root, '.cache/prompts'),
  language
});
/** @type {string[]} */
const toHear = [];

/** @param {string} text @returns {string} */
function applyAliases(text) {
  return Object.entries(manifest.aliases).reduce(
    (said, [word, spoken]) =>
      said.replace(new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'gu'), spoken),
    text
  );
}

/**
 * What to speak, the context around it, and the words it says. A trailing space lets the voice
 * finish the last word, which it otherwise breaks off mid-vowel where the next text would join.
 * @param {string} text
 * @returns {{ said: { text: string, previous: string, next: string }, words: string }}
 */
function parse(text) {
  const match =
    /^(?<before>[^[\]]*)\[(?<part>[^[\]]+)\](?<after>[^[\]]*)$/u.exec(text);
  if (match?.groups === undefined) {
    if (/[[\]]/u.test(text)) {
      throw new Error(`unbalanced brackets: ${text}`);
    }
    return {
      said: { text: `${applyAliases(text)} `, previous: '', next: '' },
      words: text
    };
  }
  const { before = '', part = '', after = '' } = match.groups;
  return {
    said: {
      text: `${applyAliases(part.trim())} `,
      previous: before.trim() === '' ? '' : `${applyAliases(before.trim())} `,
      next: applyAliases(after.trim())
    },
    words: part.trim()
  };
}

/**
 * Whether speech-to-text heard `words`, or a number prompt's number written as digits.
 * @param {string} heard @param {string} words @param {string} name
 */
function heardAs(heard, words, name) {
  const number = /^digits(?:-final)?\/(?<value>\d+)/u.exec(name)?.groups?.value;
  return plain(heard) === plain(words) || plain(heard) === number;
}

/**
 * The clip the voice speaks for `said` with `seed`, at one loudness and trimmed of silence.
 * @param {{ text: string, previous: string, next: string }} said @param {number} seed
 */
async function speak(said, seed) {
  const json = await api.speak(voiceId, said, RATE, seed);
  const bytes = Buffer.from(json.audio_base64, 'base64');
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.length / BYTES_PER_SAMPLE
  );
  return trim(
    normalize(Float32Array.from(pcm, sample => sample / INT16_SCALE))
  );
}

/**
 * What speech-to-text hears in `clip`. A clip too short for it ("de") is heard again with silence
 * after it, only then, so every other clip's transcript stays the one cached.
 * @param {Float32Array} clip
 */
async function transcribe(clip) {
  try {
    return await api.transcribe(wav(clip));
  } catch (error) {
    if (!String(error).includes('audio_too_short')) {
      throw error;
    }
    const padded = new Float32Array(clip.length + Math.round(PAD_S * RATE));
    padded.set(clip);
    return api.transcribe(wav(padded));
  }
}

/**
 * Speaks a prompt, again with the next seed while speech-to-text does not hear it as its words
 * (the voice now and then says some of the context too), and keeps the first it hears right, else
 * the first, listed for a native speaker.
 * @param {string} name @param {string} text
 */
async function generate(name, text) {
  const { said, words } = parse(text);
  const pinned = seeds[name];
  if (pinned !== undefined) {
    write(join(outDir, name), await speak(said, pinned));
    console.log(`${name}: "${words}", seed ${pinned}`);
    return;
  }
  /** @type {{ clip: Float32Array, heard: string }[]} */
  const tried = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    // eslint-disable-next-line no-await-in-loop -- the next seed is only needed if this one fails
    const clip = await speak(said, seed);
    // eslint-disable-next-line no-await-in-loop -- as above
    const heard = await transcribe(clip);
    if (heardAs(heard, words, name)) {
      write(join(outDir, name), clip);
      console.log(`${name}: "${words}"`);
      return;
    }
    tried.push({ clip, heard });
  }
  const [first] = tried;
  if (first !== undefined) {
    write(join(outDir, name), first.clip);
  }
  const heard = [...new Set(tried.map(attempt => attempt.heard))];
  toHear.push(`${name}: "${words}", heard "${heard.join('" / "')}"`);
  console.log(`${name}: "${words}" not heard`);
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
if (toHear.length > 0) {
  console.log(
    `\nNot heard as written, for a native speaker's ear:\n${toHear.join('\n')}`
  );
}
