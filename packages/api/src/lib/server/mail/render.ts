import Handlebars from 'handlebars';

import type { Db, Language } from '@zamfono/shared';

import {
  loadBuiltinTemplate,
  PLACEHOLDERS,
  type TemplateKind
} from './templates.js';
import { usedPlaceholders } from './templateSyntax.js';

// Handlebars' own `knownHelpersOnly` compile guard (defense in depth next to the helper check
// `templateSyntax.ts` runs itself, which produces the `template: helper X not allowed` message).
const KNOWN_HELPERS: Record<string, boolean> = {
  if: true,
  unless: true,
  each: true,
  with: true,
  date: true,
  lookup: false,
  log: false
};

const DEFAULT_LANGUAGE: Language = 'en';

/** `{{date value}}`: `value` formatted in the tenant's language and time zone (§10.2). */
function formatDate(value: unknown, options: Handlebars.HelperOptions): string {
  const data = options.data as { root?: unknown } | undefined;
  const root = (data?.root ?? {}) as {
    tenantLocale?: { language?: unknown; timezone?: unknown };
  };
  const language =
    typeof root.tenantLocale?.language === 'string'
      ? root.tenantLocale.language
      : DEFAULT_LANGUAGE;
  const timezone =
    typeof root.tenantLocale?.timezone === 'string'
      ? root.tenantLocale.timezone
      : undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone
  }).format(date);
}

const engine = Handlebars.create();
engine.registerHelper('date', formatDate);

/** A template compiled and validated against `kind`'s offered and required placeholders. */
export type CompiledTemplate = {
  render(
    values: Record<string, unknown>,
    tenant: { language: Language; timezone: string | null }
  ): { subject: string; text: string; html: string | null };
};

function compileField(
  source: string,
  escape: boolean
): Handlebars.TemplateDelegate {
  return engine.compile(source, {
    knownHelpers: KNOWN_HELPERS,
    knownHelpersOnly: true,
    noEscape: !escape
  });
}

/**
 * Parses and validates `subject`/`bodyText`/`bodyHtml` against `kind`'s placeholders (§10.2
 * "Templates"): throws `Error('template: unknown placeholder X')` for a placeholder `kind` does
 * not offer, `Error('template: helper X not allowed')` for anything but `if`/`unless`/`each`/
 * `with`/`date`, and `Error('template: missing required X')` for an unused required one.
 */
export function compileTemplate(
  kind: TemplateKind,
  subject: string,
  bodyText: string,
  bodyHtml: string | null
): CompiledTemplate {
  const { offered, required } = PLACEHOLDERS[kind];
  const used = new Set<string>();
  for (const source of [subject, bodyText]) {
    for (const name of usedPlaceholders(source, false)) {
      used.add(name);
    }
  }
  if (bodyHtml !== null) {
    for (const name of usedPlaceholders(bodyHtml, true)) {
      used.add(name);
    }
  }
  for (const name of used) {
    if (!offered.includes(name)) {
      throw new Error(`template: unknown placeholder ${name}`);
    }
  }
  for (const name of required) {
    if (!used.has(name)) {
      throw new Error(`template: missing required ${name}`);
    }
  }

  const subjectTemplate = compileField(subject, false);
  const textTemplate = compileField(bodyText, false);
  const htmlTemplate = bodyHtml === null ? null : compileField(bodyHtml, true);

  return {
    render(values, tenant) {
      const root = {
        ...values,
        tenantLocale: {
          language: tenant.language,
          timezone: tenant.timezone ?? undefined
        }
      };
      return {
        subject: subjectTemplate(root),
        text: textTemplate(root),
        html: htmlTemplate === null ? null : htmlTemplate(root)
      };
    }
  };
}

/**
 * The effective template for `kind` in `language` (§10.2 "Templates"): the tenant's override
 * (`mail_templates`) when one exists, else the shipped built-in.
 */
export async function resolveTemplate(
  db: Db,
  kind: TemplateKind,
  language: Language
): Promise<CompiledTemplate> {
  const override = await db
    .selectFrom('mailTemplates')
    .select(['subject', 'bodyText', 'bodyHtml'])
    .where('kind', '=', kind)
    .where('language', '=', language)
    .executeTakeFirst();
  const source = override ?? loadBuiltinTemplate(kind, language);
  return compileTemplate(
    kind,
    source.subject,
    source.bodyText,
    source.bodyHtml
  );
}
