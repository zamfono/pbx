# Multi-stage build (docs/spec.md §6.3, §4). The build stage compiles @zamfono/core to plain
# JavaScript in the installed workspace; the runtime stage ships only that output, its
# dependencies and ffmpeg (recording mixdown, §10.2). Build from the repository root through
# bake, which supplies the workspace and runtime-base stages: `docker buildx bake --load core`.

# images/workspace/Dockerfile, the installed npm workspace docker-bake.hcl builds once for api and
# core alike.
FROM workspace AS build
# No per-package "build" script exists for @zamfono/shared or @zamfono/core: `tsc -b` on core's
# project reference also builds shared, emitting packages/core/dist/main.js and
# packages/shared/dist/*.js, the output shared's manifest exports by default.
RUN npx tsc -b packages/core
# The compile is done: the development dependencies (the TypeScript and test toolchain, the
# linters, the SvelteKit build tooling) leave node_modules before the runtime stage copies it.
# Without its lifecycle scripts: api's `postinstall` runs `svelte-kit sync`, which the prune has just
# removed, and the native modules were built by `npm ci` already.
RUN npm prune --omit=dev --ignore-scripts

# images/runtime-base/Dockerfile, which docker-bake.hcl builds once for api and core alike.
FROM runtime-base
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
USER node

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it. `core` reads its own
# copy from the environment and reports it alongside `ZAMFONO_VERSION` (main.ts).
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION
ENV ZAMFONO_REVISION=$ZAMFONO_REVISION

CMD ["node", "packages/core/dist/main.js"]
