# The updater service (docs/spec.md §6.3 "Updates"): a small HTTP API on the stack's internal
# network that runs the stack directory's own update.sh for `system.update`, driving the runtime
# through its socket with the Docker CLI and Compose, which speak Docker's API and Podman's
# Docker-compatible one alike. Build from the repository root: `docker build -f
# images/updater/Dockerfile .`.
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
# update.sh's own needs: bash, curl, GNU tar and coreutils' `sha256sum -c`, and the Docker CLI
# with its Compose plugin for the runtime behind the mounted socket.
RUN apk add --no-cache bash curl tar coreutils docker-cli docker-cli-compose
WORKDIR /app
COPY packages/updater/package.json package.json
COPY --from=build /app/packages/updater/dist dist
# Root, deliberately: the socket it drives belongs to root, and it links the host's stack path
# inside its own filesystem at start (main.ts).

ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

CMD ["node", "dist/main.js"]
