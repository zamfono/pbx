import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_CONTENT,
  type DB
} from '@zamfono/shared';

import { deviceBlfKeys } from '#lib/server/provisioning/ringotelRoster.js';

import { recordChange } from '../audit.js';
import { defineOperation, OpError } from '../types.js';
import { pushToRingotel } from './_ringotelPush.js';
import { liveDevice, ownTlsDevice } from './_shared.js';

const inputSchema = z
  .object({
    id: z.string(),
    keys: z
      .array(z.string())
      .describe(
        "Extensions (users, ring groups, parking slots) whose state the panel's lamps show, in panel order; empty: every user and group extension."
      )
  })
  .strict();

/** Throws 422 for any `keys` entry that is not a live extension or parking slot (§11.2 `extensions`). */
async function assertLiveExtensions(
  db: Transaction<DB>,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom('extensions')
    .select('ext')
    .where('ext', 'in', keys)
    .execute();
  const live = new Set(rows.map(row => row.ext));
  for (const key of keys) {
    if (!live.has(key)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `devices: '${key}' is not a live extension`
      );
    }
  }
}

/** `PUT /devices/{id}/blf` (§10.4, §11.2): replaces a ringotel device's BLF panel as a whole. */
export const setBlf = defineOperation({
  name: 'devices.setBlf',
  description: "Replaces a ringotel device's BLF panel as a whole.",
  input: inputSchema,
  output: z.object({ id: z.string(), keys: z.array(z.string()) }),
  problems: [HTTP_NOT_FOUND],
  minRole: 'user',
  scope: ownTlsDevice,
  entity: input => ({ kind: 'device', id: input.id }),
  run: async (ctx, input) => {
    const device = await liveDevice(ctx.db, input.id);
    if (device.kind !== 'ringotel') {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        'devices: BLF keys apply only to ringotel devices'
      );
    }
    await assertLiveExtensions(ctx.db, input.keys);
    const before = await ctx.db
      .selectFrom('deviceBlfKeys')
      .select('ext')
      .where('deviceId', '=', input.id)
      .orderBy('position')
      .execute();
    await ctx.db
      .deleteFrom('deviceBlfKeys')
      .where('deviceId', '=', input.id)
      .execute();
    if (input.keys.length > 0) {
      await ctx.db
        .insertInto('deviceBlfKeys')
        .values(
          input.keys.map((ext, position) => ({
            deviceId: input.id,
            ext,
            position
          }))
        )
        .execute();
    }
    // `audit.undo` replays `from` through this operation, as its `keys`, in one replace (§5.8).
    recordChange(ctx, {
      field: 'blfKeys',
      from: before.map(row => row.ext),
      to: input.keys
    });
    pushToRingotel(ctx, {
      trigger: 'devices.setBlf',
      deviceId: input.id,
      push: async (provider, stored, db) => {
        await provider.onDeviceBlfChanged?.(
          stored,
          await deviceBlfKeys(db, stored.id)
        );
        return null;
      },
      failure: {
        what: `device ${input.id}'s BLF panel is stored`,
        retry: 'setting the panel again retries it'
      }
    });
    return { id: input.id, keys: input.keys };
  }
});
