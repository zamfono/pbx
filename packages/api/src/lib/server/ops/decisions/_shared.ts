import type { Selectable } from 'kysely';
import { z } from 'zod';

import { conditionsByCase, newId, type DB, type Db } from '@zamfono/shared';

import { targetSpecSchema } from '../forwardTargetSchema.js';
import { resolveTarget } from '../forwardTargetSpec.js';
import {
  deleteForwardTargets,
  writeForwardTarget
} from '../forwardTargetWrite.js';
import { assertNoLiveHolder } from '../liveHolder.js';
import { ownedExtension } from '../ownedExtension.js';
import { liveRow } from '../rows.js';
import type { Context } from '../types.js';
import {
  assertConditionsValid,
  conditionSchema,
  insertConditions
} from './_conditions.js';

/** A `decisions` row as Kysely's `CamelCasePlugin` maps it (§11.2). */
export type DecisionRow = Selectable<DB['decisions']>;

/** Loads a live decision by id, or throws `OpError(404)`. */
export async function liveDecision(db: Db, id: string): Promise<DecisionRow> {
  return liveRow(db, 'decisions', id, `decision '${id}' not found`);
}

/** Throws 409 when `name` is already used by another live decision (`decisions_name`, §11.2). */
export async function assertNameAvailable(
  db: Db,
  name: string,
  excludeId?: string
): Promise<void> {
  await assertNoLiveHolder(
    db,
    'decisions: name already in use',
    { table: 'decisions', kind: 'decision', label: 'name', values: { name } },
    excludeId
  );
}

/** One case: the conditions that must all match, and where the call goes when they do. */
export const caseSchema = z.strictObject({
  when: z
    .array(conditionSchema)
    .min(1)
    .describe('Conditions that must all match for the case to be taken.'),
  target: targetSpecSchema.describe(
    'Where the call goes when the case is taken.'
  )
});
export type DecisionCase = z.infer<typeof caseSchema>;

/** The fields `decisions.create` takes and `decisions.update` takes each optionally (§10.3). */
export const decisionFields = {
  name: z
    .string()
    .min(1)
    .describe(
      'Display text, unique among decisions, e.g. "Support – VIP customers".'
    ),
  cases: z
    .array(caseSchema)
    .describe(
      'In order: the first case whose conditions all match is taken; replaced as a whole.'
    ),
  default: targetSpecSchema.describe(
    'Where the call goes when no case matches.'
  ),
  extension: z
    .string()
    .nullable()
    .describe(
      'An extension of its own, so the decision can be dialled and transferred to; null for none.'
    )
};

/** A decision's wire shape (§10.3), as `toDecisionOut` assembles it. */
export const decisionOut = z.object({
  id: z.string(),
  name: z.string(),
  ext: z
    .string()
    .nullable()
    .describe('The extension, null for none (reached only through targets).'),
  cases: z.array(caseSchema),
  default: targetSpecSchema
});
export type DecisionOut = z.infer<typeof decisionOut>;

/**
 * Writes `cases` as `decisionId`'s cases in place of the ones it has, its conditions validated
 * first (422, a user not live 404). Each case's target is a row of its own, owned by
 * `decision_cases.target_id` (§11.2): the case at a position keeps the row the case there had,
 * written in place, and the rows of positions `cases` no longer has are deleted. The case rows
 * and their conditions (by the FK cascade) are written anew.
 */
export async function writeCases(
  ctx: Context,
  decisionId: string,
  cases: DecisionCase[]
): Promise<void> {
  await assertConditionsValid(
    ctx.db,
    cases.map(decisionCase => decisionCase.when)
  );
  const held = await ctx.db
    .selectFrom('decisionCases')
    .select('targetId')
    .where('decisionId', '=', decisionId)
    .orderBy('position')
    .execute();
  await ctx.db
    .deleteFrom('decisionCases')
    .where('decisionId', '=', decisionId)
    .execute();
  await deleteForwardTargets(
    ctx.db,
    held.slice(cases.length).map(row => row.targetId)
  );
  for (const [position, decisionCase] of cases.entries()) {
    // eslint-disable-next-line no-await-in-loop -- in input order, so the first invalid target is the one refused
    const targetId = await writeForwardTarget(
      ctx,
      decisionCase.target,
      held[position]?.targetId ?? null
    );
    const caseId = newId();
    // eslint-disable-next-line no-await-in-loop -- as above
    await ctx.db
      .insertInto('decisionCases')
      .values({ id: caseId, decisionId, position, targetId })
      .execute();
    // eslint-disable-next-line no-await-in-loop -- as above
    await insertConditions(
      ctx.db,
      { decisionId, caseId },
      decisionCase.when,
      null
    );
  }
}

/** `decisionId`'s cases in order, in `decisions.update`'s own input shape (§10.3). */
export async function decisionCases(
  db: Db,
  decisionId: string
): Promise<DecisionCase[]> {
  const [cases, conditions] = await Promise.all([
    db
      .selectFrom('decisionCases')
      .select(['id', 'targetId'])
      .where('decisionId', '=', decisionId)
      .orderBy('position')
      .execute(),
    db
      .selectFrom('decisionConditions')
      .select([
        'id',
        'caseId',
        'parentId',
        'position',
        'type',
        'valueJson',
        'userId'
      ])
      .where('decisionId', '=', decisionId)
      .execute()
  ]);
  const byCase = conditionsByCase(conditions);
  return Promise.all(
    cases.map(async row => ({
      when: byCase.get(row.id) ?? [],
      target: await resolveTarget(db, row.targetId)
    }))
  );
}

/** Assembles the wire shape of a decision from its row, extension, cases and default (§10.3). */
export async function toDecisionOut(
  db: Db,
  row: DecisionRow
): Promise<DecisionOut> {
  const [ext, cases, fallback] = await Promise.all([
    ownedExtension(db, { decisionId: row.id }),
    decisionCases(db, row.id),
    resolveTarget(db, row.defaultTargetId)
  ]);
  return { id: row.id, name: row.name, ext, cases, default: fallback };
}
