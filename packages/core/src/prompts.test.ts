import { describe, expect, it } from 'vitest';

import { assetMedia, defaultPrompt, digitsMedia, PROMPTS } from './prompts.js';

describe('defaultPrompt', () => {
  it('renders a fixed default prompt as a sound: reference to its name', () => {
    expect(defaultPrompt('vmIntro')).toBe(`sound:${PROMPTS.vmIntro}`);
    expect(defaultPrompt('pbxInvalid')).toBe(`sound:${PROMPTS.pbxInvalid}`);
  });
});

describe('assetMedia', () => {
  it('renders an audio asset as a sound: reference under the prompts volume, extension dropped', () => {
    const assets = [{ id: 'a1', filename: 'greeting-a1.wav' }];
    expect(assetMedia(assets, 'a1')).toBe('sound:/media/prompts/greeting-a1');
  });

  it('throws for an audio asset id missing from the snapshot', () => {
    expect(() => assetMedia([], 'missing')).toThrow();
  });
});

describe('digitsMedia (§10.2 "Call parking")', () => {
  it('reads the digits one clip each, the last one ending the sentence', () => {
    expect(digitsMedia('701')).toEqual([
      'sound:digits/7',
      'sound:digits/0',
      'sound:digits-final/1'
    ]);
  });
});
