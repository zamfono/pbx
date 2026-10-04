# The images CI builds (§6.3 "Images", §8): the six the stack ships, which the `stack` group below
# is the one list of, plus the TLS/SRTP scenario's baresip device, built in parallel by `docker
# buildx bake` from ci.yaml's `images` job. The workflows that publish, promote or prune the
# stack's images read the names from that group (.github/scripts/stack-images.sh). Each target's
# tag is the *_IMAGE variable of the same name; scripts/image-env.sh prints them for ci.yaml and
# the harnesses, so the names and tags below are the only place either is written.
#
# Local run, no cache and no registry involved:
#   docker buildx bake --load
# which tags the images zamfono/<name>:ci, as CI does. TAG picks another tag for all of them
# (test/load runs TAG=load, test/load/stress TAG=stress); a *_IMAGE variable names one image
# outright, e.g. `MIGRATE_IMAGE=zamfono/migrate:mine …`.

variable "TAG" { default = "ci" }
variable "MIGRATE_IMAGE" { default = "zamfono/migrate:${TAG}" }
variable "CORE_IMAGE" { default = "zamfono/core:${TAG}" }
variable "API_IMAGE" { default = "zamfono/api:${TAG}" }
variable "ASTERISK_IMAGE" { default = "zamfono/asterisk:${TAG}" }
variable "PROXY_IMAGE" { default = "zamfono/proxy:${TAG}" }
variable "UPDATER_IMAGE" { default = "zamfono/updater:${TAG}" }
variable "DEVICES_IMAGE" { default = "zamfono/test-devices:${TAG}" }

# `gha` reads (CACHE_FROM) or writes (CACHE_TO) the GitHub Actions layer cache, one scope per
# target; empty, the default, means no cache at all, which is what a local run gets. ci.yaml
# decides which of the two a run uses and says why.
variable "CACHE_FROM" { default = "" }
variable "CACHE_TO" { default = "" }

# FRESH builds every layer anew, reading no cache: ci.yaml sets it on a push to main, whose images
# `publish` pushes, so each carries the current Debian and Node layers and the packages resolved
# today. One stage is the exception: proxy's `build`, which compiles Caddy with its plugin from
# inputs pinned in images/proxy/Dockerfile (the builder image, whose tag's current digest is part
# of the cache key, Caddy's version, the plugin's), so a cached binary is the one a fresh compile
# would produce, three minutes sooner. Its runtime stage, which ships, is built fresh like the rest.
variable "FRESH" { default = false }

# The full commit these images are built from (docs/spec.md §6.3 "Images", §7 "Version"), a build
# arg on the six stack images alone; test-devices ships to no registry and reports no version.
# Default empty, so a local `bake --load` still builds, just with no revision label or env.
variable "REVISION" { default = "" }

function "cache_from" {
  params = [scope]
  result = CACHE_FROM == "gha" ? ["type=gha,scope=${scope}"] : []
}

# The cache proxy's pinned build stage reads in CI whether or not the run is FRESH.
function "pinned_cache_from" {
  params = [scope]
  result = CACHE_TO == "gha" ? ["type=gha,scope=${scope}"] : []
}

# mode=max keeps the build stages' layers too, not only the final image's: the node images do
# their `npm ci` and compile in a `build` stage that a min-mode cache would drop.
function "cache_to" {
  params = [scope]
  result = CACHE_TO == "gha" ? ["type=gha,scope=${scope},mode=max"] : []
}

group "stack" {
  targets = ["asterisk", "migrate", "core", "api", "proxy", "updater"]
}

group "default" {
  targets = ["stack", "test-devices"]
}

target "migrate" {
  context    = "."
  dockerfile = "images/migrate/Dockerfile"
  tags       = [MIGRATE_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("migrate")
  cache-to   = cache_to("migrate")
  no-cache   = FRESH
}

# api's and core's common runtime stage, built once and handed to both as the `runtime-base`
# context, so the two images share its layer by construction. It has no tag: nothing publishes it.
target "runtime-base" {
  context    = "images/runtime-base"
  dockerfile = "Dockerfile"
  cache-from = cache_from("runtime-base")
  cache-to   = cache_to("runtime-base")
  no-cache   = FRESH
}

# The installed npm workspace api's and core's build stages start from, handed to both as the
# `workspace` context, so `npm ci` runs once for the two. It has no tag: nothing publishes it.
target "workspace" {
  context    = "."
  dockerfile = "images/workspace/Dockerfile"
  cache-from = cache_from("workspace")
  cache-to   = cache_to("workspace")
  no-cache   = FRESH
}

target "core" {
  context    = "."
  dockerfile = "images/core/Dockerfile"
  contexts   = { workspace = "target:workspace", runtime-base = "target:runtime-base" }
  tags       = [CORE_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("core")
  cache-to   = cache_to("core")
  no-cache   = FRESH
}

target "api" {
  context    = "."
  dockerfile = "images/api/Dockerfile"
  contexts   = { workspace = "target:workspace", runtime-base = "target:runtime-base" }
  tags       = [API_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("api")
  cache-to   = cache_to("api")
  no-cache   = FRESH
}

target "asterisk" {
  context    = "images/asterisk"
  dockerfile = "Dockerfile"
  tags       = [ASTERISK_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("asterisk")
  cache-to   = cache_to("asterisk")
  no-cache   = FRESH
}

target "proxy" {
  context    = "."
  dockerfile = "images/proxy/Dockerfile"
  tags       = [PROXY_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = pinned_cache_from("proxy")
  cache-to   = cache_to("proxy")
  # Everything but the `build` stage, which FRESH leaves to the cache (see FRESH above).
  no-cache-filter = FRESH ? ["runtime"] : []
}

target "updater" {
  context    = "."
  dockerfile = "images/updater/Dockerfile"
  tags       = [UPDATER_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("updater")
  cache-to   = cache_to("updater")
  no-cache   = FRESH
}

target "test-devices" {
  context    = "test/load/stress/devices"
  dockerfile = "Dockerfile"
  tags       = [DEVICES_IMAGE]
  cache-from = cache_from("test-devices")
  cache-to   = cache_to("test-devices")
  no-cache   = FRESH
}
