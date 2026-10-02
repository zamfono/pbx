/**
 * Hint delivery for presence (§9.3 "BLF and presence"): every `Stasis:presence-<ext>` PUT goes
 * through here, one at a time per ext. Each REST call may travel on its own HTTP connection, so
 * two PUTs sent back to back can reach Asterisk in either order and leave a stale hint showing;
 * holding the next state until the previous PUT has answered keeps the last computed one last.
 */
import { presenceHintDevice } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import { logFailure } from './ari/failures.js';
import type { DeviceState } from './ari/types.js';

export class HintPusher {
  private readonly ari: AriClient;
  // Per ext: the state computed since the PUT in flight left, which only a newer one overwrites.
  private readonly pending = new Map<string, DeviceState>();
  // Per ext: the drain running for it, which every `push` made while it runs shares.
  private readonly draining = new Map<string, Promise<void>>();

  constructor(ari: AriClient) {
    this.ari = ari;
  }

  /** Sets `ext`'s hint to `state`, resolving once it (or a newer state after it) is written. A
   * failed PUT is logged and dropped: the next refresh writes the hint again. */
  push(ext: string, state: DeviceState): Promise<void> {
    this.pending.set(ext, state);
    const running = this.draining.get(ext);
    if (running !== undefined) {
      return running;
    }
    const drain = this.drain(ext);
    this.draining.set(ext, drain);
    return drain;
  }

  private async drain(ext: string): Promise<void> {
    let state = this.pending.get(ext);
    while (state !== undefined) {
      this.pending.delete(ext);
      // eslint-disable-next-line no-await-in-loop -- one PUT at a time per ext is the point
      await this.ari.deviceStates
        .put(presenceHintDevice(ext), state)
        .catch(logFailure(this.ari.log, 'presence hint update', { ext }));
      state = this.pending.get(ext);
    }
    // In the same tick as the last `pending` check, so no `push` can join a drain that is over.
    this.draining.delete(ext);
  }
}
