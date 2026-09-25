/**
 * HEPv3 (Homer Encapsulation Protocol) listener. Asterisk mirrors every SIP
 * message it sends or receives to this UDP listener (spec §7, §9.1
 * `hep.conf`), which correlates messages by Call-ID for the `sip` diagnostics
 * level.
 */

import { createSocket } from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';

import type { Logger } from './ari/types.js';

const HEP_MAGIC = 'HEP3';
// Generic header: magic (4 bytes) + total datagram length (2 bytes).
const HEADER_LEN = 6;
const HEADER_TOTAL_LENGTH_OFFSET = 4;
// Chunk header: vendor id (2 bytes) + type id (2 bytes) + chunk length (2 bytes).
const CHUNK_HEADER_LEN = 6;
const CHUNK_TYPE_ID_OFFSET = 2;
const CHUNK_LENGTH_OFFSET = 4;
const CHUNK_VENDOR_GENERIC = 0;
const CHUNK_TYPE_SRC_IPV4 = 0x0003;
const CHUNK_TYPE_TIMESTAMP_SEC = 0x0009;
const CHUNK_TYPE_TIMESTAMP_USEC = 0x000a;
const CHUNK_TYPE_PAYLOAD = 0x000f;
const CHUNK_TYPE_CORRELATION_ID = 0x0011;
const IPV4_LEN = 4;
const MILLISECONDS_PER_SECOND = 1000;
const MICROSECONDS_PER_MILLISECOND = 1000;

type ParsedHep = {
  callId: string;
  at: string;
  direction: 'in' | 'out';
  payload: string;
};

type LookupFn = (host: string) => Promise<{ address: string }[]>;

/** node:dns's own resolver, returning every address of the host regardless of family. */
async function defaultLookup(host: string): Promise<{ address: string }[]> {
  return dnsLookup(host, { all: true });
}

/**
 * The set of addresses that identify a SIP message as sent by Asterisk
 * itself (spec §7): the stack's own address in macvlan mode
 * (`STACK_IPV4`), the address written into SIP/SDP in ports mode
 * (`EXTERNAL_IPV4`), and every address the `asterisk` service resolves to on
 * the internal network (its `ARI_URL` host) — the address its transports
 * bind to in ports mode.
 */
export async function asteriskAddresses(
  env: Record<string, string | undefined>,
  lookup: LookupFn = defaultLookup
): Promise<Set<string>> {
  const addresses = new Set<string>();
  for (const value of [env.STACK_IPV4, env.EXTERNAL_IPV4]) {
    if (value) {
      addresses.add(value);
    }
  }
  const ariUrl = env.ARI_URL;
  if (ariUrl) {
    const resolved = await lookup(new URL(ariUrl).hostname);
    for (const { address } of resolved) {
      addresses.add(address);
    }
  }
  return addresses;
}

const UINT32_LEN = 4;

/** Reads a big-endian uint32 chunk, or undefined if the chunk is too short to hold one. */
function readUInt32Chunk(chunk: Buffer | undefined): number | undefined {
  if (!chunk || chunk.length < UINT32_LEN) {
    return undefined;
  }
  return chunk.readUInt32BE(0);
}

/** Splits a HEPv3 datagram into its generic-vendor chunks, by type id, stopping at `totalLength`. */
function readChunks(
  datagram: Buffer,
  totalLength: number
): Map<number, Buffer> {
  const chunks = new Map<number, Buffer>();
  let offset = HEADER_LEN;
  while (offset + CHUNK_HEADER_LEN <= totalLength) {
    const vendorId = datagram.readUInt16BE(offset);
    const typeId = datagram.readUInt16BE(offset + CHUNK_TYPE_ID_OFFSET);
    const chunkLength = datagram.readUInt16BE(offset + CHUNK_LENGTH_OFFSET);
    if (chunkLength < CHUNK_HEADER_LEN || offset + chunkLength > totalLength) {
      break;
    }
    if (vendorId === CHUNK_VENDOR_GENERIC) {
      chunks.set(
        typeId,
        datagram.subarray(offset + CHUNK_HEADER_LEN, offset + chunkLength)
      );
    }
    offset += chunkLength;
  }
  return chunks;
}

