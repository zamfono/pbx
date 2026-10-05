/**
 * The background check of the mail relay (§10.2 "Relay check"): nodemailer's `verify()` at
 * `api`'s start, after each change of the relay and every `settings.smtp_check_interval_s`
 * seconds, none periodically while it is NULL. Its outcomes join those of the real sends in
 * `relayState.ts`; nothing here runs for a request.
 */
import type { Transporter } from 'nodemailer';
import pino from 'pino';

import { MS_PER_SECOND, type Db } from '@zamfono/shared';

import type { Keyring } from '../secretbox.js';
import {
  createTransportFor,
  relayFromSettings,
  type RelayConfig
} from './relay.js';
import { forgetRelayOutcomes, relayOutcomeRecorder } from './relayState.js';

const logger = pino({ name: 'mail' });

export type RelayCheckDeps = {
  db: Db;
  kr: Keyring;
  /** The transport `verify()` runs on; nodemailer's own for `relay` unless given. */
  transportFor?: (relay: RelayConfig) => Pick<Transporter, 'verify'>;
};

export type RelayCheck = { stop: () => void };

type Running = {
  /** Checks the relay at once, then times the next check from then. */
  checkNow: () => void;
  /** Times the next check from now by the current `smtp_check_interval_s`. */
  reschedule: () => void;
  stop: () => void;
};

let running: Running | null = null;

/** Starts the check: one at once, then every `smtp_check_interval_s` seconds until stopped. */
export function startRelayCheck(deps: RelayCheckDeps): RelayCheck {
  const transportFor = deps.transportFor ?? createTransportFor;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const check = async (): Promise<void> => {
    const relay = await relayFromSettings(deps.db, deps.kr);
    if (relay === null) {
      return;
    }
    const record = relayOutcomeRecorder();
    try {
      await transportFor(relay).verify();
      record.ok();
    } catch (error) {
      record.failed(error);
    }
  };

  const intervalS = async (): Promise<number | null> => {
    const row = await deps.db
      .selectFrom('settings')
      .select('smtpCheckIntervalS')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return row.smtpCheckIntervalS;
  };

  // Checks first when asked to, then times the next check by the interval read after it. The
  // timer is replaced only once the interval is read, so of two runs together the later one's
  // timer stands.
  const run = (checkFirst: boolean): void => {
    const checked = checkFirst
      ? check().catch((error: unknown) => {
          logger.error({ err: error }, 'mail: the relay check failed to run');
        })
      : Promise.resolve();
    checked
      .then(intervalS)
      .then(seconds => {
        clearTimeout(timer);
        if (!stopped && seconds !== null) {
          timer = setTimeout(() => {
            run(true);
          }, seconds * MS_PER_SECOND);
        }
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error },
          'mail: the relay check failed to reschedule'
        );
      });
  };

  run(true);
  const self: Running = {
    checkNow: () => {
      run(true);
    },
    reschedule: () => {
      run(false);
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      if (running === self) {
        running = null;
      }
    }
  };
  running = self;
  return { stop: self.stop };
}

/**
 * Tells the running check of a committed change: of the relay, which forgets the outcomes of the
 * relay before it and is checked at once, or of `smtp_check_interval_s` alone, which times the
 * next check anew. It does not wait for the check, which can take as long as the relay does.
 */
export function relaySettingsChanged(change: { relay: boolean }): void {
  if (change.relay) {
    forgetRelayOutcomes();
    running?.checkNow();
  } else {
    running?.reschedule();
  }
}
