# The images CI builds (§6.3 "Images", §8): the five the stack ships plus the TLS/SRTP scenario's
# baresip device, built in parallel by `docker buildx bake` from ci.yaml's `images` job. Each
# target keeps the Dockerfile and context the separate `docker build`s used before, and its tag
# comes from the variable of the same name in ci.yaml's env block, so the workflow stays the one
# place that names them.
#
# Local run, no cache and no registry involved:
#   docker buildx bake --load
# which tags the images zamfono/<name>:ci, as CI does. Point the *_IMAGE variables elsewhere to
# keep a set of :ci images already loaded, e.g. `MIGRATE_IMAGE=zamfono/migrate:mine …`.

variable "MIGRATE_IMAGE" { default = "zamfono/migrate:ci" }
variable "CORE_IMAGE" { default = "zamfono/core:ci" }
variable "API_IMAGE" { default = "zamfono/api:ci" }
variable "ASTERISK_IMAGE" { default = "zamfono/asterisk:ci" }
variable "PROXY_IMAGE" { default = "zamfono/proxy:ci" }
variable "DEVICES_IMAGE" { default = "zamfono/test-devices:ci" }

# `gha` reads (CACHE_FROM) or writes (CACHE_TO) the GitHub Actions layer cache, one scope per
# target; empty, the default, means no cache at all, which is what a local run gets. ci.yaml
# decides which of the two a run uses and says why.
variable "CACHE_FROM" { default = "" }
variable "CACHE_TO" { default = "" }

# The full commit these images are built from (docs/spec.md §6.3 "Images", §7 "Version"), a build
# arg on the five stack images alone; test-devices ships to no registry and reports no version.
# Default empty, so a local `bake --load` still builds, just with no revision label or env.
variable "REVISION" { default = "" }

function "cache_from" {
  params = [scope]
  result = CACHE_FROM == "gha" ? ["type=gha,scope=${scope}"] : []
}

# mode=max keeps the build stages' layers too, not only the final image's: the node images do
# their `npm ci` and compile in a `build` stage that a min-mode cache would drop.
function "cache_to" {
  params = [scope]
  result = CACHE_TO == "gha" ? ["type=gha,scope=${scope},mode=max"] : []
}

group "default" {
  targets = ["migrate", "core", "api", "asterisk", "proxy", "test-devices"]
}

target "migrate" {
  context    = "db"
  dockerfile = "Dockerfile"
  tags       = [MIGRATE_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("migrate")
  cache-to   = cache_to("migrate")
}

target "core" {
  context    = "."
  dockerfile = "images/core/Dockerfile"
  tags       = [CORE_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("core")
  cache-to   = cache_to("core")
}

target "api" {
  context    = "."
  dockerfile = "images/api/Dockerfile"
  tags       = [API_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("api")
  cache-to   = cache_to("api")
}

target "asterisk" {
  context    = "images/asterisk"
  dockerfile = "Dockerfile"
  tags       = [ASTERISK_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("asterisk")
  cache-to   = cache_to("asterisk")
}

target "proxy" {
  context    = "."
  dockerfile = "images/proxy/Dockerfile"
  tags       = [PROXY_IMAGE]
  args       = { ZAMFONO_REVISION = REVISION }
  cache-from = cache_from("proxy")
  cache-to   = cache_to("proxy")
}

target "test-devices" {
  context    = "test/load/stress/devices"
  dockerfile = "Dockerfile"
  tags       = [DEVICES_IMAGE]
  cache-from = cache_from("test-devices")
  cache-to   = cache_to("test-devices")
}