function ipv4ToString(chunk: Buffer): string {
  return Array.from(chunk.subarray(0, IPV4_LEN)).join('.');
}

/**
 * Parses one HEPv3 datagram (chunks with vendor id 0: 0x0009/0x000a
 * timestamp, 0x0011 correlation id, 0x000f payload, 0x0003 source IPv4).
 * Returns null for anything that is not a well-formed HEPv3 datagram
 * carrying both a correlation id and a payload.
 */
export function parseHep(
  datagram: Buffer,
  ownAddresses: ReadonlySet<string>
): ParsedHep | null {
  if (
    datagram.length < HEADER_LEN ||
    datagram.toString('ascii', 0, HEP_MAGIC.length) !== HEP_MAGIC
  ) {
    return null;
  }
  // The header's own total-length field bounds the chunk walk, so bytes
  // appended past the declared length are never parsed as chunks.
  const totalLength = datagram.readUInt16BE(HEADER_TOTAL_LENGTH_OFFSET);
  if (totalLength > datagram.length) {
    return null;
  }
  const chunks = readChunks(datagram, totalLength);
  const payloadChunk = chunks.get(CHUNK_TYPE_PAYLOAD);
  const callIdChunk = chunks.get(CHUNK_TYPE_CORRELATION_ID);
  if (!payloadChunk || !callIdChunk) {
    return null;
  }

  const timestampSec =
    readUInt32Chunk(chunks.get(CHUNK_TYPE_TIMESTAMP_SEC)) ?? 0;
  const timestampUsec =
    readUInt32Chunk(chunks.get(CHUNK_TYPE_TIMESTAMP_USEC)) ?? 0;
  const at = new Date(
    timestampSec * MILLISECONDS_PER_SECOND +
      timestampUsec / MICROSECONDS_PER_MILLISECOND
  ).toISOString();

  const srcIpChunk = chunks.get(CHUNK_TYPE_SRC_IPV4);
  const srcIp = srcIpChunk ? ipv4ToString(srcIpChunk) : undefined;
  const direction =
    srcIp !== undefined && ownAddresses.has(srcIp) ? 'out' : 'in';

  return {
    callId: callIdChunk.toString('utf8'),
    at,
    direction,
    payload: payloadChunk.toString('utf8')
  };
}

/** Parses a datagram, swallowing anything malformed enough to throw instead of crashing the listener. */
function safeParseHep(
  log: Logger,
  datagram: Buffer,
  ownAddresses: ReadonlySet<string>
): ParsedHep | null {
  try {
    return parseHep(datagram, ownAddresses);
  } catch (err) {
    log.error({ error: err }, 'HEP listener failed to parse a datagram');
    return null;
  }
}

/**
 * Starts the UDP HEP collector on `port`, calling `onMessage` per SIP message. `listening`
 * resolves with the port once the socket is bound, which for `0` is the one the OS picked.
 */
export function startHepListener(
  port: number,
  ownAddresses: ReadonlySet<string>,
  onMessage: (message: NonNullable<ReturnType<typeof parseHep>>) => void,
  log: Logger
): { close(): void; listening: Promise<number> } {
  const socket = createSocket('udp4');
  socket.on('error', err => {
    log.error({ error: err }, 'HEP listener socket error');
    socket.close();
  });
  socket.on('message', datagram => {
    const parsed = safeParseHep(log, datagram, ownAddresses);
    if (parsed) {
      onMessage(parsed);
    }
  });
  const listening = new Promise<number>(resolve => {
    socket.bind(port, () => {
      resolve(socket.address().port);
    });
  });
  return {
    close(): void {
      socket.close();
    },
    listening
  };
}
