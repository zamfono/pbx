import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, type Db } from '@zamfono/shared';

import {
  loadBuiltinTemplate,
  type Language,
  type TemplateKind,
  type TemplateSource
} from '#lib/server/mail/index.js';

import { OpError } from '../types.js';

/** The six mail kinds `api` renders a template for (§10.2 "Templates"). */
export const TEMPLATE_KINDS = [
  'voicemail',
  'missedCall',
  'setup',
  'reset',
  'updateFailed',
  'breakingUpdate'
] as const satisfies readonly TemplateKind[];

/** The six tenant languages (§9.1, §10.2, §11.2). */
export const LANGUAGES = [
  'de',
  'en',
  'es',
  'fr',
  'it',
  'ru'
] as const satisfies readonly Language[];

export const kindSchema = z
  .enum(TEMPLATE_KINDS)
  .describe(
    'The mail: voicemail (a new voicemail), missedCall, setup (the set-password link of a new account), reset (a password reset link), updateFailed (to the owners: an automatic update failed) or breakingUpdate (to the owners: a breaking release needs a manual update).'
  );
export const languageSchema = z
  .enum(LANGUAGES)
  .describe("The template's language; mails use the one in settings.language.");

/** A `GET /mailTemplates` / `GET /mailTemplates/{kind}/{language}` row (§10.3 "Mail templates"). */
export type MailTemplateWire = {
  kind: TemplateKind;
  language: Language;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  source: 'builtin' | 'tenant';
  updatedAt: string | null;
};

/** The tenant's override row for `(kind, language)`, or `undefined` while none exists. */
export async function loadOverride(
  db: Db,
  kind: TemplateKind,
  language: Language
): Promise<
  | {
      subject: string;
      bodyText: string;
      bodyHtml: string | null;
      updatedAt: string;
    }
  | undefined
> {
  return db
    .selectFrom('mailTemplates')
    .select(['subject', 'bodyText', 'bodyHtml', 'updatedAt'])
    .where('kind', '=', kind)
    .where('language', '=', language)
    .executeTakeFirst();
}

/** The effective `(kind, language)` template as `GET` returns it: the tenant's override, else the shipped one. */
export async function effectiveTemplate(
  db: Db,
  kind: TemplateKind,
  language: Language
): Promise<MailTemplateWire> {
  const override = await loadOverride(db, kind, language);
  const source: TemplateSource =
    override ?? loadBuiltinTemplate(kind, language);
  return {
    kind,
    language,
    subject: source.subject,
    bodyText: source.bodyText,
    bodyHtml: source.bodyHtml,
    source: override ? 'tenant' : 'builtin',
    updatedAt: override?.updatedAt ?? null
  };
}

/** Runs `compile`, turning the `Error` `compileTemplate` throws on an invalid template into a 422. */
export function asValidationError<T>(compile: () => T): T {
  try {
    return compile();
  } catch (error) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      error instanceof Error ? error.message : 'template: invalid'
    );
  }
}

/** The tenant's effective language (§11.4 `settings.language`), used where no path segment gives one. */
export async function tenantLanguage(db: Db): Promise<Language> {
  const settings = await db
    .selectFrom('settings')
    .select('language')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return settings.language as Language;
}
