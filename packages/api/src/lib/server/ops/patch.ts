/** `value` where given, `before` otherwise: the resolved next value of an optional patch field,
 * distinguishing an absent key from an explicit `null`. */
export function orBefore<T>(value: T | undefined, before: T): T {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `??` would also replace an explicit `null` (a meaningful patch value), not just an absent key
  return value === undefined ? before : value;
}
