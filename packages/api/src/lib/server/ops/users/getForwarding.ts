import { z } from 'zod';

import { assertSelfOrAdmin } from '../gates.js';
import { defineOperation } from '../types.js';
import { storedForwardRules } from './_forwarding.js';
import { liveUser } from './_shared.js';

/**
 * `GET /users/{id}/forwarding` (§10.3 "Users"): reads a user's forwarding rules as `{ id, rules }`,
 * the shape `users.setForwarding` takes and returns, `sip` targets with their `headers`, so a
 * read, an edit and a `PUT` round-trip unchanged. Self-service on a `user` actor's own id.
 */
export const getForwarding = defineOperation({
  name: 'users.getForwarding',
  description:
    "Reads a user's call-forwarding rules in the shape users.setForwarding takes; a user reads their own, an admin anyone's.",
  input: z.object({ id: z.string() }).strict(),
  minRole: 'user',
  readOnly: true,
  run: async (ctx, input) => {
    assertSelfOrAdmin(
      ctx.actor,
      input.id,
      'users: may read only your own forwarding'
    );
    await liveUser(ctx.db, input.id);
    const rules = await storedForwardRules(ctx.db, input.id);
    return {
      id: input.id,
      rules: rules.map(({ condition, target }) => ({ condition, target }))
    };
  }
});
