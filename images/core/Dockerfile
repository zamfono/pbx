# Multi-stage build (docs/spec.md §6.3, §4). The build stage installs the whole npm workspace and
# compiles @zamfono/core to plain JavaScript; the runtime stage ships only that output, its
# dependencies and ffmpeg (recording mixdown, §10.2). Build from the repository root: `docker
# build -f images/core/Dockerfile .`.
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
# No per-package "build" script exists for @zamfono/shared or @zamfono/core: `tsc -b` on core's
# project reference also builds shared, emitting packages/core/dist/main.js and
# packages/shared/dist/*.js.
RUN npx tsc -b packages/core
# packages/shared's package.json points "exports"/"types" at its TypeScript source for `npm run
# dev`/`vitest`, which run it through a bundler or loader that rewrites the internal "./db.js"
# specifiers to "./db.ts"; plain `node` does not, so the runtime image below ships the compiled
# dist output instead and repoints exports/types at it here, image-local only.
RUN node -e "\
	const fs = require('node:fs'); \
	const file = 'packages/shared/package.json'; \
	const pkg = JSON.parse(fs.readFileSync(file, 'utf8')); \
	pkg.exports['.'] = './dist/index.js'; \
	pkg.types = './dist/index.d.ts'; \
	fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');"
# The compile is done: the development dependencies (the TypeScript and test toolchain, the
# linters, the SvelteKit build tooling) leave node_modules before the runtime stage copies it.
# Without its lifecycle scripts: api's `prepare` runs `svelte-kit sync`, which the prune has just
# removed, and the native modules were built by `npm ci` already.
RUN npm prune --omit=dev --ignore-scripts

FROM node:26-slim
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx
WORKDIR /app
# Byte for byte the same as images/api/Dockerfile's first runtime step: bake builds the two images
# in one run, builds an identical step once, and both images then share its ~460 MB layer, in CI's
# archive and in an operator's pull (deploy/test.sh checks that they do).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data /media \
	&& chown node:node /data /media
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY db/migrations db/migrations
ENV DB_FILE=/data/zamfono.sqlite3 \
	MEDIA_DIR=/media \
	MIGRATIONS_DIR=/app/db/migrations
USER node

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. `core` reads its own
# copy from the environment and reports it alongside `ZAMFONO_VERSION` (main.ts).
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION
ENV ZAMFONO_REVISION=$ZAMFONO_REVISION

CMD ["node", "packages/core/dist/main.js"]
