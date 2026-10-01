import { z } from 'zod';

import { compileTemplate } from '../../mail/index.js';
import { recordChange } from '../runner.js';
import { defineOperation } from '../types.js';
import {
  asValidationError,
  effectiveTemplate,
  kindSchema,
  languageSchema,
  loadOverride,
  type MailTemplateWire
} from './_shared.js';

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
        'The plain-text body: Handlebars {{placeholder}}, if/unless/each/with and {{date value}}; every kind offers companyName, recipientName and fqdn, voicemail adds callerNumber, callerName, mailboxName, receivedAt, durationS, missedCall callerNumber, callerName, receivedAt, didLabel, setup and reset require link (with linkExpiresAt, setup also invitedBy), updateFailed adds fromVersion, toVersion, reason, failedAt, and breakingUpdate currentVersion, version, releaseUrl, publishedAt.'
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

type Input = z.infer<typeof inputSchema>;

/**
 * `PUT /mailTemplates/{kind}/{language}` (§10.2 "Templates", §10.3 "Mail templates"): validates
 * the template against its kind's placeholders and helpers, then stores it as the tenant override.
 */
export const put = defineOperation<Input, MailTemplateWire>({
  name: 'mailTemplates.put',
  description:
    "Overrides the shipped mail template of a kind and language, checked against the kind's placeholders",
  input: inputSchema,
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
