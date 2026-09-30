import { z } from 'zod';

import { MS_PER_DAY } from '@zamfono/shared';

import { recordChange } from '../runner.js';
import { OpError, type Context } from '../types.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

/**
 * §7: an override set without an expiry gets one this far out, so diagnostics never stay on by
 * oversight.
 */
const DEFAULT_OVERRIDE_DAYS = 7;

/**
 * The levels a per-user, per-trunk or per-ring-group override may raise a call to (§7). An
 * override only raises the level, so `none` belongs to the tenant default alone.
 */
export const LOG_LEVEL_OVERRIDES = ['events', 'qos', 'sip'] as const;
export type LogLevelOverride = (typeof LOG_LEVEL_OVERRIDES)[number];

/** The `log_level` and `log_level_expires_at` pair an entity carries (§7, §11.2). */
export type LogLevelColumns = {
  logLevel: string | null;
  logLevelExpiresAt: string | null;
};

/** The two override fields `users.update`, `trunks.update` and `ringGroups.update` accept (§7). */
export const logLevelInputFields = {
  logLevel: z.enum(LOG_LEVEL_OVERRIDES).nullish(),
  logLevelExpiresAt: z.iso.datetime({ offset: true }).nullish()
};

export type LogLevelInput = {
  logLevel?: LogLevelOverride | null;
  logLevelExpiresAt?: string | null;
};

/** Refuses `sip` while the deployment mirrors no SIP traffic, so the ladder ends at `qos` (§7). */
function assertLevelAvailable(level: string): void {
  if (level === 'sip' && process.env.HEP_ENABLED === 'false') {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      "logLevel 'sip' requires HEP_ENABLED"
    );
  }
}

function defaultExpiry(now: string): string {
  return new Date(
    Date.parse(now) + DEFAULT_OVERRIDE_DAYS * MS_PER_DAY
  ).toISOString();
}

/**
 * The `log_level`/`log_level_expires_at` columns an override request writes (§7), or `undefined`
 * when the request carries neither field. `logLevel: null` clears the override; a level that
 * arrives without an expiry is given one 7 days out.
 */
export function resolveLogLevel(
  ctx: Context,
  before: LogLevelColumns,
  input: LogLevelInput
): LogLevelColumns | undefined {
  if (input.logLevel === undefined && input.logLevelExpiresAt === undefined) {
    return undefined;
  }
  if (input.logLevel === null) {
    return { logLevel: null, logLevelExpiresAt: null };
  }
  const level = input.logLevel ?? before.logLevel;
  if (level === null) {
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      'logLevelExpiresAt needs a logLevel to expire'
    );
  }
  assertLevelAvailable(level);
  return {
    logLevel: level,
    logLevelExpiresAt: input.logLevelExpiresAt ?? defaultExpiry(ctx.now)
  };
}

/** Records one `audit_log` diff entry per override column that changed (§7 "Level changes"). */
export function recordLogLevelChanges(
  ctx: Context,
  before: LogLevelColumns,
  after: LogLevelColumns
): void {
  if (after.logLevel !== before.logLevel) {
    recordChange(ctx, {
      field: 'logLevel',
      from: before.logLevel,
      to: after.logLevel
    });
  }
  if (after.logLevelExpiresAt !== before.logLevelExpiresAt) {
    recordChange(ctx, {
      field: 'logLevelExpiresAt',
      from: before.logLevelExpiresAt,
      to: after.logLevelExpiresAt
    });
  }
}

/** An entity row's override as the wire carries it (§10.3). */
export function logLevelWire(row: LogLevelColumns): LogLevelColumns {
  return {
    logLevel: row.logLevel,
    logLevelExpiresAt: row.logLevelExpiresAt
  };
}
