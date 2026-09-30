import { newId, nowIso, type Db } from '@zamfono/shared';

import { runOperation, type RunInput } from '../runner.js';
import type { Actor } from '../types.js';

import '../audit/index.js';
import '../trunks/index.js';
import './index.js';

// Fixtures the forwarding tests share (`setForwarding.test.ts`, `setForwardingSip.test.ts`,
// `getForwarding.test.ts`): a seeded tenant, `user`-role accounts, a trunk a `sip` target dials
// over, and the two operations called as a given actor. Importing it registers the operations.
// A fixed 32-byte test key, as the other operations' tests set one.
const SECRETBOX_KEY_BYTES = 32;
const SECRETBOX_KEY_FILL = 7;
process.env.SECRETBOX_KEY ??= `1:${Buffer.alloc(SECRETBOX_KEY_BYTES, SECRETBOX_KEY_FILL).toString('base64')}`;
process.env.ORIGIN ??= 'https://pbx.example.test';

export const owner: Actor = { id: 'owner', name: 'Owner', role: 'owner' };
export const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };

export function asRun(overrides: Partial<RunInput> = {}): RunInput {
  return { actor: owner, channel: 'rest', requestId: 'req-1', ...overrides };
}

/** Seeds the tenant `settings` singleton, required by extension and phone-number checks. */
export async function seedTenant(db: Db): Promise<Db> {
  const targetId = newId();
  await db
    .insertInto('forwardTargets')
    .values({ id: targetId, external: '+490000000' })
    .execute();
  const didId = newId();
  await db
    .insertInto('dids')
    .values({ id: didId, number: '+490000000', targetId, createdAt: nowIso() })
    .execute();
  await db
    .insertInto('settings')
    .values({
      id: 1,
      companyName: 'Test Co',
      country: 'DE',
      emergencyNumbersJson: '["112"]',
      mainDidId: didId
    })
    .execute();
  return db;
}

/** A `user`-role account, returned as the actor it signs in as. */
export async function createUser(
  db: Db,
  name: string,
  extension: string
): Promise<Actor> {
  const { user } = await runOperation<unknown, { user: { id: string } }>(
    db,
    'users.create',
    {
      name,
      email: `${extension}@x.test`,
      extension,
      role: 'user'
    },
    asRun()
  );
  return { id: user.id, name, role: 'user' };
}

/** An `ip` trunk a `sip` target can dial over (§9.4 "SIP targets"). */
export async function createTrunk(
  db: Db,
  name = 'OpenAI',
  host = 'sip.api.openai.com'
): Promise<string> {
  const { trunk } = await runOperation<unknown, { trunk: { id: string } }>(
    db,
    'trunks.create',
    {
      name,
      emergency: true,
      authMode: 'ip',
      hosts: [{ host, direction: 'outbound' }]
    },
    asRun()
  );
  return trunk.id;
}

export type Rule = { condition: string; target: Record<string, unknown> };
export type Forwarding = { id: string; rules: Rule[] };

export async function setForwarding(
  db: Db,
  id: string,
  rules: Rule[],
  actor: Actor = owner
): Promise<Forwarding> {
  return runOperation(
    db,
    'users.setForwarding',
    { id, rules },
    asRun({ actor })
  );
}

export async function getForwarding(
  db: Db,
  id: string,
  actor: Actor = owner
): Promise<Forwarding> {
  return runOperation(db, 'users.getForwarding', { id }, asRun({ actor }));
}

/** The stored rules' conditions, sorted, which each test compares against what it wrote. */
export async function storedConditions(
  db: Db,
  userId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('userForwardRules')
    .select('condition')
    .where('userId', '=', userId)
    .orderBy('condition')
    .execute();
  return rows.map(row => row.condition);
}

/** The target row id each stored rule owns, by condition. */
export async function storedTargetIds(
  db: Db,
  userId: string
): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom('userForwardRules')
    .select(['condition', 'targetId'])
    .where('userId', '=', userId)
    .execute();
  return Object.fromEntries(rows.map(row => [row.condition, row.targetId]));
}
