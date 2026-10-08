/**
 * Whether the content in view is Expert as a whole: a page that exists only in Expert mode (set by
 * the shell) or an Expert card (`Card`). Nothing inside such a scope is marked Expert again.
 */
import { getContext, setContext } from 'svelte';

const KEY = Symbol('expertScope');

export function setExpertScope(get: () => boolean): void {
  setContext(KEY, get);
}

/** A reader of the flag; call during component initialisation. */
export function expertScope(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
