/**
 * The branch-level `ringotel` hooks (§10.4): the colleague roster and the tenant profile both
 * push every key Zamfono owns of the branch's `provision` object via `updateBranch`, so they share
 * this module.
 */
import pino from 'pino';

import { loadParkingSlots } from '../ops/parking/_shared.js';
import { loadSettings } from '../ops/settings/_shared.js';
import { buildBranchProvision } from './branchProvision.js';
import { setProfilePending } from './profilePending.js';
import type { RingotelProviderDeps } from './ringotelClient.js';
import {
  blfEntries,
  branchBlfEntries,
  deviceBlfKeys,
  extensionOfUser,
  loadAllLiveExtensions,
  resolveIds,
  ringotelSipUsername,
  type RemoteUser
} from './ringotelRoster.js';
import type { SettingsRow, UserRow } from './types.js';

/**
 * A roster user whose live `ringotel` device has no Ringotel user, one removed in the Ringotel
 * Shell (setup provisions the devices created before it, `ringotelUser.ts`), is skipped by the
 * roster push and logged at `warn`, so the rest of the roster still reaches Ringotel; the
 * device's next device-scoped hook provisions it. A user without a `ringotel` device has no
 * Ringotel user by design and is skipped silently.
 */
export const ringotelLog = pino({ name: 'ringotel' });

/**
 * The Ringotel user `ext`'s owner holds: the one at `ext`, or, right after an extension rename
 * (§10.3 `users.update`), the one Ringotel still keeps under the old extension and the old
 * `e<old>-d<slug>` username. A rename keeps the device's slug (§9.3 "Naming"), so that user is
 * the one whose username carries the slug of the owner's current `sipUsername`, among the remote
 * users whose extension no Zamfono extension holds any more.
 */
function remoteUserFor(
  remoteUsers: RemoteUser[],
  liveExts: Set<string>,
  ext: string,
  sipUsername: string | null
): RemoteUser | undefined {
  const atExt = remoteUsers.find(user => user.extension === ext);
  if (atExt !== undefined || sipUsername === null) {
    return atExt;
  }
  const slugSuffix = sipUsername.slice(`e${ext}`.length);
  const renamed = remoteUsers.filter(
    user =>
      !liveExts.has(user.extension) &&
      user.username === `e${user.extension}${slugSuffix}`
  );
  if (renamed.length > 1) {
    throw new Error(
      `ringotel: several stale users match the device slug of ${sipUsername}`
    );
  }
  return renamed[0];
}

/**
 * Pushes `extension` for every `users` row that has a live Ringotel user, alongside the current
 * `username`/`authname` when the user's `ringotel` device has one: an extension rename (§10.3
 * `users.update`) also renames the device's SIP username, and the app authenticates against the
 * renamed PJSIP endpoint under that same, current username.
 */
