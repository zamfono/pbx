/**
 * Mail templates as the API compiles them (`mail/templates.ts`, `mail/render.ts`): the placeholders
 * each kind offers and requires, the Handlebars subset a template may use (`if`, `unless`, `each`,
 * `with`, `{{date value}}`), the check `mailTemplates.put` runs, and a renderer for the preview.
 */
import type { Language, MailKind } from '#lib/api/types.js';

/** Offered on every kind: the company display name, the addressee's name and the stack's host. */
const COMMON = ['companyName', 'recipientName', 'fqdn'];

/** §10.2 table: the placeholders each kind offers, and which of those a template must use. */
export const PLACEHOLDERS: Record<
  MailKind,
  { offered: string[]; required: string[] }
> = {
  voicemail: {
    offered: [
      ...COMMON,
      'callerNumber',
      'callerName',
      'mailboxName',
      'receivedAt',
      'durationS'
    ],
    required: []
  },
  missedCall: {
    offered: [
      ...COMMON,
      'callerNumber',
      'callerName',
      'receivedAt',
      'didLabel'
    ],
    required: []
  },
  setup: {
    offered: [...COMMON, 'link', 'linkExpiresAt', 'invitedBy'],
    required: ['link']
  },
  reset: { offered: [...COMMON, 'link', 'linkExpiresAt'], required: ['link'] },
  updateFailed: {
    offered: [...COMMON, 'fromVersion', 'toVersion', 'reason', 'failedAt'],
    required: []
  },
  breakingUpdate: {
    offered: [
      ...COMMON,
      'currentVersion',
      'version',
      'releaseUrl',
      'publishedAt'
    ],
    required: []
  },
  mfaChanged: {
    offered: [
      ...COMMON,
      'added',
      'removed',
      'reset',
      'passkeyName',
      'changedAt'
    ],
    required: []
  }
};

const BLOCK_HELPERS = new Set(['if', 'unless', 'each', 'with']);
const ALLOWED_HELPERS = new Set([...BLOCK_HELPERS, 'date', 'else']);
const TAG = /\{\{(\{?)\s*([#/]?)\s*([^}]*?)\s*\}?\}\}/gu;
const IDENTIFIER = /^[A-Za-z_][\w.]*$/u;

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; date: boolean; raw: boolean }
  | { kind: 'open'; helper: string; arg: string }
  | { kind: 'else'; arg: string | null }
  | { kind: 'close'; helper: string };

export class TemplateError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    const [whole, triple = '', sigil = '', body = ''] = match;
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: 'text', text: source.slice(last, index) });
    }
    last = index + whole.length;
    const parts = body.split(/\s+/u).filter(Boolean);
    const [head = '', ...rest] = parts;
    if (sigil === '#') {
      if (!BLOCK_HELPERS.has(head)) {
        throw new TemplateError(`template: helper ${head} not allowed`);
      }
      tokens.push({ kind: 'open', helper: head, arg: rest[0] ?? '' });
    } else if (sigil === '/') {
      tokens.push({ kind: 'close', helper: head });
    } else if (head === 'else') {
      tokens.push({
        kind: 'else',
        arg: rest[0] === 'if' ? (rest[1] ?? '') : null
      });
    } else if (head === 'date') {
      tokens.push({
        kind: 'var',
        name: rest[0] ?? '',
        date: true,
        raw: triple === '{'
      });
    } else if (rest.length > 0 && !ALLOWED_HELPERS.has(head)) {
      throw new TemplateError(`template: helper ${head} not allowed`);
    } else {
      tokens.push({
        kind: 'var',
        name: head,
        date: false,
        raw: triple === '{'
      });
    }
  }
  if (last < source.length) {
    tokens.push({ kind: 'text', text: source.slice(last) });
  }
  return tokens;
}

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; date: boolean; raw: boolean }
  | {
      kind: 'block';
      helper: string;
      arg: string;
      body: Node[];
      otherwise: Node[];
    };

type Frame = {
  node: Extract<Node, { kind: 'block' }>;
  inElse: boolean;
  chained: boolean;
};

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Frame[] = [];
  const target = (): Node[] => {
    const frame = stack.at(-1);
    if (frame === undefined) {
      return root;
    }
    return frame.inElse ? frame.node.otherwise : frame.node.body;
  };
  for (const token of tokenize(source)) {
    if (token.kind === 'text' || token.kind === 'var') {
      target().push(token);
    } else if (token.kind === 'open') {
      const node: Node = {
        kind: 'block',
        helper: token.helper,
        arg: token.arg,
        body: [],
        otherwise: []
      };
      target().push(node);
      stack.push({ node, inElse: false, chained: false });
    } else if (token.kind === 'else') {
      const frame = stack.at(-1);
      if (frame === undefined) {
        throw new TemplateError('template: else outside a block');
      }
      frame.inElse = true;
      if (token.arg !== null) {
        const node: Node = {
          kind: 'block',
          helper: 'if',
          arg: token.arg,
          body: [],
          otherwise: []
        };
        frame.node.otherwise.push(node);
        stack.push({ node, inElse: false, chained: true });
      }
    } else {
      let frame = stack.pop();
      while (frame?.chained === true) {
        frame = stack.pop();
      }
      if (frame === undefined || frame.node.helper !== token.helper) {
        throw new TemplateError(`template: unexpected {{/${token.helper}}}`);
      }
    }
  }
  if (stack.length > 0) {
    throw new TemplateError(
      `template: {{#${stack[0]?.node.helper ?? ''}}} is not closed`
    );
  }
  return root;
}

