import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  effectiveTemplate,
  kindSchema,
  languageSchema,
  mailTemplateWire
} from './_shared.js';

const inputSchema = z
  .object({ kind: kindSchema, language: languageSchema })
  .strict();

/** `GET /mailTemplates/{kind}/{language}` (§10.3 "Mail templates"): the effective template. */
export const get = defineOperation({
  name: 'mailTemplates.get',
  description:
    'Reads the effective mail template of a kind and language: the tenant override, else the shipped one',
  input: inputSchema,
  output: mailTemplateWire,
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) =>
    effectiveTemplate(ctx.db, input.kind, input.language)
});
