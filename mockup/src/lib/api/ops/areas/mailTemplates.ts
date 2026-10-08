/**
 * Mail templates (`ops/mailTemplates/`, §10.2 "Templates"): per kind and language the tenant's
 * override, else the shipped template. `put` checks the template against its kind's placeholders,
 * `delete` returns to the shipped one, `test` sends the effective template in the tenant language
 * to the caller with sample values.
 *
 * Overrides are the `mailTemplates` rows with `overridden: true`; the shipped text comes from the
 * API's own templates (`components/system/shippedMailTemplates.ts`).
 */
import {
  checkTemplate,
  TemplateError
} from '#lib/components/system/mailTemplate.js';
import { SHIPPED_TEMPLATES } from '#lib/components/system/shippedMailTemplates.js';

import { ApiError, invalid } from '../../errors';
import {
  LANGUAGES,
  MAIL_KINDS,
  type Db,
  type Language,
  type MailKind,
  type MailTemplate
} from '../../types';
import { defineOp } from '../core';
import { relayConfigured } from './settings';

/** A template as `GET /mailTemplates` returns it. */
export type MailTemplateWire = {
  kind: MailKind;
  language: Language;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  /** `tenant`: the tenant's override; `builtin`: the shipped template. */
  source: 'builtin' | 'tenant';
  /** When the override was last written; null for a shipped one. */
  updatedAt: string | null;
};

type Key = { kind: MailKind; language: Language };

function checkKey(input: Key): void {
  if (!MAIL_KINDS.includes(input.kind)) {
    throw invalid('kind', 'invalid', 'unknown mail kind', {
      message: String(input.kind)
    });
  }
  if (!LANGUAGES.includes(input.language)) {
    throw invalid('language', 'invalid', 'unknown language', {
      message: String(input.language)
    });
  }
}

const override = (db: Db, { kind, language }: Key): MailTemplate | undefined =>
  db.mailTemplates.find(
    row => row.kind === kind && row.language === language && row.overridden
  );

/** When the override was last written: its latest `mailTemplates.put` entry. */
function updatedAt(db: Db, { kind, language }: Key): string | null {
  return (
    db.audit.find(
      entry =>
        entry.operation === 'mailTemplates.put' &&
        entry.entityId === `${kind}:${language}` &&
        entry.undoneAt === null
    )?.createdAt ?? null
  );
}

export function effectiveTemplate(db: Db, key: Key): MailTemplateWire {
  const row = override(db, key);
  if (row !== undefined) {
    return {
      kind: key.kind,
      language: key.language,
      subject: row.subject,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      source: 'tenant',
      updatedAt: updatedAt(db, key)
    };
  }
  const shipped = SHIPPED_TEMPLATES[key.kind][key.language];
  return { ...key, ...shipped, source: 'builtin', updatedAt: null };
}

defineOp<
  { limit?: number; cursor?: string },
  { items: MailTemplateWire[]; nextCursor: null }
>({
  name: 'mailTemplates.list',
  minRole: 'admin',
  readOnly: true,
  run: ctx => ({
    items: MAIL_KINDS.map(kind =>
      effectiveTemplate(ctx.db, { kind, language: ctx.db.settings.language })
    ),
    nextCursor: null
  })
});

defineOp<Key, MailTemplateWire>({
  name: 'mailTemplates.get',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    checkKey(input);
    return effectiveTemplate(ctx.db, input);
  }
});

defineOp<
  Key & { subject: string; bodyText: string; bodyHtml?: string | null },
  MailTemplateWire
>({
  name: 'mailTemplates.put',
  minRole: 'admin',
  run: (ctx, input) => {
    checkKey(input);
    if (input.subject.trim() === '') {
      throw invalid('subject', 'required', 'subject is required');
    }
    if (input.bodyText.trim() === '') {
      throw invalid('bodyText', 'required', 'bodyText is required');
    }
    const bodyHtml =
      input.bodyHtml === undefined ||
      input.bodyHtml === null ||
      input.bodyHtml.trim() === ''
        ? null
        : input.bodyHtml;
    try {
      checkTemplate(input.kind, input.subject, input.bodyText, bodyHtml);
    } catch (error) {
      if (error instanceof TemplateError) {
        const unknown = /unknown placeholder (\S+)/u.exec(error.message);
        const missing = /missing required (\S+)/u.exec(error.message);
        if (unknown !== null) {
          throw invalid(
            'bodyText',
            'templateUnknownPlaceholder',
            error.message,
            { name: unknown[1] ?? '' }
          );
        }
        if (missing !== null) {
          throw invalid('bodyText', 'templateMissingRequired', error.message, {
            name: missing[1] ?? ''
          });
        }
        throw invalid('bodyText', 'templateSyntax', error.message, {
          message: error.message
        });
      }
      throw error;
    }
    const before = override(ctx.db, input);
    const rows = ctx.db.mailTemplates.filter(
      row => !(row.kind === input.kind && row.language === input.language)
    );
    rows.push({
      kind: input.kind,
      language: input.language,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml,
      overridden: true
    });
    ctx.setRoot('mailTemplates', rows);
    ctx.audit({
      entityKind: 'mailTemplate',
      entityId: `${input.kind}:${input.language}`,
      changes: [
        { field: 'subject', from: before?.subject ?? null, to: input.subject },
        {
          field: 'bodyText',
          from: before?.bodyText ?? null,
          to: input.bodyText
        },
        { field: 'bodyHtml', from: before?.bodyHtml ?? null, to: bodyHtml }
      ]
    });
    return effectiveTemplate(ctx.db, input);
  }
});

defineOp<Key, Key>({
  name: 'mailTemplates.delete',
  minRole: 'admin',
  confirm: (_ctx, input) => ({
    key: 'mailTemplates.delete',
    params: { kind: input.kind, language: input.language.toUpperCase() },
    destructive: true
  }),
  run: (ctx, input) => {
    checkKey(input);
    const before = override(ctx.db, input);
    if (before === undefined) {
      throw new ApiError(
        404,
        'mailTemplateNoOverride',
        'mailTemplates: no override set'
      );
    }
    ctx.setRoot(
      'mailTemplates',
      ctx.db.mailTemplates.filter(
        row => !(row.kind === input.kind && row.language === input.language)
      )
    );
    ctx.audit({
      entityKind: 'mailTemplate',
      entityId: `${input.kind}:${input.language}`,
      changes: [
        { field: 'subject', from: before.subject, to: null },
        { field: 'bodyText', from: before.bodyText, to: null },
        { field: 'bodyHtml', from: before.bodyHtml, to: null }
      ]
    });
    return { kind: input.kind, language: input.language };
  }
});

defineOp<
  { kind: MailKind },
  { status: 'sent' | 'skipped' | 'failed'; language: Language }
>({
  name: 'mailTemplates.test',
  minRole: 'admin',
  run: (ctx, input) => {
    if (!MAIL_KINDS.includes(input.kind)) {
      throw invalid('kind', 'invalid', 'unknown mail kind', {
        message: String(input.kind)
      });
    }
    const language = ctx.db.settings.language;
    const recipient = ctx.db.users.find(user => user.id === ctx.actor.id);
    const status =
      relayConfigured(ctx.db.settings) && recipient?.email ? 'sent' : 'skipped';
    ctx.audit({
      entityKind: 'mailTemplate',
      entityId: `${input.kind}:${language}`,
      changes: [],
      pure: true
    });
    return { status, language };
  }
});
