/**
 * The tenant-wide Ringotel pushes a marker keeps owed, the tenant profile's and the roster's
 * (§10.4): each attempt clears or keeps its marker and is appended to `audit_log` as an outcome
 * row on the settings (§5.7).
 */
import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';
import { activeRingotelProvider } from '#lib/server/provisioning/index.js';
import type { ProvisioningProvider } from '#lib/server/provisioning/types.js';

import type { AuditCaller } from './audit.js';
import { outcomeChanges, recordOutcome } from './outcomeLog.js';

const log = pino({ name: 'ringotel' });

/** The two moments `api` retries a pending push: its own start and an Asterisk start. */
export type RetryTrigger = 'api.start' | 'asterisk.started';

export type RingotelOutcome =
  { outcome: 'pushed' } | { outcome: 'refused' | 'skipped'; reason: string };

/**
 * Runs `push` against the tenant's Ringotel provider, never throwing; `skipped` while Ringotel is
 * not set up. A Ringotel key that cannot be used is a refusal like any other.
 */
export async function attemptRingotel(
  db: Db,
  push: (provider: ProvisioningProvider) => Promise<void>
): Promise<RingotelOutcome> {
  try {
    const provider = await activeRingotelProvider(db);
    if (provider === null) {
      return { outcome: 'skipped', reason: 'Ringotel is not set up' };
    }
    await push(provider);
    return { outcome: 'pushed' };
  } catch (error) {
    return { outcome: 'refused', reason: errorMessage(error) };
  }
}

/**
 * Keeps the marker set after a refusal and clears it otherwise, then appends the `operation` row
 * (§5.7) on the settings. Neither may throw: the write it follows stands.
 */
export async function settleRingotel(
  db: Db,
  entry: {
    operation: 'ringotel.profile' | 'ringotel.roster';
    setPending: (db: Db, pending: boolean) => Promise<void>;
    caller: AuditCaller;
    trigger: string;
    result: RingotelOutcome;
  }
): Promise<void> {
  const { operation, caller, trigger, result } = entry;
  const reason = result.outcome === 'pushed' ? undefined : result.reason;
  try {
    await entry.setPending(db, result.outcome === 'refused');
    await recordOutcome(db, {
      caller,
      operation,
      entity: { kind: 'settings', id: 'settings' },
      changes: outcomeChanges({ outcome: result.outcome, trigger, reason })
    });
  } catch (error) {
    log.error(
      { err: error, operation, trigger, outcome: result.outcome },
      'ringotel: the push outcome could not be recorded'
    );
  }
}
