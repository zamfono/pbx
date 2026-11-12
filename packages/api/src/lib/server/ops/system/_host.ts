import { z } from 'zod';

import type { Db, HostStatus } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';

import { hostClient, type HostClient } from './_updater.js';

/**
 * What `api` keeps of the host (§6.3 "Host control"), in `update_state` and `settings` (§11.2):
 * the reboot an owner scheduled for the next maintenance moment, since when the host has waited
 * for a reboot, which `/metrics` reports, `settings.host_updates` and `settings.auto_reboot`.
 */
export type RebootRequest = { at: string; by: string };

export async function rebootRequest(db: Db): Promise<RebootRequest | null> {
  const row = await db
    .selectFrom('updateState')
    .select(['rebootRequestedAt', 'rebootRequestedBy'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return row.rebootRequestedAt === null || row.rebootRequestedBy === null
    ? null
    : { at: row.rebootRequestedAt, by: row.rebootRequestedBy };
}

/** Schedules the reboot for the next maintenance moment, or with `null` drops one scheduled. */
export async function setRebootRequest(
  db: Db,
  request: RebootRequest | null
): Promise<void> {
  await db
    .updateTable('updateState')
    .set({
      rebootRequestedAt: request?.at ?? null,
      rebootRequestedBy: request?.by ?? null
    })
    .where('id', '=', 1)
    .execute();
}

/** Since when the host has waited for a reboot as last read, `null` for not. */
export async function rebootRequiredSince(db: Db): Promise<string | null> {
  const row = await db
    .selectFrom('updateState')
    .select('rebootRequiredSince')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return row.rebootRequiredSince;
}

export async function setRebootRequiredSince(
  db: Db,
  since: string | null
): Promise<void> {
  await db
    .updateTable('updateState')
    .set({ rebootRequiredSince: since })
    .where('id', '=', 1)
    .execute();
}

/** `settings.host_updates` and `settings.auto_reboot` (§11.4). */
export async function hostSettings(
  db: Db
): Promise<{ hostUpdates: boolean | null; autoReboot: boolean }> {
  const row = await db
    .selectFrom('settings')
    .select(['hostUpdates', 'autoReboot'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return {
    hostUpdates: row.hostUpdates === null ? null : row.hostUpdates === 1,
    autoReboot: row.autoReboot === 1
  };
}

/** `system.info`'s and `system.checkHost`'s `host` (§6.3 "Host control"). */
export const hostOut = z
  .object({
    rebootRequired: z
      .object({ since: z.string(), packages: z.array(z.string()) })
      .nullable()
      .describe(
        'Since when the host waits for a reboot, an upgrade such as a kernel having asked for one, and the packages that did; null while it waits for none.'
      ),
    rebootScheduled: z
      .object({ at: z.string(), by: z.string() })
      .nullable()
      .describe(
        'The reboot an owner scheduled with system.reboot for the next maintenance moment: when and who; null for none.'
      ),
    rebootRefused: z
      .string()
      .optional()
      .describe(
        'Why system.reboot is refused: the stack would not start again after it.'
      )
  })
  .or(z.object({ unavailable: z.string() }))
  .optional()
  .describe(
    'The host the stack runs on (§6.3 "Host control"), present only where .env sets HOST_CONTROL=true; unavailable says why the updater could not tell.'
  );

/**
 * The `host` block from what `ask` has the updater answer, `read` or `check`; `undefined` without
 * host control, `{ unavailable }` while the updater or the agent cannot answer.
 */
export async function hostStatus(
  db: Db,
  ask: (client: HostClient) => Promise<HostStatus>
): Promise<z.infer<typeof hostOut>> {
  const client = hostClient();
  if (client === undefined) {
    return undefined;
  }
  try {
    const { rebootRequired, rebootRefused } = await ask(client);
    return {
      rebootRequired,
      rebootScheduled: await rebootRequest(db),
      ...(rebootRefused === undefined ? {} : { rebootRefused })
    };
  } catch (error) {
    return { unavailable: errorMessage(error) };
  }
}
