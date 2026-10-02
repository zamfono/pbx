import { AST_CAUSE_NORMAL_CLEARING } from '../sipCodes.js';

/**
 * SIP release code → the Q.850 hangup cause ARI's `DELETE /channels/{id}?reason_code=` takes.
 *
 * ARI reads `reason_code` as a Q.850 cause (res/ari/resource_channels.c sets it as the channel's
 * hangup cause), and chan_pjsip turns that cause into the final response through
 * `hangup_cause2sip()` (channels/chan_pjsip.c); a cause the table does not list reaches
 * `ast_sip_session_terminate()` as 0, which answers 603. Every value below but the last two is a
 * cause that table maps to exactly the keyed SIP code, so the caller sees the code the core logs
 * and stores (§10.1).
 */
const SIP_TO_HANGUP_CAUSE: Readonly<Record<number, number>> = {
  // AST_CAUSE_CALL_REJECTED
  403: 21,
  // AST_CAUSE_UNALLOCATED
  404: 1,
  // AST_CAUSE_NO_USER_RESPONSE
  408: 18,
  // AST_CAUSE_NUMBER_CHANGED
  410: 22,
  // AST_CAUSE_NO_ANSWER
  480: 19,
  // AST_CAUSE_INVALID_NUMBER_FORMAT
  484: 28,
  // AST_CAUSE_USER_BUSY
  486: 17,
  // AST_CAUSE_BEARERCAPABILITY_NOTAVAIL
  488: 58,
  // AST_CAUSE_FAILURE
  500: 38,
  // AST_CAUSE_FACILITY_REJECTED
  501: 29,
  // AST_CAUSE_DESTINATION_OUT_OF_ORDER
  502: 27,
  // AST_CAUSE_CONGESTION
  503: 34,
  // No cause yields 504 or 600; the nearest code a cause does yield goes out instead.
  // 500: the same server-failure class
  504: 38,
  // 486: the busy condition §10.1 files 600 under
  600: 17
};

/**
 * The `reason_code` whose wire response is `sipCode`; 603 and any unlisted code go out as 603, as
 * AST_CAUSE_NORMAL_CLEARING, which `hangup_cause2sip()` leaves unmapped.
 */
export function sipToHangupCause(sipCode: number): number {
  return SIP_TO_HANGUP_CAUSE[sipCode] ?? AST_CAUSE_NORMAL_CLEARING;
}
