/* eslint-disable no-template-curly-in-string -- a literal ${…} is what this test sends and expects back */
import { describe, expect, it } from 'vitest';

import { renderSipHeaders, type CallValues } from '@zamfono/shared';

import { forwardVariables } from './forwardLeg.js';

// §9.4 "Header templates": a sip target's rendered headers as its forwarded leg's originate
// variables; the rendering itself is `@zamfono/shared`'s (`sipHeaderRender.test.ts`).

const VALUES: CallValues = {
  callerNumber: '+15559999',
  callerName: 'Dana Caller',
  did: '+15551077',
  calledExtension: '177',
  calledName: 'Bea',
  forwardedByExtension: '178',
  forwardedByName: 'AI Agent',
  forwardReason: 'unconditional',
  hopCount: '2',
  callId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  direction: 'inbound',
  language: 'en',
  startedAt: '2026-09-30T12:00:00.000Z'
};

describe('headerVariables', () => {
  it('passes a dialplan expression through literally, as the originate variable is set', () => {
    const headers = renderSipHeaders(
      [
        { name: 'X-Literal', value: '${CALLERID(num)} $[1+1] {{callerNumber}}' }
      ],
      { ...VALUES, callerNumber: '${SHELL(id)}' }
    );
    expect(
      forwardVariables(
        { diversions: [], headers },
        { policy: 'all', host: 'pbx.example', format: 'e164', country: 'US' },
        null
      )
    ).toEqual({
      'PJSIP_HEADER(add,X-Literal)': '${CALLERID(num)} $[1+1] ${SHELL(id)}'
    });
  });
});