function collect(nodes: Node[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'var') {
      into.add(node.name);
    } else if (node.kind === 'block') {
      if (IDENTIFIER.test(node.arg)) {
        into.add(node.arg);
      }
      collect(node.body, into);
      collect(node.otherwise, into);
    }
  }
}

/** The placeholder names a template source uses; throws a `TemplateError` on invalid syntax. */
export function usedPlaceholders(source: string): string[] {
  const names = new Set<string>();
  collect(parse(source), names);
  return [...names];
}

/** Placeholders `source` uses that `kind` does not offer; an unparseable source yields none. */
export function unknownPlaceholders(kind: MailKind, source: string): string[] {
  try {
    return usedPlaceholders(source).filter(
      name => !PLACEHOLDERS[kind].offered.includes(name)
    );
  } catch {
    return [];
  }
}

/** The check `mailTemplates.put` runs (`compileTemplate`): syntax, offered and required names. */
export function checkTemplate(
  kind: MailKind,
  subject: string,
  bodyText: string,
  bodyHtml: string | null
): void {
  const { offered, required } = PLACEHOLDERS[kind];
  const used = new Set<string>();
  for (const source of [
    subject,
    bodyText,
    ...(bodyHtml === null ? [] : [bodyHtml])
  ]) {
    for (const name of usedPlaceholders(source)) {
      used.add(name);
    }
  }
  for (const name of used) {
    if (!offered.includes(name)) {
      throw new TemplateError(`template: unknown placeholder ${name}`);
    }
  }
  for (const name of required) {
    if (!used.has(name)) {
      throw new TemplateError(`template: missing required ${name}`);
    }
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;'
};
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, char => HTML_ESCAPES[char] ?? char);

const truthy = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : Boolean(value);

type RenderOptions = {
  language: Language;
  timezone: string | null;
  escape: boolean;
};

function renderNodes(
  nodes: Node[],
  values: Record<string, unknown>,
  options: RenderOptions
): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.text;
    } else if (node.kind === 'var') {
      const value = values[node.name];
      let text = value === undefined || value === null ? '' : String(value);
      if (node.date && text !== '') {
        const date = new Date(text);
        text = Number.isNaN(date.getTime())
          ? text
          : new Intl.DateTimeFormat(options.language, {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: options.timezone ?? undefined
            }).format(date);
      }
      out += options.escape && !node.raw ? escapeHtml(text) : text;
    } else {
      const condition = truthy(values[node.arg]);
      const pass = node.helper === 'unless' ? !condition : condition;
      out += renderNodes(pass ? node.body : node.otherwise, values, options);
    }
  }
  return out;
}

/** Renders `source` with `values`, as the mail would read; an invalid template renders verbatim. */
export function renderTemplate(
  source: string,
  values: Record<string, unknown>,
  options: RenderOptions
): string {
  try {
    return renderNodes(parse(source), values, options);
  } catch {
    return source;
  }
}

/** Example values per kind for the preview, in the shape `mailTemplates.test` sends. */
export function sampleValues(
  kind: MailKind,
  common: { companyName: string; recipientName: string; fqdn: string },
  now: string
): Record<string, unknown> {
  const inSevenDays = new Date(
    new Date(now).getTime() + 7 * 86_400_000
  ).toISOString();
  const byKind: Record<MailKind, Record<string, unknown>> = {
    voicemail: {
      callerNumber: '+49897788990',
      callerName: 'Martina Huber',
      mailboxName: 'Empfang',
      receivedAt: now,
      durationS: 42
    },
    missedCall: {
      callerNumber: '+49897788990',
      callerName: 'Martina Huber',
      receivedAt: now,
      didLabel: 'Zentrale'
    },
    setup: {
      link: `https://${common.fqdn}/auth/set?token=…`,
      linkExpiresAt: inSevenDays,
      invitedBy: 'Jonas Weber'
    },
    reset: {
      link: `https://${common.fqdn}/auth/reset?token=…`,
      linkExpiresAt: inSevenDays
    },
    updateFailed: {
      fromVersion: '0.4.1',
      toVersion: '0.5.0',
      reason: 'backup to NAS failed: connection refused',
      failedAt: now
    },
    breakingUpdate: {
      currentVersion: '0.4.1',
      version: '1.0.0',
      releaseUrl: 'https://github.com/zamfono/pbx/releases',
      publishedAt: now
    },
    mfaChanged: {
      added: true,
      removed: false,
      reset: false,
      passkeyName: 'MacBook',
      changedAt: now
    }
  };
  return { ...common, ...byKind[kind] };
}
