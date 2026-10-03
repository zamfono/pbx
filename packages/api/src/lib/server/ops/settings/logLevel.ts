import * as env from '$app/env/private';
import { z } from 'zod';

import {
  addMsIso,
  HTTP_UNPROCESSABLE_CONTENT,
  MS_PER_DAY,
  type LogLevelColumns
} from '@zamfono/shared';

import { recordChange } from '../audit.js';
import { OpError, type Context } from '../types.js';

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

/** The two override fields `users.update`, `trunks.update` and `ringGroups.update` accept (§7). */
export const logLevelInputFields = {
  logLevel: z
    .enum(LOG_LEVEL_OVERRIDES)
    .nullish()
    .describe(
      "Raises this entity's calls to diagnostics level events, qos or sip, above settings.callLogLevel; null: no override (see zamfono.help diagnose-bad-call)."
    ),
  logLevelExpiresAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .describe(
      'When the override ends, ISO 8601 with offset; a logLevel set without one ends 7 days later.'
    )
};

export type LogLevelInput = {
  logLevel?: LogLevelOverride | null;
  logLevelExpiresAt?: string | null;
};

/** Refuses `sip` while the deployment mirrors no SIP traffic, so the ladder ends at `qos` (§7). */
function assertLevelAvailable(level: string): void {
  if (level === 'sip' && !env.HEP_ENABLED) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      "logLevel 'sip' requires HEP_ENABLED"
    );
  }
}

function defaultExpiry(now: string): string {
  return addMsIso(now, DEFAULT_OVERRIDE_DAYS * MS_PER_DAY);
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
      HTTP_UNPROCESSABLE_CONTENT,
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
