import { describe, expect, it } from 'vitest';

import { mainMenuMedia, messageOptionsMedia } from './mailboxPrompts.js';

describe('mailbox menu prompts (§10.2 "Mailbox access")', () => {
  it('offers each folder only while it holds messages, and always the greeting and exit', () => {
    expect(mainMenuMedia(0, 3)).toEqual([
      'sound:vm-press',
      'sound:digits/2',
      'sound:vm-for',
      'sound:vm-Old',
      'sound:vm-messages',
      'sound:vm-press',
      'sound:digits/0',
      'sound:vm-rec-unv',
      'sound:vm-helpexit'
    ]);
    expect(mainMenuMedia(0, 0)).toEqual([
      'sound:vm-press',
      'sound:digits/0',
      'sound:vm-rec-unv',
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
