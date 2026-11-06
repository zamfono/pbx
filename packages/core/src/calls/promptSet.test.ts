import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LANGUAGES, PROMPT_VOICES } from '@zamfono/shared';

import { BEEP_PROMPT, generatedPromptNames } from './promptSet.js';

const PROMPTS_DIR = fileURLToPath(
  new URL('../../../../images/asterisk/prompts', import.meta.url)
);
/** The formats `scripts/generate-prompts.mjs` writes, Asterisk picking one by codec (§9.1). */
const FORMATS = ['wav', 'g722'];

function setFiles(language: string, voice: string): string[] {
  const dir = join(PROMPTS_DIR, language, voice);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)));
}

describe.each(LANGUAGES)('the generated %s prompt set (§9.1)', language => {
  const names = generatedPromptNames(language);

  const manifest = JSON.parse(
    readFileSync(join(PROMPTS_DIR, `${language}.json`), 'utf8')
  ) as { voices: Record<string, unknown>; prompts: Record<string, string> };

  it('has a manifest text for every prompt the core can play, and for nothing else', () => {
    expect(Object.keys(manifest.prompts).sort()).toEqual(
      names.filter(name => name !== BEEP_PROMPT)
    );
  });

  it('names a voice for each prompt voice', () => {
    expect(Object.keys(manifest.voices).sort()).toEqual([...PROMPT_VOICES]);
  });

  it.each(PROMPT_VOICES)(
    'holds every prompt the core can play in every format for the %s voice, and nothing else',
    voice => {
      expect(setFiles(language, voice).sort()).toEqual(
        names.flatMap(name => FORMATS.map(format => `${name}.${format}`)).sort()
      );
    }
  );
});
