# Multi-stage build (docs/spec.md §6.3, §4, §6.4). The build stage is the official Caddy builder
# image for the exact Caddy version the runtime stage ships, running `xcaddy` to add the one
# plugin the stack needs, `caddy-events-exec` (the `cert_obtained` hook, §6.4). The runtime stage
# is the official, unmodified Caddy image with only that binary swapped in, so everything else —
# the base OS, the entrypoint, the default config lookup — stays exactly what upstream ships and
# tests. Build from the repository root: `docker build -f images/proxy/Dockerfile .`.
#
# Both tags are pinned exactly here alone (§6.3 "Images": "each pinned to one exact version in
# `images/proxy/Dockerfile`, which alone names them"); Dependabot bumps them in a pull request
# that passes CI (the docker ecosystem entry for /images/proxy, .github/dependabot.yaml), the
# plugin's pin moves by hand.
FROM caddy:2.11.4-builder AS build
WORKDIR /build
# The builder image bakes in CADDY_VERSION=v2.11.4 (matching the FROM tag) and XCADDY_SETCAP=1,
# so `xcaddy build --with …` alone builds that Caddy version with the plugin added and already
# applies `setcap cap_net_bind_service=+ep` to the binary it produces — the same capability the
# upstream image's binary carries, so Caddy can still bind :80/:443 without running as root. The
# plugin is pinned to its one released tag (v0.1.0, commit 3a351bf9c023b8f9305aaceaa5bf004b31a0ca3d
# — `gh api repos/mholt/caddy-events-exec/tags`); it ships one Go module, `events.handlers.exec`.
RUN xcaddy build --with github.com/mholt/caddy-events-exec@v0.1.0 --output /build/caddy

FROM caddy:2.11.4 AS runtime
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

# The defect this image exists to fix (§6.4's change-log entry): upstream Caddy runs as root and
# certmagic writes its certificate store 0700 root:root, so `api` (uid 1000, as §6.3 "Migrations"
# requires of every container sharing a volume) could never read it. This image runs Caddy as
# uid 1000 instead — the same id `node` and the remapped `asterisk` user already use — and owns
# its two writable directories accordingly. COPY does not carry a file's capability xattr across
# build stages (a known BuildKit limitation), so it is re-applied here; images/proxy/test.sh
# asserts it with `getcap`, since a silently-dropped capability would only fail at container
# start, on the privileged bind to :80/:443.
COPY --from=build /build/caddy /usr/bin/caddy
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
	&& getcap /usr/bin/caddy | grep -q cap_net_bind_service=ep
COPY images/proxy/zamfono-cert-hook /usr/local/bin/zamfono-cert-hook
COPY images/proxy/zamfono-proxy-entrypoint /usr/local/bin/zamfono-proxy-entrypoint
RUN chmod 0755 /usr/local/bin/zamfono-cert-hook /usr/local/bin/zamfono-proxy-entrypoint

# The base image already sets XDG_CONFIG_HOME=/config and XDG_DATA_HOME=/data, which is why
# certmagic's default file storage — and this image's own hook, §6.4 — land under /data (the
# `caddy-data` volume, §6.3) rather than assumed elsewhere. Both directories are all Caddy is
# left able to write to, so nothing it does reaches outside the volume compose gives it.
RUN mkdir -p /data /config \
	&& chown -R 1000:1000 /data /config
USER 1000:1000

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. Unlike `api` and
# `core`, `proxy` neither reads nor reports it (§6.3 "Images": only those two also carry it as
# ZAMFONO_REVISION); the label alone is enough for it to be traced back to its build.
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

# Runs the hook once for the certificate Caddy already holds, then execs the upstream command
# (zamfono-proxy-entrypoint). Setting ENTRYPOINT clears the CMD inherited from caddy:2.11.4, so it
# is restated.
ENTRYPOINT ["/usr/local/bin/zamfono-proxy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
