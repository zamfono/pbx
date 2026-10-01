/**
 * The pure half of presence (§9.3 "BLF and presence"; §10.2 "Presence and BLF"): a user's call
 * flags, registered devices and DND folded into the `Stasis:` hint and the presence status that
 * `presence.ts` publishes.
 */
import type { Presence as PresenceState } from '@zamfono/shared';

import type { DeviceState } from './ari/types.js';
import type { Snapshot } from './internal/server.js';

export type CallFlags = {
  state: 'idle' | 'ringing' | 'inCall';
  peer: string | null;
  ringGroupId: string | null;
};
export const IDLE: CallFlags = { state: 'idle', peer: null, ringGroupId: null };

export function registeredDeviceCount(
  snapshot: Snapshot,
  online: ReadonlyMap<string, boolean>,
  userId: string
): number {
  return snapshot.devices.filter(
    device =>
      device.userId === userId &&
      device.deletedAt === null &&
      online.get(device.sipUsername) === true
  ).length;
}

/** §9.3 "a user: RINGING while ... INUSE ... BUSY on DND ... UNAVAILABLE with no registered device". */
export function userHint(
  flags: CallFlags,
  dnd: boolean,
  registered: number
): DeviceState {
  if (flags.state === 'ringing') {
    return 'RINGING';
  }
  if (flags.state === 'inCall') {
    return 'INUSE';
  }
  if (dnd) {
    return 'BUSY';
  }
  return registered === 0 ? 'UNAVAILABLE' : 'NOT_INUSE';
}

/** §10.2 "Presence and BLF": available, busy, offline, dnd. */
export function userStatus(
  flags: CallFlags,
  dnd: boolean,
  registered: number
): PresenceState['status'] {
  if (flags.state !== 'idle') {
    return 'busy';
  }
  if (dnd) {
    return 'dnd';
  }
  return registered === 0 ? 'offline' : 'available';
}
