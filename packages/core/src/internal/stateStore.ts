/**
 * `core`'s in-memory live state (§3, §3.1): what `GET /internal/state` serves to `api`. Live state
 * never lands in a table (§10.1); the modules that observe it write it here, or, for a reading
 * that has to be derived at the moment it is served, wire in the function that derives it.
 */
import type { Presence, StateResponse, TrunkStatus } from '@zamfono/shared';

import { liveView, type LiveEntry } from '../calls/callState.js';

/** In-memory live state (§3, `GET /internal/state`): calls, trunk registration and channels in
 * use, presence, registered devices, recording-mix failures, and what the maintenance gate asks
 * (§6.4): Asterisk's open channels and the recordings in progress. */
export class StateStore {
  /** The calls in progress, served through `liveView` (`callState.ts`). */
  readonly calls = new Map<string, LiveEntry>();
  readonly trunks = new Map<string, TrunkStatus>();
  /** Active legs per trunk id (§9.4 "Channels"), which `TrunkState` counts. */
  readonly trunkChannels = new Map<string, number>();
  readonly presence = new Map<string, Presence>();
  private registeredDevicesReading: (() => Promise<number>) | null = null;
  private recordingMixFailuresReading: (() => number) | null = null;
  private asteriskChannelsReading: (() => Promise<number>) | null = null;
  private recordingsInProgressReading: (() => number) | null = null;

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

  /** Wires the count of channels Asterisk holds, read when served; the snapshot reports `null`
   * until it is wired and whenever the reading fails, as it does while ARI is down. */
  readAsteriskChannelsFrom(reading: () => Promise<number>): void {
    this.asteriskChannelsReading = reading;
  }

  /** Wires the recorder's count of participations recording or mixing; the snapshot reports
   * zero until it is wired. */
  readRecordingsInProgressFrom(reading: () => number): void {
    this.recordingsInProgressReading = reading;
  }

  private async asteriskChannels(): Promise<number | null> {
    if (this.asteriskChannelsReading === null) {
      return null;
    }
    return this.asteriskChannelsReading().catch(() => null);
  }

  async snapshot(): Promise<StateResponse> {
    return {
      calls: [...this.calls.values()].map(liveView),
      trunks: Object.fromEntries(this.trunks),
      trunkChannels: Object.fromEntries(this.trunkChannels),
      presence: Object.fromEntries(this.presence),
      registeredDevices: (await this.registeredDevicesReading?.()) ?? 0,
      recordingMixFailures: this.recordingMixFailuresReading?.() ?? 0,
      asteriskChannels: await this.asteriskChannels(),
      recordingsInProgress: this.recordingsInProgressReading?.() ?? 0
    };
  }
}
