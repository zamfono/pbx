import { describe, expect, it } from 'vitest';

import { sipToHangupCause } from './releaseCause.js';

// chan_pjsip's `hangup_cause2sip()` (Asterisk 22, channels/chan_pjsip.c): the SIP final response
// each Q.850 cause goes out as; any other cause yields 0, which `ast_sip_session_terminate()`
// sends as 603.
const CHAN_PJSIP_CAUSE_TO_SIP: Readonly<Record<number, number>> = {
  1: 404,
  2: 404,
  3: 404,
  17: 486,
  18: 408,
  19: 480,
  20: 480,
  21: 403,
  22: 410,
  23: 302,
  27: 502,
  28: 484,
  29: 501,
  31: 480,
  34: 503,
  38: 500,
  42: 503,
  58: 488,
  66: 503,
  127: 500
};

function wireResponse(cause: number): number {
  return CHAN_PJSIP_CAUSE_TO_SIP[cause] ?? 603;
}

describe('sipToHangupCause', () => {
  it.each([403, 404, 408, 410, 480, 484, 486, 488, 500, 501, 502, 503, 603])(
    'sends %i out as itself through chan_pjsip',
    code => {
      expect(wireResponse(sipToHangupCause(code))).toBe(code);
    }
  );

  it('carries the Q.850 causes a Reason header should name', () => {
    expect(sipToHangupCause(403)).toBe(21);
    expect(sipToHangupCause(404)).toBe(1);
    expect(sipToHangupCause(480)).toBe(19);
    expect(sipToHangupCause(484)).toBe(28);
    expect(sipToHangupCause(486)).toBe(17);
    expect(sipToHangupCause(500)).toBe(38);
    expect(sipToHangupCause(503)).toBe(34);
    expect(sipToHangupCause(603)).toBe(16);
  });

  it('sends the codes no cause yields as their nearest neighbour', () => {
    expect(wireResponse(sipToHangupCause(600))).toBe(486);
    expect(wireResponse(sipToHangupCause(504))).toBe(500);
  });

  it('declines a code outside the table with 603', () => {
    expect(wireResponse(sipToHangupCause(409))).toBe(603);
  });
});
