/* eslint-disable no-template-curly-in-string -- a literal ${…} is what these tests send and expect back */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SIP_HEADERS } from '@zamfono/shared';

import { forwardVariables } from './forwardContext.js';
import {
  cutUtf8,
  renderForwardHeaders,
  type ForwardValues
} from './forwardHeaders.js';

// §9.4 "Header templates": a sip target's headers as its forwarded leg sends them.

const VALUES: ForwardValues = {
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

describe('renderForwardHeaders', () => {
  it('renders the defaults as the fixed headers were: the caller and the DID', () => {
    expect(renderForwardHeaders(DEFAULT_SIP_HEADERS, VALUES)).toEqual([
      { name: 'X-Zamfono-Caller', value: '+15559999' },
      { name: 'X-Zamfono-Did', value: '+15551077' }
    ]);
  });

  it("leaves out a header that renders empty, as a withheld caller's number does (CLIR)", () => {
    expect(
      renderForwardHeaders(DEFAULT_SIP_HEADERS, {
        ...VALUES,
        callerNumber: '',
        did: ''
      })
    ).toEqual([]);
    expect(
      renderForwardHeaders([{ name: 'X-Who', value: ' {{callerNumber}} ' }], {
        ...VALUES,
        callerNumber: ''
      })
    ).toEqual([]);
  });

  it('substitutes placeholders into literal text, in order and repeated', () => {
    expect(
      renderForwardHeaders(
        [
          {
            name: 'X-Route',
            value:
              '{{calledName}} ({{calledExtension}}) via {{ forwardedByName }}: {{forwardReason}}/{{hopCount}}'
          },
          { name: 'X-Twice', value: '{{language}}-{{language}}' }
        ],
        VALUES
      )
    ).toEqual([
      { name: 'X-Route', value: 'Bea (177) via AI Agent: unconditional/2' },
      { name: 'X-Twice', value: 'en-en' }
    ]);
  });

  it('strips CR, LF and every other control character from a substituted value', () => {
    expect(
      renderForwardHeaders([{ name: 'X-Name', value: 'n={{callerName}}' }], {
        ...VALUES,
        callerName: 'Eve\r\nVia: SIP/2.0/UDP evil\t\u0000\u007f\u0085!'
      })
    ).toEqual([{ name: 'X-Name', value: 'n=EveVia: SIP/2.0/UDP evil!' }]);
  });

  it("cuts a value to its placeholder's maximum and the whole to 256 bytes", () => {
    const [name] = renderForwardHeaders(
      [{ name: 'X-Name', value: '{{callerName}}' }],
      { ...VALUES, callerName: 'x'.repeat(100) }
    );
    expect(name?.value).toBe('x'.repeat(64));
    const [long] = renderForwardHeaders(
      [{ name: 'X-Long', value: `${'a'.repeat(250)}{{callerName}}` }],
      VALUES
    );
    expect(long?.value).toBe(`${'a'.repeat(250)}Dana C`);
    // A cut never splits a character: 'ü' is two bytes, so 32 of them fill 64.
    const [umlaut] = renderForwardHeaders(
      [{ name: 'X-Name', value: '{{callerName}}' }],
      { ...VALUES, callerName: `a${'ü'.repeat(40)}` }
    );
    expect(umlaut?.value).toBe(`a${'ü'.repeat(31)}`);
  });

  it('passes a dialplan expression through literally, as the originate variable is set', () => {
    const headers = renderForwardHeaders(
      [
        { name: 'X-Literal', value: '${CALLERID(num)} $[1+1] {{callerNumber}}' }
      ],
      { ...VALUES, callerNumber: '${SHELL(id)}' }
    );
    expect(
      forwardVariables(
        { diversions: [], headers },
        { policy: 'all', host: 'pbx.example', format: 'e164', country: 'US' }
      )
    ).toEqual({
      'PJSIP_HEADER(add,X-Literal)': '${CALLERID(num)} $[1+1] ${SHELL(id)}'
    });
  });

  it('leaves out a header whose value api would have refused', () => {
    expect(
      renderForwardHeaders(
        [
          { name: 'X-Bad', value: '{{nope}}' },
          { name: 'X-Bad2', value: 'a\r\nb' },
          { name: 'X-Good', value: '{{did}}' }
        ],
        VALUES
      )
    ).toEqual([{ name: 'X-Good', value: '+15551077' }]);
  });
});

describe('cutUtf8', () => {
  it('keeps whole characters within the byte budget', () => {
    expect(cutUtf8('abc', 2)).toBe('ab');
    expect(cutUtf8('a€b', 3)).toBe('a');
    expect(cutUtf8('a€b', 4)).toBe('a€');
    expect(cutUtf8('😀x', 3)).toBe('');
    expect(cutUtf8('😀x', 5)).toBe('😀x');
  });
});
