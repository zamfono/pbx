import { findMeColumn } from '@zamfono/shared';

import type { WireColumns } from '../audit.js';
import type { UserRow } from './_shared.js';

/** A 0/1 column (nullable or not) as its wire `boolean` (§11.1, §10.3). */
const fromFlag = (stored: number | null): boolean | null =>
  stored === null ? null : Boolean(stored);

/**
 * The `users` columns whose wire field differs in name or value (§10.3 "Conventions": every value
 * a client sees, `GET /audit` included, is a wire value): `findMeJson`'s JSON string becomes
 * `findMe`'s parsed array, a flag column's 0/1/`null` becomes `false`/`true`/`null`; every other
 * column shares its name and value type with the wire field it maps to.
 */
export const USER_WIRE_COLUMNS: WireColumns<UserRow> = {
  findMeJson: {
    field: 'findMe',
    decode: stored => findMeColumn.decode(stored)
  },
  clir: { decode: fromFlag },
  rejectAnonymous: { decode: fromFlag },
  recordCalls: { decode: fromFlag },
  notifyMissedCalls: { decode: fromFlag },
  mailboxEnabled: { decode: fromFlag }
};
