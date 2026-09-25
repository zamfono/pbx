import { z } from 'zod';

import { defineOperation } from '../types.js';
import { effectiveTemplate, kindSchema, languageSchema } from './_shared.js';

const inputSchema = z
  .object({ kind: kindSchema, language: languageSchema })
  .strict();

/** `GET /mailTemplates/{kind}/{language}` (§10.3 "Mail templates"): the effective template. */
export const get = defineOperation({
  name: 'mailTemplates.get',
  description: 'Reads one mail template',
  input: inputSchema,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) =>
    effectiveTemplate(ctx.db, input.kind, input.language)
});
