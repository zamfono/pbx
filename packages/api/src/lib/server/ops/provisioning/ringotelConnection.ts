import * as env from '$app/env/private';
import { z } from 'zod';

import { HTTP_CONFLICT, type Db } from '@zamfono/shared';

import { buildBranchProvision } from '#lib/server/provisioning/branchProvision.js';
import type { RingotelClient } from '#lib/server/provisioning/ringotelClient.js';
import { branchBlfEntries } from '#lib/server/provisioning/ringotelRoster.js';
import {
  liveRingotelDevices,
  provisionExistingDevice
} from '#lib/server/provisioning/ringotelUser.js';
import { SIP_TLS_PORT } from '#lib/server/stackAddress.js';

import { recordChange, setUndoable } from '../audit.js';
import { pushExistingDevice } from '../devices/_ringotelPush.js';
import { loadParkingSlots } from '../parking/_shared.js';
import { propagate } from '../propagate.js';
import { loadSettings, type SettingsRow } from '../settings/_shared.js';
import { OpError, type Context } from '../types.js';

// What `provisioning.ringotelSetup` and `provisioning.ringotelAdopt` share (§10.3, §10.4): the
// stack's own connection address and profile, the organization's `params`, and the one way the
// two ids reach `settings`.

/** The ids `provisioning.ringotelSetup` and `provisioning.ringotelAdopt` answer with, as stored. */
export const ringotelIdsOut = z.object({
  ringotelOrgId: z.string(),
  ringotelBranchId: z.string()
});

/** The stack's connection address, `<fqdn>:5061`, from `FQDN` (§6.3), the one hostname `api` is given. */
export function stackBranchAddress(): string {
  return `${env.FQDN}:${SIP_TLS_PORT}`;
}

/** One organization and one connection per stack (§10.4): a stack already set up refuses a
 *  second organization beside the one its devices are provisioned in. */
export function assertNotSetUp(settings: SettingsRow): void {
  if (settings.ringotelOrgId !== null || settings.ringotelBranchId !== null) {
    throw new OpError(
      HTTP_CONFLICT,
      `provisioning: Ringotel is already set up (organization ${settings.ringotelOrgId ?? '-'}, connection ${settings.ringotelBranchId ?? '-'})`
    );
  }
}

/** The organization's `params` object, written whole (§10.4): onboarding mails never carry the
 *  password, and they speak the tenant's language. */
export function organizationParams(settings: SettingsRow): {
  hidePassInEmail: true;
  lang: string;
} {
  return { hidePassInEmail: true, lang: settings.language };
}

// `settings.ringotel_max_regs`'s default (§11.4), the one a stack follows its package from.
const DEFAULT_MAX_REGS = 3;

/**
 * The `ringotel_max_regs` a stack at `settings` takes from its package's `maxregs`, the
 * registrations per user the package allows (6 for Pro, `ringotelOffer`), or `null` where it
 * keeps its own: only while the setting is still at its default, so a value an owner chose stays.
 */
function followedMaxRegs(
  settings: SettingsRow,
  maxregs: number | undefined
): number | null {
  if (
    settings.ringotelMaxRegs !== DEFAULT_MAX_REGS ||
    maxregs === undefined ||
    maxregs < 1 ||
    maxregs === DEFAULT_MAX_REGS
  ) {
    return null;
  }
  return maxregs;
}

/** Sets `settings.ringotelMaxRegs` to what the package's `maxregs` makes it (`followedMaxRegs`). */
async function followPackageMaxRegs(
  ctx: Context,
  maxregs: number | undefined
): Promise<void> {
  const followed = followedMaxRegs(await loadSettings(ctx.db), maxregs);
  if (followed === null) {
    return;
  }
  await ctx.db
    .updateTable('settings')
    .set({ ringotelMaxRegs: followed })
    .where('id', '=', 1)
    .execute();
  recordChange(ctx, {
    field: 'ringotelMaxRegs',
    from: DEFAULT_MAX_REGS,
    to: followed
  });
  // `max_contacts` on every `ringotel` endpoint follows it (§10.4).
  propagate(ctx, ['pjsip']);
}

/**
 * What setup and adoption give Ringotel of the tenant (§10.4): the connection's name, address,
 * country and provision profile, roster included, and the organization's `params`, from the
 * settings as the package's `maxregs` leaves them.
 */
