#!/usr/bin/env python3
"""test/load: builds the ulaw pcap the transcoding load step needs.

sipp ships /sipp/g711a.pcap (alaw, RTP payload type 8) in its own image; there is no ulaw
counterpart. For the transcoding-cost step (docs/spec.md §6.6 "Sizing envelope") the provider leg
needs to actually negotiate and send ulaw, not just relabel alaw bytes under payload type 0, or
Asterisk's transcoding CPU cost would go unmeasured. This pulls the shipped pcap out of the sipp
image, transcodes its audio samples with ffmpeg (alaw -> raw PCM -> ulaw), and rewrites each
packet's RTP payload-type byte from 8 to 0, keeping every Ethernet/IPv4/UDP header byte as
captured (sipp rewrites addresses/ports itself at replay time; this only zeroes the UDP checksum
since the payload changed underneath it).

Usage: make_ulaw_pcap.py <sipp-image> <output-file>
"""
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ETH_IP_UDP_HDR = 42
RTP_HDR = 12


def extract_source_pcap(sipp_image: str, dest: Path) -> None:
    name = f'zamfono-load-pcap-extract-{uuid.uuid4().hex[:8]}'
    subprocess.run(
        ['docker', 'create', '--name', name, sipp_image, 'true'],
        check=True, stdout=subprocess.DEVNULL
    )
    try:
        subprocess.run(
            ['docker', 'cp', f'{name}:/sipp/g711a.pcap', str(dest)],
            check=True
        )
    finally:
        subprocess.run(['docker', 'rm', name], check=True, stdout=subprocess.DEVNULL)


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    sipp_image, out_path = sys.argv[1], Path(sys.argv[2])

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / 'g711a.pcap'
        extract_source_pcap(sipp_image, src)
        data = src.read_bytes()

        global_hdr = data[:24]
        off = 24
        frames = []
        while off < len(data):
            if off + 16 > len(data):
                break
            ts_sec, ts_usec, incl_len, _orig_len = struct.unpack('<IIII', data[off:off + 16])
            off += 16
            pkt = data[off:off + incl_len]
            off += incl_len
            frames.append((ts_sec, ts_usec, pkt))

        payload_lens = []
        alaw_stream = bytearray()
        for _, _, pkt in frames:
            payload = pkt[ETH_IP_UDP_HDR + RTP_HDR:]
            payload_lens.append(len(payload))
            alaw_stream += payload

        alaw_raw = tmp / 'alaw_stream.raw'
        ulaw_raw = tmp / 'ulaw_stream.raw'
        alaw_raw.write_bytes(bytes(alaw_stream))
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', str(alaw_raw),
             '-f', 'mulaw', '-ar', '8000', '-ac', '1', str(ulaw_raw)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        ulaw_stream = ulaw_raw.read_bytes()
        if len(ulaw_stream) != len(alaw_stream):
            print(
                f'WARNING: ffmpeg output {len(ulaw_stream)}B for {len(alaw_stream)}B input',
                file=sys.stderr
            )

        out = bytearray(global_hdr)
        pos = 0
        for (ts_sec, ts_usec, pkt), plen in zip(frames, payload_lens):
            header = bytearray(pkt[:ETH_IP_UDP_HDR + RTP_HDR])
            marker = header[ETH_IP_UDP_HDR + 1] & 0x80
            header[ETH_IP_UDP_HDR + 1] = marker | 0  # RTP payload type -> 0 (PCMU)
            udp_checksum_off = 34 + 6
            header[udp_checksum_off] = 0
            header[udp_checksum_off + 1] = 0
            new_payload = ulaw_stream[pos:pos + plen]
            pos += plen
            new_pkt = bytes(header) + new_payload
            incl_len = len(new_pkt)
            out += struct.pack('<IIII', ts_sec, ts_usec, incl_len, incl_len)
            out += new_pkt

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(bytes(out))
        print(f'wrote {out_path}: {len(frames)} packets, {pos} payload bytes')


if __name__ == '__main__':
    main()
