/**
 * The ban list (§5.6, §9.1): `sip_bans.list` on the `asterisk-config` volume, a line
 * `<address> <expires_at>` per active ban, `<address>` alone for a permanent one, which the ban
 * helper in the `asterisk` container applies as its nftables sets.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as env from '$app/env/private';

import {
  MS_PER_MINUTE,
  nowIso,
  sipBanStepsColumn,
  type Db
} from '@zamfono/shared';

import { writeFileAtomically } from './propagation.js';
import { serialQueue } from './serialQueue.js';

export const SIP_BAN_LIST_FILE = 'sip_bans.list';
const HELPER_STATUS_FILE = 'sip_ban_helper.status';
// The helper writes its heartbeat every 30 seconds; one older than this means it stopped (§9.1).
const HELPER_STALE_MS = MS_PER_MINUTE;
// `<time in ISO 8601 UTC to the second> <hex SHA-256 of the list it applied>` (§9.1).
const HELPER_STATUS_LINE =
  /^(?<time>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (?<hash>[0-9a-f]{64})$/u;

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

/** Whether the ban helper runs, and its last heartbeat, `null` while none is readable. */
export type SipBanHelperState = { running: boolean; heartbeat: string | null };

/**
 * The ban helper's state (§9.1, §10.3 `sipBan:helper`): it runs while its heartbeat in
 * `sip_ban_helper.status` is at most 60 seconds old and names the list this process last
 * rendered. A missing or unreadable file is a helper that does not run, with no heartbeat.
 */
export async function sipBanHelperState(
  nowMs: number = Date.now()
): Promise<SipBanHelperState> {
  const text = await readFile(
    path.join(env.ASTERISK_GEN_DIR, HELPER_STATUS_FILE),
    'utf8'
  ).catch(() => '');
  const { time, hash } = HELPER_STATUS_LINE.exec(text.trim())?.groups ?? {};
  const heartbeatMs = Date.parse(time ?? '');
  if (time === undefined || Number.isNaN(heartbeatMs)) {
    return { running: false, heartbeat: null };
  }
  return {
    running: nowMs - heartbeatMs <= HELPER_STALE_MS && hash === renderedHash,
    heartbeat: time
  };
}
