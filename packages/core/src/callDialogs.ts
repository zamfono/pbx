/**
 * §7: the joining of each channel's SIP dialog, by its Call-ID, to the call it is part of, for the
 * SIP messages Asterisk mirrors (level `sip`, `sipCapture.ts`), and to the channel, for its RTCP
 * reports (level `qos`, `rtcpQos.ts`). `cdr.ts`'s `CdrWriter` joins a call's caller as it opens and
 * forgets the call as it closes; the pipeline joins each leg as it is placed.
 */
import type { AriClient } from './ari/client.js';
import { logFailure } from './ari/failures.js';
import type { Logger } from './ari/types.js';
import type { Call } from './calls/call.js';
import type { RtcpQos } from './rtcpQos.js';
import type { RtcpHepReport } from './rtcpReport.js';
import { SipCapture, type SipMessage } from './sipCapture.js';

export class CallDialogs {
  private readonly sip: SipCapture;
  private readonly rtcp: RtcpQos;
  private readonly log: Logger;

  constructor(ari: AriClient, rtcp: RtcpQos, log: Logger) {
    this.sip = new SipCapture(ari);
    this.rtcp = rtcp;
    this.log = log;
  }

  /** Appends one mirrored SIP message to its call's log (§7 level `sip`). */
  sipMessage(message: SipMessage): void {
    this.sip.message(message);
  }

  /** One RTCP report Asterisk mirrored, for its leg's `call_qos` row (§7 level `qos`). */
  rtcpReport(report: RtcpHepReport): void {
    this.rtcp.report(report);
  }

  /** Joins a leg's SIP dialog to `call` (§7 level `sip`: the call's SIP messages are every
   * dialog's, not the caller's alone). */
  registerLeg(call: Call, channelId: string): void {
    this.join(call, channelId).catch(
      logFailure(this.log, 'SIP dialog join', {
        callId: call.id,
        channelId
      })
    );
  }

  /** `registerLeg`, resolving once the join is in place or has failed: a leg created but not yet
   * dialled (`legOriginate.ts`) joins before its INVITE leaves, and a call's caller as it opens
   * (`cdr.ts`). */
  joinLeg(call: Call, channelId: string): Promise<void> {
    return this.join(call, channelId).catch(
      logFailure(this.log, 'SIP dialog join', {
        callId: call.id,
        channelId
      })
    );
  }

  /** Joins `channelId`'s Call-ID to `call` for its SIP messages, and to the channel for its RTCP
   * reports. */
  private async join(call: Call, channelId: string): Promise<void> {
    const sipCallId = await this.sip.register(call, channelId);
    if (sipCallId !== null) {
      this.rtcp.join(channelId, sipCallId);
    }
  }

  /** Drops every Call-ID joined to `call`, once it has closed. */
  forget(call: Call): void {
    this.sip.forget(call);
  }
}
