import { describe, expect, it } from 'vitest';

import { readEnv } from './env.js';

const REQUIRED = { ARI_PASSWORD: 'ari', AMI_PASSWORD: 'ami' };

// §6.1, §9.1: the address the stack writes into SIP, the host a forwarded leg's `Diversion`
// entries name (§9.4 "Forwarded calls").
describe('readEnv sipHost', () => {
  it('takes EXTERNAL_IPV4 in the ports mode, before STACK_IPV4', () => {
    expect(
      readEnv({
        ...REQUIRED,
        EXTERNAL_IPV4: '198.51.100.7',
        STACK_IPV4: '203.0.113.34'
      }).sipHost
    ).toBe('198.51.100.7');
  });

  it('takes STACK_IPV4 in the macvlan mode, an empty EXTERNAL_IPV4 counting as unset', () => {
    expect(
      readEnv({ ...REQUIRED, EXTERNAL_IPV4: '', STACK_IPV4: '203.0.113.34' })
        .sipHost
    ).toBe('203.0.113.34');
  });

  it('is null while neither is set', () => {
    expect(readEnv({ ...REQUIRED, STACK_IPV4: '' }).sipHost).toBeNull();
  });
});
