import { z } from 'zod';

import {
  createRingotelClient,
  RingotelError,
  type RingotelClient
} from '../../provisioning/ringotelClient.js';
import { keyringFromEnv } from '../../secretbox.js';
import { onRollback } from '../runner.js';
import { loadSettings } from '../settings/_shared.js';
import { defineOperation, OpError } from '../types.js';
import {
  assertNotSetUp,
  createConnection,
  followPackageMaxRegs,
  organizationParams,
  stackBranchAddress,
  STATUS_CONFLICT,
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

/**
 * `createOrganization` for `input`, with a taken domain answered as what it usually is (§10.4):
 * an organization that already exists in this Ringotel account, created in the Ringotel Shell or
 * left by an earlier setup, which `provisioning.ringotelAdopt` takes over. The refusal names its
 * id, so the adoption is one call.
 */
async function createOrganization(
  client: RingotelClient,
  params: Record<string, unknown>
): Promise<{ id: string }> {
  try {
    return await client.call<{ id: string }>('createOrganization', params);
  } catch (error) {
    if (
      !(error instanceof RingotelError) ||
      !/already exists/iu.test(error.ringotelMessage)
    ) {
      throw error;
    }
    const domain = String(params.domain);
    const existing = (
      await client.call<{ id: string; domain: string }[]>('getOrganizations')
    ).find(org => org.domain === domain);
    throw new OpError(
      STATUS_CONFLICT,
      existing === undefined
        ? `provisioning: Ringotel refused domain ${domain} (${error.ringotelMessage}); choose another domain`
        : `provisioning: the Ringotel account already has an organization with domain ${domain}, id ${existing.id}; if it is this stack's, adopt it: provisioning.ringotelAdopt { orgId: '${existing.id}', domain: '${domain}' }`
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
    const chosen = await assertOffered(client, input.region, input.packageid);
    const org = await createOrganization(client, {
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
    await followPackageMaxRegs(ctx, chosen.maxregs);
    const branchId = await createConnection(ctx, client, org.id, address);
    await storeRingotelIds(ctx, client, org.id, branchId);
    return { ringotelOrgId: org.id, ringotelBranchId: branchId };
  }
});
