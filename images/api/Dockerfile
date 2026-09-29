# Multi-stage build (docs/spec.md §6.3, §4). The build stage installs the whole npm workspace and
# produces the SvelteKit adapter-node output; the runtime stage ships only that output, its
# dependencies and the tools the api process shells out to (ffmpeg for recording mixdown,
# restic/rclone for backups, §6.5). Build from the repository root: `docker build -f
# images/api/Dockerfile .`.
FROM node:26-slim AS build
WORKDIR /app
# better-sqlite3 (via @zamfono/shared) falls back to compiling from source when no prebuild
# matches this platform's Node ABI; the toolchain never reaches the runtime stage.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages packages
RUN npm ci
# packages/shared has no build step of its own; its tsconfig still builds standalone via project
# references, emitting packages/shared/dist/*.js.
RUN npx tsc -b packages/shared
# packages/shared's package.json points "exports"/"types" at its TypeScript source for `npm run
# dev`/`vitest`, which run it through a bundler or loader that rewrites the internal "./db.js"
# specifiers to "./db.ts"; plain `node` does not, so the runtime image below ships the compiled
# dist output instead and repoints exports/types at it here, image-local only. Doing this before
# the SvelteKit build lets Vite's SSR bundle (which externalizes workspace dependencies found in
# node_modules rather than inlining them) resolve @zamfono/shared the same way at both build and
# run time.
RUN node -e "\
	const fs = require('node:fs'); \
	const file = 'packages/shared/package.json'; \
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8')); \
	pkg.exports['.'] = './dist/index.js'; \
	pkg.types = './dist/index.d.ts'; \
	fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');"
# The admin guide that `zamfono.help` serves is bundled into the server chunk at build time by an
# `import.meta.glob` over `docs/guide/**/*.md` (§10.5), so those files are inputs to the build.
COPY docs/guide docs/guide
RUN npm run build -w packages/api
# The compile is done: the development dependencies (the TypeScript and test toolchain, the
# linters, the SvelteKit build tooling) leave node_modules before the runtime stage copies it.
# Without its lifecycle scripts: api's `prepare` runs `svelte-kit sync`, which the prune has just
# removed, and the native modules were built by `npm ci` already.
RUN npm prune --omit=dev --ignore-scripts

FROM node:26-slim
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx
WORKDIR /app
# Byte for byte the same as images/core/Dockerfile's first runtime step: bake builds the two images
# in one run, builds an identical step once, and both images then share its ~460 MB layer, in CI's
# archive and in an operator's pull (deploy/test.sh checks that they do).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /media \
	&& chown node:node /data /media
# The opsound packages carry the five bundled hold-music tracks (§10.2 "Hold music") as plain
# data under /usr/share/asterisk/moh, in the 8 kHz wav and 16 kHz g722 variants. `api` is the
# process that seeds them into the media volume and the `audio_assets` table on first boot
# (§6.3 "First boot"), so its image is where they have to be readable. restic's native sftp
# backend (§6.5) spawns `ssh` from openssh-client, wrapped in `sshpass` to feed it the target's
# password (`backupBackends.ts`).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends restic rclone \
	   openssh-client sshpass \
	   asterisk-moh-opsound-wav asterisk-moh-opsound-g722 \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/asterisk/gen /backups \
	&& chown node:node /etc/asterisk/gen /backups
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/api/build packages/api/build
COPY db/migrations db/migrations
# The generator for BOOTSTRAP_OWNER_PASSWORD_HASH (§6.3 "First boot"); it runs against the
# `argon2` binding already in node_modules, so it costs the image nothing beyond the file:
# `docker compose run --rm --no-deps -T api node hash-password.mjs`.
COPY packages/api/scripts/hashPassword.mjs hash-password.mjs
ENV DB_FILE=/data/zamfono.sqlite3 \
	MEDIA_DIR=/media \
	ASTERISK_GEN_DIR=/etc/asterisk/gen \
	MIGRATIONS_DIR=/app/db/migrations \
	PORT=3000
USER node

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. `api` reads its own
# copy from the environment and reports it alongside `ZAMFONO_VERSION` (server.ts).
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION
ENV ZAMFONO_REVISION=$ZAMFONO_REVISION

CMD ["node", "packages/api/build/server.js"]
