/* eslint-disable no-template-curly-in-string -- a literal ${…} is what these tests send and expect back */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SIP_HEADERS,
  isCallPlaceholder,
  lineTemplateProblem,
  maxRenderedBytes,
  SIP_HEADER_NAME_PATTERN,
  SIP_HEADER_PLACEHOLDERS,
  sipHeadersSize
} from './sipHeaders.js';

// §9.4 "Header templates", §10.3 "Forward targets": the placeholders a sip target's header values
// name, and the one reading of their `{{placeholder}}` syntax api and core share.

describe('SIP_HEADER_PLACEHOLDERS', () => {
  it('names the thirteen placeholders of the spec, each with its maximum', () => {
    expect(SIP_HEADER_PLACEHOLDERS).toEqual({
      callerNumber: 32,
      callerName: 64,
      did: 16,
      calledExtension: 16,
      calledName: 64,
      forwardedByExtension: 16,
      forwardedByName: 64,
      forwardReason: 13,
      hopCount: 2,
      callId: 36,
      direction: 8,
      language: 2,
      startedAt: 24
    });
  });

  it('gives every forward reason and a call id room', () => {
    for (const reason of [
      'outOfOffice',
      'closed',
      'unconditional',
      'busy',
      'noAnswer',
      'unavailable',
      'dnd'
    ]) {
      expect(reason.length).toBeLessThanOrEqual(
        SIP_HEADER_PLACEHOLDERS.forwardReason
      );
    }
    expect('0192f3a4-5b6c-7d8e-9f01-23456789abcd').toHaveLength(
      SIP_HEADER_PLACEHOLDERS.callId
    );
    expect(new Date(0).toISOString()).toHaveLength(
      SIP_HEADER_PLACEHOLDERS.startedAt
    );
  });
});

describe('SIP_HEADER_NAME_PATTERN', () => {
  it('takes X- in any case and 1 to 64 letters, digits and dashes', () => {
    for (const name of [
      'X-Called',
      'x-a',
      'X-Zamfono-Caller',
      `X-${'a'.repeat(64)}`
    ]) {
      expect(SIP_HEADER_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of [
      'Diversion',
      'X-',
      'X_Called',
      'X-Call ed',
      'X-Ä',
      `X-${'a'.repeat(65)}`
    ]) {
      expect(SIP_HEADER_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

describe('lineTemplateProblem', () => {
  it('takes literal text, placeholders with spaces inside the braces, paths and helpers', () => {
    for (const value of [
      'ext {{calledExtension}}, {{ hopCount }}',
      '',
      'a } b }} {c}',
      '${CALLERID(num)}',
      '{{slice did -2}}',
      '{{crm.data.tier}}'
    ]) {
      expect(lineTemplateProblem(value), value).toBeNull();
    }
  });

  it('refuses a name the field does not take', () => {
    expect(lineTemplateProblem('{{caller}}', isCallPlaceholder)).toMatch(
      /unknown placeholder 'caller'/u
    );
    expect(lineTemplateProblem('{{did}}', isCallPlaceholder)).toBeNull();
  });

  it('refuses malformed braces, blocks, unknown helpers, unescaped output and control characters', () => {
    const refused = {
      '{{callerNumber': /opens no/u,
      '{{': /opens no/u,
      '{{#if did}}x{{/if}}': /block/u,
      '{{> partial}}': /block/u,
      '{{date startedAt}}': /unknown helper 'date'/u,
      '{{lookup this "did"}}': /unknown helper 'lookup'/u,
      '{{{callerNumber}}}': /unescaped/u,
      '\\{{callerNumber}}x{{': /opens no/u,
      'a\r\nVia: x': /control character/u,
      'a\tb': /control character/u,
      'a\u0085b': /control character/u
    };
    for (const [value, reason] of Object.entries(refused)) {
      expect(lineTemplateProblem(value) ?? '', value).toMatch(reason);
    }
  });
});

describe('sizes', () => {
  it('counts literal bytes of UTF-8 and each placeholder at its maximum, capped at 256', () => {
    expect(maxRenderedBytes('{{callerNumber}}')).toBe(32);
    expect(maxRenderedBytes('ü:{{did}}')).toBe(3 + 16);
    expect(maxRenderedBytes('{{callerName}}'.repeat(5))).toBe(256);
  });

  it("counts any other mustache at the value's own cap", () => {
    expect(maxRenderedBytes('{{slice did -2}}')).toBe(256);
    expect(maxRenderedBytes('{{crm.tier}}')).toBe(256);
  });

  it('sizes the default headers at name, colon and space, and value maximum', () => {
    expect(sipHeadersSize(DEFAULT_SIP_HEADERS)).toBe(16 + 2 + 32 + 13 + 2 + 16);
    expect(sipHeadersSize([])).toBe(0);
  });
});
