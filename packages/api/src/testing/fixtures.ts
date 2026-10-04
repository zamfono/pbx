/**
 * Fixtures the api tests share: a fresh secretbox key, and the trunk and user an operation test
 * builds on, created through their operations as `owner`.
 */
import { randomBytes } from 'node:crypto';

import type { Db } from '@zamfono/shared';

import { runOperation } from '#lib/server/ops/runner.js';
import type { TrunkWire } from '#lib/server/ops/trunks/_shared.js';
import { keyringFromEnv, type Keyring } from '#lib/server/secretbox.js';

import { asConfirmedRun } from './testDb.js';

import '#lib/server/ops/trunks/index.js';
import '#lib/server/ops/users/index.js';

const KEY_BYTE_LENGTH = 32;

/** A valid `SECRETBOX_KEY`-shaped value for `generation`, with a fresh random key. */
export function keySpec(generation = 1): string {
  return `${generation}:${randomBytes(KEY_BYTE_LENGTH).toString('base64')}`;
}

/** A keyring over one fresh random key. */
export function testKeyring(): Keyring {
  return keyringFromEnv({ SECRETBOX_KEY: keySpec() });
}

/** `trunks.create`'s output. */
export type CreatedTrunk = { trunk: TrunkWire; warnings: string[] };

/** An emergency-capable `ip` trunk `Provider A` at `sip.provider.example`, `fields` on top. */
export async function createTrunk(
  db: Db,
  fields: Record<string, unknown> = {}
): Promise<CreatedTrunk> {
  return (await runOperation(
    db,
    'trunks.create',
    {
      name: 'Provider A',
      emergency: true,
      authMode: 'ip',
      hosts: [{ host: 'sip.provider.example' }],
      ...fields
    },
    asConfirmedRun()
  )) as CreatedTrunk;
}

/** A user `Anna Huber` with `extension`, reached at `<extension>@x.test`, `fields` on top;
 *  returns their id. */
export async function createUser(
  db: Db,
  extension: string,
  fields: { name?: string; email?: string; role?: 'admin' | 'user' } = {}
): Promise<string> {
  const { user } = (await runOperation(
    db,
    'users.create',
    {
      name: 'Anna Huber',
      email: `${extension}@x.test`,
      extension,
      ...fields
    },
    asConfirmedRun()
  )) as { user: { id: string } };
  return user.id;
}
