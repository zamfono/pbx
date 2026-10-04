/**
 * Re-registers the Ringotel apps after an Asterisk restart (§10.4 "After a restart"): a new
 * Asterisk holds none of the contacts the one before held, a restart of the stack or an update
 * included, and an app would otherwise stay unreachable until its own registration expires.
 * `core` announces each ARI connection's Asterisk start on its internal event stream, and is asked
 * for the running one each time that stream (re)connects: no timer asks in between.
 */
import pino from 'pino';

import type { CoreVersionResponse, Db } from '@zamfono/shared';

import { errorMessage } from '../errors.js';
import {
  JOB_CALLER,
  outcomeChanges,
  recordOutcome
} from '../ops/outcomeLog.js';
import {
  activeRingotelProvider,
  type ProvisioningProvider
} from '../provisioning/index.js';

const logger = pino({ name: 'ringotel' });

/**
 * The entries after which the Ringotel apps registered against the running Asterisk anyway: the
 * setup or adoption that pointed them at this stack, and an earlier re-registration.
 */
const REGISTERING_OPERATIONS = [
  'provisioning.ringotelSetup',
  'provisioning.ringotelAdopt',
  'ringotel.rereg'
];

export type ReregDeps = {
  db: Db;
  /** `core`'s `/internal/version`, whose `asteriskStartedAt` names the running Asterisk. */
  lookup: () => Promise<CoreVersionResponse>;
  /** The tenant's Ringotel provider, `null` while Ringotel is not set up. */
  provider?: (db: Db) => Promise<ProvisioningProvider | null>;
  /**
   * One more try for a tenant profile or roster push Ringotel refused before (§10.4 "Tenant
   * profile push", "Colleague presence"), at `api`'s start and at each Asterisk start, ahead of
   * that start's re-registration.
   */
  retryPending?: (trigger: 'api.start' | 'asterisk.started') => Promise<void>;
};

/** What one check saw: the Asterisk start it handled last, so each start is handled once. */
export type ReregState = { lastSeen: string | null };

/**
 * Whether the Asterisk that started at `asteriskStartedAt` is newer than the latest entry after
 * which the apps registered anyway. The audit log is the durable memory: an `api` restart alone
 * sees the same Asterisk start and an older `ringotel.rereg` entry, and sends nothing.
 */
async function restartIsNew(
  db: Db,
  asteriskStartedAt: string
): Promise<boolean> {
  const latest = await db
    .selectFrom('auditLog')
    .select('createdAt')
    .where('operation', 'in', REGISTERING_OPERATIONS)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  return (
    latest === undefined ||
    Date.parse(asteriskStartedAt) > Date.parse(latest.createdAt)
  );
}

/** Sends the re-registration and records its outcome as a `ringotel.rereg` entry (§5.7). */
async function reregister(
  db: Db,
  onPbxRestarted: () => Promise<void>,
  asteriskStartedAt: string
): Promise<void> {
  const outcome = await onPbxRestarted().then(
    () => ({ outcome: 'reregistered', reason: undefined }),
    (error: unknown) => ({
      outcome: 'refused',
      reason: errorMessage(error)
    })
  );
  if (outcome.reason === undefined) {
    logger.info({ asteriskStartedAt }, 'ringotel: re-registration sent');
  } else {
    logger.error(
      { asteriskStartedAt, reason: outcome.reason },
      'ringotel: re-registration refused'
    );
  }
  await recordOutcome(db, {
    caller: JOB_CALLER,
    operation: 'ringotel.rereg',
    entity: { kind: 'settings', id: 'settings' },
    changes: outcomeChanges({ ...outcome, asteriskStartedAt })
  });
}

/**
 * One check, for the Asterisk that started at `asteriskStartedAt`: for a start it has not handled
 * and that is newer than the last registration the audit log knows of, re-registers the apps
 * once, while Ringotel is set up. At most one attempt per Asterisk start, whatever Ringotel
 * answers, so a refusal never turns into a loop; a refusal is logged and audited, never thrown.
 */
export async function handleAsteriskStart(
  deps: ReregDeps,
  state: ReregState,
  asteriskStartedAt: string | null
): Promise<void> {
  if (asteriskStartedAt === null || asteriskStartedAt === state.lastSeen) {
    return;
  }
  const provider = await (deps.provider ?? activeRingotelProvider)(deps.db);
  const onPbxRestarted = provider?.onPbxRestarted?.bind(provider);
  const isNew =
    onPbxRestarted !== undefined &&
    (await restartIsNew(deps.db, asteriskStartedAt));
  // Only now: a check that failed before this point is retried by the next one, and one that got
  // here never sends a second re-registration for the same start.
  // eslint-disable-next-line require-atomic-updates -- one check runs at a time (`watchAsteriskRestarts`)
  state.lastSeen = asteriskStartedAt;
  if (onPbxRestarted === undefined || !isNew) {
    return;
  }
  await reregister(deps.db, onPbxRestarted, asteriskStartedAt);
}

/**
 * `handleAsteriskStart` for the Asterisk `core` reports running now; nothing while it cannot say.
 * A start it has not handled went unannounced, so the pending profile and roster get the retry
 * an announcement would have given them, ahead of the re-registration.
 */
export async function checkAsteriskRestart(
  deps: ReregDeps,
  state: ReregState
): Promise<void> {
  const version = await deps.lookup().catch(() => null);
  const asteriskStartedAt = version?.asteriskStartedAt ?? null;
  if (
    deps.retryPending !== undefined &&
    asteriskStartedAt !== null &&
    asteriskStartedAt !== state.lastSeen &&
    (await restartIsNew(deps.db, asteriskStartedAt))
  ) {
    await deps.retryPending('asterisk.started');
  }
  await handleAsteriskStart(deps, state, asteriskStartedAt);
}

/** What `core`'s internal event stream tells the re-registration (`background.ts`). */
export type ReregWatcher = {
  /**
   * The stream (re)connected: an Asterisk start announced while it was down went unheard, so
   * `core` is asked which Asterisk runs.
   */
  streamConnected(): void;
  /** `core` announced an ARI connection to the Asterisk that started then (`asterisk.started`). */
  asteriskStarted(asteriskStartedAt: string): void;
  /** Resolves once every check asked for so far has run. */
  idle(): Promise<void>;
};

/**
 * Runs a check for each thing the stream tells, one at a time and in order, for the process's
 * life; a failed check is logged, and the next event runs the next one. The retries of a pending
 * tenant profile and roster share that queue: the first runs as the watcher starts, with `api`,
 * and one runs before each announced Asterisk start's check, so the profile push, which also
 * carries the organization's language, goes first; the re-registration's own `updateBranch`
 * leaves the markers alone.
 */
export function watchAsteriskRestarts(deps: ReregDeps): ReregWatcher {
  const state: ReregState = { lastSeen: null };
  let queue = Promise.resolve();
  const enqueue = (check: () => Promise<void>): void => {
    queue = queue.then(check).catch((error: unknown) => {
      logger.error({ error }, 'ringotel: re-registration check failed');
    });
  };
  const { retryPending } = deps;
  if (retryPending !== undefined) {
    enqueue(() => retryPending('api.start'));
  }
  return {
    streamConnected: () => {
      enqueue(() => checkAsteriskRestart(deps, state));
    },
    asteriskStarted: asteriskStartedAt => {
      if (retryPending !== undefined) {
        enqueue(() => retryPending('asterisk.started'));
      }
      enqueue(() => handleAsteriskStart(deps, state, asteriskStartedAt));
    },
    idle: () => queue
  };
}
