import { describe, expect, it } from 'vitest';

import { CallLog, effectiveLevel } from './callLog.js';

describe('effectiveLevel', () => {
  it('ignores an expired override and returns the tenant default', () => {
    const past = '2020-01-01T00:00:00.000Z';
    const now = '2024-01-01T00:00:00.000Z';

    const level = effectiveLevel(
      'events',
      [{ level: 'sip', expiresAt: past }],
      now
    );

    expect(level).toBe('events');
  });

  it('raises the level to the highest non-expired override', () => {
    const future = '2030-01-01T00:00:00.000Z';
    const now = '2024-01-01T00:00:00.000Z';

    const level = effectiveLevel(
      'events',
      [
        { level: 'qos', expiresAt: null },
        { level: 'sip', expiresAt: future }
      ],
      now
    );

    expect(level).toBe('sip');
  });
});

describe('CallLog', () => {
  it('keeps the earliest lines and marks the log truncated once the byte cap is reached', () => {
    // Measure one real logged line rather than assuming its serialized shape.
    const probe = new CallLog('call-1', 'events', Number.MAX_SAFE_INTEGER);
    probe.event({ seq: 0 });
    const oneLineBytes =
      Buffer.byteLength(probe.finish().log ?? '', 'utf8') + 1;

    const log = new CallLog('call-1', 'events', oneLineBytes * 2);
    for (let seq = 0; seq < 5; seq += 1) {
      log.event({ seq });
    }

    const result = log.finish();
    const lines = (result.log ?? '')
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(result.truncated).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 0 });
    expect(lines[1]).toMatchObject({ seq: 1 });
  });

  it('stops appending once truncated, even if a later, smaller line would fit under the cap', () => {
    const smallLineBytes =
      Buffer.byteLength(JSON.stringify({ callId: 'call-1', seq: 1 }), 'utf8') +
      1;
    // A cap that rejects the first (larger) line outright, but is big enough
    // for the second (smaller) line to fit on its own.
    const log = new CallLog('call-1', 'events', smallLineBytes);

    log.event({ seq: 0, pad: 'xxxxxxxxxxxxxxxxxxxx' });
    log.event({ seq: 1 });

    const result = log.finish();

    expect(result.truncated).toBe(true);
    expect(result.log).toBeNull();
  });

  it('returns a null log at level none', () => {
    const log = new CallLog('call-1', 'none', 1024);

    log.event({ seq: 0 });
    const result = log.finish();

    expect(result.log).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('records sip messages only at level sip', () => {
    const log = new CallLog('call-1', 'events', 1024);

    log.sip({ at: '2024-01-01T00:00:00.000Z', direction: 'in', raw: 'INVITE' });
    const result = log.finish();

    expect(result.log).toBeNull();
  });
});

describe('CallLog raise', () => {
  it('raises the level and never lowers it (§7: an override can only raise the level)', () => {
    const log = new CallLog('call-1', 'events', 1024);

    log.raise('qos');
    log.raise('events');

    expect(log.level).toBe('qos');
  });

  it('keeps the routing trace logged before a raise from none', () => {
    const log = new CallLog('call-1', 'none', 1024);

    log.event({ event: 'entry' });
    log.raise('events');

    expect(log.finish().log).toContain('"event":"entry"');
  });

  it('keeps the SIP messages mirrored before a raise to sip, in arrival order', () => {
    const log = new CallLog('call-1', 'events', 4096);

    log.sip({ at: '2024-01-01T00:00:00.000Z', direction: 'in', raw: 'INVITE' });
    log.event({ event: 'entry' });
    log.raise('sip');
    log.sip({
      at: '2024-01-01T00:00:01.000Z',
      direction: 'out',
      raw: 'SIP/2.0 180'
    });

    const lines = (log.finish().log ?? '')
      .split('\n')
      .map(line => JSON.parse(line) as { raw?: string; event?: string });
    expect(lines.map(line => line.raw ?? line.event)).toEqual([
      'INVITE',
      'entry',
      'SIP/2.0 180'
    ]);
  });

  it('never lets held SIP messages truncate the routing trace of a call below sip', () => {
    const log = new CallLog('call-1', 'events', 256);

    for (let seq = 0; seq < 20; seq += 1) {
      log.sip({
        at: '2024-01-01T00:00:00.000Z',
        direction: 'in',
        raw: 'OPTIONS'
      });
    }
    log.event({ event: 'entry' });
    const result = log.finish();

    expect(result.log).toContain('"event":"entry"');
    expect(result.log).not.toContain('OPTIONS');
    expect(result.truncated).toBe(false);
  });
});
