import { z } from 'zod';

import {
  createRingotelClient,
  type RingotelClient
} from '../../provisioning/ringotelClient.js';
import { keyringFromEnv } from '../../secretbox.js';
import { onRollback } from '../runner.js';
import { loadSettings } from '../settings/_shared.js';
import { defineOperation } from '../types.js';
import {
  assertNotSetUp,
  createConnection,
  organizationParams,
  stackBranchAddress,
  storeRingotelIds
} from './ringotelConnection.js';
import { assertOffered } from './ringotelOptions.js';

/**
 * Deletes the organization a failed setup created, so the next attempt can create it again: its
 * `domain` is globally unique at Ringotel (§10.4). When the delete fails too, the error names the
 * organization, which `provisioning.ringotelAdopt` can then take over, or which the Ringotel
 * Shell can delete.
 */
async function discardOrganization(
  client: RingotelClient,
  orgId: string,
  cause: unknown
): Promise<void> {
  try {
    await client.call('deleteOrganization', { id: orgId });
  } catch (deleteError) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `ringotel: setup failed (${reason}) and organization ${orgId} could not be deleted; adopt it with provisioning.ringotelAdopt, or delete it in the Ringotel Shell before retrying`,
      { cause: deleteError }
    );
  }
}

const inputSchema = z
  .object({
    domain: z.string().min(1),
    region: z.string().min(1),
    packageid: z.number().int().positive()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Output = { ringotelOrgId: string; ringotelBranchId: string };

/**
 * `POST /provisioning/ringotel/setup` (§10.3, §10.4): creates the tenant's Ringotel organization
 * and connection (`createOrganization` + `createBranch`), stores their ids in `settings`, and
 * provisions the `ringotel` devices that already exist.
 */
export const ringotelSetup = defineOperation<Input, Output>({
  name: 'provisioning.ringotelSetup',
  description:
    'Creates the Ringotel organization and connection, and stores their ids; provisioning.ringotelOptions lists the regions and packages it takes.',
  input: inputSchema,
  minRole: 'owner',
  entity: () => ({ kind: 'settings', id: 'settings' }),
  run: async (ctx, input) => {
    const settings = await loadSettings(ctx.db);
    assertNotSetUp(settings);
    // Resolved before the first RPC, so a stack that cannot name its own branch address creates
    // no Ringotel organization it would then be unable to attach a connection to.
    const address = stackBranchAddress();
    const client = createRingotelClient(settings, keyringFromEnv(process.env));
    // The region is immutable once the organization exists (§10.4), so a value the account does
    // not offer is refused here, naming the ones it does, before anything is created.
    await assertOffered(client, input.region, input.packageid);
    const org = await client.call<{ id: string }>('createOrganization', {
      name: settings.companyName,
      domain: input.domain,
      region: input.region,
      packageid: input.packageid,
      params: organizationParams(settings)
    });
    // From here on, whatever keeps the ids from being committed, the connection, the settings
    // write, the audit row or the commit itself, deletes the organization again, and the
    // connection with it.
    onRollback(ctx, cause => discardOrganization(client, org.id, cause));
    const branchId = await createConnection(ctx, client, org.id, address);
    await storeRingotelIds(ctx, client, org.id, branchId);
    return { ringotelOrgId: org.id, ringotelBranchId: branchId };
  }
});
