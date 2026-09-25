/**
 * The per-call diagnostics level and log cap (§7): validating `settings.call_log_level` into its
 * `LogLevel`, raising a call's level by the overrides of the user, trunk and ring group that route
 * it, and reading `CALL_LOG_MAX_BYTES` from the environment.
 */
import process from 'node:process';

import { effectiveLevel, type CallLog, type LogLevel } from '../callLog.js';

/** `CALL_LOG_MAX_BYTES` (§7), default 1 MB. */
const DEFAULT_CALL_LOG_MAX_BYTES = 1_048_576;
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

/** A `users`, `trunks` or `ring_groups` row's diagnostics override (§7, §11.2). */
type LevelOverrideRow = {
  logLevel: string | null;
  logLevelExpiresAt: string | null;
};

/**
 * Raises `log`'s level to `row`'s override when it is set, unexpired and higher (§7: the level is
 * "the maximum of the tenant default and the overrides of the user, the trunk and the ring group
 * that routed the call"). Called as routing reaches each of them.
 */
export function raiseLogLevel(
  log: CallLog,
  row: LevelOverrideRow | undefined,
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

/** `CALL_LOG_MAX_BYTES` from the environment, falling back to the spec default on anything invalid. */
export function callLogMaxBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.CALL_LOG_MAX_BYTES;
  const value = raw === undefined ? DEFAULT_CALL_LOG_MAX_BYTES : Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_CALL_LOG_MAX_BYTES;
}
