/**
 * Per-participation call recording (§10.2 "Call recording", "Recording semantics"): two snoop
 * channels on the recorded leg, mixed into one stereo file once the leg leaves the bridge.
 */
import path from 'node:path';

import { newId, RECORDINGS_SUBDIR, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logUnlessGone } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import {
  userById,
  type ConfigCache,
  type Snapshot
} from '../internal/snapshot.js';
import type { Call, Leg } from './call.js';
import {
  startSnoopPair,
  waitForRecordingFinished
} from './recordingChannels.js';
import { ffmpegMix, type Mixer } from './recordingMix.js';
import { recordFormatFor } from './recordingRate.js';
import { storeParticipation } from './recordingStore.js';

type RecorderDeps = {
  ari: AriClient;
  cache: ConfigCache;
  db: Db;
  mediaDir: string;
  mix?: Mixer;
  log: Logger;
  now: () => string;
};

type Participation = {
  id: string;
  callId: string;
  userId: string | null;
  leftChannelId: string;
  rightChannelId: string;
  leftPath: string;
  rightPath: string;
  outPath: string;
};

/** The OR-resolution of §10.2 "Recording semantics": the participant's own flag, or the flag of
 * the ring group that routed this participation. A participation outside a group is governed by
 * the user flag alone, and a leg with no user behind it, such as an outbound call's trunk leg, is
 * no user's participation at all ("A recording captures one user's participation"). */
function recordingEnabled(snapshot: Snapshot, call: Call, leg: Leg): boolean {
  if (leg.userId === null) {
    return false;
  }
  const user = userById(snapshot, leg.userId);
  const group =
    call.ringGroupId === null
      ? undefined
      : snapshot.ringGroups.find(row => row.id === call.ringGroupId);
  return user?.recordCalls === 1 || group?.recordCalls === 1;
}

/** A participation is one user's in one call: a transferee's channel records in the call it
 * leaves and, from the transfer on, in the call it carries on (§10.2 "Start and end"). */
function participationKey(callId: string, channelId: string): string {
  return `${callId}:${channelId}`;
}

