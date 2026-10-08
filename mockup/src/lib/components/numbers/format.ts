/**
 * How numbers, blocks and trunks read on the numbers, trunks and routes pages.
 */
import type {
  DidBlock,
  Member,
  RouteNumber,
  TrunkHost
} from '#lib/api/types.js';
import { formatPhone } from '#lib/i18n/index.svelte.js';

/** A DID number the trunk boundary produced in the international form, `+` and digits. */
export const isNumeric = (number: string): boolean =>
  /^\+[0-9]+$/u.test(number);

/** A block as §11.3 renders it: the base, then one `x` per digit, or `*` when open-ended. */
export function blockPattern(block: Pick<DidBlock, 'base' | 'digits'>): string {
  const base = formatPhone(block.base);
  return `${base} ${block.digits === null ? '*' : 'x'.repeat(block.digits)}`;
}

/** How many numbers a fixed-digit block holds, or null for an open-ended one. */
export const blockSize = (block: Pick<DidBlock, 'digits'>): number | null =>
  block.digits === null ? null : 10 ** block.digits;

/** A host as `host[:port]`. */
export const hostLabel = (host: Pick<TrunkHost, 'host' | 'port'>): string =>
  host.port === null ? host.host : `${host.host}:${host.port}`;

/** An outbound route as the routes page edits it before `outboundRoutes.replace` saves the list. */
export type DraftRoute = {
  /** Local key; the route's id once it exists. */
  key: string;
  id?: string;
  trunkId: string;
  callerIdDidId: string | null;
  members: Member[];
  numbers: RouteNumber[];
};

/**
 * A number as typed, without the spaces and separators people write it with, when what is left is
 * digits with an optional `+`; anything else (a provider's account string) as typed.
 */
export function compactNumber(typed: string): string {
  const compact = typed.trim().replace(/[\s()/.-]/gu, '');
  return /^\+?[0-9]+$/u.test(compact) ? compact : typed.trim();
}
