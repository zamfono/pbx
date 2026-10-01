/**
 * The template syntax §10.2 "Templates" allows, checked on the parsed AST before a template is
 * compiled: which helpers and statements may appear, and which placeholders a source reads.
 * `render.ts` compiles and renders what passes.
 */
import Handlebars from 'handlebars';

// §10.2 "Templates": `{{placeholder}}` substitution, the built-in block helpers and one
// registered helper, `date`; no other helper and no partial is available.
const ALLOWED_HELPERS = new Set(['if', 'unless', 'each', 'with', 'date']);

/** Adds `path`'s own name to `used` unless it is a private `@..` data variable or `this`. */
function collectPath(path: hbs.AST.PathExpression, used: Set<string>): void {
  if (path.data) {
    return;
  }
  const [head] = path.parts;
  if (!head || head === 'this') {
    return;
  }
  used.add(head);
}

/** Throws `template: helper X not allowed` for a helper name outside `ALLOWED_HELPERS`. */
function assertAllowedHelper(name: string): void {
  if (!ALLOWED_HELPERS.has(name)) {
    throw new Error(`template: helper ${name} not allowed`);
  }
}

function collectExpression(node: hbs.AST.Expression, used: Set<string>): void {
  if (node.type === 'PathExpression') {
    collectPath(node as hbs.AST.PathExpression, used);
    return;
  }
  if (node.type === 'SubExpression') {
    const sub = node as hbs.AST.SubExpression;
    assertAllowedHelper(sub.path.original);
    // eslint-disable-next-line no-use-before-define -- collectArgs and collectExpression walk the AST mutually
    collectArgs(sub.params, sub.hash, used);
  }
}

/** Collects the placeholders read by a helper's or a mustache's arguments and hash pairs. */
function collectArgs(
  params: hbs.AST.Expression[],
  hash: hbs.AST.Hash | undefined,
  used: Set<string>
): void {
  for (const param of params) {
    collectExpression(param, used);
  }
  // Handlebars omits `hash` on a statement with no `key=value` pairs (e.g. `{{date value}}`).
  for (const pair of hash?.pairs ?? []) {
    collectExpression(pair.value, used);
  }
}

function collectProgram(
  program: hbs.AST.Program,
  used: Set<string>,
  isHtml: boolean
): void {
  for (const statement of program.body) {
    // eslint-disable-next-line no-use-before-define -- collectProgram and collectStatement walk the AST mutually
    collectStatement(statement, used, isHtml);
  }
}

function collectStatement(
  node: hbs.AST.Statement,
  used: Set<string>,
  isHtml: boolean
): void {
  if (node.type === 'ContentStatement' || node.type === 'CommentStatement') {
    return;
  }
  if (node.type === 'MustacheStatement') {
    const mustache = node as hbs.AST.MustacheStatement;
    if (isHtml && !mustache.escaped) {
      // §10.2 "Templates": "values are HTML-escaped in the HTML body" — a triple-stash mustache
      // opts out of that escaping, so it is rejected the same way a disallowed helper is.
      throw new Error('template: unescaped output not allowed');
    }
    const path = mustache.path as hbs.AST.PathExpression;
    if (mustache.params.length > 0) {
      assertAllowedHelper(path.original);
      collectArgs(mustache.params, mustache.hash, used);
    } else {
      collectPath(path, used);
    }
    return;
  }
  if (node.type === 'BlockStatement') {
    const block = node as hbs.AST.BlockStatement;
    assertAllowedHelper(block.path.original);
    collectArgs(block.params, block.hash, used);
    collectProgram(block.program, used, isHtml);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Handlebars types `inverse` as a non-optional Program, but it is undefined for a block with no {{else}}
    if (block.inverse) {
      collectProgram(block.inverse, used, isHtml);
    }
    return;
  }
  // Only mustaches and the allowed blocks are valid template statements (§10.2 "Templates").
  throw new Error(`template: ${node.type} not allowed`);
}

/** The placeholders `source` reads; throws for a disallowed helper, partial or unescaped mustache. */
export function usedPlaceholders(source: string, isHtml: boolean): Set<string> {
  const used = new Set<string>();
  collectProgram(Handlebars.parse(source), used, isHtml);
  return used;
}
