import { z } from 'zod';

import {
  createRingotelClient,
  type RingotelClient
} from '../../provisioning/ringotelClient.js';
import { keyringFromEnv } from '../../secretbox.js';
import { onRollback } from '../runner.js';
import { loadSettings } from '../settings/_shared.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  assertNotSetUp,
  connectionFields,
  createConnection,
  organizationParams,
  stackBranchAddress,
  STATUS_CONFLICT,
  STATUS_NOT_FOUND,
  storeRingotelIds
} from './ringotelConnection.js';

const inputSchema = z
  .object({
    orgId: z.string().min(1),
    domain: z.string().min(1),
    branchId: z.string().min(1).optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Output = { ringotelOrgId: string; ringotelBranchId: string };

/**
 * The organization `input` names, by its id and its domain together: the account's key reaches
 * every customer's organization (§10.4), so one mistyped value alone must find nothing. The
 * refusal names neither the other organization nor its domain.
 */
async function findOrganization(
  client: RingotelClient,
  input: Input
): Promise<void> {
  const organizations =
    await client.call<{ id: string; domain: string }[]>('getOrganizations');
  if (
    !organizations.some(
      org => org.id === input.orgId && org.domain === input.domain
    )
  ) {
    throw new OpError(
      STATUS_NOT_FOUND,
      `provisioning: the Ringotel account has no organization ${input.orgId} with domain ${input.domain}`
    );
  }
}

/** Only an organization without users is adopted, so no stack takes over one already in use. */
async function assertEmpty(
  client: RingotelClient,
  input: Input
): Promise<void> {
  const users = await client.call<unknown[]>('getUsers', {
    orgid: input.orgId
  });
  if (users.length > 0) {
    throw new OpError(
      STATUS_CONFLICT,
      `provisioning: organization ${input.domain} already has ${users.length} user(s); only an organization without users is adopted`
    );
  }
}

/**
 * The connection the stack uses: the one `branchId` names, rewritten to this stack's address and
 * profile, or a new one, which a failure later in the operation deletes again.
 */
async function adoptConnection(
  ctx: Context,
  client: RingotelClient,
  input: Input,
  address: string
): Promise<string> {
  if (input.branchId === undefined) {
    const created = await createConnection(ctx, client, input.orgId, address);
    onRollback(ctx, () =>
      client
        .call('deleteBranch', { id: created, orgid: input.orgId })
        .then(() => undefined)
    );
    return created;
  }
  const branches = await client.call<{ id: string }[]>('getBranches', {
    orgid: input.orgId
  });
  if (!branches.some(branch => branch.id === input.branchId)) {
    throw new OpError(
      STATUS_NOT_FOUND,
      `provisioning: organization ${input.domain} has no connection ${input.branchId}`
    );
  }
  await client.call('updateBranch', {
    id: input.branchId,
    orgid: input.orgId,
    ...(await connectionFields(ctx, address))
  });
  return input.branchId;
}

/**
 * `POST /provisioning/ringotel/adopt` (§10.3): takes over an organization that already exists at
 * Ringotel, created in the Ringotel Shell or left behind by a setup whose cleanup failed, instead
 * of creating one (§10.4). It takes the organization only by id and domain together, and only
 * while it has no users; it points the named connection, or a new one, at this stack, writes the
 * organization's `params` as setup does, then stores the ids exactly as setup does.
 */
export const ringotelAdopt = defineOperation<Input, Output>({
  name: 'provisioning.ringotelAdopt',
  description:
    'Adopts an existing, empty Ringotel organization (by id and domain) and one of its connections, or a new one, instead of creating them.',
  input: inputSchema,
  minRole: 'owner',
  confirm: input =>
    `Adopt Ringotel organization ${input.domain} and point ${input.branchId === undefined ? 'a new connection' : `connection ${input.branchId}`} at this stack?`,
  entity: () => ({ kind: 'settings', id: 'settings' }),
  run: async (ctx, input) => {
    const settings = await loadSettings(ctx.db);
    assertNotSetUp(settings);
    // Resolved before the first RPC, as in setup: a stack that cannot name its own address
    // changes nothing at Ringotel.
    const address = stackBranchAddress();
    const client = createRingotelClient(settings, keyringFromEnv(process.env));
    await findOrganization(client, input);
    await assertEmpty(client, input);
    const branchId = await adoptConnection(ctx, client, input, address);
    await client.call('updateOrganization', {
      id: input.orgId,
      params: organizationParams(settings)
    });
    await storeRingotelIds(ctx, client, input.orgId, branchId);
    return { ringotelOrgId: input.orgId, ringotelBranchId: branchId };
  }
});
