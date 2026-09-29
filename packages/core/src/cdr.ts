/**
 * Writes the durable call-history record (§10.2 "Call history"): one `calls` row, per-leg
 * `call_qos` rows at diagnostics level `qos` and above (§7), and the `history.appended` realtime
 * event (§10.6). `open()` inserts the `calls` row immediately, under the placeholder status
 * `interrupted`, so a `recordings` row can reference it (§11.2 FK) before the call itself ends; a
 * row left at `interrupted` by an unclean process exit is exactly the case `resyncOnBoot` (Task
 * 33) already reconciles. `finish()` upserts the same row with the call's real outcome.
 */
import type { Db } from '@zamfono/shared';

import type { AriClient } from './ari/client.js';
import type { Call } from './calls/call.js';
import { callEnded } from './calls/callState.js';
import { QosSnapshots } from './cdrQos.js';
import type { ConfigCache, EventBus, StateStore } from './internal/server.js';
import { SipCapture, type SipMessage } from './sipCapture.js';

export type CdrWriterDeps = {
  db: Db;
  ari: AriClient;
  cache: ConfigCache;
  bus: EventBus;
  state: StateStore;
  now: () => string;
  /** How long a `sip`-level call keeps collecting mirrored messages after it ends; tests pass 0. */
  sipTailMs?: number;
  /** How often an open call's legs are read for `call_qos` (§7 level `qos`); 0 samples only at the
   * call-ending paths. Default `QOS_SAMPLE_MS`. */
  qosSampleMs?: number;
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
 * §7 reads `rtp_statistics` "before the leg is hung up", and a destroyed channel answers nothing,
 * so an open call's legs are read every few seconds while it runs (`QosSnapshots.watch`), every
 * path that ends a call calls `captureQos` while its channels still exist, and `finish` writes the
 * last reading of each. A remote hangup reaches `captureQos` through `ChannelHangupRequest`, but
 * the channel that hung up may answer nothing by then, which is what the periodic reading covers.
 */
export class CdrWriter {
  private readonly deps: CdrWriterDeps;

  private readonly qos: QosSnapshots;

  constructor(deps: CdrWriterDeps) {
    this.deps = deps;
    this.qos = new QosSnapshots(deps.ari, deps.db, deps.qosSampleMs);
    this.sip = new SipCapture(deps.ari);
  }

  /** §7 level `sip`: the mirrored SIP messages, joined to their call by Call-ID. */
  private readonly sip: SipCapture;
  // Several paths end a call — the mailbox storing a message, a leg's own hangup, the caller's
  // channel going — and more than one runs for the same call. `history.appended` and the ended
  // `call.state` event are emitted once per call, so the first `finish` is the one that counts.
  private readonly finished = new Set<string>();

  /** Whether a Call-ID is registered; the HEP correlation's own test seam. */
  knowsCallId(callId: string): boolean {
    return this.sip.knowsCallId(callId);
  }

  /** Appends one mirrored SIP message to its call's log (§7 level `sip`). */
  sipMessage(message: SipMessage): void {
    this.sip.message(message);
  }

  /** Joins a leg's SIP dialog to `call` (§7 level `sip`: the call's SIP messages are every
   * dialog's, not the caller's alone). */
  registerLeg(call: Call, channelId: string): void {
    this.sip.register(call, channelId).catch(() => undefined);
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
    const joined = this.sip.register(call, call.callerChannelId);
    // §7 level `qos`: a leg's statistics go with its channel, so they are read while it runs.
    this.qos.watch(call);
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
      .catch(() => undefined);
  }

  /** Closes out `call`: the `calls` row (upserted, since `open()` may already have inserted its
   * placeholder), its `call_qos` rows, and the `history.appended` event. */
  async finish(call: Call): Promise<void> {
    if (this.finished.has(call.id)) {
      return;
    }
    this.finished.add(call.id);
    if (call.log.level === 'sip') {
      await new Promise(resolve => {
        setTimeout(resolve, this.deps.sipTailMs ?? SIP_TAIL_MS);
      });
    }
    this.sip.forget(call);
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

  /** Holds `call`'s `call_qos` rows, read while its channels still exist, until `finish`. */
  async captureQos(call: Call): Promise<void> {
    // A hangup request reaching a call already closed out has nothing left to add to it.
    if (this.finished.has(call.id)) {
      return;
    }
    await this.qos.capture(call);
  }
}
