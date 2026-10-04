import { z } from 'zod';

import { HTTP_NOT_FOUND } from '@zamfono/shared';

import { idOutput, softDeleteQuestion } from '../rows.js';
import { Conflict, defineOperation } from '../types.js';
import { cascadeSoftDeleteUser } from './_cascade.js';
import { userExtension } from './_extensions.js';
import { findUserReferences } from './_references.js';
import { assertNotLastOwner, liveUser, namesAnOwner } from './_shared.js';

/** `DELETE /users/{id}` (§10.3, §5.9): soft-deletes a user and cascades their devices and extension. */
export const deleteUser = defineOperation({
  name: 'users.delete',
  description:
    'Soft-deletes a user, cascading their devices, extension and sessions.',
  input: z.object({ id: z.string() }).strict(),
  output: idOutput,
  problems: [HTTP_NOT_FOUND],
  minRole: 'admin',
  ownerOnly: namesAnOwner,
  confirm: async (ctx, input) => {
    const user = await liveUser(ctx.db, input.id);
    const ext = await userExtension(ctx.db, input.id);
    return softDeleteQuestion(ctx, `${user.name} (extension ${ext})`);
  },
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
