# The updater service (docs/spec.md §6.3 "Updates"): a small HTTP API on the stack's internal
# network that asks GitHub for releases, judges an update with the stack directory's own
# `update.sh --check`, and hands it, a reboot or the host's upgrades to the host agent by a request
# file (deploy/setup/agent.sh). It holds no container runtime socket. Build from the repository
# root: `docker build -f images/updater/Dockerfile .`.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# The workspace's manifests before its sources, so a source change reuses the installed layer.
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/updater/package.json packages/updater/
# Only the TypeScript compiler is needed, so no package's native build runs.
RUN npm ci --ignore-scripts
COPY packages packages
RUN npx tsc -b packages/updater

FROM node:26-alpine
# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx
# What `update.sh --check` and `--current` need: bash, curl for the latest release, coreutils.
RUN apk add --no-cache bash curl coreutils
WORKDIR /app
COPY packages/updater/package.json package.json
COPY --from=build /app/packages/updater/dist dist
# Root inside the container, deliberately: .env, which `update.sh --check` reads, belongs to root,
# as does the request directory. With no socket and no host mount beyond the stack directory,
# read-only but for that directory, it is no root of the host.

ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

CMD ["node", "dist/main.js"]
