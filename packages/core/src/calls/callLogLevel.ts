/**
 * The per-call diagnostics level (§7): raising a call's level by the overrides of the user, trunk
 * and ring group that route it.
 */
import type { LogLevelColumns } from '@zamfono/shared';

import { effectiveLevel, type CallLog } from '../callLog.js';

/**
 * Raises `log`'s level to `row`'s override when it is set, unexpired and higher (§7: the level is
 * "the maximum of the tenant default and the overrides of the user, the trunk and the ring group
 * that routed the call"). Called as routing reaches each of them.
 */
export function raiseLogLevel(
  log: CallLog,
  row: LogLevelColumns | null,
  nowIso: string
): void {
  log.raise(
    effectiveLevel(
      log.level,
      [
        {
          level: row?.logLevel ?? null,
          expiresAt: row?.logLevelExpiresAt ?? null
        }
      ],
      nowIso
    )
  );
}
