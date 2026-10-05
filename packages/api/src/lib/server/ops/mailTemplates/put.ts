import { z } from 'zod';

import { compileTemplate, PLACEHOLDERS } from '#lib/server/mail/index.js';

import { recordChange } from '../audit.js';
import { defineOperation } from '../types.js';
import {
  asValidationError,
  effectiveTemplate,
  kindSchema,
  languageSchema,
  loadOverride,
  mailTemplateWire
} from './_shared.js';

/** Each kind's placeholders, and the ones it requires, for the bodies' description. */
const PLACEHOLDER_LIST = Object.entries(PLACEHOLDERS)
  .map(([kind, { offered, required }]) => {
    const must =
      required.length > 0 ? ` (required: ${required.join(', ')})` : '';
    return `${kind}: ${offered.join(', ')}${must}`;
  })
  .join('; ');

const inputSchema = z
  .object({
    kind: kindSchema,
    language: languageSchema,
    subject: z
      .string()
      .min(1)
      .describe('The subject line, a Handlebars template like the bodies.'),
    bodyText: z
      .string()
      .min(1)
      .describe(
        `The plain-text body: Handlebars {{placeholder}}, if/unless/each/with and {{date value}}. The placeholders per kind, which the subject and the bodies share, a required one used in at least one of them: ${PLACEHOLDER_LIST}.`
      ),
    bodyHtml: z
      .string()
      .nullable()
      .optional()
      .describe(
        'An optional HTML body with the same placeholders, their values HTML-escaped; null sends text only.'
      )
  })
  .strict();

/**
 * `PUT /mailTemplates/{kind}/{language}` (§10.2 "Templates", §10.3 "Mail templates"): validates
 * the template against its kind's placeholders and helpers, then stores it as the tenant override.
 */
export const put = defineOperation({
  name: 'mailTemplates.put',
  description:
    "Overrides the shipped mail template of a kind and language, checked against the kind's placeholders",
  input: inputSchema,
  output: mailTemplateWire,
  minRole: 'admin',
  entity: input => ({
    kind: 'mailTemplate',
    id: `${input.kind}:${input.language}`
  }),
  run: async (ctx, input) => {
    const bodyHtml = input.bodyHtml ?? null;
    asValidationError(() =>
      compileTemplate(input.kind, input.subject, input.bodyText, bodyHtml)
    );
    const before = await loadOverride(ctx.db, input.kind, input.language);
    await ctx.db
      .insertInto('mailTemplates')
      .values({
        kind: input.kind,
        language: input.language,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml,
        updatedAt: ctx.now
      })
      .onConflict(oc =>
        oc.columns(['kind', 'language']).doUpdateSet({
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml,
          updatedAt: ctx.now
        })
      )
      .execute();
    recordChange(ctx, {
      field: 'subject',
      from: before?.subject ?? null,
      to: input.subject
    });
    recordChange(ctx, {
      field: 'bodyText',
      from: before?.bodyText ?? null,
      to: input.bodyText
    });
    recordChange(ctx, {
      field: 'bodyHtml',
      from: before?.bodyHtml ?? null,
      to: bodyHtml
    });
    return effectiveTemplate(ctx.db, input.kind, input.language);
  }
});
