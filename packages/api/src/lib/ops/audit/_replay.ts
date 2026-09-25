import { registry } from '../registry.js';
import { OpError, type Context } from '../types.js';

const STATUS_CONFLICT = 409;

/**
 * Writes `input` back through the registered operation `name` (§5.8: "Field changes are reverted
 * by writing the `from` values back through the normal operations"), after validating it against
 * that operation's own input schema. A recorded diff that does not form a valid input for the
 * operation is refused with a 409, so the entry stays live and the caller learns why.
 */
export async function replayOperation(
  ctx: Context,
  name: string,
  input: unknown
): Promise<void> {
  const op = registry.get(name);
  if (!op) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: operation '${name}' is not registered`
    );
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    throw new OpError(
      STATUS_CONFLICT,
      `audit.undo: '${name}' cannot take this change back`,
      parsed.error.issues
    );
  }
  await op.run(ctx, parsed.data);
}
