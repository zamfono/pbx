# test/load/devices: the device-side emulator for the TLS+SRTP+Opus stress profile. sipp 3.5.1
# (ctaloi/sipp) does TLS signalling but no SRTP, and a Ringotel device (docs/spec.md §10.4:
# `protocol: sips`, `nosrtp: false`) needs both, so the device side is baresip instead: it
# registers many accounts over TLS in one process, auto-answers, negotiates SDES-SRTP and encodes
# Opus live from a WAV file. python3 + libvo-amrwbenc0 also make this image the one place the
# harness can encode the trunk side's AMR-WB pcap (make_amrwb_pcap.py), which neither the host's
# nor the api image's ffmpeg can.
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends baresip-core libvo-amrwbenc0 python3 procps \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["sleep", "infinity"]
