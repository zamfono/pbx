import path from 'node:path';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { OpError } from '../ops/types.js';

// The guide ships as `docs/guide/{*.md,recipes/*.md}` (§10.5). `import.meta.glob` bundles the
// text into the server chunk at build time, so it ships inside the deployed tree regardless of
// where the bundle ends up; an absent `docs/guide` at build time yields an empty topic and prompt
// list.
const GUIDE_MODULES = import.meta.glob<string>(
  '../../../../../../docs/guide/**/*.md',
  { query: '?raw', import: 'default', eager: true }
);
const RECIPES_SEGMENT = '/recipes/';
// A topic name clients guess for the table of contents; it lists the topics, as no topic does,
// unless a guide file of that name exists.
const INDEX_ALIAS = 'index';
const MD_EXT = '.md';
export const HELP_TOOL_NAME = 'zamfono.help';
export const HELP_TOOL = {
  name: HELP_TOOL_NAME,
  description:
    'Reads a section of the admin guide by topic name; without a topic, lists every topic.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'A topic name, such as mental-model, routing-order, numbers or a recipe; left out, the list of every topic.'
      }
    }
  },
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

/** Every guide topic name mapped to its text; a guide topic wins over a recipe of the same name. */
function helpFiles(): Map<string, string> {
  const entries = bundledEntries();
  const files = new Map<string, string>();
  for (const entry of [
    ...entries.filter(candidate => !candidate.isRecipe),
    ...entries.filter(candidate => candidate.isRecipe)
  ]) {
    if (!files.has(entry.name)) {
      files.set(entry.name, entry.content);
    }
  }
  return files;
}

/** `zamfono.help`'s output: the topic list with no `topic` (or `index`), else that topic's text;
 * an unknown topic throws, naming every topic, which the tool call reports as a tool execution
 * error. */
export function callHelp(args: Record<string, unknown>): HelpOutput {
  const topic = typeof args.topic === 'string' ? args.topic : null;
  const files = helpFiles();
  const topics = [...files.keys()].sort();
  if (topic === null || (topic === INDEX_ALIAS && !files.has(topic))) {
    return { topics };
  }
  const content = files.get(topic);
  if (content === undefined) {
    // The message is all a client sees of the error, so it carries the list itself.
    throw new OpError(
      HTTP_NOT_FOUND,
      `unknown help topic '${topic}'; call zamfono.help without a topic for the list: ${topics.join(', ')}`
    );
  }
  return { topic, content };
}