export type TenantProfile = {
  connection: {
    name: string;
    address: string;
    country: string;
    provision: ReturnType<typeof buildBranchProvision>;
  };
  organization: ReturnType<typeof organizationParams>;
  maxregs: number | undefined;
};

/** The `TenantProfile` of the stack at `address` as `db` holds it now. */
export async function tenantProfile(
  db: Db,
  address: string,
  maxregs: number | undefined
): Promise<TenantProfile> {
  const stored = await loadSettings(db);
  const settings = {
    ...stored,
    ringotelMaxRegs: followedMaxRegs(stored, maxregs) ?? stored.ringotelMaxRegs
  };
  const parkingSlots = await loadParkingSlots(db);
  const blfs = await branchBlfEntries(db);
  return {
    connection: {
      name: settings.companyName,
      address,
      // The default country the app matches phone numbers against to find a caller among the
      // contacts (the Shell's "Country"), the tenant's own (§11.4).
      country: settings.country,
      provision: buildBranchProvision(settings, parkingSlots, blfs)
    },
    organization: organizationParams(settings),
    maxregs
  };
}

/** `createBranch` under `orgId` with the stack's connection fields (§10.4). */
export async function createConnection(
  client: RingotelClient,
  orgId: string,
  profile: TenantProfile
): Promise<string> {
  const branch = await client.call<{ id: string }>('createBranch', {
    orgid: orgId,
    ...profile.connection
  });
  return branch.id;
}

/** What setup's and adoption's `prepare` created or took at Ringotel, for their `run` to store. */
export type RingotelConnection = {
  client: RingotelClient;
  ids: { orgId: string; branchId: string };
  sent: TenantProfile;
};

/**
 * Stores the two ids and provisions the `ringotel` devices created before any provider existed
 * (§10.4), once the caller's write committed and Asterisk holds it, so a rolled-back setup or
 * adoption leaves no Ringotel user behind; each device's outcome is a `ringotel.push` row with
 * the operation, `trigger`, as its trigger, and a refusal a warning. Not undoable (§5.8, "where
 * reversal is impossible"): the ids are "written by the setup operation, read-only through
 * `PATCH`" (§11.4), so no normal operation takes the `from` values back, and the objects at
 * Ringotel lie beyond a diff.
 */
export async function storeRingotelIds(
  ctx: Context,
  { client, ids, sent }: RingotelConnection,
  trigger: 'provisioning.ringotelSetup' | 'provisioning.ringotelAdopt'
): Promise<void> {
  const { orgId, branchId } = ids;
  // A setup or adoption that committed since this one's `prepare` stands; this one rolls back,
  // and its rollback hooks take back what it created at Ringotel.
  assertNotSetUp(await loadSettings(ctx.db));
  await followPackageMaxRegs(ctx, sent.maxregs);
  // The connection and the organization were given the whole profile and roster
  // (`tenantProfile`), so nothing waits for Ringotel any more, unless a write since changed what
  // they were given: then both pushes are owed (§10.4 "Tenant profile push", "Colleague
  // presence").
  const now = await tenantProfile(
    ctx.db,
    sent.connection.address,
    sent.maxregs
  );
  const owed = JSON.stringify(now) === JSON.stringify(sent) ? 0 : 1;
  await ctx.db
    .updateTable('settings')
    .set({
      ringotelOrgId: orgId,
      ringotelBranchId: branchId,
      ringotelProfilePending: owed,
      ringotelRosterPending: owed,
      // The apps register against the running Asterisk from here on (§10.4 "After a restart").
      ringotelRegisteredAt: ctx.now
    })
    .where('id', '=', 1)
    .execute();
  for (const device of await liveRingotelDevices(ctx.db)) {
    pushExistingDevice(ctx, {
      trigger,
      deviceId: device.id,
      failure: {
        what: `device ${device.id} has no Ringotel user yet`,
        retry: 'devices.rotate on the device creates it'
      },
      provision: (db, stored) => provisionExistingDevice({ client, db }, stored)
    });
  }
  recordChange(ctx, { field: 'ringotelOrgId', from: null, to: orgId });
  recordChange(ctx, { field: 'ringotelBranchId', from: null, to: branchId });
  setUndoable(ctx, false);
}
