import pino from 'pino';

import type { Db } from '@zamfono/shared';

import { errorMessage } from '#lib/server/errors.js';
import { isPropagationPending } from '#lib/server/propagationPending.js';
import {
  activeRingotelProvider,
  type DeviceRow,
  type ProvisioningProvider,
  type PushReceipt
} from '#lib/server/provisioning/index.js';
import {
  liveRingotelDevices,
  storedCredentials
} from '#lib/server/provisioning/ringotelUser.js';

import { afterPropagation, oweRestartPush } from '../afterCommit.js';
import type { AuditCaller } from '../audit.js';
import {
  callerOf,
  JOB_CALLER,
  outcomeChanges,
  recordOutcome
} from '../outcomeLog.js';
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
  caller: AuditCaller,
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

/**
 * Runs the push against the tenant's Ringotel provider, never throwing. A Ringotel key that
 * cannot be used is a refusal like any other.
 */
async function attempt(db: Db, push: Push): Promise<PushOutcome> {
  try {
    const provider = await activeRingotelProvider(db);
    if (provider === null) {
      return { outcome: 'skipped', reason: 'Ringotel is not set up' };
    }
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

/** `provision`'s answer as the push's outcome, never throwing. */
async function provisioned(
  db: Db,
  provision: (db: Db) => Promise<string>
): Promise<PushOutcome> {
  try {
    return { outcome: 'pushed', receipt: { remoteId: await provision(db) } };
  } catch (error) {
    return { outcome: 'refused', reason: errorMessage(error) };
  }
}

/**
 * Provisions a device that existed before setup or adoption (§10.4) once their write has
 * committed and Asterisk holds it, as every other push: `provision` creates its Ringotel user and
 * returns its id; the outcome is a `ringotel.push` row and a refusal the result's warning. A
 * rolled-back setup or adoption has created no Ringotel user.
 */
export function pushExistingDevice(
  ctx: Context,
  push: PushTarget & { provision: (db: Db) => Promise<string> }
): void {
  const caller = callerOf(ctx);
  afterPropagation(ctx, async db => {
    const result = await provisioned(db, push.provision);
    await auditPush(db, caller, push, result);
    return pushWarning(push, result);
  });
}

/** One device's stored credentials, pushed again as the job (`pushEveryDevice`). */
async function pushStoredCredentials(db: Db, device: DeviceRow): Promise<void> {
  const push: Push = {
    trigger: 'api.start',
    deviceId: device.id,
    push: provider =>
      provider.onCredentialsRotated(device, storedCredentials(device)),
    failure: {
      what: `device ${device.id}'s credentials are stored`,
      retry: 'devices.rotate on the device pushes them again'
    }
  };
  const result = await attempt(db, push);
  await auditPush(db, JOB_CALLER, push, result);
  const warning = pushWarning(push, result);
  if (warning !== null) {
    log.error(
      { deviceId: device.id, warning },
      'ringotel: a device push failed'
    );
  }
}

/**
 * Pushes every live `ringotel` device's stored credentials (`onCredentialsRotated`, which creates
 * a Ringotel user that is missing), as the job, with trigger `api.start`: what the pushes the
 * `api` before this one held for an owed propagation were to send (§3.1, §10.4). Every outcome is
 * a `ringotel.push` row; a refusal is logged. A stack without Ringotel pushes nothing.
 */
async function pushEveryDevice(db: Db): Promise<void> {
  if ((await activeRingotelProvider(db)) === null) {
    return;
  }
  for (const device of await liveRingotelDevices(db)) {
    // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch update; sequential pushes are the plain reading of the API
    await pushStoredCredentials(db, device);
  }
}

/**
 * At `api`'s start, while a propagation is owed: the device pushes that waited for it were held
 * in memory and went with the `api` before this one, so the first propagation that succeeds
 * pushes every device again (`pushEveryDevice`).
 */
export async function oweDevicePushesAtStart(db: Db): Promise<void> {
  if (await isPropagationPending(db)) {
    oweRestartPush(pushEveryDevice);
  }
}
