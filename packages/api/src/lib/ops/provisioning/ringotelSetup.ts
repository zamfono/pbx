import { z } from 'zod';

import { buildBranchProvision } from '../../provisioning/ringotel.js';
import {
  createRingotelClient,
  type RingotelClient
} from '../../provisioning/ringotelClient.js';
import { branchBlfEntries } from '../../provisioning/ringotelRoster.js';
import { provisionExistingDevices } from '../../provisioning/ringotelUser.js';
import { keyringFromEnv } from '../../secretbox.js';
import { loadParkingSlots } from '../parking/_shared.js';
import { onRollback, recordChange, setUndoable } from '../runner.js';
import { loadSettings } from '../settings/_shared.js';
import { defineOperation, OpError, type Context } from '../types.js';

// §6.1 "One IP, two listeners": the fixed SIP-TLS port every client, Ringotel included, dials.
const SIP_TLS_PORT = 5061;
const STATUS_CONFLICT = 409;
const STATUS_SERVICE_UNAVAILABLE = 503;

/**
 * The stack FQDN from `ORIGIN` (`https://<fqdn>`, §6.3), the one hostname `api` is given. `ORIGIN`
 * is set by the deployment, never by the caller, so a missing one is this stack's own
 * misconfiguration rather than a bad request.
 */
function fqdnFromOrigin(): string {
  const origin = process.env.ORIGIN;
  if (!origin) {
    throw new OpError(
      STATUS_SERVICE_UNAVAILABLE,
      'provisioning: ORIGIN is not set'
    );
  }
  return new URL(origin).hostname;
}

/** `createBranch` under `orgId` with the stack's address and provision profile (§10.4). */
async function createConnection(
  ctx: Context,
  client: RingotelClient,
  orgId: string,
  address: string
): Promise<string> {
  const settings = await loadSettings(ctx.db);
  const parkingSlots = await loadParkingSlots(ctx.db);
  const blfs = await branchBlfEntries(ctx.db);
  const provision = buildBranchProvision(settings, parkingSlots, blfs);
  const branch = await client.call<{ id: string }>('createBranch', {
    orgid: orgId,
    name: settings.companyName,
    address,
    provision
  });
  return branch.id;
}

/**
 * Deletes the organization a failed setup created, so the next attempt can create it again: its
 * `domain` is globally unique at Ringotel (§10.4), and this setup creates the organization rather
 * than adopting one by domain, since the account-scoped key reaches every customer's
 * organization. When the delete fails too, the error names the organization to remove by hand.
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
      `ringotel: setup failed (${reason}) and organization ${orgId} could not be deleted; delete it in the Ringotel Shell before retrying`,
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
    'Creates the Ringotel organization and connection, and stores their ids.',
  input: inputSchema,
  minRole: 'owner',
  entity: () => ({ kind: 'settings', id: 'settings' }),
  run: async (ctx, input) => {
    const settings = await loadSettings(ctx.db);
    // One organization and one connection per stack (§10.4): a second run would create another
    // organization beside the one the stack's devices are provisioned in.
    if (settings.ringotelOrgId !== null || settings.ringotelBranchId !== null) {
      throw new OpError(
        STATUS_CONFLICT,
        `provisioning: Ringotel is already set up (organization ${settings.ringotelOrgId ?? '-'}, connection ${settings.ringotelBranchId ?? '-'})`
      );
    }
    // Resolved before the first RPC, so a stack that cannot name its own branch address creates
    // no Ringotel organization it would then be unable to attach a connection to.
    const address = `${fqdnFromOrigin()}:${SIP_TLS_PORT}`;
    const keyring = keyringFromEnv(process.env);
    const client = createRingotelClient(settings, keyring);
    const org = await client.call<{ id: string }>('createOrganization', {
      name: settings.companyName,
      domain: input.domain,
      region: input.region,
      packageid: input.packageid,
      params: { hidePassInEmail: true, lang: settings.language }
    });
    // From here on, whatever keeps the ids from being committed, the connection, the settings
    // write, the audit row or the commit itself, deletes the organization again, and the
    // connection with it.
    onRollback(ctx, cause => discardOrganization(client, org.id, cause));
    const branchId = await createConnection(ctx, client, org.id, address);
    await ctx.db
      .updateTable('settings')
      .set({ ringotelOrgId: org.id, ringotelBranchId: branchId })
      .where('id', '=', 1)
      .execute();
    // A `ringotel` device created before this ran got no `createUser`, since no provider existed
    // (§10.4); it is provisioned now, inside the same rollback as the organization.
    await provisionExistingDevices({ client, db: ctx.db });
    recordChange(ctx, { field: 'ringotelOrgId', from: null, to: org.id });
    recordChange(ctx, { field: 'ringotelBranchId', from: null, to: branchId });
    // Not undoable (§5.8, "where reversal is impossible"): the ids are "written by the setup
    // operation, read-only through `PATCH`" (§11.4), so no normal operation takes the `from`
    // values back, and the organization and connection this created live at Ringotel, beyond the
    // reach of a diff.
    setUndoable(ctx, false);
    return { ringotelOrgId: org.id, ringotelBranchId: branchId };
  }
});
