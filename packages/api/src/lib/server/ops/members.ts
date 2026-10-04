import { z } from 'zod';

import { HTTP_UNPROCESSABLE_CONTENT, type Db } from '@zamfono/shared';

import { liveRow } from './rows.js';
import { OpError } from './types.js';

/** One member of a ring group or user group (§10.3): a user or a user group, by id. */
export const memberSchema = z.object({
  kind: z
    .enum(['user', 'userGroup'])
    .describe('Whether id names a user or a user group.'),
  id: z.string()
});
export type MemberSpec = z.infer<typeof memberSchema>;

/**
 * Throws 422 when `members` lists the same user or user group twice (the membership tables'
 * UNIQUEs and PKs, §11.2), or 404 when a member names no live user or user-group row (their FKs);
 * `label` (`ringGroups`, `userGroups`) prefixes the 422.
 */
export async function assertMembersValid(
  db: Db,
  members: MemberSpec[],
  label: string
): Promise<void> {
  const seen = { user: new Set<string>(), userGroup: new Set<string>() };
  for (const member of members) {
    if (seen[member.kind].has(member.id)) {
      throw new OpError(
        HTTP_UNPROCESSABLE_CONTENT,
        `${label}: duplicate ${member.kind} member '${member.id}'`
      );
    }
    seen[member.kind].add(member.id);
  }
  await Promise.all(
    members.map(async member => {
      const table = member.kind === 'user' ? 'users' : 'userGroups';
      await liveRow(
        db,
        table,
        member.id,
        `${member.kind} '${member.id}' not found`
      );
    })
  );
}
