import { z } from 'zod';

import { Conflict, defineOperation } from '../types.js';
import { cascadeSoftDeleteUser } from './_cascade.js';
import { findUserReferences } from './_references.js';
import { assertNotLastOwner, liveUser } from './_shared.js';

/** `DELETE /users/{id}` (§10.3, §5.9): soft-deletes a user and cascades their devices and extension. */
export const deleteUser = defineOperation({
  name: 'users.delete',
  description:
    'Soft-deletes a user, cascading their devices, extension and sessions.',
  input: z.object({ id: z.string() }).strict(),
  minRole: 'admin',
  confirm: input =>
    `Delete this user? The deletion can be undone until the retention period expires. (${input.id})`,
  entity: input => ({ kind: 'user', id: input.id }),
  run: async (ctx, input) => {
    const before = await liveUser(ctx.db, input.id);
    await assertNotLastOwner(ctx.db, before);
    const references = await findUserReferences(ctx.db, input.id);
    if (references.length > 0) {
      throw new Conflict('user is still in use', references);
    }
    await cascadeSoftDeleteUser(ctx, input.id);
    return { id: input.id };
  }
});
