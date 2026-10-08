import { describe, expect, it } from 'vitest';

import { pageAt } from './nav';

describe('pageAt', () => {
  it('matches whole path segments, so /menus is not /me', () => {
    expect(pageAt('/menus')?.id).toBe('menus');
    expect(pageAt('/menus/abc/keys')?.id).toBe('menus');
    expect(pageAt('/me')?.id).toBe('me');
    expect(pageAt('/me/devices')?.id).toBe('me');
  });
});
