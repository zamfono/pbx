/**
 * A user's devices as the ring steps see them (§10.1 steps 4 and 5): which of them are
 * registered, and whether the user is already in a call. Shared by the user step, its ring race
 * and the ring group's member states and originate step.
 */
import type { Snapshot } from '../internal/snapshot.js';
import type { Call } from './call.js';
import type { Pipeline } from './pipeline.js';

/** §10.1 step 5 "already in a call": presence's own in-call view (§9.3 `INUSE`), which counts a
 * call the member placed as well as one they answered; without presence (tests), any of the
 * member's legs bridged in. */
export function isUserInCall(pipeline: Pipeline, userId: string): boolean {
  if (pipeline.deps.presence?.isInCall(userId) === true) {
    return true;
  }
  const seen = new Set<Call>();
  for (const call of pipeline.callByChannel.values()) {
    if (seen.has(call)) {
      continue;
    }
    seen.add(call);
    for (const leg of call.legs.values()) {
      if (leg.userId === userId && leg.state === 'up') {
        return true;
      }
    }
  }
  return false;
}

/** `userId`'s devices that can ring (§10.1 steps 4 and 5 "offline"; §10.2 "Click-to-dial"
 * `noRegisteredDevice` and pickup): live rows whose AOR is registered. Registration is the AOR's
 * own reachability, which `Presence` tracks from `ContactStatusChange` and the boot endpoint list,
 * not the user's presence status: a user on DND is not thereby unreachable. Without presence
 * (tests) every live device counts, as `ringUser` treats them (§10.1 step 4). */
export function registeredDevices(
  pipeline: Pipeline,
  snapshot: Snapshot,
  userId: string
): Snapshot['devices'] {
  const { presence } = pipeline.deps;
  return snapshot.devices.filter(
    device =>
      device.userId === userId &&
      device.deletedAt === null &&
      (presence === null || presence.isRegistered(device.sipUsername))
  );
}

// Asterisk names a PJSIP channel `PJSIP/<endpoint>-<8 hex digits>`, the endpoint being the device's
// SIP username (§9.3 "Naming").
const CHANNEL_SEQUENCE_SUFFIX = /-[0-9a-f]{8}$/u;

/** The SIP usernames of the devices carrying a call right now: every `PJSIP/` channel that is up,
 * whether the device placed the call or answered it. */
export async function busyDevices(pipeline: Pipeline): Promise<Set<string>> {
  const channels = await pipeline.deps.ari.channels.list().catch(() => []);
  const busy = new Set<string>();
  for (const channel of channels) {
    if (channel.state === 'Up' && channel.name.startsWith('PJSIP/')) {
      busy.add(
        channel.name.slice('PJSIP/'.length).replace(CHANNEL_SEQUENCE_SUFFIX, '')
      );
    }
  }
  return busy;
}

/** The devices a ring reaches (§10.1 steps 4 and 5): `userId`'s registered devices, and for a user
 * already in a call only "their other devices, as call waiting", never the one carrying it. */
export async function devicesToRing(
  pipeline: Pipeline,
  snapshot: Snapshot,
  userId: string
): Promise<Snapshot['devices']> {
  const devices = registeredDevices(pipeline, snapshot, userId);
  if (devices.length === 0 || !isUserInCall(pipeline, userId)) {
    return devices;
  }
  const busy = await busyDevices(pipeline);
  return devices.filter(device => !busy.has(device.sipUsername));
}
