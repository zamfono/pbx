# The one-shot schema migration (docs/spec.md §6.3 "Migrations"). `db/` is a workspace of the root
# package, so the build stage installs from the root lockfile, which locks kysely and
# better-sqlite3 once for the migrations and the app, but only the `db` workspace's production
# dependencies. The runtime stage keeps the workspace's layout under /app, the root's hoisted
# node_modules beside db/ with any of db's own that npm nests under db/node_modules, so every
# module resolves as in a checkout; db/package.json carries the `deploy` script migrate.ts runs.
# Build from the repository root: `docker build -f images/migrate/Dockerfile .`.
FROM node:26-slim AS build

WORKDIR /app

# better-sqlite3 has no prebuilt binary for every image architecture and falls back to compiling
# its native addon; the toolchain only needs to exist for `npm ci`, not at runtime, so it stays
# out of the final image below.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY db/package.json db/
# `--workspace db` installs the db workspace's dependencies alone, none of the root's or the other
# workspaces', and `--omit=dev` leaves out its type packages, which nothing needs at run time.
RUN npm ci --workspace db --omit=dev

FROM node:26-slim

# Links the published package to its repository (§6.3 "Images").
LABEL org.opencontainers.image.source=https://github.com/zamfono/pbx

WORKDIR /app/db

COPY --from=build /app /app
COPY db/config.ts db/migrate.ts ./
COPY db/migrations ./migrations

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
