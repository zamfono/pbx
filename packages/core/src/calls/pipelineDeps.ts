// What a `Pipeline` is built from: the collaborators and settings the call modules reach through
// `pipeline.deps`.
import type { Db } from '@zamfono/shared';

import type { AmiClient } from '../ami/client.js';
import type { AriClient } from '../ari/client.js';
import type { Channel, Logger } from '../ari/types.js';
import type { EventBus } from '../internal/eventBus.js';
import type { ConfigCache } from '../internal/snapshot.js';
import type { StateStore } from '../internal/stateStore.js';
import type { Presence } from '../presence.js';
import type { Call } from './call.js';
import type { ParticipationRecorder } from './recordParticipation.js';
import type { TrunkChannels } from './trunkChannels.js';
import type { MailSender } from './voicemail.js';

export type PipelineDeps = {
  ari: AriClient;
  // The part of `AmiClient` the pipeline uses (`userDevices.ts`'s contact reads), typed
  // structurally so a test can stand in for it.
  ami: Pick<AmiClient, 'action'>;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  // The part of `CdrWriter` the pipeline uses, typed structurally so a test can stand in for it.
  cdr: {
    open(call: Call): Promise<void>;
    finish(call: Call): Promise<void>;
    /** §7 level `qos`: notes the call's channels as the ones its `call_qos` rows come from. */
    noteQosLegs(call: Call): void;
    /** §7 level `qos`: a channel's `ChannelDestroyed`, carrying its `RTPAUDIOQOS`. */
    channelEnded(channel: Channel): Promise<void>;
    /** §7: joins a leg's SIP dialog to its call (`callDialogs.ts`). */
    dialogs: {
      registerLeg(call: Call, channelId: string): void;
      /** `registerLeg`, resolving once the join is in place (`legOriginate.ts`). */
      joinLeg(call: Call, channelId: string): Promise<void>;
    };
  };
  // §10.2 "Call recording": the answer and end points below hand every participation to the
  // recorder, which decides per participation whether the effective flag is set.
  recorder: ParticipationRecorder;
  now: () => string;
  // The stack's `TZ` (§11.4 `timezone`: "NULL = stack `TZ`, else UTC"), `CoreEnv.tz`.
  stackTz: string;
  // The stack's FQDN (`CoreEnv.fqdn`), the `From` host of a trunk leg not on a `pai` trunk and the
  // host a forwarded leg's `Diversion` entries name (§9.4 "Caller-ID", "Forwarded calls").
  stackFqdn: string;
  /** How long a created leg may take to enter the app before it counts as not placed
   * (`legOriginate.ts`), `STASIS_WAIT_MS`. */
  legStasisWaitMs: number;
  /** `CALL_LOG_MAX_BYTES` (§7), `CoreEnv.callLogMaxBytes`: each new call's log cap. */
  callLogMaxBytes: number;
  /** `core`'s own mount of the media volume, `CoreEnv.mediaDir` (§11.6). */
  mediaDir: string;
  // Voicemail deposit's own collaborators (§3.1).
  db: Db;
  apiClient: MailSender;
  // Process-level logging (§10.1 "Emergency calls": an ERROR line while no live emergency trunk
  // exists).
  logger: Logger;
  // `addParty.ts`'s `addParty` reaches `outboundExternal.ts`'s `originateExternalLeg` through
  // `trunkChannels` for an external `*5` target, and the ring/answer/end call sites in
  // `outbound.ts`, `legs.ts`, `legsEnded.ts`, `ringGroup.ts` and `ringGroupDial.ts` call
  // `presence.setCallState` (§10.2 "Presence and BLF", "Three-way calls").
  trunkChannels: TrunkChannels;
  presence: Presence;
};
