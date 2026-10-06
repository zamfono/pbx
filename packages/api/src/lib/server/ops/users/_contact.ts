import type { UserRole } from '@zamfono/shared';

import { OpError, type ProblemStatus } from '../types.js';

/**
 * Throws `OpError(status)` unless a user of `role` with `email` and `extension` keeps §11.2's
 * rule: an e-mail, an extension or both, and an e-mail for an owner or an admin, who log in to
 * configure the stack. `status` is 422 for a new user's input, 409 for a change to a live one.
 */
export function assertContact(
  user: { role: UserRole; email: string | null; extension: string | null },
  status: ProblemStatus
): void {
  if (user.email === null && user.extension === null) {
    throw new OpError(status, 'users: a user needs an e-mail or an extension');
  }
  if (user.email === null && user.role !== 'user') {
    throw new OpError(status, `users: an ${user.role} needs an e-mail`);
  }
}
