import * as env from '$app/env/private';

import type { Db } from '@zamfono/shared';

import { loadSettings } from '../ops/settings/_shared.js';
import { keyringFromEnv } from '../secretbox.js';
import { manualProvider } from './manual.js';
import {
  createRingotelProvider,
  type RingotelProviderDeps
} from './ringotel.js';
import { createRingotelClient } from './ringotelClient.js';
import type { ProvisioningProvider } from './types.js';

export { manualProvider } from './manual.js';
export { createRingotelClient, type RingotelClient } from './ringotelClient.js';
export {
  buildBranchProvision,
  createRingotelProvider,
  type RingotelProviderDeps
} from './ringotel.js';
export * from './types.js';

export type ProvisioningKind = 'manual' | 'ringotel';

/** `manual` needs no deps; `ringotel`'s client and db are required, enforced at compile time. */
export function providerFor(kind: 'manual'): ProvisioningProvider;
export function providerFor(
  kind: 'ringotel',
  ringotelDeps: RingotelProviderDeps
): ProvisioningProvider;
export function providerFor(
  kind: ProvisioningKind,
  ringotelDeps?: RingotelProviderDeps
): ProvisioningProvider {
  if (kind === 'manual') {
    return manualProvider;
  }
  // The 'ringotel' overload above requires ringotelDeps, so only a caller outside the type
  // system (plain JS, or a cast) can reach this without one.
  if (!ringotelDeps) {
    throw new Error("providerFor: 'ringotel' requires ringotelDeps");
  }
  return createRingotelProvider(ringotelDeps);
}

/**
 * The tenant's Ringotel provider, or `null` while `provisioning.ringotelSetup` (§10.3) has not
 * run yet: `devices`, `users` and `settings` operations (§10.4) call this rather than
 * `providerFor('ringotel', …)` directly, since they know only that a `ringotel` device or a
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
  return providerFor('ringotel', { client, db });
}
