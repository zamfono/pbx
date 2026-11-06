#!/usr/bin/env node
// A page to listen to a generated prompt set (spec §9.1) the way a caller hears it: pick a
// language, a voice and what the core plays (the mailbox intro for any counts, the main menu, a
// message's header and options, a parking slot, one prompt, or any clips), and the page joins the
// committed clips the core's own media functions name. Run `tsc -b` first; it reads
// `packages/core/dist`.
//
//   node scripts/prompt-playground.mjs [port]     # http://127.0.0.1:<port>, 4310 by default
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  introMedia,
  messageHeaderMedia
} from '../packages/core/dist/calls/mailboxGrammar.js';
import {
  mainMenuMedia,
  messageOptionsMedia
} from '../packages/core/dist/calls/mailboxPrompts.js';
import { generatedPromptNames } from '../packages/core/dist/calls/promptSet.js';
import { digitsMedia } from '../packages/core/dist/prompts.js';
import { LANGUAGES, PROMPT_VOICES } from '../packages/shared/dist/index.js';

const FIRST_ARG = 2;
const DEFAULT_PORT = 4310;
const HTTP = { ok: 200, partial: 206, badRequest: 400, notFound: 404 };

const promptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../images/asterisk/prompts'
);
const port = Number(process.argv[FIRST_ARG] ?? DEFAULT_PORT);

