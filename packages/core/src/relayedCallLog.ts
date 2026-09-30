import { CallLog } from './callLog.js';

/**
 * The trace of a call that is never written itself, such as an API pickup's ring on the picker's
 * own phones (`actions.ts`): each routing-trace line lands in `into`, the log of the call that is
 * written, as one `relayAs` line whose `step` names the original event, so that call's history
 * explains what the ring did (which devices rang, which declined or failed to be placed) without
 * any of it reading as the call's own answer or decline. SIP messages are not relayed: the ring's
 * dialogs already join the written call's SIP capture on their own.
 */
export class RelayedCallLog extends CallLog {
  readonly #into: CallLog;
  readonly #relayAs: string;

  constructor(
    callId: string,
    into: CallLog,
    relayAs: string,
    maxBytes: number
  ) {
    super(callId, into.level, maxBytes);
    this.#into = into;
    this.#relayAs = relayAs;
  }

  override event(line: Record<string, unknown>): void {
    const { event: step, ...rest } = line;
    this.#into.event({ event: this.#relayAs, step, ...rest });
  }
}
