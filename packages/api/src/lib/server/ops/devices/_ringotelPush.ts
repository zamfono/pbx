import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';
import {
  activeRingotelProvider,
  type ProvisioningProvider,
  type PushReceipt
} from '#lib/server/provisioning/index.js';

import {
  callerOf,
  outcomeChanges,
  recordOutcome,
  type OutcomeCaller
} from '../outcomeLog.js';
import { afterPropagation } from '../runner.js';
import type { Context } from '../types.js';

const log = pino({ name: 'ringotel' });

export type PushOutcome =
  | { outcome: 'pushed'; receipt: PushReceipt }
  | { outcome: 'refused' | 'skipped'; reason: string };

type PushTarget = {
  /** The operation whose write this push follows, e.g. `devices.create`. */
  trigger: string;
  deviceId: string;
  /** What stands whatever Ringotel answers, and how to push again. */
  failure: { what: string; retry: string };
};

type Push = PushTarget & {
  push: (provider: ProvisioningProvider) => Promise<PushReceipt>;
};

/**
 * The `ringotel.push` audit row (§5.7, §10.4): what Ringotel answered, attributed to the caller of
 * the operation it follows, so the answer outlives the logs and the result's warnings. A row that
 * cannot be written is logged, since the write it records has committed already.
 */
async function auditPush(
  db: Db,
  caller: OutcomeCaller,
  push: PushTarget,
  result: PushOutcome
): Promise<void> {
  const changes = outcomeChanges({
    outcome: result.outcome,
    trigger: push.trigger,
    ringotelUserId:
      result.outcome === 'pushed'
        ? (result.receipt?.remoteId ?? null)
        : undefined,
    reason: result.outcome === 'pushed' ? undefined : result.reason
  });
  await recordOutcome(db, {
    caller,
    operation: 'ringotel.push',
    entity: { kind: 'device', id: push.deviceId },
    changes
  }).catch((error: unknown) => {
    log.error(
      { error, deviceId: push.deviceId, outcome: result.outcome },
      'ringotel: the push outcome could not be audited'
    );
  });
}

/** Runs the push against the tenant's Ringotel provider, never throwing. */
async function attempt(db: Db, push: Push): Promise<PushOutcome> {
  const provider = await activeRingotelProvider(db);
  if (provider === null) {
    return { outcome: 'skipped', reason: 'Ringotel is not set up' };
  }
  try {
    return { outcome: 'pushed', receipt: await push.push(provider) };
  } catch (error) {
    const reason = errorMessage(error);
    return { outcome: 'refused', reason };
  }
}

/** The result's warning for `result`, or `null` where Ringotel took the push. */
function pushWarning(push: PushTarget, result: PushOutcome): string | null {
  if (result.outcome === 'pushed') {
    return null;
  }
  if (result.outcome === 'skipped') {
    return `${push.failure.what}: Ringotel is not set up, so nothing reached it; provisioning.ringotelSetup or provisioning.ringotelAdopt pushes the device when it runs`;
  }
  return `${push.failure.what}, but Ringotel refused it (${result.reason}); ${push.failure.retry}`;
}

/**
 * Pushes a `ringotel` device's change to Ringotel once its write has committed and Asterisk holds
 * it (§10.4): an activated Ringotel user registers against the PBX with its SIP credentials
 * before Ringotel accepts it, and fails with "Unauthorized" while Asterisk does not know them
 * yet, which inside the operation's transaction it never does. The stored write stands whatever
 * happens: a refusal becomes a warning of the operation's result naming Ringotel's reason and
 * `retry`, the way to try again; a stack without a Ringotel setup pushes nothing and warns that
 * `ringotelSetup` or `ringotelAdopt` will provision the device. Every outcome, success included,
 * is a `ringotel.push` audit row on the device.
 */
export function pushToRingotel(ctx: Context, push: Push): void {
  const caller = callerOf(ctx);
  afterPropagation(ctx, async db => {
    const result = await attempt(db, push);
    await auditPush(db, caller, push, result);
    return pushWarning(push, result);
  });
}

/**
 * Records a push that ran inside `ctx`'s operation, as setup and adoption provision the devices
 * created before them (§10.4): the `ringotel.push` row is written, and a refusal becomes the
 * result's warning, once the operation has committed, like every other push's.
 */
export function reportPush(
  ctx: Context,
  push: PushTarget,
  result: PushOutcome
): void {
  const caller = callerOf(ctx);
  afterPropagation(ctx, async db => {
    await auditPush(db, caller, push, result);
    return pushWarning(push, result);
  });
}
