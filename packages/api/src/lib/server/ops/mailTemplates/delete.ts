import { z } from 'zod';

import { recordChange } from '../runner.js';
import { defineOperation, OpError } from '../types.js';
import { kindSchema, languageSchema, loadOverride } from './_shared.js';

const STATUS_NOT_FOUND = 404;

const inputSchema = z
  .object({ kind: kindSchema, language: languageSchema })
  .strict();

/**
 * `DELETE /mailTemplates/{kind}/{language}` (§10.2 "Templates", §5.9): removes the tenant
 * override, so the shipped template for that kind and language applies again.
 */
export const del = defineOperation({
  name: 'mailTemplates.delete',
  description:
    "Removes a tenant's mail template override, so the shipped template applies again",
  input: inputSchema,
  minRole: 'admin',
  confirm: input => `Remove the ${input.language} override for ${input.kind}?`,
  entity: input => ({
    kind: 'mailTemplate',
    id: `${input.kind}:${input.language}`
  }),
  run: async (ctx, input) => {
    const before = await loadOverride(ctx.db, input.kind, input.language);
    if (!before) {
      throw new OpError(STATUS_NOT_FOUND, 'mailTemplates: no override set');
    }
    await ctx.db
      .deleteFrom('mailTemplates')
      .where('kind', '=', input.kind)
      .where('language', '=', input.language)
      .execute();
    recordChange(ctx, { field: 'subject', from: before.subject, to: null });
    recordChange(ctx, { field: 'bodyText', from: before.bodyText, to: null });
    recordChange(ctx, { field: 'bodyHtml', from: before.bodyHtml, to: null });
    return { kind: input.kind, language: input.language };
  }
});
