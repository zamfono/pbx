import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { attempt } from '../errors.js';
import { OpError } from '../ops/types.js';

// The guide ships as `docs/guide/{*.md,recipes/*.md}` (§10.5). `import.meta.glob` bundles the
// text into the server chunk at build time, so it ships inside the deployed tree regardless of
// where the bundle ends up; an absent `docs/guide` at build time yields an empty topic and prompt
// list (Task 42 adds the files).
const GUIDE_MODULES = import.meta.glob<string>(
  '../../../../../docs/guide/**/*.md',
  { query: '?raw', import: 'default', eager: true }
);
const RECIPES_SEGMENT = '/recipes/';
const STATUS_NOT_FOUND = 404;
export const MD_EXT = '.md';
export const HELP_TOOL_NAME = 'zamfono.help';
export const HELP_TOOL = {
  name: HELP_TOOL_NAME,
  description: 'Reads a section of the admin guide by topic name.',
  inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
  annotations: { readOnlyHint: true, destructiveHint: false }
};
type HelpOutput = { topics: string[] } | { topic: string; content: string };
export type BundledEntry = { name: string; content: string; isRecipe: boolean };

/** Every bundled guide/recipe file, named by its topic. */
export function bundledEntries(): BundledEntry[] {
  return Object.entries(GUIDE_MODULES).map(([file, content]) => ({
    name: path.basename(file, MD_EXT),
    content,
    isRecipe: file.includes(RECIPES_SEGMENT)
  }));
}

/** Every guide topic name mapped to a loader for its content; a guide topic wins over a recipe of
 * the same name. With no directory override this reads the files bundled at build time; passing
 * `guideDir`/`recipesDir` (fixture tests only) reads them from disk instead. */
function helpFiles(
  guideDir?: string,
  recipesDir?: string
): Map<string, () => string> {
  const files = new Map<string, () => string>();
  if (guideDir === undefined && recipesDir === undefined) {
    const entries = bundledEntries();
    for (const entry of entries.filter(candidate => !candidate.isRecipe)) {
      files.set(entry.name, () => entry.content);
    }
    for (const entry of entries.filter(candidate => candidate.isRecipe)) {
      if (!files.has(entry.name)) {
        files.set(entry.name, () => entry.content);
      }
    }
    return files;
  }
  for (const dir of [guideDir, recipesDir]) {
    if (dir === undefined) {
      continue;
    }
    for (const entry of attempt(() => readdirSync(dir)) ?? []) {
      if (!entry.endsWith(MD_EXT)) {
        continue;
      }
      const name = entry.slice(0, -MD_EXT.length);
      const filePath = path.join(dir, entry);
      if (!files.has(name)) {
        files.set(name, () => readFileSync(filePath, 'utf8'));
      }
    }
  }
  return files;
}

/** `zamfono.help`'s output: the topic list with no `topic`, else that topic's text; an unknown
 * topic throws, which the tool call reports as a tool execution error. */
export function callHelp(
  args: Record<string, unknown>,
  guideDir?: string,
  recipesDir?: string
): HelpOutput {
  const topic = typeof args.topic === 'string' ? args.topic : null;
  const files = helpFiles(guideDir, recipesDir);
  if (topic === null) {
    return { topics: [...files.keys()].sort() };
  }
  const load = files.get(topic);
  if (!load) {
    throw new OpError(STATUS_NOT_FOUND, `unknown help topic '${topic}'`);
  }
  return { topic, content: load() };
}
