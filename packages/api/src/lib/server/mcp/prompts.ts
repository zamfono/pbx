import { isRecord } from '@zamfono/shared';

import { bundledEntries, type BundledEntry } from './guide.js';

// §10.5 "Prompts": every `docs/guide/recipes/*.md` file is published as an MCP prompt, its
// parameters from the recipe's front matter, listed by `prompts/list` and fetched, filled in with
// the client's arguments, by `prompts/get`. The shapes are the MCP schema's `Prompt` and
// `GetPromptResult`, the same in 2025-11-25 and 2026-07-28
// (https://modelcontextprotocol.io/specification/2026-07-28/server/prompts).
const FRONT_MATTER_DELIM = '---';
type RecipeArgument = { name: string; description: string; required: boolean };
export type Prompt = {
  name: string;
  title: string;
  description: string;
  arguments: RecipeArgument[];
};
/** A `GetPromptResult`'s own fields; the era's result shape wraps them (`./results.js`). */
export type PromptContent = {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
};

/**
 * A `prompts/get` the server cannot answer: an unknown prompt, a required argument missing, or
 * arguments that are not the schema's string map. Both revisions' "Error Handling" name `-32602`
 * (Invalid params) for these, a protocol error rather than a result.
 */
export class PromptRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRequestError';
  }
}

/** The index of the front matter's closing delimiter, or -1 when the file has none. */
function frontMatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== FRONT_MATTER_DELIM) {
    return -1;
  }
  return lines.indexOf(FRONT_MATTER_DELIM, 1);
}

// ponytail: parses only the flat shape the guide's recipes use (a `title` line and a flat
// `arguments` list of `{name, description, required}`) and throws on any other line, so a recipe
// whose front matter grows nested or multi-line values fails the build's tests; a maintained YAML
// parser replaces this then.
export function parseRecipeFrontMatter(content: string): {
  title: string;
  arguments: RecipeArgument[];
} {
  const lines = content.split('\n');
  const end = frontMatterEnd(lines);
  if (end === -1) {
    return { title: '', arguments: [] };
  }
  let title = '';
  const args: Partial<RecipeArgument>[] = [];
  for (const line of lines.slice(1, end)) {
    const titleMatch = /^title:\s*(?<value>.+)$/u.exec(line);
    const nameMatch = /^\s*-\s*name:\s*(?<value>.+)$/u.exec(line);
    const descMatch = /^\s*description:\s*(?<value>.+)$/u.exec(line);
    const requiredMatch = /^\s*required:\s*(?<value>true|false)$/u.exec(line);
    const lastArg = args.at(-1);
    if (titleMatch?.groups) {
      // The regex's `value` group is mandatory, so a match always sets it.
      title = (titleMatch.groups.value ?? '').trim();
    } else if (nameMatch?.groups) {
      args.push({ name: (nameMatch.groups.value ?? '').trim() });
    } else if (descMatch?.groups && lastArg) {
      lastArg.description = (descMatch.groups.value ?? '').trim();
    } else if (requiredMatch?.groups && lastArg) {
      lastArg.required = requiredMatch.groups.value === 'true';
    } else if (line.trim() !== '' && line.trim() !== 'arguments:') {
      throw new Error(`recipe front matter: unparsed line '${line}'`);
    }
  }
  const complete = args.map(arg => ({
    name: arg.name ?? '',
    description: arg.description ?? '',
    required: arg.required ?? false
  }));
  return { title, arguments: complete };
}

/** The recipe's text after its front matter: what `prompts/get` hands the model. */
function recipeBody(content: string): string {
  const lines = content.split('\n');
  const end = frontMatterEnd(lines);
  return lines
    .slice(end + 1)
    .join('\n')
    .trim();
}

/** Every recipe, named by its file. */
function recipes(): BundledEntry[] {
  return bundledEntries().filter(entry => entry.isRecipe);
}

function promptFrom({ name, content }: BundledEntry): Prompt {
  const { title, arguments: args } = parseRecipeFrontMatter(content);
  return {
    name,
    title: title || name,
    description: title || name,
    arguments: args
  };
}

/** One MCP prompt per recipe, its parameters from the front matter (§10.5). */
export function listPrompts(): Prompt[] {
  return recipes().map(promptFrom);
}

/** `prompts/get`'s `arguments`, the schema's `{ [key: string]: string }`; `null` when malformed. */
function promptArguments(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  const strings = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return strings.length === entries.length ? Object.fromEntries(strings) : null;
}

/**
 * `prompts/get`: the named recipe as one user message, followed by the arguments the client
 * filled in. An empty string counts as not given, since a client's form sends one for an optional
 * field left blank. Each value is quoted as a JSON string, so a newline in one cannot forge
 * another parameter line of the message.
 */
export function getPrompt(params: Record<string, unknown>): PromptContent {
  const name = params.name;
  if (typeof name !== 'string') {
    throw new PromptRequestError('prompts/get needs a prompt name');
  }
  const recipe = recipes().find(entry => entry.name === name);
  if (!recipe) {
    throw new PromptRequestError(`Unknown prompt: ${name}`);
  }
  const args = promptArguments(params.arguments);
  if (!args) {
    throw new PromptRequestError('prompt arguments must be strings');
  }
  const prompt = promptFrom(recipe);
  const declared = new Set(prompt.arguments.map(arg => arg.name));
  const unknown = Object.keys(args).filter(key => !declared.has(key));
  if (unknown.length > 0) {
    throw new PromptRequestError(`Unknown argument: ${unknown.join(', ')}`);
  }
  const missing = prompt.arguments.filter(
    arg => arg.required && !args[arg.name]
  );
  if (missing.length > 0) {
    const names = missing.map(arg => arg.name).join(', ');
    throw new PromptRequestError(`Missing required argument: ${names}`);
  }
  const given = prompt.arguments
    .filter(arg => args[arg.name])
    .map(arg => `- ${arg.name}: ${JSON.stringify(args[arg.name])}`);
  const body = recipeBody(recipe.content);
  const text =
    given.length > 0 ? `${body}\n\nParameters:\n${given.join('\n')}` : body;
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text } }]
  };
}
