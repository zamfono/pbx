/**
 * A ban on `core`'s report of an address's failed SIP attempts (§5.6 "Bans"): the escalation
 * step, the `sip_bans` row and its audit entry, then the ban list, `sipBan.added` and the log.
 */
import pino from 'pino';

import {
  addMsIso,
  MS_PER_SECOND,
  newId,
  nowIso,
  sipBanStepsColumn,
  type Db,
  type Envelope,
  type SipBanReport
} from '@zamfono/shared';

import type { Bus } from './jobs/backup.js';
import { insertAuditRow } from './ops/audit.js';
import { JOB_CALLER, outcomeChanges } from './ops/outcomeLog.js';
import { activeSipBans, renderSipBanList } from './sipBanList.js';

const log = pino({ name: 'sip-ban' });

export type SipBan = { id: string; address: string; expiresAt: string | null };

/**
 * The step of a new ban of `address` (1-based, §5.6): the one after its previous ban's when that
 * ban ended within the last `lookbackS` seconds, the last again past the end of `stepCount`, else
 * the first.
 */
async function nextStep(
  db: Db,
  address: string,
  now: string,
  lookbackS: number,
  stepCount: number
): Promise<number> {
  const previous = await db
    .selectFrom('sipBans')
    .select(['step', 'expiresAt', 'liftedAt'])
    .where('address', '=', address)
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  // A ban that is not active ended when it was lifted, or else when it expired.
  const endedAt = previous && (previous.liftedAt ?? previous.expiresAt);
  if (
    !previous ||
    !endedAt ||
    endedAt < addMsIso(now, -lookbackS * MS_PER_SECOND)
  ) {
    return 1;
  }
  return Math.min(previous.step + 1, stepCount);
}

/**
 * Writes the ban `report` asks for and its audit entry, `sipBans.ban` (channel `job`, actor
 * `system`), in one transaction; `null` when banning is off (no steps) or the address already has
 * an active ban, which changes nothing.
 */
async function writeBan(db: Db, report: SipBanReport): Promise<SipBan | null> {
  return db.transaction().execute(async trx => {
    const now = nowIso();
    const settings = await trx
      .selectFrom('settings')
      .select(['sipBanStepsJson', 'sipBanLookbackS'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const steps = sipBanStepsColumn.decode(settings.sipBanStepsJson);
    const active = await activeSipBans(trx, now)
      .select('id')
      .where('address', '=', report.address)
      .executeTakeFirst();
    if (steps.length === 0 || active) {
      return null;
    }
    const step = await nextStep(
      trx,
      report.address,
      now,
      settings.sipBanLookbackS,
      steps.length
    );
    const lengthS = steps[step - 1] ?? null;
    const ban: SipBan = {
      id: newId(),
      address: report.address,
      expiresAt:
        lengthS === null ? null : addMsIso(now, lengthS * MS_PER_SECOND)
    };
    await trx
      .insertInto('sipBans')
      .values({ ...ban, step, failures: report.failures, createdAt: now })
      .execute();
    await insertAuditRow(trx, {
      caller: JOB_CALLER,
      operation: 'sipBans.ban',
      entity: { kind: 'sipBan', id: ban.id },
      changes: outcomeChanges({
        address: ban.address,
        step,
        failures: report.failures,
        expiresAt: ban.expiresAt
      }),
      undoable: false,
      revertsId: null,
      createdAt: now
    });
    return ban;
  });
}

/**
 * Bans the address `core` reported (§5.6 "Bans"), renders the ban list, emits `sipBan.added`
 * and logs a warning naming the address; `null` when it changed nothing.
 */
export async function recordSipBan(
  db: Db,
  bus: Bus,
  report: SipBanReport
): Promise<SipBan | null> {
  const ban = await writeBan(db, report);
  if (!ban) {
    return null;
  }
  log.warn(
    {
      address: ban.address,
      failures: report.failures,
      expiresAt: ban.expiresAt
    },
    'banned a source of failed SIP attempts'
  );
  await renderSipBanList(db).catch((error: unknown) => {
    // The row stands; the next render, a later change's or the next start's, writes it.
    log.error({ err: error }, 'rendering the SIP ban list failed');
  });
  const envelope: Envelope = {
    type: 'sipBan.added',
    banId: ban.id,
    address: ban.address,
    expiresAt: ban.expiresAt,
    id: newId(),
    at: nowIso()
  };
  bus.publish(envelope);
  // The deliveries run their retries on their own (§10.6); the report does not wait for them.
  bus.enqueue(envelope).catch((error: unknown) => {
    log.error({ err: error, eventId: envelope.id }, 'webhook delivery failed');
  });
  return ban;
}
