import {
  decodeOffsetCursor,
  offsetPage,
  pageInput
} from '#lib/server/pagination.js';

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
  input: pageInput.strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const offset = decodeOffsetCursor(ctx.operation, input.cursor);
    const { page, nextCursor } = offsetPage(
      ctx.operation,
      TEMPLATE_KINDS.slice(offset, offset + input.limit + 1),
      offset,
      input.limit
    );
    const language = await tenantLanguage(ctx.db);
    const items = await Promise.all(
      page.map(kind => effectiveTemplate(ctx.db, kind, language))
    );
    return { items, nextCursor };
  }
});
