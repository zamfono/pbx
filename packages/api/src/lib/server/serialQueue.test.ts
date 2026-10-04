import { describe, expect, it } from 'vitest';

import { serialQueue } from './serialQueue.js';

describe('serialQueue', () => {
  it('runs each piece of work once the one queued before it has ended, failed or not', async () => {
    const inTurn = serialQueue();
    const order: string[] = [];
    const first = Promise.withResolvers<undefined>();

    const scheduled = inTurn(async () => {
      order.push('scheduled starts');
      await first.promise;
      order.push('scheduled ends');
      throw new Error('restic failed');
    });
    const automatic = inTurn(async () => {
      order.push('automatic');
      return Promise.resolve('ok');
    });
    await Promise.resolve();
    expect(order).toEqual(['scheduled starts']);

    first.resolve(undefined);
    await expect(scheduled).rejects.toThrow('restic failed');
    await expect(automatic).resolves.toBe('ok');
    expect(order).toEqual(['scheduled starts', 'scheduled ends', 'automatic']);
  });
});
