import { z } from 'zod';

import {
  createRingotelClient,
  type RingotelClient
} from '$lib/server/provisioning/ringotelClient.js';
import { keyringFromEnv } from '$lib/server/secretbox.js';

import { loadSettings } from '../settings/_shared.js';
import { defineOperation, OpError } from '../types.js';

const STATUS_BAD_REQUEST = 400;

/** A region an organization can be created in, as Ringotel names it (§10.4 "Organization"). */
type Region = { id: string; name: string };
/** A plan `packageid` selects, as the account offers it, with the registrations per user it
 *  allows (`features.maxregs`), where Ringotel names them. */
type Package = { id: number; name: string; maxregs?: number };
type Output = { regions: Region[]; packages: Package[] };

/**
 * What the account offers, read live (`getRegions`, `getPackages`): Ringotel adds regions, an
 * account may have a server of its own among them, and the packages are the account's own, so
 * no list fixed in this code could be right for every account.
 */
export async function ringotelOffer(client: RingotelClient): Promise<Output> {
  const regions = await client.call<Region[]>('getRegions');
  const packages =
    await client.call<
      { id: number; name: string; features?: { maxregs?: unknown } }[]
    >('getPackages');
  return {
    regions: regions.map(({ id, name }) => ({ id, name })),
    packages: packages.map(({ id, name, features }) =>
      typeof features?.maxregs === 'number'
        ? { id, name, maxregs: features.maxregs }
        : { id, name }
    )
  };
}

/** Refuses a `region` or `packageid` the account does not offer, naming the ones it does, and
 *  returns the chosen package. */
export async function assertOffered(
  client: RingotelClient,
  region: string,
  packageid: number
): Promise<Package> {
  const offer = await ringotelOffer(client);
  const list = (items: { id: string | number; name: string }[]): string =>
    items.map(item => `${item.id} (${item.name})`).join(', ');
  if (!offer.regions.some(item => item.id === region)) {
    throw new OpError(
      STATUS_BAD_REQUEST,
      `provisioning: Ringotel offers no region ${region}; choose one of ${list(offer.regions)}`
    );
  }
  const chosen = offer.packages.find(item => item.id === packageid);
  if (chosen === undefined) {
    throw new OpError(
      STATUS_BAD_REQUEST,
      `provisioning: Ringotel offers no package ${packageid}; choose one of ${list(offer.packages)}`
    );
  }
  return chosen;
}

export const ringotelOptions = defineOperation<Record<string, never>, Output>({
  name: 'provisioning.ringotelOptions',
  description:
    'Lists the Ringotel regions and packages the account offers, the choices provisioning.ringotelSetup takes.',
  input: z.object({}).strict(),
  minRole: 'owner',
  readOnly: true,
  run: async ctx => {
    const settings = await loadSettings(ctx.db);
    return ringotelOffer(
      createRingotelClient(settings, keyringFromEnv(process.env))
    );
  }
});