export class Recorder {
  private readonly deps: RecorderDeps;
  private readonly mix: Mixer;
  private readonly participations = new Map<string, Participation>();
  private mixFailures = 0;
  // Participations already out of `participations` whose raw files are still being finished or
  // mixed: a recording in progress all the same, until its row is stored.
  private finishing = 0;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    this.mix = deps.mix ?? ffmpegMix;
  }

  /** Mixes failed since construction (§7 "Metrics" `zamfono_recording_mix_failures_total`). */
  get mixFailureCount(): number {
    return this.mixFailures;
  }

  /** Participations being recorded or still being mixed (§6.4 "Maintenance gate"). */
  get inProgressCount(): number {
    return this.participations.size + this.finishing;
  }

  /** Starts recording `leg`'s participation when the effective flag (§10.2) is set, at answer;
   * never for an unanswered call, a voicemail deposit or a feature-code service call, none of
   * which ever reach `onLegUp`. */
  async onLegUp(call: Call, leg: Leg): Promise<void> {
    const snapshot = await this.deps.cache.get();
    if (!recordingEnabled(snapshot, call, leg)) {
      return;
    }
    await this.start(call.id, leg.userId, leg.channelId);
  }

  /** Starts recording the calling party's own participation when their `record_calls` flag is
   * set (§10.2 "Internal calls": a call between two flagged users produces two recordings, one
   * per side). The caller is never a `Leg` — it has no routing group of its own — so its flag is
   * evaluated alone, unlike `onLegUp`'s OR-resolution with the routing group. A call with no
   * caller channel has no calling party in it to record. */
  async onCallerUp(call: Call): Promise<void> {
    if (call.callerChannelId !== null) {
      await this.startOnOwnFlag(
        call.id,
        call.callerUserId,
        call.callerChannelId
      );
    }
  }

  /** Starts recording a transferee's participation in the call it now carries on (§10.1
   * attended transfer; §10.2 "The next participation after a transfer is evaluated on its own
   * flags"). No group routed it there, so its user flag is evaluated alone, like the caller's. */
  async onTransfereeUp(
    call: Call,
    transferee: { channelId: string; userId: string | null }
  ): Promise<void> {
    await this.startOnOwnFlag(call.id, transferee.userId, transferee.channelId);
  }

  private async startOnOwnFlag(
    callId: string,
    userId: string | null,
    channelId: string
  ): Promise<void> {
    if (userId === null) {
      return;
    }
    const snapshot = await this.deps.cache.get();
    const user = userById(snapshot, userId);
    if (user?.recordCalls !== 1) {
      return;
    }
    await this.start(callId, userId, channelId);
  }

  /** Starts `channelId`'s snoop pair. Best effort (§10.2 "A snoop or mixing failure never affects
   * the call"): a pair that cannot start logs an error, leaves no half of itself behind, and the
   * call goes on unrecorded. */
  private async start(
    callId: string,
    userId: string | null,
    channelId: string
  ): Promise<void> {
    const id = newId();
    // §11.6: the raw per-leg pair and the mixed output live in `media/recordings/`. The name given
    // to ARI is relative to Asterisk's recording directory, which the asterisk image resolves to
    // the shared media volume, so the same relative prefix names the file on both sides.
    const dir = path.join(this.deps.mediaDir, RECORDINGS_SUBDIR);
    // Asterisk names the raw file after its format: `<id>-l.wav` at 8 kHz, `<id>-l.wav16` at 16.
    const format = await recordFormatFor(
      this.deps.ari,
      channelId,
      this.deps.log
    );
    const leftPath = path.join(dir, `${id}-l.${format}`);
    const rightPath = path.join(dir, `${id}-r.${format}`);
    const snoops = await startSnoopPair(this.deps.ari, channelId, {
      left: { name: `${RECORDINGS_SUBDIR}/${id}-l`, file: leftPath },
      right: { name: `${RECORDINGS_SUBDIR}/${id}-r`, file: rightPath },
      format
    }).catch((error: unknown) => {
      this.deps.log.error(
        { error, callId, channelId },
        'recording could not start; the call goes on unrecorded'
      );
      return null;
    });
    if (snoops === null) {
      return;
    }
    const [leftChannelId, rightChannelId] = snoops;
    this.participations.set(participationKey(callId, channelId), {
      id,
      callId,
      userId,
      leftChannelId,
      rightChannelId,
      leftPath,
      rightPath,
      outPath: path.join(dir, `${id}.wav`)
    });
  }

  /** Ends `leg`'s recording, mixes its two raw files, and inserts the `recordings` row; a mix
   * failure keeps the raw files for manual salvage and never touches the call itself. */
  async onLegEnded(call: Call, leg: Leg): Promise<void> {
    await this.end(call, leg.channelId);
  }

  /** Carries `leg`'s participation over from `from` to `to`, the call its channel is in from
   * here on (a parking ring-back's answer, §10.2 "Call parking"): it goes on recording, and its
   * row names `to`. */
  onLegMoved(from: Call, to: Call, leg: Leg): void {
    const key = participationKey(from.id, leg.channelId);
    const participation = this.participations.get(key);
    if (participation === undefined) {
      return;
    }
    this.participations.delete(key);
    this.participations.set(participationKey(to.id, leg.channelId), {
      ...participation,
      callId: to.id
    });
  }

  /** The caller-side counterpart of `onLegEnded`, for a participation started by `onCallerUp`. */
  async onCallerEnded(call: Call): Promise<void> {
    if (call.callerChannelId !== null) {
      await this.end(call, call.callerChannelId);
    }
  }

  private async end(call: Call, channelId: string): Promise<void> {
    const key = participationKey(call.id, channelId);
    const participation = this.participations.get(key);
    if (participation === undefined) {
      return;
    }
    this.participations.delete(key);
    this.finishing += 1;
    try {
      await this.finish(participation);
    } finally {
      this.finishing -= 1;
    }
  }

  private async finish(participation: Participation): Promise<void> {
    // Registered before the hangup that stops the recordings, so neither `RecordingFinished`
    // event can fire (and be missed) before this module is listening for it.
    const leftFinished = waitForRecordingFinished(
      this.deps.ari,
      `${RECORDINGS_SUBDIR}/${participation.id}-l`
    );
    const rightFinished = waitForRecordingFinished(
      this.deps.ari,
      `${RECORDINGS_SUBDIR}/${participation.id}-r`
    );
    await Promise.all([
      this.deps.ari.channels.hangup(participation.leftChannelId).catch(
        logUnlessGone(this.deps.log, 'snoop hangup', {
          participationId: participation.id
        })
      ),
      this.deps.ari.channels.hangup(participation.rightChannelId).catch(
        logUnlessGone(this.deps.log, 'snoop hangup', {
          participationId: participation.id
        })
      )
    ]);
    await Promise.all([leftFinished, rightFinished]);
    const stored = await storeParticipation(
      {
        db: this.deps.db,
        mix: this.mix,
        log: this.deps.log,
        now: this.deps.now
      },
      participation
    );
    if (!stored) {
      this.mixFailures += 1;
    }
  }
}
