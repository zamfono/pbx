import { describe, expect, it } from 'vitest';

import { reloadKindsFor } from './changeEffects.js';

describe('reloadKindsFor (§3.1)', () => {
  it('re-renders the device endpoints with the hold music, whose class each one suggests (§10.2 "Hold music")', () => {
    expect(reloadKindsFor({ holdMohAudioId: 'm1' })).toEqual(['pjsip', 'moh']);
  });

  it('reloads PJSIP alone for codecs and registrations, and nothing for other columns', () => {
    expect(reloadKindsFor({ codecsJson: '["alaw"]' })).toEqual(['pjsip']);
    expect(reloadKindsFor({ ringotelMaxRegs: 2 })).toEqual(['pjsip']);
    expect(reloadKindsFor({ companyName: 'Acme' })).toEqual([]);
  });
});
