#!/usr/bin/env python3
"""test/load/density: the G.711 A-law RTP pcap the trunk side of profiles P1-P3 replays with
sipp's play_pcap_audio, from raw A-law samples (ffmpeg -f alaw, 8 kHz mono), one 20 ms frame
(160 bytes, payload type 8) per packet, in the same placeholder framing as
stress/make_amrwb_pcap.py's (whose packet() this reuses).

Usage: make_g711a_pcap.py <in.alaw> <out.pcap>
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'stress'))
from make_amrwb_pcap import packet  # noqa: E402

FRAME = 160


def main() -> None:
    data = Path(sys.argv[1]).read_bytes()
    with open(sys.argv[2], 'wb') as f:
        f.write(struct.pack('<IHHiIII', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for i in range(len(data) // FRAME):
            rtp = struct.pack('!BBHII', 0x80, (0x80 if i == 0 else 0) | 8, i & 0xFFFF,
                              i * FRAME, 0x47373131) + data[i * FRAME:(i + 1) * FRAME]
            pkt = packet(rtp)
            ts_us = i * 20000
            f.write(struct.pack('<IIII', ts_us // 1_000_000, ts_us % 1_000_000, len(pkt), len(pkt)))
            f.write(pkt)
    print(f'{sys.argv[2]}: {len(data) // FRAME} frames, PCMA', file=sys.stderr)


if __name__ == '__main__':
    main()
