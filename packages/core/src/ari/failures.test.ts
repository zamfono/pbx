import { describe, expect, it, vi } from 'vitest';

import { ignoreGone, logFailure } from './failures.js';
import { AriError, type Logger } from './types.js';

describe('ignoreGone', () => {
  it('drops a 404 and rethrows every other failure', async () => {
    await expect(
      Promise.reject(new AriError(404, {})).catch(ignoreGone)
    ).resolves.toBeUndefined();
    const refused = new AriError(500, {});
    await expect(Promise.reject(refused).catch(ignoreGone)).rejects.toBe(
      refused
    );
    const down = new Error('connect ECONNREFUSED');
    await expect(Promise.reject(down).catch(ignoreGone)).rejects.toBe(down);
  });
});

describe('logFailure', () => {
  it('logs what failed, with its context, and continues', async () => {
    const error = vi.fn();
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error };
    const failure = new Error('POST /internal/mail responded 502');
    await expect(
      Promise.reject(failure).catch(
        logFailure(log, 'voicemail mail', { callId: 'c1' })
      )
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      { err: failure, callId: 'c1' },
      'voicemail mail failed'
    );
  });
});
