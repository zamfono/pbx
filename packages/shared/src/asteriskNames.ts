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
