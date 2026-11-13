import { describe, expect, it } from 'vitest';

import { redactLog, redactSip } from './redactLog.js';

describe('redactSip', () => {
  it('replaces X-, Authorization and Proxy-Authorization values and a=crypto lines, keeping the rest', () => {
    const raw = [
      'INVITE sip:agent@ai.example SIP/2.0',
      'x-api-key : sk-live-123',
      'Authorization: Digest username="u",',
      '  response="d1g3st"',
      'X-Empty:',
      'From: <sip:101@pbx.test>;tag=1',
      'Content-Type: application/sdp',
      '',
      'v=0',
      'A=CRYPTO:1 AES_CM_128_HMAC_SHA1_80 inline:KEY',
      'a=rtpmap:0 PCMU/8000',
      ''
    ].join('\r\n');

    expect(redactSip(raw)).toBe(
      [
        'INVITE sip:agent@ai.example SIP/2.0',
        'x-api-key: ***',
        'Authorization: ***',
        'X-Empty: ***',
        'From: <sip:101@pbx.test>;tag=1',
        'Content-Type: application/sdp',
        '',
        'v=0',
        'a=crypto:***',
        'a=rtpmap:0 PCMU/8000',
        ''
      ].join('\r\n')
    );
  });
});

describe('redactLog', () => {
  it('redacts SIP lines, keeps event lines as stored and replaces a line that is no JSON object', () => {
    const event = '{"callId":"c","event":"entry"}';
    const sip = JSON.stringify({
      callId: 'c',
      at: 't',
      direction: 'in',
      raw: 'BYE sip:x SIP/2.0\nX-Token: secret\n'
    });

    expect(redactLog([event, sip, 'not json', '42'].join('\n'))).toBe(
      [
        event,
        JSON.stringify({
          callId: 'c',
          at: 't',
          direction: 'in',
          raw: 'BYE sip:x SIP/2.0\nX-Token: ***\n'
        }),
        '***',
        '***'
      ].join('\n')
    );
  });
});
