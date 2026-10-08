/**
 * Small helpers the people screens share: the next free extension to suggest, inline field
 * errors from a refused operation, and how a person's sign-in stands.
 */
import { errorText } from '#lib/actions.svelte.js';
import type { ApiError } from '#lib/api/errors.js';
import { store } from '#lib/api/store.svelte.js';
import type { User } from '#lib/api/types.js';

/** The next extension after the highest user extension that is free and not an emergency number. */
export function nextFreeExtension(): string {
  const db = store.db;
  const length = db.settings.extLength;
  const taken = new Set<string>([
    ...db.users
      .filter(user => user.deletedAt === null && user.extension !== null)
      .map(user => user.extension as string),
    ...db.ringGroups
      .filter(group => group.deletedAt === null)
      .map(group => group.ext),
    ...db.parkingSlots,
    ...db.settings.emergencyNumbers
  ]);
  const first = 10 ** (length - 1);
  const last = 10 ** length - 1;
  const highest = Math.max(
    first,
    ...db.users
      .filter(user => user.deletedAt === null && user.extension !== null)
      .map(user => Number(user.extension))
  );
  for (let candidate = highest + 1; candidate <= last; candidate += 1) {
    if (!taken.has(String(candidate))) {
      return String(candidate);
    }
  }
  for (let candidate = first; candidate <= last; candidate += 1) {
    if (!taken.has(String(candidate))) {
      return String(candidate);
    }
  }
  return '';
}

/** Field errors of a refusal: the 422's own field, or `fallback` for a refusal without one. */
export function fieldErrors(
  error: ApiError,
  fallback: string
): Record<string, string> {
  const field =
    error.field === null ? fallback : (error.field.split('.')[0] ?? fallback);
  const text = errorText(error);
  // A refusal naming what blocks it ends in a colon, followed in a toast by links; inline, the
  // names follow as text.
  const refs =
    text.endsWith(':') && error.refs.length > 0
      ? ` ${error.refs.map(ref => ref.label).join(', ')}`
      : '';
  return { [field]: `${text}${refs}` };
}

export type MfaState = 'on' | 'off';

/** Whether the person has any second factor: an authenticator app or a passkey. */
export const mfaState = (user: User): MfaState =>
  user.mfa.totp || user.mfa.passkeys > 0 ? 'on' : 'off';

/** The fields of `draft` whose value differs from `base`, for a patch with only the changes. */
export function changedFields<T extends Record<string, unknown>>(
  base: T,
  draft: T
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (JSON.stringify(base[key]) !== JSON.stringify(draft[key])) {
      out[key] = draft[key];
    }
  }
  return out;
}
