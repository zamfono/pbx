/**
 * The one template renderer (§9.4 "Templates"): a SIP target's headers, a forward target's
 * templated address, a decision's `template` condition and an HTTP request's URL, headers and
 * body are Handlebars templates of `{{placeholder}}`s, paths into them and the helpers below. No
 * blocks, no partials and no other helper. `api` validates a template on write and `core` and
 * `api` render it, so the two cannot disagree on what one means. Handlebars' HTML escaping is off:
 * each mustache's output is escaped for the field it lands in (`TemplateContext`).
 */
import Handlebars from 'handlebars';

import {
  ESCAPES,
  HELPERS,
  text,
  type TemplateContext
} from './templateHelpers.js';
import { isCall, parseTemplate } from './templateSyntax.js';

export type { TemplateContext } from './templateHelpers.js';
export {
  RESERVED_TEMPLATE_NAMES,
  templateNames,
  templateParts,
  templateProblem
} from './templateSyntax.js';

/** The helpers' names. */
export const TEMPLATE_HELPERS = Object.keys(HELPERS);

/** Whether `value` is a template rather than literal text: it opens a mustache. */
export function isTemplate(value: string): boolean {
  return value.includes('{{');
}

const escapeHelper = (context: TemplateContext): string => `escape:${context}`;

const engine = Handlebars.create();
// Only the helpers above exist: no `lookup` and no `log`, and no block is let through to `if`,
// `each` and the like (`templateProblem`).
engine.unregisterHelper('lookup');
engine.unregisterHelper('log');
for (const [name, helper] of Object.entries(HELPERS)) {
  // Handlebars hands a helper its options last, after the template's own arguments.
  engine.registerHelper(name, (...args: unknown[]) =>
    helper.run(...args.slice(0, -1))
  );
}
for (const [context, escape] of Object.entries(ESCAPES)) {
  engine.registerHelper(escapeHelper(context as TemplateContext), value =>
    escape(text(value))
  );
}
const KNOWN_HELPERS = Object.fromEntries(
  [
    ...Object.keys(HELPERS),
    ...Object.keys(ESCAPES).map(context =>
      escapeHelper(context as TemplateContext)
    )
  ].map(name => [name, true])
);

/** `program` with each mustache's output passed through `context`'s escape: `{{x}}` becomes
 * `{{escape:<context> x}}`, a helper call its one argument. */
function escaped(
  program: hbs.AST.Program,
  context: TemplateContext
): hbs.AST.Program {
  const name = escapeHelper(context);
  return {
    ...program,
    body: program.body.map(node => {
      if (node.type !== 'MustacheStatement') {
        return node;
      }
      const mustache = node as hbs.AST.MustacheStatement;
      const inner: hbs.AST.Expression = isCall(mustache)
        ? ({
            type: 'SubExpression',
            path: mustache.path,
            params: mustache.params,
            hash: mustache.hash,
            loc: mustache.loc
          } as hbs.AST.SubExpression)
        : mustache.path;
      return {
        ...mustache,
        path: {
          type: 'PathExpression',
          data: false,
          depth: 0,
          parts: [name],
          original: name,
          loc: mustache.loc
        },
        params: [inner],
        hash: undefined
      } as unknown as hbs.AST.MustacheStatement;
    })
  };
}

// ponytail: every template rendered stays compiled for the process; they are the configuration's
// own, so the map grows with config edits alone. Bound it if templates ever come from a request.
const compiled = new Map<string, Handlebars.TemplateDelegate | null>();

function compile(
  source: string,
  context: TemplateContext
): Handlebars.TemplateDelegate | null {
  const key = `${context}\n${source}`;
  let template = compiled.get(key);
  if (template === undefined) {
    const parsed = parseTemplate(source);
    template = parsed.ok
      ? engine.compile(escaped(parsed.program, context), {
          noEscape: true,
          knownHelpers: KNOWN_HELPERS,
          knownHelpersOnly: true
        })
      : null;
    compiled.set(key, template);
  }
  return template;
}

/**
 * `source` rendered with `values`, each mustache's output escaped for `context`. A value or a
 * path that is missing renders empty, never an error; `null` for a source that is no valid
 * template, which a write would have refused.
 */
export function renderTemplate(
  source: string,
  values: Readonly<Record<string, unknown>>,
  context: TemplateContext
): string | null {
  if (!isTemplate(source)) {
    return source;
  }
  const template = compile(source, context);
  return template === null ? null : template(values);
}
