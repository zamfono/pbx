import { z } from 'zod';

import { defineOperation } from '../types.js';
import { loadSettings, rowToWire, type SettingsWire } from './_shared.js';

/** `GET /settings` (§10.3, §11.4): the tenant settings row, with 🔒 secrets masked as `'***'`. */
export const get = defineOperation<Record<string, never>, SettingsWire>({
  name: 'settings.get',
  description: 'Reads the tenant settings row, with secrets masked',
  input: z.object({}),
  minRole: 'admin',
  readOnly: true,
  run: async ctx => rowToWire(ctx.db, await loadSettings(ctx.db))
});
