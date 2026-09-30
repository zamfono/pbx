/**
 * The tenant profile push (§10.4 "Tenant profile push"): the settings Ringotel carries in its
 * branch and organization, the emergency numbers among them, are stored and reach Asterisk first,
 * and reach Ringotel after the write committed, so a Ringotel outage never loses the change nor
 * fails the operation (§10.1 "Emergency calls"). A push Ringotel refuses leaves
 * `settings.ringotel_profile_pending` set; only a push Ringotel took in full, branch and
 * organization, clears it, and `api` tries once more at its start and at each Asterisk start. No
 * timer retries it.
 */
import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '../../errorMessage.js';
import { activeRingotelProvider } from '../../provisioning/index.js';
import { setProfilePending } from '../../provisioning/profilePending.js';
import { afterPropagation } from '../afterPropagationHooks.js';
import {
  callerOf,
  JOB_CALLER,
  outcomeChanges,
  recordOutcome,
  type OutcomeCaller
} from '../outcomeLog.js';
import type { Context } from '../types.js';
import { loadSettings } from './_shared.js';

const log = pino({ name: 'ringotel' });

/** What caused a profile push: the write, or one of the two moments `api` retries a pending one. */
export type ProfileTrigger =
  'settings.update' | 'api.start' | 'asterisk.started';

type ProfileOutcome =
  { outcome: 'pushed' } | { outcome: 'refused' | 'skipped'; reason: string };

/** Runs the tenant's profile push, never throwing; `skipped` while Ringotel is not set up. */
async function attempt(db: Db): Promise<ProfileOutcome> {
  const provider = await activeRingotelProvider(db);
  if (provider === null) {
    return { outcome: 'skipped', reason: 'Ringotel is not set up' };
  }
  try {
    await provider.onTenantProfileChanged?.(await loadSettings(db));
    return { outcome: 'pushed' };
  } catch (error) {
    const reason = errorMessage(error);
    return { outcome: 'refused', reason };
  }
}

/**
 * Keeps the marker set after a refusal and clears it otherwise, then appends the
 * `ringotel.profile` row (§5.7) on the settings. Neither may throw: the write it follows stands.
 */
async function settle(
  db: Db,
  caller: OutcomeCaller,
  trigger: ProfileTrigger,
  result: ProfileOutcome
): Promise<void> {
  const reason = result.outcome === 'pushed' ? undefined : result.reason;
  try {
    await setProfilePending(db, result.outcome === 'refused');
    await recordOutcome(db, {
      caller,
      operation: 'ringotel.profile',
      entity: { kind: 'settings', id: 'settings' },
      changes: outcomeChanges({ outcome: result.outcome, trigger, reason })
    });
  } catch (error) {
    log.error(
      { error, trigger, outcome: result.outcome },
      'ringotel: the profile push outcome could not be recorded'
    );
  }
}

/**
 * Pushes the tenant profile once `ctx`'s write has committed and propagated, when that write
 * changed a profile column and Ringotel is set up. The marker is set inside the write's own
 * transaction, so even an `api` that stops before the push knows at its next start that one is
 * owed. A refusal is a `warnings` entry of the operation's result.
 */
export async function pushProfileAfterCommit(ctx: Context): Promise<void> {
  const settings = await loadSettings(ctx.db);
  if (settings.ringotelOrgId === null || settings.ringotelBranchId === null) {
    return;
  }
  await setProfilePending(ctx.db, true);
  const caller = callerOf(ctx);
  afterPropagation(ctx, async db => {
    const result = await attempt(db);
    await settle(db, caller, 'settings.update', result);
    if (result.outcome !== 'refused') {
      return null;
    }
    log.error(
      { reason: result.reason },
      'ringotel: the tenant profile push was refused'
    );
    return `the settings are stored and in force on the PBX, but Ringotel refused the tenant profile (${result.reason}); api pushes it again at its next start, when Asterisk next starts, or with the next change to the tenant profile`;
  });
}

/**
 * One more try for a profile push Ringotel refused before, at `api`'s start or at an Asterisk
 * start (§10.4 "Tenant profile push"), by the job (channel `job`). Nothing is sent while none is
 * pending; a refusal keeps the marker for the next such moment, never for a timer, so nothing
 * loops. A stack no longer set up with Ringotel drops the marker as `skipped`.
 */
export async function retryPendingProfile(
  db: Db,
  trigger: Exclude<ProfileTrigger, 'settings.update'>
): Promise<void> {
  const settings = await loadSettings(db);
  if (settings.ringotelProfilePending !== 1) {
    return;
  }
  const result = await attempt(db);
  await settle(db, JOB_CALLER, trigger, result);
  if (result.outcome === 'refused') {
    log.error(
      { trigger, reason: result.reason },
      'ringotel: the pending tenant profile was refused again'
    );
  } else {
    log.info(
      { trigger, outcome: result.outcome },
      'ringotel: the pending tenant profile was settled'
    );
  }
}
