/**
 * Writes the durable call-history record (§10.2 "Call history"): one `calls` row, per-leg
 * `call_qos` rows at diagnostics level `qos` and above (§7), and the `history.appended` realtime
 * event (§10.6). `open()` inserts the `calls` row immediately, under the placeholder status
 * `interrupted`, so a `recordings` row can reference it (§11.2 FK) before the call itself ends; a
 * row left at `interrupted` by an unclean process exit is exactly the case `resyncOnBoot`
 * reconciles. `finish()` upserts the same row with the call's real outcome.
 */
import type { Db } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import { logFailure } from './ari/failures.js';
import type { Channel, Logger } from './ari/types.js';
import { CallDialogs } from './callDialogs.js';
import type { Call } from './calls/call.js';
import { callEnded } from './calls/callState.js';
import { QosRows } from './cdrQos.js';
import type { EventBus } from './internal/eventBus.js';
import type { ConfigCache } from './internal/snapshot.js';
import type { StateStore } from './internal/stateStore.js';
import { RtcpQos } from './rtcpQos.js';

type CdrWriterDeps = {
  db: Db;
  ari: AriClient;
  cache: ConfigCache;
  bus: EventBus;
  state: StateStore;
  log: Logger;
  now: () => string;
  /** How long a `sip`-level call keeps collecting mirrored messages after it ends; tests pass 0. */
  sipTailMs?: number;
};

// §7 level `sip`: the messages that end a dialog leave after its call does. Asterisk sends a
// refused call's final response once the core has released it, and the provider's ACK follows a
// round trip later, so a call rejected at Entry within milliseconds (a DID that matches nothing)
// would record none of its own dialog. A `sip`-level call waits this long before it closes.
const SIP_TAIL_MS = 2000;

// `calls.status` has no NULL branch (CHECK enum, §11.2); a call that reaches `finish()` without
// ever picking an outcome (a bug elsewhere in the pipeline) is recorded as `failed` rather than
// crashing the write that closes it out.
const DEFAULT_STATUS = 'failed';

// The placeholder `open()` writes before the call's outcome is known; also `calls.status`'s own
// value for core-crash cleanup (§10.1), so a row never updated by `finish()` already carries it.
const PLACEHOLDER_STATUS = 'interrupted';

// One line appended to `calls.log` when `CallLog` hit its `CALL_LOG_MAX_BYTES` cap (§7 "Per-call
// diagnostics level"): the schema carries no separate truncation column, so the marker travels
// inside the JSON-lines log itself.
const TRUNCATION_MARKER = JSON.stringify({ truncated: true });

function withTruncationMarker(
  log: string | null,
  truncated: boolean
): string | null {
  if (!truncated) {
    return log;
  }
  return log === null ? TRUNCATION_MARKER : `${log}\n${TRUNCATION_MARKER}`;
}

/**
 * Writes the `calls` row, `call_qos` rows and `history.appended` event at call end (§10.2, §7,
 * §10.6).
 *
 * §7's per-leg summary is what Asterisk sets on each leg's channel as it hangs up, pushed with the
 * channel's `ChannelDestroyed` (`channelEnded`, `QosRows`): the pipeline notes a call's channels
 * (`noteQosLegs`) on every event of the call and before any path ends it, while the legs still
 * count as its own, and each leg's row is written from its own final event, before `finish` or
 * after it.
 */
export class CdrWriter {
  private readonly deps: CdrWriterDeps;

  private readonly qos: QosRows;

  /** §7: each channel's SIP dialog joined to its call and its RTCP reports to the channel. */
  readonly dialogs: CallDialogs;

  // Several paths end a call — the mailbox storing a message, a leg's own hangup, the caller's
  // channel going — and more than one runs for the same call. `history.appended` and the ended
  // `call.state` event are emitted once per call, so the first `finish` is the one that counts.
  // Weakly held: a call's entry goes with the call.
  private readonly finished = new WeakSet<Call>();

