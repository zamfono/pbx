import { z } from 'zod';

import { defineOperation } from '../types.js';
import {
  effectiveTemplate,
  TEMPLATE_KINDS,
  tenantLanguage
} from './_shared.js';

/**
 * `GET /mailTemplates` (§10.3 "Mail templates"): the effective template of every kind in the
 * tenant's language (§11.4 `settings.language`), each marked `builtin` or `tenant`.
 */
export const list = defineOperation({
  name: 'mailTemplates.list',
  description: 'Lists the effective mail templates in the tenant language',
  input: z.object({}).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async ctx => {
    const language = await tenantLanguage(ctx.db);
    const items = await Promise.all(
      TEMPLATE_KINDS.map(kind => effectiveTemplate(ctx.db, kind, language))
    );
    return { items };
  }
});
