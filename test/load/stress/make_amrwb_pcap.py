#!/usr/bin/env python3
"""test/load: builds the AMR-WB RTP pcap the trunk side of the stress profile replays with sipp's
play_pcap_audio (docs/spec.md §9.1: the image ships AMR-WB via codec_amr).

Neither the host's ffmpeg nor the api image's has an AMR-WB encoder (libvo_amrwbenc), so this
calls libvo-amrwbenc directly through ctypes; it runs inside the load-devices image, which
installs that library. E_IF_encode emits RFC 4867 §5 storage-format frames (one ToC-style header
byte, then the speech bits padded to whole octets); this repacks each 20 ms frame into one RTP
packet in the payload format the SDP negotiates:
  - octet-aligned (RFC 4867 §4.4): CMR byte 0xF0 (no mode request), ToC byte, the frame octets;
  - bandwidth-efficient (§4.3): CMR(4) F(1) FT(4) Q(1) then exactly the mode's speech bits.

Usage: make_amrwb_pcap.py <in.wav 16 kHz mono s16> <out.pcap> <seconds> <mode 0-8>
       <octet|be> [payload_type]
The WAV is looped to fill <seconds>. Every IP/UDP address in the pcap is a placeholder: sipp
rewrites addresses and ports at replay and keeps only payload, payload type, sequence and timing.
"""
import ctypes
import struct
import sys
import wave

# Speech bits per AMR-WB mode (3GPP TS 26.201 Table 2), index = frame type.
MODE_BITS = [132, 177, 253, 285, 317, 365, 397, 461, 477]
FRAME_SAMPLES = 320  # 20 ms at 16 kHz


def encode_frames(pcm: bytes, seconds: int, mode: int) -> list[bytes]:
    lib = ctypes.CDLL('libvo-amrwbenc.so.0')
    lib.E_IF_init.restype = ctypes.c_void_p
    lib.E_IF_encode.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                ctypes.c_int]
    lib.E_IF_exit.argtypes = [ctypes.c_void_p]
    state = lib.E_IF_init()
    frame_bytes = FRAME_SAMPLES * 2
    total = seconds * 50
    out = ctypes.create_string_buffer(64)
    frames = []
    offset = 0
    for _ in range(total):
        if offset + frame_bytes > len(pcm):
            offset = 0
        chunk = ctypes.create_string_buffer(pcm[offset:offset + frame_bytes], frame_bytes)
        offset += frame_bytes
        n = lib.E_IF_encode(state, mode, chunk, out, 0)
        frames.append(out.raw[:n])
    lib.E_IF_exit(state)
    return frames


def payload_octet(frame: bytes) -> bytes:
    # Storage header byte is 0|FT(4)|Q|00: exactly the octet-aligned ToC with F=0.
    return b'\xf0' + frame


def payload_be(frame: bytes) -> bytes:
    header = frame[0]
    ft = (header >> 3) & 0x0F
    q = (header >> 2) & 0x01
    nbits = MODE_BITS[ft] if ft < len(MODE_BITS) else 0
    speech = int.from_bytes(frame[1:], 'big') >> (len(frame[1:]) * 8 - nbits) if nbits else 0
    bits = (0xF << (6 + nbits)) | (0 << (5 + nbits)) | (ft << (1 + nbits)) | (q << nbits) | speech
    total = 10 + nbits
    pad = (-total) % 8
    return (bits << pad).to_bytes((total + pad) // 8, 'big')


def ip_checksum(header: bytes) -> int:
    s = sum(struct.unpack('!10H', header))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF


def packet(rtp: bytes) -> bytes:
    udp = struct.pack('!HHHH', 6000, 6002, 8 + len(rtp), 0) + rtp
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), 0, 0x4000, 64, 17, 0,
                     bytes([10, 0, 0, 1]), bytes([10, 0, 0, 2]))
    ip = ip[:10] + struct.pack('!H', ip_checksum(ip)) + ip[12:]
    eth = b'\x02\x00\x00\x00\x00\x02' + b'\x02\x00\x00\x00\x00\x01' + b'\x08\x00'
    return eth + ip + udp


def main() -> None:
    src, dest, seconds, mode, packing = sys.argv[1:6]
    pt = int(sys.argv[6]) if len(sys.argv) > 6 else 96
    with wave.open(src, 'rb') as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            sys.exit(f'{src}: need 16 kHz mono s16')
        pcm = w.readframes(w.getnframes())
    frames = encode_frames(pcm, int(seconds), int(mode))
    pack = payload_octet if packing == 'octet' else payload_be
    ssrc = 0x5A4D464E
    with open(dest, 'wb') as f:
        f.write(struct.pack('<IHHiIII', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for i, frame in enumerate(frames):
            rtp = struct.pack('!BBHII', 0x80, (0x80 if i == 0 else 0) | pt, i & 0xFFFF,
                              i * FRAME_SAMPLES, ssrc) + pack(frame)
            data = packet(rtp)
            ts_us = i * 20000
            f.write(struct.pack('<IIII', ts_us // 1_000_000, ts_us % 1_000_000, len(data),
                                len(data)))
            f.write(data)
    print(f'{dest}: {len(frames)} frames, mode {mode}, {packing}, pt {pt}', file=sys.stderr)


if __name__ == '__main__':
    main()
