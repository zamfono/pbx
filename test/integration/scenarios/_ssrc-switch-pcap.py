"""Writes the two A-law RTP captures `inbound-ssrc-switch.xml` plays, into directory argv[1].

`before.pcap` is 2 s of one stream (SSRC 0x11111111, sequence numbers from 40000); `after.pcap`
is 4 s of another (SSRC 0x22222222), whose sequence numbers start at 35000, a little *below* the
first stream's, as a carrier's media gateway switching sources can. sipp's `play_pcap_audio`
sends each packet's RTP header as captured, so Asterisk sees its far end switch SSRC with a
backward sequence step. This runs in the `sipp` container, whose image has Python but whose
scenario directory is read-only, so the captures are written at setup rather than kept in Git.
"""

import math
import struct
import sys

PACKETS_PER_SECOND = 50
SAMPLES_PER_PACKET = 160


def alaw(sample: int) -> int:
    """G.711 A-law code of a 16-bit linear sample."""
    sign = 0x80 if sample >= 0 else 0x00
    if sample < 0:
        sample = -sample - 1
    sample = min(sample, 32767) >> 3
    if sample < 32:
        code = sample >> 1
    else:
        segment = sample.bit_length() - 5
        code = (segment << 4) | ((sample >> segment) & 0x0F)
    return (code | sign) ^ 0x55


def write(path: str, ssrc: int, seconds: int, first_seq: int, first_ts: int, hz: int) -> None:
    with open(path, 'wb') as out:
        out.write(struct.pack('<IHHiIII', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for i in range(seconds * PACKETS_PER_SECOND):
            payload = bytes(
                alaw(int(8000 * math.sin(2 * math.pi * hz * (i * SAMPLES_PER_PACKET + k) / 8000)))
                for k in range(SAMPLES_PER_PACKET)
            )
            rtp = struct.pack(
                '!BBHII', 0x80, 8, (first_seq + i) & 0xFFFF,
                (first_ts + SAMPLES_PER_PACKET * i) & 0xFFFFFFFF, ssrc,
            ) + payload
            udp = struct.pack('!HHHH', 6000, 6000, 8 + len(rtp), 0) + rtp
            ip = struct.pack(
                '!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), 0, 0, 64, 17, 0,
                bytes([10, 0, 0, 1]), bytes([10, 0, 0, 2]),
            ) + udp
            frame = b'\x00' * 12 + b'\x08\x00' + ip
            usec = i * 1_000_000 // PACKETS_PER_SECOND
            out.write(struct.pack('<IIII', usec // 1_000_000, usec % 1_000_000, len(frame),
                                  len(frame)) + frame)


write(sys.argv[1] + '/before.pcap', 0x11111111, 2, 40000, 1000, 440)
write(sys.argv[1] + '/after.pcap', 0x22222222, 4, 35000, 900000, 880)
