import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTestDb } from '../../testDb.js';
import { runOperation, type RunInput } from '../runner.js';

import '../index.js';

import { setCoreVersionLookup } from './info.js';

// The lowest role: every signed-in user may read what the stack runs.
const asUser: RunInput = {
  actor: { id: 'u1', name: 'User', role: 'user' },
  channel: 'mcp',
  requestId: 'req-1'
};
const CORE = {
  version: '0.0.4',
  revision: 'abc1234ffff',
  display: '0.0.4 (abc1234)'
};

afterEach(() => {
  setCoreVersionLookup(undefined);
  delete process.env.ZAMFONO_VERSION;
  delete process.env.ZAMFONO_REVISION;
});

describe('system.info', () => {
  it("reports api's version and the one core reports, each on its own", async () => {
    process.env.ZAMFONO_VERSION = '0.0.5';
    process.env.ZAMFONO_REVISION = '79c1041aaaaaaa';
    setCoreVersionLookup(() => Promise.resolve(CORE));

    expect(
      await runOperation(await makeTestDb(), 'system.info', {}, asUser)
    ).toEqual({
      api: {
        version: '0.0.5',
        revision: '79c1041aaaaaaa',
        display: '0.0.5 (79c1041)'
      },
      core: CORE
    });
  });

  it('reports core as null while core does not answer', async () => {
    setCoreVersionLookup(() =>
      Promise.reject(new Error('connect ECONNREFUSED'))
    );

    expect(
      await runOperation(await makeTestDb(), 'system.info', {}, asUser)
    ).toEqual({
      api: { version: 'dev', revision: '', display: 'dev' },
      core: null
    });
  });
});