/** @param {string} value */
function count(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * The clip names the core plays for `kind`, from the page's two fields.
 * @param {import('../packages/shared/dist/index.js').Language} language
 * @param {URLSearchParams} query @returns {string[]}
 */
function sequence(language, query) {
  const first = query.get('a') ?? '';
  const second = query.get('b') ?? '';
  /** @type {Record<string, () => string[]>} */
  const kinds = {
    intro: () => introMedia(language, count(first), count(second)),
    menu: () => [
      ...introMedia(language, count(first), count(second)),
      ...mainMenuMedia(count(first), count(second))
    ],
    header: () =>
      messageHeaderMedia(
        language,
        first === 'old' ? 'old' : 'new',
        count(second)
      ),
    options: () => messageOptionsMedia(first === 'yes', second === 'yes'),
    parking: () => digitsMedia(first.replace(/\D/gu, '')),
    clips: () => first.split(/[\s,]+/u).filter(name => name !== '')
  };
  const media = kinds[query.get('kind') ?? '']?.() ?? [];
  return media.map(entry => entry.replace(/^sound:/u, ''));
}

/**
 * The clips' files in the voice's set, the names no file answers, and the clips joined as WAV.
 * @param {string} dir @param {string[]} names
 */
function join8k(dir, names) {
  const files = names.map(name => join(dir, `${name}.wav`));
  const missing = names.filter(
    (name, index) =>
      name.split('/').includes('..') || !existsSync(files.at(index) ?? '')
  );
  const found = files.filter(
    (_file, index) => !missing.includes(names.at(index) ?? '')
  );
  if (found.length === 0) {
    return { missing, wav: Buffer.alloc(0) };
  }
  // A file, not a pipe: only a seekable output gets a WAV header with its sizes, which Safari needs.
  const tempDir = mkdtempSync(join(tmpdir(), 'prompt-playground-'));
  const out = join(tempDir, 'joined.wav');
  try {
    spawnSync('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      ...found.flatMap(file => ['-i', file]),
      '-filter_complex',
      `${found.map((_file, index) => `[${index}:a]`).join('')}concat=n=${found.length}:v=0:a=1`,
      out
    ]);
    return { missing, wav: readFileSync(out) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * The WAV, or the byte range asked for: Safari plays only media served in ranges.
 * @param {string | undefined} range @param {import('node:http').ServerResponse} response
 * @param {Buffer} wav
 */
function sendAudio(range, response, wav) {
  const asked = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(range ?? '')?.groups;
  const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' };
  if (asked === undefined) {
    response
      .writeHead(HTTP.ok, { ...headers, 'content-length': wav.length })
      .end(wav);
    return;
  }
  const start = asked.start === '' ? 0 : Number(asked.start);
  const end = Math.min(
    asked.end === '' ? wav.length - 1 : Number(asked.end),
    wav.length - 1
  );
  const part = wav.subarray(start, end + 1);
  response
    .writeHead(HTTP.partial, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${wav.length}`,
      'content-length': part.length
    })
    .end(part);
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Prompt playground</title>
<style>
  body { font: 15px system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
  label { display: block; margin: .6rem 0 .2rem; font-weight: 600; }
  select, input { font: inherit; padding: .3rem; width: 100%; box-sizing: border-box; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  button { font: inherit; margin-top: 1rem; padding: .4rem 1.2rem; }
  #presets { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .3rem; }
  #presets button { margin: 0; padding: .2rem .6rem; font-size: 13px; }
  h2 { font-size: 13px; margin: 1.6rem 0 0; color: #555; text-transform: uppercase; }
  code { display: block; margin-top: 1rem; white-space: pre-wrap; color: #555; }
  .missing { color: #b00; }
</style></head><body>
<h1>Prompt playground</h1>
<div class="row">
  <div><label for="language">Language</label><select id="language">${LANGUAGES.map(
    language => `<option>${language}</option>`
  ).join('')}</select></div>
  <div><label for="voice">Voice</label><select id="voice">${PROMPT_VOICES.map(
    voice => `<option>${voice}</option>`
  ).join('')}</select></div>
</div>
<label for="kind">What the core plays</label>
<select id="kind">
  <option value="intro">Mailbox intro: new, saved</option>
  <option value="menu">Mailbox intro and main menu: new, saved</option>
  <option value="header">Message header: folder (new/old), place</option>
  <option value="options">Message options: previous (yes/no), next (yes/no)</option>
  <option value="parking">Parking slot: digits</option>
  <option value="prompt">One prompt</option>
  <option value="clips">Clips: names, separated by spaces</option>
</select>
<div class="row">
  <div><label for="a" id="a-label">A</label><input id="a"></div>
  <div><label for="b" id="b-label">B</label><input id="b"></div>
</div>
<datalist id="names"></datalist>
<button id="play">Play</button>
<audio id="audio" controls style="width:100%;margin-top:1rem"></audio>
<code id="clips"></code>
<h2>Presets</h2>
<div id="presets"></div>
<script>
  // The how-to's listening list: every count form, both folders, the menus, a parking slot and
  // the caller-facing prompts.
  const PRESETS = [
    ['No messages', 'intro', '0', '0'], ['1 new', 'intro', '1', '0'],
    ['2 new, 1 saved', 'intro', '2', '1'], ['5 new', 'intro', '5', '0'],
    ['12 new, 3 saved', 'intro', '12', '3'], ['14 new', 'intro', '14', '0'],
    ['21 new, 1 saved', 'intro', '21', '1'], ['22 new', 'intro', '22', '0'],
    ['1 new, 24 saved', 'intro', '1', '24'], ['99 new, 42 saved', 'intro', '99', '42'],
    ['112 new, 1 saved', 'intro', '112', '1'], ['132 new', 'intro', '132', '0'],
    ['2002 new', 'intro', '2002', '0'], ['2,000,101 new', 'intro', '2000101', '0'],
    ['Main menu, 3 new, 1 saved', 'menu', '3', '1'], ['Main menu, empty', 'menu', '0', '0'],
    ['New message 2', 'header', 'new', '2'], ['Saved message 21', 'header', 'old', '21'],
    ['Saved message 132', 'header', 'old', '132'], ['New message 10', 'header', 'new', '10'],
    ['Options, all', 'options', 'yes', 'yes'], ['Options, first', 'options', 'no', 'yes'],
    ['Options, last', 'options', 'yes', 'no'],
    ['Parking 701', 'parking', '701', ''], ['Parking 7010', 'parking', '7010', ''],
    ['Parking 7023', 'parking', '7023', ''],
    ['Leave a message', 'prompt', 'vm-intro', ''], ['Mailbox full', 'prompt', 'vm-mailboxfull', ''],
    ['Goodbye', 'prompt', 'vm-goodbye', ''], ['Invalid choice', 'prompt', 'pbx-invalid', ''],
    ['Call failed', 'prompt', 'please-try-call-later', ''],
    ['Find-me accept', 'prompt', 'followme/options', ''],
    ['Record greeting', 'clips', 'vm-rec-unv beep', ''], ['Greeting saved', 'prompt', 'vm-msgsaved', ''],
    ['Deleted', 'prompt', 'vm-deleted', ''], ['No more messages', 'prompt', 'vm-nomore', ''],
    ['Sorry', 'prompt', 'vm-sorry', '']
  ];
  const FIELDS = {
    intro: ['New', 'Saved', '2', '1'], menu: ['New', 'Saved', '3', '1'],
    header: ['Folder', 'Place', 'new', '2'], options: ['Previous', 'Next', 'yes', 'yes'],
    parking: ['Digits', '', '701', ''], prompt: ['Prompt', '', 'vm-intro', ''],
    clips: ['Clips', '', 'mailbox/you-have digits/2 mailbox/new-one', '']
  };
  const $ = id => document.getElementById(id);
  async function names() {
    const list = await (await fetch('names?language=' + $('language').value)).json();
    $('names').innerHTML = list.map(name => '<option value="' + name + '">').join('');
  }
  function fields() {
    const [a, b, aValue, bValue] = FIELDS[$('kind').value];
    $('a-label').textContent = a; $('b-label').textContent = b;
    $('a').value = aValue; $('b').value = bValue;
    const named = ['prompt', 'clips'].includes($('kind').value);
    if (named) $('a').setAttribute('list', 'names'); else $('a').removeAttribute('list');
    $('b').disabled = b === '';
  }
  async function play() {
    const kind = $('kind').value === 'prompt' ? 'clips' : $('kind').value;
    const query = new URLSearchParams({ language: $('language').value, voice: $('voice').value,
      kind, a: $('a').value, b: $('b').value });
    $('audio').src = 'audio?' + query + '&t=' + Date.now();
    $('audio').play();
    const info = await (await fetch('sequence?' + query)).json();
    $('clips').innerHTML = info.names.map(name => info.missing.includes(name)
      ? '<span class="missing">' + name + ' (missing)</span>' : name).join(' + ');
  }
  $('kind').onchange = fields; $('language').onchange = names; $('play').onclick = play;
  for (const id of ['a', 'b']) {
    $(id).addEventListener('keydown', event => { if (event.key === 'Enter') play(); });
  }
  for (const [label, kind, a, b] of PRESETS) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => {
      $('kind').value = kind; fields();
      $('a').value = a; $('b').value = b;
      play();
    };
    $('presets').append(button);
  }
  fields(); names();
</script></body></html>`;

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const query = url.searchParams;
  if (url.pathname === '/') {
    response.writeHead(HTTP.ok, { 'content-type': 'text/html' }).end(page);
    return;
  }
  const voice = query.get('voice') ?? '';
  const json = { 'content-type': 'application/json' };
  const language = LANGUAGES.find(name => name === query.get('language'));
  if (language === undefined) {
    response.writeHead(HTTP.badRequest).end('unknown language');
    return;
  }
  if (url.pathname === '/names') {
    response
      .writeHead(HTTP.ok, json)
      .end(JSON.stringify(generatedPromptNames(language)));
    return;
  }
  if (!PROMPT_VOICES.some(name => name === voice)) {
    response.writeHead(HTTP.badRequest).end('unknown voice');
    return;
  }
  const names = sequence(language, query);
  const joined = join8k(join(promptsDir, language, voice), names);
  if (url.pathname === '/sequence') {
    response
      .writeHead(HTTP.ok, json)
      .end(JSON.stringify({ names, missing: joined.missing }));
  } else if (url.pathname === '/audio') {
    sendAudio(request.headers.range, response, joined.wav);
  } else {
    response.writeHead(HTTP.notFound).end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`prompt playground: http://127.0.0.1:${port}`);
});