  constructor(deps: CdrWriterDeps) {
    this.deps = deps;
    const rtcp = new RtcpQos();
    this.qos = new QosRows(
      deps.db,
      deps.ari.channels,
      deps.log,
      undefined,
      rtcp
    );
    this.dialogs = new CallDialogs(deps.ari, rtcp, deps.log);
    // §7 level `qos`: a `ChannelDestroyed` sent while the connection was down never arrives.
    deps.ari.on('connected', () => {
      this.qos.resync().catch(logFailure(this.deps.log, 'qos resync'));
    });
  }

  /** Inserts `call`'s `calls` row now, under the placeholder status, so anything that references
   * `call.id` (a `recordings` or `call_qos` row, a child call's `parent_call_id`) satisfies the FK
   * while the call is still in progress. Kysely runs even a better-sqlite3 statement several
   * microtasks after `execute()` returns, so the row exists only once this resolves: every caller
   * (`inbound.ts`, `outbound.ts`, `transfers.ts`, `actions.ts`, `parkingRingback.ts`) awaits it
   * before anything that may reference the call. */
  async open(call: Call): Promise<void> {
    // At level `sip` the join is in place before routing starts: a call released at once would
    // otherwise be gone before its Call-ID is read, and its dialog would reach no call at all.
    // A call with no caller channel has its legs join as they are placed.
    const joined =
      call.callerChannelId === null
        ? Promise.resolve()
        : this.dialogs.join(call, call.callerChannelId);
    // §7 level `qos`: the caller's channel has a `call_qos` row from the start.
    this.qos.note(call);
    if (call.log.level === 'sip') {
      await joined;
    }
    await this.deps.db
      .insertInto('calls')
      .values({
        id: call.id,
        parentCallId: call.parentCallId,
        direction: call.direction,
        fromUri: call.from,
        toUri: call.to,
        didId: call.didId,
        callerUserId: call.callerUserId,
        calleeUserId: call.calleeUserId,
        ringGroupId: call.ringGroupId,
        answeredByUserId: call.answeredByUserId,
        status: PLACEHOLDER_STATUS,
        startedAt: call.startedAt,
        answeredAt: null,
        endedAt: null,
        log: null
      })
      .execute()
      .catch(
        logFailure(this.deps.log, 'calls row insert', { callId: call.id })
      );
  }

  /** Closes out `call`: the `calls` row (upserted, since `open()` may already have inserted its
   * placeholder), its `call_qos` rows, and the `history.appended` event. */
  async finish(call: Call): Promise<void> {
    if (this.finished.has(call)) {
      return;
    }
    this.finished.add(call);
    if (call.log.level === 'sip') {
      await new Promise(resolve => {
        setTimeout(resolve, this.deps.sipTailMs ?? SIP_TAIL_MS);
      });
    }
    this.dialogs.forget(call);
    callEnded(this.deps, call);
    const { log, truncated } = call.log.finish();
    const row = {
      parentCallId: call.parentCallId,
      direction: call.direction,
      fromUri: call.from,
      toUri: call.to,
      didId: call.didId,
      callerUserId: call.callerUserId,
      calleeUserId: call.calleeUserId,
      ringGroupId: call.ringGroupId,
      answeredByUserId: call.answeredByUserId,
      status: call.status ?? DEFAULT_STATUS,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: this.deps.now(),
      log: withTruncationMarker(log, truncated)
    };
    await this.deps.db
      .insertInto('calls')
      .values({ id: call.id, ...row })
      .onConflict(oc => oc.column('id').doUpdateSet(row))
      .execute();

    await this.qos.write(call);

    this.deps.bus.emit({ type: 'history.appended', callId: call.id });
  }

  /** Notes `call`'s channels as they are now, the caller's and each leg that is up, as the ones
   * its `call_qos` rows come from (§7 level `qos`). */
  noteQosLegs(call: Call): void {
    // An event reaching a call already closed out has nothing left to add to it.
    if (this.finished.has(call)) {
      return;
    }
    this.qos.note(call);
  }

  /** A channel's `ChannelDestroyed`: the `call_qos` row its `RTPAUDIOQOS` gives, for each call it
   * was noted for (§7 level `qos`). The notes are taken synchronously; the write settles later. */
  channelEnded(channel: Channel): Promise<void> {
    return this.qos.channelEnded(channel);
  }
}
