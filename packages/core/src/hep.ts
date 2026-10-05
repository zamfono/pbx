/**
 * HEPv3 (Homer Encapsulation Protocol) listener. Asterisk mirrors every SIP
 * message it sends or receives to this UDP listener (spec §7, §9.1
 * `hep.conf`), which correlates messages by Call-ID for the `sip` diagnostics
 * level, and every RTCP report its RTP instances send or receive
 * (`res_hep_rtcp`), which feed the level `qos` figures and never the SIP log.
 */

import { createSocket } from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';

import { MS_PER_SECOND } from '@zamfono/shared';

import type { Logger } from './ari/types.js';
import type { CoreEnv } from './env.js';
import { dispatchHep, type HepHandlers } from './hepDispatch.js';

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
const CHUNK_TYPE_DST_IPV4 = 0x0004;
const CHUNK_TYPE_TIMESTAMP_SEC = 0x0009;
const CHUNK_TYPE_TIMESTAMP_USEC = 0x000a;
const CHUNK_TYPE_PROTOCOL_TYPE = 0x000b;
const CHUNK_TYPE_PAYLOAD = 0x000f;
const CHUNK_TYPE_CORRELATION_ID = 0x0011;
const IPV4_LEN = 4;
const MICROSECONDS_PER_MILLISECOND = 1000;
export type ParsedHep = {
  callId: string;
  at: string;
  /** The capture time in milliseconds since the epoch, to the microsecond HEP carries. */
  atMs: number;
  direction: 'in' | 'out';
  /** Whether the destination address is one of Asterisk's own. */
  toAsterisk: boolean;
  /** The HEP protocol type (chunk 0x000b); null when the datagram carries none. */
  protocol: number | null;
  payload: string;
};

export type LookupFn = (host: string) => Promise<{ address: string }[]>;

/** node:dns's own resolver, returning every address of the host regardless of family. */
export async function defaultLookup(
  host: string
): Promise<{ address: string }[]> {
  return dnsLookup(host, { all: true });
}

/**
 * The set of addresses that identify a SIP message as sent by Asterisk
 * itself (spec §7): the stack's own address in macvlan mode
 * (`STACK_IPV4`), the address written into SIP/SDP in ports mode
 * (`EXTERNAL_IPV4`), and every address the `asterisk` service resolves to on
 * the internal network (the `ariUrl` host) — the address its transports
 * bind to in ports mode.
 */
export async function asteriskAddresses(
  env: Pick<CoreEnv, 'ariUrl' | 'stackIpv4' | 'externalIpv4'>,
  lookup: LookupFn = defaultLookup
): Promise<Set<string>> {
  const addresses = new Set<string>();
  for (const value of [env.stackIpv4, env.externalIpv4]) {
    if (value !== null) {
      addresses.add(value);
    }
  }
  const resolved = await lookup(new URL(env.ariUrl).hostname);
  for (const { address } of resolved) {
    addresses.add(address);
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

/** Reads a one-byte chunk, or null if the chunk is absent or empty. */
function readUInt8Chunk(chunk: Buffer | undefined): number | null {
  return chunk && chunk.length > 0 ? chunk.readUInt8(0) : null;
}

/**
 * Parses one HEPv3 datagram (chunks with vendor id 0: 0x0009/0x000a
 * timestamp, 0x0011 correlation id, 0x000f payload, 0x0003/0x0004 source and
 * destination IPv4, 0x000b protocol type).
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
  const atMs =
    timestampSec * MS_PER_SECOND + timestampUsec / MICROSECONDS_PER_MILLISECOND;

  const srcIpChunk = chunks.get(CHUNK_TYPE_SRC_IPV4);
  const srcIp = srcIpChunk ? ipv4ToString(srcIpChunk) : undefined;
  const dstIpChunk = chunks.get(CHUNK_TYPE_DST_IPV4);
  const dstIp = dstIpChunk ? ipv4ToString(dstIpChunk) : undefined;
  const direction =
    srcIp !== undefined && ownAddresses.has(srcIp) ? 'out' : 'in';

  return {
    callId: callIdChunk.toString('utf8'),
    at: new Date(atMs).toISOString(),
    atMs,
    direction,
    toAsterisk: dstIp !== undefined && ownAddresses.has(dstIp),
    protocol: readUInt8Chunk(chunks.get(CHUNK_TYPE_PROTOCOL_TYPE)),
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
    log.error({ err }, 'HEP listener failed to parse a datagram');
    return null;
  }
}

/**
 * Starts the UDP HEP collector on `port`, handing each SIP message and RTCP report to `handlers`
 * (`dispatchHep`). `listening` resolves with the port once the socket is bound, which for `0` is
 * the one the OS picked.
 */
export function startHepListener(
  port: number,
  ownAddresses: ReadonlySet<string>,
  handlers: HepHandlers,
  log: Logger
): { close(): void; listening: Promise<number> } {
  const socket = createSocket('udp4');
  socket.on('error', err => {
    log.error({ err }, 'HEP listener socket error');
    socket.close();
  });
  socket.on('message', datagram => {
    const parsed = safeParseHep(log, datagram, ownAddresses);
    if (parsed) {
      dispatchHep(parsed, handlers);
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
