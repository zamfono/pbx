import type { Db } from '@zamfono/shared';

import { runOperation } from '#lib/server/ops/runner.js';
import type { Actor } from '#lib/server/ops/types.js';

import { createTrunk, createUser } from './fixtures.js';
import { asRun, owner } from './testDb.js';

import '#lib/server/ops/audit/index.js';
import '#lib/server/ops/trunks/index.js';
import '#lib/server/ops/users/index.js';

// Fixtures the forwarding tests share (`setForwarding.test.ts`, `setForwardingSip.test.ts`,
// `getForwarding.test.ts`): an `admin` actor, `user`-role accounts, a trunk a `sip` target dials
// over, and the two operations called as a given actor. Importing it registers the operations.
export const admin: Actor = { id: 'admin-1', name: 'Admin', role: 'admin' };

/** A `user`-role account, returned as the actor it signs in as. */
export async function createUserActor(
  db: Db,
  name: string,
  extension: string
): Promise<Actor> {
  const id = await createUser(db, extension, { name, role: 'user' });
  return { id, name, role: 'user' };
}

/** An `ip` trunk a `sip` target can dial over (§9.4 "SIP targets"). */
export async function createSipTargetTrunk(
  db: Db,
  name = 'OpenAI',
  host = 'sip.api.openai.com'
): Promise<string> {
  const { trunk } = await createTrunk(db, {
    name,
    hosts: [{ host, direction: 'outbound' }]
  });
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
  return (await runOperation(
    db,
    'users.setForwarding',
    { id, rules },
    asRun({ actor })
  )) as Forwarding;
}

export async function getForwarding(
  db: Db,
  id: string,
  actor: Actor = owner
): Promise<Forwarding> {
  return (await runOperation(
    db,
    'users.getForwarding',
    { id },
    asRun({ actor })
  )) as Forwarding;
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
