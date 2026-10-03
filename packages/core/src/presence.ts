/**
 * Presence and BLF (§9.3 "BLF and presence"; §10.2 "Presence and BLF"): per-user device
 * state (`Stasis:presence-<ext>` hints) and presence status derived from registrations (ARI
 * `ContactStatusChange`, `endpoints.list` at boot) and call state, appended to `presence_log` and
 * emitted on `/events` only on an actual status transition. `setHint` also carries the ring-group
 * and parking-slot hints of §9.3, whose ext is already known to their own callers. The hint and
 * status a user's state folds into are `presenceState.ts`'s; `presenceHints.ts` delivers the hints
 * in order.
 */
import {
  newId,
  type Db,
  type Presence as PresenceState
} from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import { isEvent, type AriEvent, type AriEventOf } from './ari/events.js';
import { logFailure } from './ari/failures.js';
import type { DeviceState, Logger } from './ari/types.js';
import { extensionOf } from './calls/extensionOwner.js';
import type { EventBus } from './internal/eventBus.js';
import {
  userById,
  type ConfigCache,
  type Snapshot
} from './internal/snapshot.js';
import type { StateStore } from './internal/stateStore.js';
import { HintPusher } from './presenceHints.js';
import {
  IDLE,
  registeredDeviceCount,
  userHint,
  userStatus,
  type CallFlags
} from './presenceState.js';

type PresenceDeps = {
  ari: AriClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  db: Db;
  log: Logger;
  now: () => string;
};

/** Per-extension `Stasis:presence-<ext>` hint (§9.3), derived from registrations and call state. */
export class Presence {
  private readonly deps: PresenceDeps;
  private readonly online = new Map<string, boolean>();
  private readonly hints: HintPusher;

  /**
   * Whether `sipUsername`'s AOR currently has a reachable contact (§9.3). The ring skips a device
   * that is not registered, and the `offline` rule of §10.1 step 4 counts the same devices, so
   * both read this one view rather than the `devices` rows, which say only that a device exists.
   */
  isRegistered(sipUsername: string): boolean {
    return this.online.get(sipUsername) === true;
  }

  /** How many live devices are registered right now (§7 "registered devices"), by the same view
   * `isRegistered` reads: a device counts while its AOR has a reachable contact, not because it
   * once registered (`devices.last_registered_at` is an event's timestamp, §3.1). */
  async registeredDevices(): Promise<number> {
    const snapshot = await this.deps.cache.get();
    return snapshot.devices.filter(device =>
      this.isRegistered(device.sipUsername)
    ).length;
  }

  /** Whether `userId` is in a call (§9.3 `INUSE`): bridged into one, or on one they placed
   * themselves, which `outbound.ts` flags from the moment it is dialled. A group's `skip_busy`
   * skips the same members this hint shows as in use (§10.1 step 5). */
  isInCall(userId: string): boolean {
    return this.effectiveFlags(userId).state === 'inCall';
  }
  // Reference-counted per call: `userId` -> (`callId` -> its own flags), so a second call ringing
  // or ending never overwrites the flags an earlier, still-live call set (§9.3, §10.2 "Presence
  // and BLF"). `effectiveFlags` folds a user's several entries into the one hint/status pair.
  private readonly callFlags = new Map<string, Map<string, CallFlags>>();

  constructor(deps: PresenceDeps) {
    this.deps = deps;
    this.hints = new HintPusher(deps.ari);
    this.deps.ari.on('event', (event: AriEvent) => {
      if (isEvent(event, 'ContactStatusChange')) {
        this.handleContactStatusChange(event).catch(
          logFailure(this.deps.log, 'presence contact status change')
        );
      }
    });
  }

  /** Seeds registration state from `endpoints.list()` and writes every live user's initial hint. */
  async resyncOnBoot(): Promise<void> {
    const endpoints = await this.deps.ari.endpoints.list();
    for (const endpoint of endpoints) {
      this.online.set(endpoint.resource, endpoint.state === 'online');
    }
    await this.refreshAll();
  }

  /** Recomputes every live user's hint and status from a fresh snapshot: at boot, and after each
   * `/internal/configChanged` (§3.1), since `api`'s writes (DND through `PUT /users/{id}/presence`,
   * a deleted device, a renumbered extension) change what they fold from (§9.3, §10.2). Only a
   * real transition reaches `presence_log` and `/events`. */
  async refreshAll(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    await Promise.all(
      snapshot.users.map(user => this.refreshUser(user.id, snapshot))
    );
  }

