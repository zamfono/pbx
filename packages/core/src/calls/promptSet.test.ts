import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GENERATED_LANGUAGES } from '../prompts.js';
import { BEEP_PROMPT, generatedPromptNames } from './promptSet.js';

const PROMPTS_DIR = fileURLToPath(
  new URL('../../../../images/asterisk/prompts', import.meta.url)
);
/** The formats `scripts/generate-prompts.mjs` writes, Asterisk picking one by codec (§9.1). */
const FORMATS = ['wav', 'g722'];

function setFiles(language: string): string[] {
  const dir = join(PROMPTS_DIR, language);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)));
}

describe.each(GENERATED_LANGUAGES)(
  'the generated %s prompt set (§9.1)',
  language => {
    const names = generatedPromptNames(language);

    it('has a manifest text for every prompt the core can play, and for nothing else', () => {
      const manifest = JSON.parse(
        readFileSync(join(PROMPTS_DIR, `${language}.json`), 'utf8')
      ) as { prompts: Record<string, string> };
      expect(Object.keys(manifest.prompts).sort()).toEqual(
        names.filter(name => name !== BEEP_PROMPT)
      );
    });

    it('holds every prompt the core can play in every format, and nothing else', () => {
      expect(setFiles(language).sort()).toEqual(
        names.flatMap(name => FORMATS.map(format => `${name}.${format}`)).sort()
      );
    });
  }
);
