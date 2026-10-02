import * as env from '$app/env/private';

import type { Db } from '@zamfono/shared';

import { loadSettings } from '../ops/settings/_shared.js';
import { keyringFromEnv } from '../secretbox.js';
import { createRingotelProvider } from './ringotel.js';
import { createRingotelClient } from './ringotelClient.js';
import type { ProvisioningProvider } from './types.js';

export { createRingotelClient, type RingotelClient } from './ringotelClient.js';
export {
  buildBranchProvision,
  createRingotelProvider,
  type RingotelProviderDeps
} from './ringotel.js';
export * from './types.js';

/**
 * The tenant's Ringotel provider, or `null` while `provisioning.ringotelSetup` (§10.3) has not
 * run yet: `devices`, `users` and `settings` operations (§10.4) call this, since they know only that a `ringotel` device or a
 * profile field exists, not whether the organization and connection have been created.
 */
export async function activeRingotelProvider(
  db: Db
): Promise<ProvisioningProvider | null> {
  const settings = await loadSettings(db);
  if (settings.ringotelOrgId === null || settings.ringotelBranchId === null) {
    return null;
  }
  const client = createRingotelClient(settings, keyringFromEnv(env));
  return createRingotelProvider({ client, db });
}
