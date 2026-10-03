import { describe, expect, it } from 'vitest';

import { defaultFeatureCodes } from '@zamfono/shared/testDb.js';

import { resolveDialed, type ResolveDialedContext } from './outbound.js';

const FEATURE_CODES = await defaultFeatureCodes();

const baseCtx = (
  overrides: Partial<ResolveDialedContext> = {}
): ResolveDialedContext => ({
  featureCodes: FEATURE_CODES,
  emergencyNumbers: ['112', '110'],
  country: 'DE',
  extLength: 3,
  extensions: new Map(),
  dids: new Map(),
  ...overrides
});

describe('resolveDialed', () => {
  it('strips a CLIR prefix, recurses and marks the result withheld', () => {
    const result = resolveDialed('#31#0891234', baseCtx());

    expect(result).toEqual({
      kind: 'external',
      number: '+49891234',
      clir: true
    });
  });

  it('resolves an emergency number even when an extension of the same digits exists', () => {
    const ctx = baseCtx({
      extensions: new Map([
        ['112', { userId: 'user-1', ringGroupId: null, isParkingSlot: false }]
      ])
    });

    expect(resolveDialed('112', ctx)).toEqual({
      kind: 'emergency',
      number: '112'
    });
  });

  it('resolves an owned extension', () => {
    const ctx = baseCtx({
      extensions: new Map([
        ['101', { userId: 'user-1', ringGroupId: null, isParkingSlot: false }]
      ])
    });

    expect(resolveDialed('101', ctx)).toEqual({
      kind: 'extension',
      owner: { kind: 'user', userId: 'user-1' },
      clir: null
    });
  });

  it('refuses a digit string of extension length or shorter that no row owns', () => {
    expect(resolveDialed('11', baseCtx())).toEqual({
      kind: 'refuse',
      code: 404
    });
  });

  it('refuses a longer bare digit string as an incomplete address', () => {
    expect(resolveDialed('89123', baseCtx())).toEqual({
      kind: 'refuse',
      code: 484
    });
  });

  it('resolves a normalized number matching one of the tenant own DIDs', () => {
    const ctx = baseCtx({
      dids: new Map([['+4989123', { id: 'did-1', targetId: 'target-1' }]])
    });

    expect(resolveDialed('+4989123', ctx)).toEqual({
      kind: 'ownDid',
      didId: 'did-1',
      number: '+4989123',
      targetId: 'target-1',
      clir: null
    });
  });

  it('resolves a feature code without an argument', () => {
    expect(resolveDialed('*70', baseCtx())).toEqual({
      kind: 'feature',
      key: 'park',
      rest: '',
      clir: null
    });
  });
});
