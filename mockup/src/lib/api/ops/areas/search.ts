/**
 * `search.query` (any user): type-ahead over users, ring groups and contacts.
 */
import { defineOp } from '../core';

type Input = { q: string; limit?: number };
type Hit = {
  kind: 'user' | 'ringGroup' | 'contact';
  id: string;
  name: string;
  detail: string | null;
};

const DEFAULT_LIMIT = 10;

defineOp<Input, { items: Hit[] }>({
  name: 'search.query',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: (ctx, input) => {
    const needle = input.q.toLowerCase();
    const hit = (...values: (string | null)[]): boolean =>
      values.some(value => value?.toLowerCase().includes(needle) === true);
    const items: Hit[] = [
      ...ctx.db.users
        .filter(
          user =>
            user.deletedAt === null &&
            hit(user.name, user.extension, user.email)
        )
        .map(user => ({
          kind: 'user' as const,
          id: user.id,
          name: user.name,
          detail: user.extension
        })),
      ...ctx.db.ringGroups
        .filter(group => group.deletedAt === null && hit(group.name, group.ext))
        .map(group => ({
          kind: 'ringGroup' as const,
          id: group.id,
          name: group.name,
          detail: group.ext
        })),
      ...ctx.db.contacts
        .filter(
          contact =>
            contact.deletedAt === null &&
            hit(
              contact.displayName,
              contact.company,
              ...contact.phones.map(phone => phone.number)
            )
        )
        .map(contact => ({
          kind: 'contact' as const,
          id: contact.id,
          name: contact.displayName,
          detail: contact.phones[0]?.number ?? null
        }))
    ];
    return { items: items.slice(0, input.limit ?? DEFAULT_LIMIT) };
  }
});
