/**
 * What a template may hold (§9.4 "Templates"), checked on Handlebars' parsed program before it is
 * compiled: literal text and mustaches of a path or of a helper call, nothing else. `templates.ts`
 * compiles and renders what passes.
 */
import Handlebars from 'handlebars';

import { helperArity, HELPERS } from './templateHelpers.js';

/** The names a template may not use for a value of its own: the helpers and what Handlebars
 * reads as a literal or a keyword. */
export const RESERVED_TEMPLATE_NAMES: readonly string[] = [
  ...Object.keys(HELPERS),
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'else'
];

type Expression = hbs.AST.Expression;

/** Why `expression` is not allowed, else `null`, its top-level names added to `names`: a path
 * into the values, a literal, or a helper call with the helper's number of arguments. */
function expressionProblem(
  expression: Expression,
  names: Set<string>
): string | null {
  if (expression.type === 'PathExpression') {
    const path = expression as hbs.AST.PathExpression;
    const [head] = path.parts;
    if (path.data || path.depth > 0 || head === undefined) {
      return `'${path.original}' is no placeholder`;
    }
    names.add(head);
    return null;
  }
  if (expression.type !== 'SubExpression') {
    // A string, number, boolean, undefined or null literal.
    return null;
  }
  // eslint-disable-next-line no-use-before-define -- a call's arguments are expressions again
  return callProblem(expression as hbs.AST.SubExpression, names);
}

/** Why the helper call `call` is not allowed, else `null`. */
function callProblem(
  call: Pick<hbs.AST.SubExpression, 'path' | 'params' | 'hash'>,
  names: Set<string>
): string | null {
  const name = call.path.original;
  if (!Object.hasOwn(HELPERS, name)) {
    return `the unknown helper '${name}'`;
  }
  const [least, most] = helperArity(name);
  // Handlebars leaves `hash` out of a call with no `key=value` pair.
  const { hash } = call as { hash?: hbs.AST.Hash };
  if (
    call.params.length < least ||
    call.params.length > most ||
    (hash?.pairs.length ?? 0) > 0
  ) {
    return `'${name}' with the wrong number of arguments`;
  }
  for (const param of call.params) {
    const problem = expressionProblem(param, names);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/** Whether `mustache` calls a helper: it has arguments, or names one. */
export function isCall(mustache: hbs.AST.MustacheStatement): boolean {
  const { hash } = mustache as { hash?: hbs.AST.Hash };
  return (
    mustache.params.length > 0 ||
    (hash?.pairs.length ?? 0) > 0 ||
    Object.hasOwn(HELPERS, (mustache.path as hbs.AST.PathExpression).original)
  );
}

/** Why the statement `node` is not allowed, else `null`: literal text, or a mustache of a path
 * or a helper call, escaped (`{{{…}}}` would opt out of the field's escaping). */
function statementProblem(
  node: hbs.AST.Statement,
  names: Set<string>
): string | null {
  if (node.type === 'ContentStatement') {
    return null;
  }
  if (node.type !== 'MustacheStatement') {
    return 'a block, partial or comment, which no template takes';
  }
  const mustache = node as hbs.AST.MustacheStatement;
  if (!mustache.escaped) {
    return 'an unescaped {{{…}}}';
  }
  if (mustache.path.type !== 'PathExpression') {
    return 'a mustache of a literal';
  }
  return isCall(mustache)
    ? callProblem(
        mustache as hbs.AST.MustacheStatement & hbs.AST.SubExpression,
        names
      )
    : expressionProblem(mustache.path, names);
}

export type ParsedTemplate =
  | { ok: true; program: hbs.AST.Program; names: Set<string> }
  | { ok: false; reason: string };

/** `source` parsed and checked: its program and the top-level names it reads, or why it is no
 * template. */
export function parseTemplate(source: string): ParsedTemplate {
  let program: hbs.AST.Program;
  try {
    program = Handlebars.parse(source);
  } catch {
    return { ok: false, reason: `a '{{' that opens no {{placeholder}}` };
  }
  const names = new Set<string>();
  for (const statement of program.body) {
    const reason = statementProblem(statement, names);
    if (reason !== null) {
      return { ok: false, reason };
    }
  }
  return { ok: true, program, names };
}

/**
 * Why `source` is no valid template, as a write refuses it (422), else `null`: it parses, holds
 * only text and mustaches, calls only the helpers, each with its number of arguments, and every
 * top-level name it reads is one `isName` takes (left out, any name).
 */
export function templateProblem(
  source: string,
  isName: (name: string) => boolean = () => true
): string | null {
  const parsed = parseTemplate(source);
  if (!parsed.ok) {
    return parsed.reason;
  }
  const unknown = [...parsed.names].find(name => !isName(name));
  return unknown === undefined ? null : `the unknown placeholder '${unknown}'`;
}

/** The top-level names `source` reads, none for one that is no valid template. */
export function templateNames(source: string): string[] {
  const parsed = parseTemplate(source);
  return parsed.ok ? [...parsed.names] : [];
}

/** The plain `{{name}}` mustaches and the other mustaches of `source`, and its literal text, for
 * a field that bounds what a template may render to (`sipHeaders.ts`); `null` for no template. */
export function templateParts(
  source: string
): ({ text: string } | { name: string } | { computed: true })[] | null {
  const parsed = parseTemplate(source);
  if (!parsed.ok) {
    return null;
  }
  return parsed.program.body.map(node => {
    if (node.type === 'ContentStatement') {
      return { text: (node as hbs.AST.ContentStatement).value };
    }
    const { path, params } = node as hbs.AST.MustacheStatement;
    const { parts, original } = path as hbs.AST.PathExpression;
    return params.length === 0 && parts.length === 1 && parts[0] === original
      ? { name: original }
      : { computed: true };
  });
}