  private async handleContactStatusChange(
    event: AriEventOf<'ContactStatusChange'>
  ): Promise<void> {
    const info = event.contact_info;
    const snapshot = await this.deps.cache.get();
    const device = snapshot.devices.find(row => row.sipUsername === info.aor);
    if (device === undefined) {
      // Not one of ours: a trunk contact, matched instead by `TrunkState`.
      return;
    }
    const reachable = info.contact_status === 'Reachable';
    this.online.set(info.aor, reachable);
    // `last_registered_at` is when the device last became reachable (§3, §11): Asterisk publishes
    // `ContactStatusChange` only when a contact's status changes (`res_pjsip`'s OPTIONS
    // qualifier), so a REGISTER refresh of a contact already reachable raises no event to stamp.
    if (reachable) {
      await this.deps.db
        .updateTable('devices')
        .set({ lastRegisteredAt: this.deps.now() })
        .where('id', '=', device.id)
        .execute();
    }
    await this.refreshUser(device.userId, snapshot);
  }

  /** Records `userId`'s ring/bridge state for one call (§9.3): `idle` clears that call's own
   * entry rather than the user's whole state, so a call that stops ringing or ends never clears a
   * flag another, still-live call set. `refreshUser` reads the result back through
   * `effectiveFlags` to compute the hint and status. */
  setCallState(
    userId: string,
    state: CallFlags['state'],
    peer: string | null,
    ringGroupId: string | null,
    callId: string
  ): void {
    const perCall = this.callFlags.get(userId) ?? new Map<string, CallFlags>();
    if (state === 'idle') {
      perCall.delete(callId);
    } else {
      perCall.set(callId, { state, peer, ringGroupId });
    }
    if (perCall.size === 0) {
      this.callFlags.delete(userId);
    } else {
      this.callFlags.set(userId, perCall);
    }
    this.refreshUser(userId).catch(
      logFailure(this.deps.log, 'presence refresh', { userId })
    );
  }

  /** The strongest state across every call `userId` currently participates in: a bridged call
   * always wins over one still ringing, so a second call's own ring outcome never downgrades a
   * user who is already `inCall` in an earlier one (§9.3, §10.2 "Presence and BLF"). */
  private effectiveFlags(userId: string): CallFlags {
    const perCall = this.callFlags.get(userId);
    if (perCall === undefined || perCall.size === 0) {
      return IDLE;
    }
    let ringing: CallFlags | null = null;
    for (const flags of perCall.values()) {
      if (flags.state === 'inCall') {
        return flags;
      }
      ringing ??= flags;
    }
    return ringing ?? IDLE;
  }

  /** Recomputes `userId`'s hint and status; `presence_log`/`/events` fire only on a real transition. */
  async refreshUser(userId: string, snapshotArg?: Snapshot): Promise<void> {
    const snapshot = snapshotArg ?? (await this.deps.cache.get());
    const user = userById(snapshot, userId);
    if (user === null) {
      return;
    }
    const flags = this.effectiveFlags(userId);
    const registered = registeredDeviceCount(snapshot, this.online, userId);
    const dnd = user.dnd === 1;
    const ext = extensionOf(snapshot, { userId });
    if (ext !== null) {
      await this.hints.push(ext, userHint(flags, dnd, registered));
    }
    await this.writeStatus(userId, userStatus(flags, dnd, registered), flags);
  }

  private async writeStatus(
    userId: string,
    status: PresenceState['status'],
    flags: CallFlags
  ): Promise<void> {
    const previous = this.deps.state.presence.get(userId);
    if (
      previous?.status === status &&
      previous.peer === flags.peer &&
      previous.ringGroupId === flags.ringGroupId
    ) {
      return;
    }
    const since = this.deps.now();
    this.deps.state.presence.set(userId, {
      status,
      peer: flags.peer,
      ringGroupId: flags.ringGroupId,
      since
    });
    await this.deps.db
      .insertInto('presenceLog')
      .values({
        id: newId(),
        userId,
        status,
        peer: flags.peer,
        ringGroupId: flags.ringGroupId,
        since
      })
      .execute();
    this.deps.bus.emit({
      type: 'presence',
      userId,
      status,
      peer: flags.peer,
      ringGroupId: flags.ringGroupId
    });
  }

  /** A ring group's or a parking slot's own hint (§9.3), keyed by their extension directly. */
  async setHint(ext: string, state: DeviceState): Promise<void> {
    await this.hints.push(ext, state);
  }
}