async function pushRosterExtensions(
  deps: RingotelProviderDeps,
  users: UserRow[],
  orgId: string,
  remoteUsers: RemoteUser[],
  liveExts: Set<string>
): Promise<void> {
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch update; sequential pushes are the plain reading of the API
    const ext = await extensionOfUser(deps.db, user.id);
    if (ext === null) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each push depends on the previous lookup's result, not on unrelated work
    const sipUsername = await ringotelSipUsername(deps.db, user.id);
    const remote = remoteUserFor(remoteUsers, liveExts, ext, sipUsername);
    if (remote === undefined) {
      if (sipUsername !== null) {
        ringotelLog.warn(
          { userId: user.id, ext, sipUsername },
          'ringotel: no Ringotel user for this ringotel device; its extension was not pushed'
        );
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each push depends on the previous lookup's result, not on unrelated work
    await deps.client.call('updateUser', {
      orgid: orgId,
      id: remote.id,
      extension: ext,
      ...(sipUsername === null
        ? {}
        : { username: sipUsername, authname: sipUsername })
    });
  }
}

/**
 * Re-renders every live `ringotel` device's panel as its Ringotel user's `options.blfs` (§10.4
 * "re-renders the branch and per-user blfs lists"): a roster change moves the numbers and titles
 * its keys show, an extension rename rewrites `device_blf_keys` (§10.3 `users.update`) and a
 * removed extension drops its keys by the FK. The prior panel is gone by now, so which panels
 * changed is not knowable here and each one is pushed, an empty one as the branch default, as
 * `devices.setBlf` pushes it. `remoteUsers` is the list read before this change's extension push.
 */
async function pushDevicePanels(
  deps: RingotelProviderDeps,
  orgId: string,
  remoteUsers: RemoteUser[],
  liveExts: Set<string>
): Promise<void> {
  const devices = await deps.db
    .selectFrom('devices')
    .innerJoin('extensions', 'extensions.userId', 'devices.userId')
    .select(['devices.id', 'devices.sipUsername', 'extensions.ext'])
    .where('devices.kind', '=', 'ringotel')
    .where('devices.deletedAt', 'is', null)
    .orderBy('extensions.ext')
    .execute();
  for (const device of devices) {
    const remote = remoteUserFor(
      remoteUsers,
      liveExts,
      device.ext,
      device.sipUsername
    );
    if (remote === undefined) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- the Ringotel RPC has no batch update; sequential pushes are the plain reading of the API
    const keys = await deviceBlfKeys(deps.db, device.id);
    // eslint-disable-next-line no-await-in-loop -- as above
    const blfs = await blfEntries(deps.db, keys);
    // eslint-disable-next-line no-await-in-loop -- as above
    await deps.client.call('updateUser', {
      orgid: orgId,
      id: remote.id,
      options: { blfs }
    });
  }
}

/**
 * The branch fields Zamfono owns, as every `updateBranch` push carries them, the roster's
 * included: the default country the app matches phone numbers against (the Shell's "Country")
 * and every key of the provision profile (§10.4). So any push Ringotel takes delivers the whole
 * tenant profile, and clears a profile change still waiting (`profilePending.ts`).
 */
async function branchUpdate(
  deps: RingotelProviderDeps,
  settings: SettingsRow,
  branchId: string,
  orgId: string
): Promise<Record<string, unknown>> {
  const parkingSlots = await loadParkingSlots(deps.db);
  const blfs = await branchBlfEntries(deps.db);
  return {
    id: branchId,
    orgid: orgId,
    country: settings.country,
    provision: buildBranchProvision(settings, parkingSlots, blfs)
  };
}

/**
 * `onRosterChanged` (§10.4): re-renders the branch's `blfs` list, then each user's extension, then
 * every device's own panel.
 */
export async function ringotelRosterChanged(
  deps: RingotelProviderDeps,
  users: UserRow[]
): Promise<void> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const settings = await loadSettings(deps.db);
  const liveExts = await loadAllLiveExtensions(deps.db);
  await deps.client.call(
    'updateBranch',
    await branchUpdate(deps, settings, branchId, orgId)
  );
  // The push carried the whole profile, so a profile change still waiting has reached Ringotel.
  await setProfilePending(deps.db, false);
  const remoteUsers = await deps.client.call<RemoteUser[]>('getUsers', {
    orgid: orgId,
    branchid: branchId
  });
  const liveExtSet = new Set(liveExts);
  await pushRosterExtensions(deps, users, orgId, remoteUsers, liveExtSet);
  await pushDevicePanels(deps, orgId, remoteUsers, liveExtSet);
}

/** `onTenantProfileChanged` (§10.4): codecs, `maxRegs`, feature codes, emergency numbers and country via `updateBranch`, language via `updateOrganization`. */
export async function ringotelTenantProfileChanged(
  deps: RingotelProviderDeps,
  settings: SettingsRow
): Promise<void> {
  if (settings.ringotelOrgId === null || settings.ringotelBranchId === null) {
    return;
  }
  await deps.client.call(
    'updateBranch',
    await branchUpdate(
      deps,
      settings,
      settings.ringotelBranchId,
      settings.ringotelOrgId
    )
  );
  // The organization's `params` object is written whole (§10.4), so every push carries
  // `hidePassInEmail: true` alongside the language.
  await deps.client.call('updateOrganization', {
    id: settings.ringotelOrgId,
    params: { hidePassInEmail: true, lang: settings.language }
  });
}

/**
 * `onPbxRestarted` (§10.4 "After a restart"): the Shell's "Reset registrations", which is
 * `updateBranch` with the branch's fields and `rereg: true`; Ringotel then re-registers every user
 * of the connection, which a new Asterisk holds no contact of.
 */
export async function ringotelPbxRestarted(
  deps: RingotelProviderDeps
): Promise<void> {
  const { orgId, branchId } = await resolveIds(deps.db);
  const settings = await loadSettings(deps.db);
  await deps.client.call('updateBranch', {
    ...(await branchUpdate(deps, settings, branchId, orgId)),
    rereg: true
  });
  // As the roster push: the whole profile went with it.
  await setProfilePending(deps.db, false);
}
