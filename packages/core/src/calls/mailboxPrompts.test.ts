import { describe, expect, it } from 'vitest';

import { mainMenuMedia, messageOptionsMedia } from './mailboxPrompts.js';

describe('mailbox menu prompts (§10.2 "Mailbox access")', () => {
  it('says each option as one sentence, each folder only while it holds messages', () => {
    expect(mainMenuMedia(2, 1)).toEqual([
      'sound:mailbox/menu-new',
      'sound:mailbox/menu-old',
      'sound:mailbox/menu-greeting',
      'sound:vm-helpexit'
    ]);
    expect(mainMenuMedia(0, 0)).toEqual([
      'sound:mailbox/menu-greeting',
      'sound:vm-helpexit'
    ]);
  });

  it('announces previous and next only where they exist', () => {
    expect(messageOptionsMedia(true, true)).toEqual([
      'sound:vm-prev',
      'sound:vm-repeat',
      'sound:vm-next',
      'sound:vm-delete',
      'sound:vm-starmain'
    ]);
    expect(messageOptionsMedia(true, false)).toEqual([
      'sound:vm-prev',
      'sound:vm-repeat',
      'sound:vm-delete',
      'sound:vm-starmain'
    ]);
  });
});
