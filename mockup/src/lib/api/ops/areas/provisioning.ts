/**
 * Ringotel provisioning (`ops/provisioning/`, §10.4), owner only: the regions and packages the
 * Ringotel account offers, and connecting the stack to an organization, either a new one
 * (`ringotelSetup`) or an existing, empty one (`ringotelAdopt`). Both refuse a stack that is
 * already connected, and both need the Ringotel API token.
 */
import { ApiError, conflict, invalid, notFound } from '../../errors';
import type { Db } from '../../types';
import { defineOp, type Ctx } from '../core';

export type RingotelRegion = { id: string; name: string };
export type RingotelPackage = { id: number; name: string; maxregs?: number };
export type RingotelIds = { ringotelOrgId: string; ringotelBranchId: string };

/** What the demo Ringotel account offers (`getRegions`, `getPackages`). */
const OFFER: { regions: RingotelRegion[]; packages: RingotelPackage[] } = {
  regions: [
    { id: '1', name: 'North America (Virginia)' },
    { id: '3', name: 'Europe (Frankfurt)' },
    { id: '4', name: 'Europe (London)' },
    { id: '6', name: 'Asia Pacific (Singapore)' },
    { id: '7', name: 'Australia (Sydney)' }
  ],
  packages: [
    { id: 1, name: 'Essentials', maxregs: 3 },
    { id: 2, name: 'Pro', maxregs: 6 }
  ]
};

/** Organizations already in the demo account that a stack could adopt. */
const EXISTING_ORGS = [
  {
    id: '66b1d0e4a2c9f3b7e5d1a0c8',
    domain: 'brandtpartner-test',
    users: 0,
    branches: ['66b1d0e4a2c9f3b7e5d1a0c9']
  }
];

const DEFAULT_MAX_REGS = 3;

function requireToken(db: Db): void {
  if (!db.settings.ringotelApiTokenSet) {
    throw new ApiError(
      503,
      'ringotelNoToken',
      'ringotel: no API token configured (settings.ringotelApiToken)'
    );
  }
}

function assertNotSetUp(db: Db): void {
  const { ringotelOrgId, ringotelBranchId } = db.settings;
  if (ringotelOrgId !== null || ringotelBranchId !== null) {
    throw conflict(
      'ringotelAlreadySetUp',
      'provisioning: Ringotel is already set up',
      [],
      {
        orgId: ringotelOrgId ?? '–',
        branchId: ringotelBranchId ?? '–'
      }
    );
  }
}

const hexId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');

/** Stores the ids as `storeRingotelIds` does; `ringotelMaxRegs` follows the package while at its default. */
function storeIds(
  ctx: Ctx,
  ids: RingotelIds,
  details: { domain: string; region: string | null; packageId: number | null }
): RingotelIds {
  const before = ctx.db.settings;
  const maxregs = OFFER.packages.find(
    item => item.id === details.packageId
  )?.maxregs;
  const followMaxRegs =
    maxregs !== undefined && before.ringotelMaxRegs === DEFAULT_MAX_REGS;
  const after = {
    ...before,
    ringotelOrgId: ids.ringotelOrgId,
    ringotelBranchId: ids.ringotelBranchId,
    ...(followMaxRegs ? { ringotelMaxRegs: maxregs } : {})
  };
  ctx.setRoot('settings', after);
  ctx.db.ringotel = {
    orgId: ids.ringotelOrgId,
    branchId: ids.ringotelBranchId,
    ...details
  };
  ctx.audit({ entityKind: 'settings', entityId: 'settings', before, after });
  return ids;
}

defineOp<Record<string, never>, typeof OFFER>({
  name: 'provisioning.ringotelOptions',
  minRole: 'owner',
  readOnly: true,
  run: ctx => {
    requireToken(ctx.db);
    return {
      regions: OFFER.regions.map(item => ({ ...item })),
      packages: OFFER.packages.map(item => ({ ...item }))
    };
  }
});

defineOp<{ domain: string; region: string; packageid: number }, RingotelIds>({
  name: 'provisioning.ringotelSetup',
  minRole: 'owner',
  run: (ctx, input) => {
    assertNotSetUp(ctx.db);
    requireToken(ctx.db);
    const domain = (input.domain ?? '').trim().toLowerCase();
    if (domain === '') {
      throw invalid('domain', 'required', 'domain is required');
    }
    if (!OFFER.regions.some(item => item.id === input.region)) {
      throw invalid(
        'region',
        'ringotelRegion',
        `Ringotel offers no region ${input.region}`,
        {
          list: OFFER.regions.map(item => item.name).join(', ')
        }
      );
    }
    if (!OFFER.packages.some(item => item.id === input.packageid)) {
      throw invalid(
        'packageid',
        'ringotelPackage',
        `Ringotel offers no package ${input.packageid}`,
        {
          list: OFFER.packages.map(item => item.name).join(', ')
        }
      );
    }
    const existing = EXISTING_ORGS.find(org => org.domain === domain);
    if (existing !== undefined) {
      throw conflict(
        'ringotelDomainTaken',
        `the Ringotel account already has an organization with domain ${domain}`,
        [],
        {
          domain,
          orgId: existing.id
        }
      );
    }
    return storeIds(
      ctx,
      { ringotelOrgId: hexId(), ringotelBranchId: hexId() },
      { domain, region: input.region, packageId: input.packageid }
    );
  }
});

defineOp<{ orgId: string; domain: string; branchId?: string }, RingotelIds>({
  name: 'provisioning.ringotelAdopt',
  minRole: 'owner',
  confirm: (_ctx, input) => ({
    key:
      input.branchId === undefined
        ? 'provisioning.ringotelAdopt'
        : 'provisioning.ringotelAdoptBranch',
    params: { domain: input.domain, branchId: input.branchId ?? '' }
  }),
  run: (ctx, input) => {
    assertNotSetUp(ctx.db);
    requireToken(ctx.db);
    const org = EXISTING_ORGS.find(
      candidate =>
        candidate.id === input.orgId.trim() &&
        candidate.domain === input.domain.trim()
    );
    if (org === undefined) {
      throw notFound('ringotelOrganization', input.orgId);
    }
    if (org.users > 0) {
      throw conflict(
        'ringotelOrgHasUsers',
        'only an organization without users is adopted',
        [],
        { users: org.users }
      );
    }
    const branchId = input.branchId?.trim() || undefined;
    if (branchId !== undefined && !org.branches.includes(branchId)) {
      throw notFound('ringotelBranch', branchId);
    }
    return storeIds(
      ctx,
      { ringotelOrgId: org.id, ringotelBranchId: branchId ?? hexId() },
      { domain: org.domain, region: null, packageId: null }
    );
  }
});
