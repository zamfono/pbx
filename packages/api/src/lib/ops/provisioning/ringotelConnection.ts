import { buildBranchProvision } from '../../provisioning/ringotel.js';
import type { RingotelClient } from '../../provisioning/ringotelClient.js';
import { branchBlfEntries } from '../../provisioning/ringotelRoster.js';
import { provisionExistingDevices } from '../../provisioning/ringotelUser.js';
import { reportPush } from '../devices/_ringotelPush.js';
import { loadParkingSlots } from '../parking/_shared.js';
import { propagate, recordChange, setUndoable } from '../runner.js';
import { loadSettings, type SettingsRow } from '../settings/_shared.js';
import { OpError, type Context } from '../types.js';

// What `provisioning.ringotelSetup` and `provisioning.ringotelAdopt` share (§10.3, §10.4): the
// stack's own connection address and profile, the organization's `params`, and the one way the
// two ids reach `settings`.

// §6.1 "One IP, two listeners": the fixed SIP-TLS port every client, Ringotel included, dials.
const SIP_TLS_PORT = 5061;
export const STATUS_CONFLICT = 409;
export const STATUS_NOT_FOUND = 404;
const STATUS_SERVICE_UNAVAILABLE = 503;

/**
 * The stack's connection address, `<fqdn>:5061`, from `ORIGIN` (`https://<fqdn>`, §6.3), the one
 * hostname `api` is given. `ORIGIN` is set by the deployment, never by the caller, so a missing
 * one is this stack's own misconfiguration rather than a bad request.
 */
export function stackBranchAddress(): string {
  const origin = process.env.ORIGIN;
  if (!origin) {
    throw new OpError(
      STATUS_SERVICE_UNAVAILABLE,
      'provisioning: ORIGIN is not set'
    );
  }
  return `${new URL(origin).hostname}:${SIP_TLS_PORT}`;
}

/** One organization and one connection per stack (§10.4): a stack already set up refuses a
 *  second organization beside the one its devices are provisioned in. */
export function assertNotSetUp(settings: SettingsRow): void {
  if (settings.ringotelOrgId !== null || settings.ringotelBranchId !== null) {
    throw new OpError(
      STATUS_CONFLICT,
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
 * Sets `settings.ringotelMaxRegs` to `maxregs`, the registrations per user the organization's
 * package allows (6 for Pro, `ringotelOffer`), while it is still at its default, so a value an
 * owner chose stays. Run before the connection's profile is written, which carries it.
 */
export async function followPackageMaxRegs(
  ctx: Context,
  maxregs: number | undefined
): Promise<void> {
  const settings = await loadSettings(ctx.db);
  if (
    settings.ringotelMaxRegs !== DEFAULT_MAX_REGS ||
    maxregs === undefined ||
    maxregs < 1 ||
    maxregs === DEFAULT_MAX_REGS
  ) {
    return;
  }
  await ctx.db
    .updateTable('settings')
    .set({ ringotelMaxRegs: maxregs })
    .where('id', '=', 1)
    .execute();
  recordChange(ctx, {
    field: 'ringotelMaxRegs',
    from: DEFAULT_MAX_REGS,
    to: maxregs
  });
  // `max_contacts` on every `ringotel` endpoint follows it (§10.4).
  propagate(ctx, ['pjsip']);
}

/** The connection's name, address and provision profile (§10.4), as this stack wants it. */
export async function connectionFields(
  ctx: Context,
  address: string
): Promise<{
  name: string;
  address: string;
  country: string;
  provision: ReturnType<typeof buildBranchProvision>;
}> {
  const settings = await loadSettings(ctx.db);
  const parkingSlots = await loadParkingSlots(ctx.db);
  const blfs = await branchBlfEntries(ctx.db);
  return {
    name: settings.companyName,
    address,
    // The default country the app matches phone numbers against to find a caller among the
    // contacts (the Shell's "Country"), the tenant's own (§11.4).
    country: settings.country,
    provision: buildBranchProvision(settings, parkingSlots, blfs)
  };
}

/** `createBranch` under `orgId` with the stack's address and provision profile (§10.4). */
export async function createConnection(
  ctx: Context,
  client: RingotelClient,
  orgId: string,
  address: string
): Promise<string> {
  const branch = await client.call<{ id: string }>('createBranch', {
    orgid: orgId,
    ...(await connectionFields(ctx, address))
  });
  return branch.id;
}

/**
 * Stores the two ids and provisions the `ringotel` devices created before any provider existed
 * (§10.4), inside the caller's rollback; each device's outcome is a `ringotel.push` row with the
 * operation, `trigger`, as its trigger, and a refusal a warning. Not undoable (§5.8, "where
 * reversal is impossible"): the ids are "written by the setup operation, read-only through
 * `PATCH`" (§11.4), so no normal operation takes the `from` values back, and the objects at
 * Ringotel lie beyond a diff.
 */
export async function storeRingotelIds(
  ctx: Context,
  client: RingotelClient,
  ids: { orgId: string; branchId: string },
  trigger: 'provisioning.ringotelSetup' | 'provisioning.ringotelAdopt'
): Promise<void> {
  const { orgId, branchId } = ids;
  await ctx.db
    .updateTable('settings')
    // The connection was just written with the whole profile (`connectionFields`) and the
    // organization with its `params`, so no profile change waits for Ringotel any more (§10.4
    // "Tenant profile push").
    .set({
      ringotelOrgId: orgId,
      ringotelBranchId: branchId,
      ringotelProfilePending: 0
    })
    .where('id', '=', 1)
    .execute();
  const outcomes = await provisionExistingDevices({ client, db: ctx.db });
  for (const outcome of outcomes) {
    reportPush(
      ctx,
      {
        trigger,
        deviceId: outcome.deviceId,
        failure: {
          what: `device ${outcome.deviceId} has no Ringotel user yet`,
          retry: 'devices.rotate on the device creates it'
        }
      },
      'remoteId' in outcome
        ? { outcome: 'pushed', receipt: { remoteId: outcome.remoteId } }
        : { outcome: 'refused', reason: outcome.reason }
    );
  }
  recordChange(ctx, { field: 'ringotelOrgId', from: null, to: orgId });
  recordChange(ctx, { field: 'ringotelBranchId', from: null, to: branchId });
  setUndoable(ctx, false);
}
