/**
 * The ban list (§5.6, §9.1): `sip_bans.list` on the `asterisk-config` volume, a line
 * `<address> <expires_at>` per active ban, `<address>` alone for a permanent one, which the ban
 * helper in the `asterisk` container applies as its nftables sets.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';

import { nowIso, sipBanStepsColumn, type Db } from '@zamfono/shared';

import { writeFileAtomically } from './propagation.js';
import { serialQueue } from './serialQueue.js';

export const SIP_BAN_LIST_FILE = 'sip_bans.list';

/** The `sip_bans` rows of the bans active at `now`: not lifted and not expired (§11.2). */
export function activeSipBans(db: Db, now: string) {
  return db
    .selectFrom('sipBans')
    .where('liftedAt', 'is', null)
    .where(eb =>
      eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)])
    );
}

/** Whether banning is off: `settings.sip_ban_steps_json` = `[]` (§5.6). */
async function banningOff(db: Db): Promise<boolean> {
  const settings = await db
    .selectFrom('settings')
    .select('sipBanStepsJson')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return sipBanStepsColumn.decode(settings.sipBanStepsJson).length === 0;
}

/** The number of bans in force, the lines of the rendered list, for `/metrics` (§7). */
export async function countSipBansInForce(db: Db): Promise<number> {
  if (await banningOff(db)) {
    return 0;
  }
  const row = await activeSipBans(db, nowIso())
    .select(eb => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return row.count;
}

/** The list's text: empty while banning is off (§5.6). */
async function banListText(db: Db): Promise<string> {
  if (await banningOff(db)) {
    return '';
  }
  const bans = await activeSipBans(db, nowIso())
    .select(['address', 'expiresAt'])
    .orderBy('address')
    .execute();
  return bans
    .map(ban =>
      ban.expiresAt === null
        ? `${ban.address}\n`
        : `${ban.address} ${ban.expiresAt}\n`
    )
    .join('');
}

// One render at a time, each reading the database once it runs, so the newest state lands last.
const serialized = serialQueue();
let renderedHash: string | null = null;

/**
 * Renders the ban list from the database onto the volume (§9.1): at `api`'s start, at each change
 * of `sip_bans` or `sip_allowlist` and of `settings.sip_ban_steps_json`.
 */
export async function renderSipBanList(db: Db): Promise<void> {
  await serialized(async () => {
    const text = await banListText(db);
    const dir = env.ASTERISK_GEN_DIR;
    await mkdir(dir, { recursive: true });
    await writeFileAtomically(path.join(dir, SIP_BAN_LIST_FILE), text);
    renderedHash = createHash('sha256').update(text).digest('hex');
  });
}

/** The SHA-256 (hex) of the list this process last rendered; `null` before its first render. */
export function renderedSipBanListHash(): string | null {
  return renderedHash;
}
