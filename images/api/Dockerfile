# Multi-stage build (docs/spec.md §6.3, §4). The build stage installs the whole npm workspace and
# produces the SvelteKit adapter-node output; the runtime stage ships only that output, its
# dependencies and the tools the api process shells out to (ffmpeg for recording mixdown,
# restic/rclone for backups, §6.5). Build from the repository root through bake, which supplies
# the runtime-base stage: `docker buildx bake --load api`.
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
# references, emitting packages/shared/dist/*.js. Its manifest's default export is that output,
# which plain `node` loads and Vite's production build resolves; the `development` condition that
# `vite dev` and `vitest` set picks its TypeScript source instead.
RUN npx tsc -b packages/shared
# The admin guide that `zamfono.help` serves is bundled into the server chunk at build time by an
# `import.meta.glob` over `docs/guide/**/*.md` (§10.5), so those files are inputs to the build.
COPY docs/guide docs/guide
RUN npm run build -w packages/api
# The compile is done: the development dependencies (the TypeScript and test toolchain, the
# linters, the SvelteKit build tooling) leave node_modules before the runtime stage copies it.
# Without its lifecycle scripts: api's `prepare` runs `svelte-kit sync`, which the prune has just
# removed, and the native modules were built by `npm ci` already.
RUN npm prune --omit=dev --ignore-scripts

# images/runtime-base/Dockerfile, which docker-bake.hcl builds once for api and core alike.
FROM runtime-base
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx
WORKDIR /app
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
USER node

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. `api` reads its own
# copy from the environment and reports it alongside `ZAMFONO_VERSION` (server.ts).
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION
ENV ZAMFONO_REVISION=$ZAMFONO_REVISION

CMD ["node", "packages/api/build/server.js"]
