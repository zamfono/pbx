# Multi-stage build (docs/spec.md §6.3, §4, §6.4). The build stage is the official Caddy builder
# image for the exact Caddy version the runtime stage ships, running `xcaddy` to add the one
# plugin the stack needs, `caddy-events-exec` (the `cert_obtained` hook, §6.4). The runtime stage
# is the official, unmodified Caddy image with only that binary swapped in, so everything else —
# the base OS, the entrypoint, the default config lookup — stays exactly what upstream ships and
# tests. Build from the repository root: `docker build -f images/proxy/Dockerfile .`.
#
# Both tags are pinned exactly here alone (§6.3 "Images": "each pinned to one exact version in
# `images/proxy/Dockerfile`, which alone names them"), each with its digest; Dependabot bumps
# tag and digest in a pull request that passes CI (the docker ecosystem entry for /images/proxy,
# .github/dependabot.yaml), the plugin's pin moves by hand.
FROM caddy:2.11.9-builder@sha256:345264d8c6b50f44f4a4d507d4e6b6bcae40eef2f210d70f76e717fd8cc31baf AS build
WORKDIR /build
# The builder image bakes in CADDY_VERSION matching its FROM tag, so `xcaddy build --with …` alone
# builds that Caddy version with the plugin added. XCADDY_SETCAP=0 overrides the builder's 1, which
# would give the binary `cap_net_bind_service=+ep` as upstream's carries: the stack runs proxy with
# every capability dropped and no-new-privileges (§6.3), where executing a binary with a file
# capability fails ("operation not permitted"), and binds :80/:443 by netns's
# net.ipv4.ip_unprivileged_port_start instead (deploy/compose.yaml). The plugin is pinned to its
# one released tag (v0.1.0, commit 3a351bf9c023b8f9305aaceaa5bf004b31a0ca3d —
# `gh api repos/mholt/caddy-events-exec/tags`); it ships one Go module, `events.handlers.exec`.
RUN XCADDY_SETCAP=0 xcaddy build --with github.com/mholt/caddy-events-exec@v0.1.0 --output /build/caddy

FROM caddy:2.11.9@sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c AS runtime
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

# Why this image runs Caddy as uid 1000 (§6.3 "Images"): upstream Caddy runs as root and
# certmagic writes its certificate store 0700 root:root, so `api` (uid 1000, as §6.3 "Migrations"
# requires of every container sharing a volume) could never read it. This image runs Caddy as
# uid 1000 instead — the same id `node` and the remapped `asterisk` user already use — and owns
# its writable directories accordingly. The binary replaces upstream's, and with it the file
# capability upstream's carries (see the build stage); images/proxy/test.sh asserts with `getcap`
# that it has none.
COPY --from=build /build/caddy /usr/bin/caddy
COPY images/proxy/zamfono-cert-hook /usr/local/bin/zamfono-cert-hook
COPY images/proxy/zamfono-proxy-entrypoint /usr/local/bin/zamfono-proxy-entrypoint
RUN chmod 0755 /usr/local/bin/zamfono-cert-hook /usr/local/bin/zamfono-proxy-entrypoint

# The base image already sets XDG_CONFIG_HOME=/config and XDG_DATA_HOME=/data, which is why
# certmagic's default file storage — and this image's own hook, §6.4 — land under /data (the
# `caddy-data` volume, §6.3) rather than assumed elsewhere. /cert-copy is where the hook puts
# its copy for `api` (the `cert-copy` volume, §6.4); owned by uid 1000 here, so a fresh volume
# mounted there is too. These three directories are all Caddy is left able to write to, so nothing
# it does reaches outside the volumes and the tmpfs compose gives it.
RUN mkdir -p /data /config /cert-copy \
	&& chown -R 1000:1000 /data /config /cert-copy
USER 1000:1000

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. Unlike `api` and
# `core`, `proxy` neither reads nor reports it (§6.3 "Images": only those two also carry it as
# ZAMFONO_REVISION); the label alone is enough for it to be traced back to its build.
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

# Runs the hook once for the certificate Caddy already holds, then execs the upstream command
# (zamfono-proxy-entrypoint). Setting ENTRYPOINT clears the CMD inherited from the caddy image, so it
# is restated.
ENTRYPOINT ["/usr/local/bin/zamfono-proxy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
