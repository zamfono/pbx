import {
  activeRingotelProvider,
  type ProvisioningProvider
} from '../../provisioning/index.js';
import { afterPropagation } from '../runner.js';
import type { Context } from '../types.js';

/**
 * Pushes a `ringotel` device's change to Ringotel once its write has committed and Asterisk holds
 * it (§10.4): an activated Ringotel user registers against the PBX with its SIP credentials
 * before Ringotel accepts it, and fails with "Unauthorized" while Asterisk does not know them
 * yet, which inside the operation's transaction it never does. A refusal leaves the stored write
 * standing and becomes a warning of the operation's result naming Ringotel's reason and `retry`,
 * the way to try again. A stack without a Ringotel setup pushes nothing: `ringotelSetup` and
 * `ringotelAdopt` provision such devices when they run.
 */
export function pushToRingotel(
  ctx: Context,
  push: (provider: ProvisioningProvider) => Promise<void>,
  failure: { what: string; retry: string }
): void {
  afterPropagation(ctx, async db => {
    const provider = await activeRingotelProvider(db);
    if (provider === null) {
      return null;
    }
    try {
      await push(provider);
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `${failure.what}, but Ringotel refused it (${reason}); ${failure.retry}`;
    }
  });
}
