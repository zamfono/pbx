FROM node:26-slim AS build

WORKDIR /migrations

# better-sqlite3 has no prebuilt binary for every image architecture and falls back to compiling
# its native addon; the toolchain only needs to exist for `npm ci`, not at runtime, so it stays
# out of the final image below.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY config.ts migrate.ts ./
COPY migrations ./migrations

FROM node:26-slim

# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

WORKDIR /migrations

COPY --from=build /migrations ./

ENV NODE_ENV=production
USER node

# The commit this image was built from (§6.3 "Images", §7 "Version"), passed by
# docker-bake.hcl's REVISION variable. Declared this late so a value that changes on every build
# — every commit gets its own — never busts the cache of any layer above it.
ARG ZAMFONO_REVISION
LABEL org.opencontainers.image.revision=$ZAMFONO_REVISION

# Retries only a briefly locked database file; a migration that fails on its own merits exits 1
# at once (§6.3 "Migrations", `migrate.ts`).
CMD ["node", "migrate.ts"]
