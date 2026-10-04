import { z } from 'zod';

import { defineOperation } from '../types.js';
import { loadSettings, rowToWire, settingsWire } from './_shared.js';

/** `GET /settings` (§10.3, §11.4): the tenant settings row, each 🔒 secret as its `<name>Set`. */
export const get = defineOperation({
  name: 'settings.get',
  description:
    'Reads the tenant settings row, each secret only as whether it is set',
  input: z.object({}),
  output: settingsWire,
  minRole: 'admin',
  readOnly: true,
  run: async ctx => rowToWire(ctx.db, await loadSettings(ctx.db))
});
