import { noopProvider, type ProvisioningProvider } from './types.js';

/**
 * `manual` (§10.4): the admin enters a device's SIP credentials into the phone by hand, so the
 * provider has nothing to push for any of the six hooks.
 */
export const manualProvider: ProvisioningProvider = noopProvider;
