/**
 * `core`'s in-memory live state (§3, §3.1), served to `api` by `GET /internal/state`. Live state
 * never lands in a table (§10.1); the modules that observe it write it here.
 */
import type { Presence, StateResponse, TrunkStatus } from '@zamfono/shared';

import { liveView, type LiveEntry } from '../calls/callState.js';

/** The part of `GET /internal/state` held in memory: the readings derived when it is served
 * (registered devices, recording-mix failures, Asterisk's channels, recordings in progress) are
 * `internal/server.ts`'s. */
type StoredState = Pick<
  StateResponse,
  'calls' | 'trunks' | 'trunkChannels' | 'presence'
>;

/** In-memory live state (§3, `GET /internal/state`): calls, trunk registration and channels in
 * use, and presence. */
export class StateStore {
  /** The calls in progress, served through `liveView` (`callState.ts`). */
  readonly calls = new Map<string, LiveEntry>();
  readonly trunks = new Map<string, TrunkStatus>();
  /** Active legs per trunk id (§9.4 "Channels"), which `TrunkState` counts. */
  readonly trunkChannels = new Map<string, number>();
  readonly presence = new Map<string, Presence>();

  /** The state held here; `/internal/state` adds the readings derived when it is served. */
  snapshot(): StoredState {
    return {
      calls: [...this.calls.values()].map(liveView),
      trunks: Object.fromEntries(this.trunks),
      trunkChannels: Object.fromEntries(this.trunkChannels),
      presence: Object.fromEntries(this.presence)
    };
  }
}
