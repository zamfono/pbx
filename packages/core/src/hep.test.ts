import { createSocket } from 'node:dgram';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from './ari/types.js';
import { asteriskAddresses, parseHep, startHepListener } from './hep.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const HEP_MAGIC = 'HEP3';
const HEADER_LEN = 6;
const CHUNK_HEADER_LEN = 6;
const CHUNK_TYPE_SRC_IPV4 = 0x0003;
const CHUNK_TYPE_DST_IPV4 = 0x0004;
const CHUNK_TYPE_TIMESTAMP_SEC = 0x0009;
const CHUNK_TYPE_PAYLOAD = 0x000f;
const CHUNK_TYPE_CORRELATION_ID = 0x0011;

const NO_ASTERISK_ADDRESSES: ReadonlySet<string> = new Set();

function encodeChunk(typeId: number, data: Buffer): Buffer {
  const header = Buffer.alloc(CHUNK_HEADER_LEN);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(typeId, 2);
  header.writeUInt16BE(CHUNK_HEADER_LEN + data.length, 4);
  return Buffer.concat([header, data]);
}

function encodeIpv4(ip: string): Buffer {
  return Buffer.from(ip.split('.').map(octet => Number(octet)));
}

function encodeUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function encodeHepDatagram(options: {
  srcIp: string;
  dstIp: string;
  callId: string;
  payload: string;
  timestampSec: number;
}): Buffer {
  const chunks = Buffer.concat([
    encodeChunk(CHUNK_TYPE_SRC_IPV4, encodeIpv4(options.srcIp)),
    encodeChunk(CHUNK_TYPE_DST_IPV4, encodeIpv4(options.dstIp)),
    encodeChunk(CHUNK_TYPE_TIMESTAMP_SEC, encodeUint32(options.timestampSec)),
    encodeChunk(
      CHUNK_TYPE_CORRELATION_ID,
      Buffer.from(options.callId, 'ascii')
    ),
    encodeChunk(CHUNK_TYPE_PAYLOAD, Buffer.from(options.payload, 'ascii'))
  ]);
  const header = Buffer.alloc(HEADER_LEN);
  header.write(HEP_MAGIC, 0, 'ascii');
  header.writeUInt16BE(HEADER_LEN + chunks.length, 4);
  return Buffer.concat([header, chunks]);
}

describe('parseHep', () => {
  it('extracts the call id and payload from a HEPv3 datagram', () => {
    const datagram = encodeHepDatagram({
      srcIp: '203.0.113.10',
      dstIp: '198.51.100.20',
      callId: 'abc123@example.com',
      payload: 'INVITE sip:bob@example.com SIP/2.0',
      timestampSec: 1_700_000_000
    });

    const parsed = parseHep(datagram, NO_ASTERISK_ADDRESSES);

    expect(parsed?.callId).toBe('abc123@example.com');
    expect(parsed?.payload).toBe('INVITE sip:bob@example.com SIP/2.0');
  });

  it('returns null for a datagram missing the HEP magic', () => {
    expect(
      parseHep(Buffer.from('not-a-hep-datagram'), NO_ASTERISK_ADDRESSES)
    ).toBeNull();
  });

  it('marks the direction "out" when the source ip is one of Asterisk\'s own addresses', () => {
    const datagram = encodeHepDatagram({
      srcIp: '203.0.113.10',
      dstIp: '198.51.100.20',
      callId: 'x',
      payload: 'BYE',
      timestampSec: 0
    });

    expect(parseHep(datagram, new Set(['203.0.113.10']))?.direction).toBe(
      'out'
    );
  });

  it('marks the direction "in" when the destination, not the source, ip is one of Asterisk\'s own addresses', () => {
    const datagram = encodeHepDatagram({
      srcIp: '203.0.113.10',
      dstIp: '198.51.100.20',
      callId: 'x',
      payload: 'BYE',
      timestampSec: 0
    });

    expect(parseHep(datagram, new Set(['198.51.100.20']))?.direction).toBe(
      'in'
    );
  });

  it('does not throw on a malformed (empty) timestamp chunk, treating the timestamp as absent', () => {
    const chunks = Buffer.concat([
      encodeChunk(CHUNK_TYPE_TIMESTAMP_SEC, Buffer.alloc(0)),
      encodeChunk(CHUNK_TYPE_CORRELATION_ID, Buffer.from('x', 'ascii')),
      encodeChunk(CHUNK_TYPE_PAYLOAD, Buffer.from('BYE', 'ascii'))
    ]);
    const header = Buffer.alloc(HEADER_LEN);
    header.write(HEP_MAGIC, 0, 'ascii');
    header.writeUInt16BE(HEADER_LEN + chunks.length, 4);
    const datagram = Buffer.concat([header, chunks]);

    expect(() => parseHep(datagram, NO_ASTERISK_ADDRESSES)).not.toThrow();
    expect(parseHep(datagram, NO_ASTERISK_ADDRESSES)?.at).toBe(
      new Date(0).toISOString()
    );
  });
});

describe('asteriskAddresses', () => {
  it('combines STACK_IPV4/EXTERNAL_IPV4 with every resolved address of the ARI_URL host', async () => {
    const fakeLookup = vi
      .fn()
      .mockResolvedValue([{ address: '10.0.0.5' }, { address: '10.0.0.6' }]);

    const addresses = await asteriskAddresses(
      { STACK_IPV4: '203.0.113.34', ARI_URL: 'http://asterisk:8088' },
      fakeLookup
    );

    expect(fakeLookup).toHaveBeenCalledWith('asterisk');
    expect(addresses).toEqual(
      new Set(['203.0.113.34', '10.0.0.5', '10.0.0.6'])
    );
  });

  it('adds nothing for an unset STACK_IPV4/EXTERNAL_IPV4', async () => {
    const fakeLookup = vi.fn().mockResolvedValue([{ address: '10.0.0.5' }]);

    const addresses = await asteriskAddresses(
      { ARI_URL: 'http://asterisk:8088' },
      fakeLookup
    );

    expect(addresses).toEqual(new Set(['10.0.0.5']));
  });
});

describe('startHepListener', () => {
  it('parses a received datagram and dispatches it to onMessage', async () => {
    const received: NonNullable<ReturnType<typeof parseHep>>[] = [];
    // Any free port, never one reserved and released first for another process to take; the
    // datagram goes out once the socket is bound, so it is not sent to a port nobody holds yet.
    const listener = startHepListener(
      0,
      new Set(['203.0.113.10']),
      message => {
        received.push(message);
      },
      noopLogger
    );
    const port = await listener.listening;

    const datagram = encodeHepDatagram({
      srcIp: '203.0.113.10',
      dstIp: '198.51.100.20',
      callId: 'listener-test',
      payload: 'BYE',
      timestampSec: 0
    });
    const sender = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      sender.send(datagram, port, '127.0.0.1', err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    sender.close();
    listener.close();
    expect(received[0]?.callId).toBe('listener-test');
    expect(received[0]?.direction).toBe('out');
  });
});
