# The harness's SIP tools, for test/integration and every test/load profile: sipp (Debian's
# sip-tester), which plays the trunks, the providers' registrars and the scripted phones, and
# baresip, the device-side emulator for the TLS+SRTP+Opus stress profile and inbound-forward-sip's
# TLS SIP target. sipp does TLS signalling but no SRTP, and a Ringotel device (docs/spec.md
# §10.4: `protocol: sips`, `nosrtp: false`) needs both, so that device side is baresip instead:
# it registers many accounts over TLS in one process, auto-answers, negotiates SDES-SRTP and
# encodes Opus live from a WAV file. python3 + libvo-amrwbenc0 also make this image the one place
# the harness can encode the trunk side's AMR-WB pcap (make_amrwb_pcap.py), which neither the
# host's nor the api image's ffmpeg can.
#
# baresip comes from the Zamfono APT repository (same archive keyring as images/asterisk): Debian
# ships baresip 1.1.0 in every suite. The package puts its modules under the multiarch libdir; the symlink gives the
# harness's configs one module_path for amd64 and arm64.
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /tmp/zamfono-archive-keyring.deb \
       https://packages.zamfono.com/debian/baresip/pool/main/z/zamfono-archive-keyring/zamfono-archive-keyring_1.0_all.deb \
    && apt-get install -y --no-install-recommends /tmp/zamfono-archive-keyring.deb \
    && rm /tmp/zamfono-archive-keyring.deb \
    && echo 'deb [signed-by=/usr/share/keyrings/zamfono-archive-keyring.gpg] https://packages.zamfono.com/debian/baresip trixie main' \
       > /etc/apt/sources.list.d/zamfono-baresip.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends baresip sip-tester libvo-amrwbenc0 python3 procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /usr/lib/baresip \
    && ln -s "$(dpkg -L baresip | grep -m1 '/baresip/modules$')" /usr/lib/baresip/modules
ENTRYPOINT ["sleep", "infinity"]
