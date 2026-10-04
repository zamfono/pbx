import * as env from '$app/env/private';
import { z } from 'zod';

import {
  HTTP_BAD_GATEWAY,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND
} from '@zamfono/shared';

import {
  createRingotelClient,
  type RingotelClient
} from '#lib/server/provisioning/ringotelClient.js';
import { keyringFromEnv } from '#lib/server/secretbox.js';

import { onRollback } from '../rollbackHooks.js';
import { loadSettings } from '../settings/_shared.js';
import { defineOperation, OpError, type Context } from '../types.js';
import {
  assertNotSetUp,
  createConnection,
  ringotelIdsOut,
  stackBranchAddress,
  storeRingotelIds,
  tenantProfile,
  type RingotelConnection,
  type TenantProfile
} from './ringotelConnection.js';
import { ringotelOffer } from './ringotelOptions.js';

const inputSchema = z
  .object({
    orgId: z
      .string()
      .min(1)
      .describe('The id of an existing Ringotel organization without users.'),
    domain: z
      .string()
      .min(1)
      .describe("That organization's domain, which must match its id."),
    branchId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A connection of the organization to reuse; left out, a new one is created.'
      )
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/**
 * The organization `input` names, by its id and its domain together: the account's key reaches
 * every customer's organization (§10.4), so one mistyped value alone must find nothing. The
 * refusal names neither the other organization nor its domain.
 */
async function findOrganization(
  client: RingotelClient,
  input: Input
): Promise<{ packageid?: number }> {
  const organizations =
    await client.call<{ id: string; domain: string; packageid?: number }[]>(
      'getOrganizations'
    );
  const found = organizations.find(
    org => org.id === input.orgId && org.domain === input.domain
  );
  if (found === undefined) {
    throw new OpError(
      HTTP_NOT_FOUND,
      `provisioning: the Ringotel account has no organization ${input.orgId} with domain ${input.domain}`
    );
  }
  return found;
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
      HTTP_CONFLICT,
      `provisioning: organization ${input.domain} already has ${users.length} user(s); only an organization without users is adopted`
    );
  }
}

/**
 * The connection the stack uses: the one `branchId` names, rewritten to this stack's address and
 * profile, or a new one, which a failure later in the operation deletes again.
 */
async function adoptConnection(
  ctx: Pick<Context, 'effects'>,
  client: RingotelClient,
  input: Input,
  profile: TenantProfile
): Promise<string> {
  if (input.branchId === undefined) {
    const created = await createConnection(client, input.orgId, profile);
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
      HTTP_NOT_FOUND,
      `provisioning: organization ${input.domain} has no connection ${input.branchId}`
    );
  }
  await client.call('updateBranch', {
    id: input.branchId,
    orgid: input.orgId,
    ...profile.connection
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
export const ringotelAdopt = defineOperation({
  name: 'provisioning.ringotelAdopt',
  description:
    'Adopts an existing, empty Ringotel organization (by id and domain) and one of its connections, or a new one, instead of creating them.',
  input: inputSchema,
  output: ringotelIdsOut,
  problems: [HTTP_NOT_FOUND, HTTP_BAD_GATEWAY],
  minRole: 'owner',
  confirm: (_ctx, input) =>
    `Adopt Ringotel organization ${input.domain} and point ${input.branchId === undefined ? 'a new connection' : `connection ${input.branchId}`} at this stack?`,
  entity: () => ({ kind: 'settings', id: 'settings' }),
  prepare: async (ctx, input): Promise<RingotelConnection> => {
    const settings = await loadSettings(ctx.db);
    assertNotSetUp(settings);
    // Resolved before the first RPC, as in setup: a stack that cannot name its own address
    // changes nothing at Ringotel.
    const address = stackBranchAddress();
    const client = createRingotelClient(settings, keyringFromEnv(env));
    const organization = await findOrganization(client, input);
    await assertEmpty(client, input);
    const maxregs =
      organization.packageid === undefined
        ? undefined
        : (await ringotelOffer(client)).packages.find(
            item => item.id === organization.packageid
          )?.maxregs;
    const sent = await tenantProfile(ctx.db, address, maxregs);
    const branchId = await adoptConnection(ctx, client, input, sent);
    await client.call('updateOrganization', {
      id: input.orgId,
      params: sent.organization
    });
    return { client, ids: { orgId: input.orgId, branchId }, sent };
  },
  run: async (ctx, _input, connection) => {
    await storeRingotelIds(ctx, connection, 'provisioning.ringotelAdopt');
    return {
      ringotelOrgId: connection.ids.orgId,
      ringotelBranchId: connection.ids.branchId
    };
  }
});
