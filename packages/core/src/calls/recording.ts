/**
 * Per-participation call recording (§10.2 "Call recording", "Recording semantics"): two snoop
 * channels on the recorded leg, mixed into one stereo file once the leg leaves the bridge.
 */
import path from 'node:path';

import { newId, RECORDINGS_SUBDIR, type Db } from '@zamfono/shared';

import type { AriClient } from '../ari/client.js';
import { logUnlessGone } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import type { ConfigCache } from '../internal/snapshot.js';
import {
  legParticipant,
  type Call,
  type Leg,
  type Transferee
} from './call.js';
import {
  startSnoopPair,
  waitForRecordingFinished
} from './recordingChannels.js';
import { legRecords, userRecords } from './recordingFlags.js';
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

/** A participation's snoop pair once it records; the call it names is the `Entry`'s. */
type Snoops = Omit<Participation, 'callId'>;

/** A participation from the moment its start is asked for, before any await: an end or move
 * arriving while its flags are read or its snoops start still finds it. `snoops` settles to
 * `null` when it records nothing; `key` and `callId` follow the leg's moves meanwhile. */
type Entry = { key: string; callId: string; snoops: Promise<Snoops | null> };

/** A participation is one user's in one call: a transferee's channel records in the call it
 * leaves and, from the transfer on, in the call it carries on (§10.2 "Start and end"). */
function participationKey(callId: string, channelId: string): string {
  return `${callId}:${channelId}`;
}

export class Recorder {
  private readonly deps: RecorderDeps;
  private readonly mix: Mixer;
  private readonly participations = new Map<string, Entry>();
  private mixFailures = 0;
  // Participations already out of `participations` whose snoops are still starting or whose raw
  // files are still being finished or mixed: a recording in progress all the same, until its row
  // is stored.
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
    await this.start(call.id, leg.channelId, async () =>
      legRecords(await this.deps.cache.get(), leg)
        ? { userId: legParticipant(leg) }
        : null
    );
  }

  /** Starts recording the calling party's own participation when their `record_calls` flag is
   * set (§10.2 "Internal calls": a call between two flagged users produces two recordings, one
   * per side), or when it is a transferee's trunk leg whose forward target records
   * (`Call.callerTargetRecords`). The caller is never a `Leg` — it has no routing group of its
   * own — so its flags are evaluated alone, unlike `onLegUp`'s OR-resolution with the routing
   * group. A call with no caller channel has no calling party in it to record. */
  async onCallerUp(call: Call): Promise<void> {
    if (call.callerChannelId !== null) {
      await this.startOnOwnFlags(call.id, {
        channelId: call.callerChannelId,
        userId: call.callerUserId,
        ...(call.callerTargetRecords === undefined
          ? {}
          : { targetRecords: call.callerTargetRecords })
      });
    }
  }

  /** Starts recording a transferee's participation in the call it now carries on (§10.1
   * attended transfer; §10.2 "The next participation after a transfer is evaluated on its own
   * flags"). No group routed it there, so its user flag is evaluated alone, like the caller's. */
  async onTransfereeUp(call: Call, transferee: Transferee): Promise<void> {
    await this.startOnOwnFlags(call.id, transferee);
  }

  /** Records `party` on its user's flag, its row naming them, or on its forward target's, its row
   * naming nobody (§10.2 "Recording semantics"). */
  private async startOnOwnFlags(
    callId: string,
    party: Transferee
  ): Promise<void> {
    const { userId, channelId } = party;
    await this.start(callId, channelId, async () => {
      const own =
        userId !== null && userRecords(await this.deps.cache.get(), userId);
      return own || party.targetRecords === true
        ? { userId: own ? userId : null }
        : null;
    });
  }

  /** Registers `channelId`'s participation, then starts it if `recorded` names whose it is. */
  private async start(
    callId: string,
    channelId: string,
    recorded: () => Promise<{ userId: string | null } | null>
  ): Promise<void> {
    const key = participationKey(callId, channelId);
    const snoops = recorded().then(party =>
      party === null ? null : this.startSnoops(callId, party.userId, channelId)
    );
    const entry: Entry = { key, callId, snoops: snoops.catch(() => null) };
    this.participations.set(key, entry);
    try {
      await snoops;
    } finally {
      // Nothing to record: no longer in progress. An entry ended meanwhile is `end`'s already.
      if (
        (await entry.snoops) === null &&
        this.participations.get(entry.key) === entry
      ) {
        this.participations.delete(entry.key);
      }
    }
  }

  /** Starts `channelId`'s snoop pair. Best effort (§10.2 "A snoop or mixing failure never affects
   * the call"): a pair that cannot start logs an error, leaves no half of itself behind, and the
   * call goes on unrecorded. */
  private async startSnoops(
    callId: string,
    userId: string | null,
    channelId: string
  ): Promise<Snoops | null> {
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
        { err: error, callId, channelId },
        'recording could not start; the call goes on unrecorded'
      );
      return null;
    });
    if (snoops === null) {
      return null;
    }
    const [leftChannelId, rightChannelId] = snoops;
    return {
      id,
      userId,
      leftChannelId,
      rightChannelId,
      leftPath,
      rightPath,
      outPath: path.join(dir, `${id}.wav`)
    };
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
    const entry = this.participations.get(
      participationKey(from.id, leg.channelId)
    );
    if (entry === undefined) {
      return;
    }
    this.participations.delete(entry.key);
    entry.key = participationKey(to.id, leg.channelId);
    entry.callId = to.id;
    this.participations.set(entry.key, entry);
  }

  /** The caller-side counterpart of `onLegEnded`, for a participation started by `onCallerUp`. */
  async onCallerEnded(call: Call): Promise<void> {
    if (call.callerChannelId !== null) {
      await this.end(call, call.callerChannelId);
    }
  }

  private async end(call: Call, channelId: string): Promise<void> {
    const key = participationKey(call.id, channelId);
    const entry = this.participations.get(key);
    if (entry === undefined) {
      return;
    }
    this.participations.delete(key);
    this.finishing += 1;
    try {
      // A participation still starting is finished once its snoops record.
      const snoops = await entry.snoops;
      if (snoops !== null) {
        await this.finish({ ...snoops, callId: entry.callId });
      }
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
