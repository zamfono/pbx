# The build stage the api and core images both start from (docs/spec.md §6.3 "Images"): the whole
# npm workspace installed, with the toolchain its native modules may need. docker-bake.hcl builds
# it once as the `workspace` target and hands it to both as a build context; each compiles its own
# package on top and prunes the development dependencies before its runtime stage copies
# node_modules. It is never published.
FROM node:26-slim
WORKDIR /app
# better-sqlite3 (via @zamfono/shared) falls back to compiling from source when no prebuild
# matches this platform's Node ABI; the toolchain never reaches a runtime stage.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# The workspace's manifests before its sources, so a source change reuses the installed layer.
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/updater/package.json packages/updater/
RUN npm ci
COPY packages packages
