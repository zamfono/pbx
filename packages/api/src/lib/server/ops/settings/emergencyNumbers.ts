import { OpError, type Context } from '../types.js';

const STATUS_UNPROCESSABLE_ENTITY = 422;

/**
 * Throws `OpError(422)` when a number the tenant is adopting as an emergency number is already a
 * live extension. An emergency number is "always external and never a valid extension" (§9.4
 * "Dial-plan resolution"), and dialling resolves it as the emergency call before any extension,
 * so adopting one an extension holds would silently make that extension unreachable.
 */
export async function assertNoExtensionCollision(
  ctx: Context,
  numbers: string[] | undefined
): Promise<void> {
  if (numbers === undefined) {
    return;
  }
  const taken = await ctx.db
    .selectFrom('extensions')
    .select('ext')
    .where('ext', 'in', numbers)
    .execute();
  if (taken.length > 0) {
    const list = taken.map(row => row.ext).join(', ');
    throw new OpError(
      STATUS_UNPROCESSABLE_ENTITY,
      `already a live extension, so it cannot be an emergency number: ${list}`
    );
  }
}
