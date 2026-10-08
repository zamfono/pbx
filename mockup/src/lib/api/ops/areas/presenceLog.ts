/**
 * `presenceLog.snapshot` (admin, §11.2 `presence_log`): each user's latest presence state as of a
 * past instant — the log row with the greatest `since` still at or before `at` — paged by user.
 */
import type { PresenceLogEntry } from '../../types';
import { defineOp } from '../core';
import { paginate, requireInstant, type Page, type PageInput } from './calls';

defineOp<PageInput & { at: string; userId?: string }, Page<PresenceLogEntry>>({
  name: 'presenceLog.snapshot',
  minRole: 'admin',
  readOnly: true,
  run: (ctx, input) => {
    const at = requireInstant(ctx.db, 'at', input.at);
    const latest = new Map<string, PresenceLogEntry>();
    for (const entry of ctx.db.presenceLog) {
      if (
        Date.parse(entry.since) > at ||
        (input.userId !== undefined && entry.userId !== input.userId)
      ) {
        continue;
      }
      const current = latest.get(entry.userId);
      if (current === undefined || entry.since >= current.since) {
        latest.set(entry.userId, entry);
      }
    }
    const rows = [...latest.values()]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(entry => ({ ...entry }));
    return paginate(ctx.operation, rows, input);
  }
});
