import { describe, expect, it } from 'vitest';

import {
  renderTargetField,
  targetFieldProblem,
  templateSample,
  urlTemplateProblem
} from './targetFields.js';

// §9.4 "Templates", §10.3 "Forward targets": the target fields that take a template.

const VALUES = { did: '+4312345617', callerNumber: '+43 660 1', evil: 'a@b/c' };

describe('renderTargetField', () => {
  it('renders an external number and takes only E.164', () => {
    expect(
      renderTargetField('external', '+431999{{slice did -2}}', VALUES)
    ).toEqual({ ok: true, value: '+43199917' });
    expect(renderTargetField('external', '{{evil}}', VALUES)).toEqual({
      ok: false,
      value: 'a@b/c'
    });
    expect(renderTargetField('external', '{{missing}}', VALUES)).toEqual({
      ok: false,
      value: ''
    });
  });

  it("escapes a sip user part's substituted values, so none reaches into the dial string", () => {
    expect(renderTargetField('user', 'q-{{evil}}', VALUES)).toEqual({
      ok: true,
      value: 'q-a%40b%2Fc'
    });
    expect(renderTargetField('user', '{{missing}}', VALUES).ok).toBe(false);
    expect(
      renderTargetField('user', '{{long}}', { long: 'x'.repeat(65) }).ok
    ).toBe(false);
  });

  it("escapes a URL's substituted values as URL components", () => {
    expect(
      renderTargetField(
        'url',
        'wss://bot.example/{{evil}}?c={{callerNumber}}',
        VALUES
      )
    ).toEqual({
      ok: true,
      value: 'wss://bot.example/a%40b%2Fc?c=%2B43%20660%201'
    });
  });

  it('renders an extension and takes only digits', () => {
    expect(renderTargetField('extension', '{{slice did -2}}', VALUES)).toEqual({
      ok: true,
      value: '17'
    });
    expect(renderTargetField('extension', '{{did}}', VALUES).ok).toBe(false);
  });

  it('returns a value that is no template as it is', () => {
    expect(renderTargetField('external', '+4312345', VALUES)).toEqual({
      ok: true,
      value: '+4312345'
    });
  });
});

describe('on write', () => {
  it("refuses literal text the field's value cannot hold", () => {
    expect(targetFieldProblem('external', '+43{{slice did -2}}')).toBeNull();
    expect(targetFieldProblem('external', '0043 {{did}}')).toMatch(
      /cannot hold/u
    );
    expect(targetFieldProblem('user', 'q@{{did}}')).toMatch(/cannot hold/u);
    expect(targetFieldProblem('extension', '1{{slice did -1}}')).toBeNull();
    expect(targetFieldProblem('extension', 'x{{did}}')).toMatch(/cannot hold/u);
    expect(targetFieldProblem('extension', '{{slice did}}')).toMatch(
      /wrong number/u
    );
  });

  it("keeps a URL's scheme, host and port literal", () => {
    expect(
      urlTemplateProblem('wss://bot.example:8443/s/{{did}}?t={{callId}}')
    ).toBeNull();
    for (const source of [
      'wss://{{host}}/s',
      'wss://bot.{{did}}.example/s',
      'wss://bot.example:{{port}}/s',
      '{{scheme}}://bot.example/s',
      'wss://{{user}}@bot.example/s',
      '{{url}}'
    ]) {
      expect(urlTemplateProblem(source), source).toMatch(
        /scheme, host or port/u
      );
    }
    expect(templateSample('wss://bot.example/{{did}}?t={{slice did 1}}')).toBe(
      'wss://bot.example/x?t=x'
    );
  });
});
