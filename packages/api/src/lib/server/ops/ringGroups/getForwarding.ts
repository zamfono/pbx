import { z } from 'zod';

import { defineOperation } from '../types.js';
import { storedRingGroupForwardRules } from './_forwarding.js';
import { liveRingGroup } from './_shared.js';

/**
 * `GET /ringGroups/{id}/forwarding` (§10.3 "Ring groups"): reads a ring group's forwarding rules
 * as `{ id, rules }`, the shape `ringGroups.setForwarding` takes and returns, `sip` targets with
 * their `headers`, so a read, an edit and a `PUT` round-trip unchanged.
 */
export const getRingGroupForwarding = defineOperation({
  name: 'ringGroups.getForwarding',
  description:
    "Reads a ring group's 'unanswered' and 'unavailable' forwarding rules in the shape ringGroups.setForwarding takes.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  readOnly: true,
  run: async (ctx, input) => {
    await liveRingGroup(ctx.db, input.id);
    const rules = await storedRingGroupForwardRules(ctx.db, input.id);
    return {
      id: input.id,
      rules: rules.map(({ condition, target }) => ({ condition, target }))
    };
  }
});
