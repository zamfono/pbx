/**
 * Hint delivery for presence (§9.3 "BLF and presence"): every `Stasis:presence-<ext>` and
 * `Stasis:dnd-<ext>` PUT goes through here, one at a time per device state. Each REST call may travel on its own HTTP connection, so
 * two PUTs sent back to back can reach Asterisk in either order and leave a stale hint showing;
 * holding the next state until the previous PUT has answered keeps the last computed one last.
 */
import { dndHintDevice, presenceHintDevice } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import { logFailure } from './ari/failures.js';
import type { DeviceState } from './ari/types.js';

export class HintPusher {
  private readonly ari: AriClient;
  // Per device state: the state computed since the PUT in flight left, which only a newer one
  // overwrites.
  private readonly pending = new Map<string, DeviceState>();
  // Per device state: the drain running for it, which every `push` made while it runs shares.
  private readonly draining = new Map<string, Promise<void>>();

  constructor(ari: AriClient) {
    this.ari = ari;
  }

  /** Sets `ext`'s hint to `state`, resolving once it (or a newer state after it) is written. A
   * failed PUT is logged and dropped: the next refresh writes the hint again. */
  push(ext: string, state: DeviceState): Promise<void> {
    return this.pushDevice(presenceHintDevice(ext), state);
  }

  /** Sets user `ext`'s DND hint: `BUSY` while DND is on, else `NOT_INUSE`. */
  pushDnd(ext: string, dnd: boolean): Promise<void> {
    return this.pushDevice(dndHintDevice(ext), dnd ? 'BUSY' : 'NOT_INUSE');
  }

  private pushDevice(device: string, state: DeviceState): Promise<void> {
    this.pending.set(device, state);
    const running = this.draining.get(device);
    if (running !== undefined) {
      return running;
    }
    const drain = this.drain(device);
    this.draining.set(device, drain);
    return drain;
  }

  private async drain(device: string): Promise<void> {
    let state = this.pending.get(device);
    while (state !== undefined) {
      this.pending.delete(device);
      // eslint-disable-next-line no-await-in-loop -- one PUT at a time per device state is the point
      await this.ari.deviceStates
        .put(device, state)
        .catch(logFailure(this.ari.log, 'presence hint update', { device }));
      state = this.pending.get(device);
    }
    // In the same tick as the last `pending` check, so no `push` can join a drain that is over.
    this.draining.delete(device);
  }
}
