/**
 * Whether the page in view exists only in Expert mode, set by the shell. Such a page marks nothing
 * inside it as Expert: all of it is.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('expertPage');

export function setExpertPage(get: () => boolean): void {
  setContext(KEY, get);
}

/** A reader of the flag; call during component initialisation. */
export function expertPage(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
