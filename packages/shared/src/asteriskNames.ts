/**
 * The Asterisk object names `api` renders into the generated config (§10.2) and core addresses
 * at runtime, defined once so the two processes cannot drift apart.
 */

/** The prefix of every trunk's own PJSIP section name, which no other section may start with. */
export const TRUNK_SECTION_PREFIX = 'trunk-';

/** The trunk's PJSIP section name; the core dials `PJSIP/<number>@trunk-<id>` (§9.4 "Flows"). */
export function trunkSectionName(trunkId: string): string {
  return `${TRUNK_SECTION_PREFIX}${trunkId}`;
}

/** The custom device state an extension's hint watches, `Stasis:presence-<ext>` (§9.3 "BLF and presence"). */
export function presenceHintDevice(ext: string): string {
  return `Stasis:presence-${ext}`;
}

/** The custom device state the hint of the mailbox owned by extension `ext` watches,
 * `Stasis:mwi-<ext>`: `BUSY` while the mailbox holds new messages (§9.3 "BLF and presence"). */
export function mwiHintDevice(ext: string): string {
  return `Stasis:mwi-${ext}`;
}

/** The custom device state a user's DND hint watches, `Stasis:dnd-<ext>`: `BUSY` while DND is on
 * (§9.3 "BLF and presence"). */
export function dndHintDevice(ext: string): string {
  return `Stasis:dnd-${ext}`;
}
