import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '#lib/api/ops/index.js';

import { DID, NUM, U } from '#lib/api/seed/ids.js';
import { resetDb, store } from '#lib/api/store.svelte.js';
import type { Call } from '#lib/api/types.js';
import { setMoment } from '#lib/clock.svelte.js';

import { ENTRIES, inboundCall, type Entry } from './simulator.svelte.js';

const entry = (did: string): Entry => {
  const found = ENTRIES.find(item => item.entry.did === did);
  if (found === undefined) {
    throw new Error(`no entry for ${did}`);
  }
  return found.entry;
};

/** The finished call: its history row once the simulated ringing and talking has run out. */
function placed(did: string): Call {
  const callId = inboundCall(entry(did));
  vi.advanceTimersByTime(200_000);
  const row = store.db.calls.find(candidate => candidate.id === callId);
  if (row === undefined) {
    throw new Error('call not in history');
  }
  return row;
}

const trace = (call: Call): string[] =>
  call.log.map(
    line =>
      `${line.event}${typeof line.condition === 'string' ? `:${line.condition}` : ''}`
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setMoment('now');
});

describe('inbound calls at a demo moment', () => {
  it('sends the main number to the closed announcement after hours', () => {
    setMoment('evening');
    resetDb();
    const call = placed(DID.main);
    expect(trace(call)).toContain('forward:closed');
    expect(trace(call)).toContain('announcement');
    expect(call.status).toBe('missed');
  });

  it("forwards Felix's calls to Daniel while he is on vacation", () => {
    setMoment('vacation');
    resetDb();
    const call = placed(DID.felix);
    expect(trace(call)).toContain('forward:ooo');
    expect(call.log.some(line => line.userId === U.daniel)).toBe(true);
  });

  it('plays the holiday announcement between the years', () => {
    setMoment('holidays');
    resetDb();
    const call = placed(DID.hotline);
    expect(trace(call)).toContain('forward:ooo');
    expect(trace(call)).toContain('announcement');
  });

  it('rings the hotline as usual on an office morning', () => {
    setMoment('officeDay');
    resetDb();
    const call = placed(DID.hotline);
    expect(call.toUri).toContain(NUM.hotline);
    expect(trace(call)).not.toContain('forward:closed');
    expect(trace(call)).toContain('ringGroup');
  });
});
