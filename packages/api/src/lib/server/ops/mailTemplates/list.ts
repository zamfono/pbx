import { MAIL_KINDS } from '@zamfono/shared';

import { arrayPage, pageInput, pageOutput } from '#lib/server/pagination.js';

import { defineOperation } from '../types.js';
import {
  effectiveTemplate,
  mailTemplateWire,
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
  output: pageOutput(mailTemplateWire),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    const { page, nextPageToken, totalSize } = arrayPage(
      ctx.operation,
      input,
      MAIL_KINDS
    );
    const language = await tenantLanguage(ctx.db);
    const items = await Promise.all(
      page.map(kind => effectiveTemplate(ctx.db, kind, language))
    );
    return { items, nextPageToken, totalSize };
  }
});
