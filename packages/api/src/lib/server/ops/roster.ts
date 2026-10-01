import { activeRingotelProvider } from '../provisioning/index.js';
import type { UserRow } from '../provisioning/types.js';
import type { Context } from './types.js';

/**
 * §10.4 `onRosterChanged`, "on every user or extension change": the provider's tenant-wide roster
 * (Ringotel's branch `blfs` list, one entry per extension titled by its owner, and the parking
 * slots) moves whenever a user, ring group or slot gains, loses or renames an extension, so each
 * operation that does so calls this once its own writes have landed. `users` are the rows whose
 * own extension or SIP username moved and must reach their Ringotel user too.
 */
export async function pushRoster(
  ctx: Context,
  users: UserRow[] = []
): Promise<void> {
  const provider = await activeRingotelProvider(ctx.db);
  await provider?.onRosterChanged?.(users);
}
