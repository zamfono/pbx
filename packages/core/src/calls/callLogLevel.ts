/**
 * The per-call diagnostics level (§7): validating `settings.call_log_level` into its `LogLevel`
 * and raising a call's level by the overrides of the user, trunk and ring group that route it.
 */
import type { LogLevelColumns } from '@zamfono/shared';

import { effectiveLevel, type CallLog, type LogLevel } from '../callLog.js';

const LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  'none',
  'events',
  'qos',
  'sip'
]);

/** Validates `settings.call_log_level` into its `LogLevel`; the column's own CHECK guarantees it. */
export function toLogLevel(raw: string): LogLevel {
  if (!LOG_LEVELS.has(raw as LogLevel)) {
    throw new Error(`callLog: invalid level "${raw}"`);
  }
  return raw as LogLevel;
}

// An override's values: it "can only raise the level", so `none` exists only as the tenant
// default (§7).
const OVERRIDE_LEVELS: ReadonlySet<string> = new Set(['events', 'qos', 'sip']);

/**
 * Raises `log`'s level to `row`'s override when it is set, unexpired and higher (§7: the level is
 * "the maximum of the tenant default and the overrides of the user, the trunk and the ring group
 * that routed the call"). Called as routing reaches each of them.
 */
export function raiseLogLevel(
  log: CallLog,
  row: LogLevelColumns | undefined,
  nowIso: string
): void {
  const override = row?.logLevel ?? null;
  if (override === null || !OVERRIDE_LEVELS.has(override)) {
    return;
  }
  const level = override as Exclude<LogLevel, 'none'>;
  log.raise(
    effectiveLevel(
      log.level,
      [{ level, expiresAt: row?.logLevelExpiresAt ?? null }],
      nowIso
    )
  );
}
