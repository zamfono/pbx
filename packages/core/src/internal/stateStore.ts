/**
 * `core`'s in-memory live state (§3, §3.1): what `GET /internal/state` serves to `api`. Live state
 * never lands in a table (§10.1); the modules that observe it write it here, or, for a reading
 * that has to be derived at the moment it is served, wire in the function that derives it.
 * `server.ts` re-exports `StateStore` as part of its public API.
 */
import type {
  LiveCall,
  Presence,
  StateResponse,
  TrunkStatus
} from '@zamfono/shared';

/** In-memory live state (§3, `GET /internal/state`): calls, trunk registration and channels in
 * use, presence, registered devices, recording-mix failures. */
export class StateStore {
  readonly calls = new Map<string, LiveCall>();
  readonly trunks = new Map<string, TrunkStatus>();
  /** Active legs per trunk id (§9.4 "Channels"), which `TrunkState` counts. */
  readonly trunkChannels = new Map<string, number>();
  readonly presence = new Map<string, Presence>();
  private registeredDevicesReading: (() => Promise<number>) | null = null;
  private recordingMixFailuresReading: (() => number) | null = null;

  /**
   * Wires the count of live devices registered right now, `Presence.registeredDevices`: counted
   * against the current config when served, so a device deleted while registered drops out at
   * once. The snapshot reports zero until it is wired.
   */
  readRegisteredDevicesFrom(reading: () => Promise<number>): void {
    this.registeredDevicesReading = reading;
  }

  /** Wires the recorder's count of failed mixes (§10.2 "Best effort": "visible in /metrics");
   * the snapshot reports zero until it is wired. */
  readRecordingMixFailuresFrom(reading: () => number): void {
    this.recordingMixFailuresReading = reading;
  }

  async snapshot(): Promise<StateResponse> {
    return {
      calls: [...this.calls.values()],
      trunks: Object.fromEntries(this.trunks),
      trunkChannels: Object.fromEntries(this.trunkChannels),
      presence: Object.fromEntries(this.presence),
      registeredDevices: (await this.registeredDevicesReading?.()) ?? 0,
      recordingMixFailures: this.recordingMixFailuresReading?.() ?? 0
    };
  }
}
