import type { ChangeEntry } from '@zamfono/shared';

import { replayOperation } from '../replay.js';
import type { Context } from '../types.js';
import {
  restoreSsoSubjects,
  SSO_SUBJECTS_FIELD,
  type SsoBinding
} from './sso.js';

/**
 * Reverts one `settings.update` entry (§5.8). Its fields go back together, in one
 * `settings.update` call, rather than field by field: the `sso_*` fields are constrained jointly
 * (§11.2 CHECKs), so restoring `ssoProvider` alone before `ssoClientId` or `ssoTenantId` would be
 * refused. Where the entry cleared the `sso_subject` bindings, the replay restores the issuer
 * that minted them and, per §5.2, clears the bindings made since; the recorded ones then go back.
 */
export async function revertSettingsUpdate(
  ctx: Context,
  _entityId: string,
  changes: ChangeEntry[]
): Promise<void> {
  const input: Record<string, unknown> = {};
  let bindings: SsoBinding[] = [];
  for (const change of changes) {
    if (change.field === SSO_SUBJECTS_FIELD) {
      bindings = change.from as SsoBinding[];
    } else {
      input[change.field] = change.from;
    }
  }
  await replayOperation(ctx, 'settings.update', input);
  await restoreSsoSubjects(ctx, bindings);
}
