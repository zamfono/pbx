/**
 * The stack's version (§7 "Version"): the tag `api` and `core` were deployed under and the
 * commit their images were built from, neither of which is baked into the image as a version
 * number — only the commit is (§6.3 "Images"), since a release is the edge build retagged, never
 * rebuilt. `ZAMFONO_VERSION` comes from Compose (`.env`, default `latest`); `ZAMFONO_REVISION`
 * comes from the image itself, set by the Dockerfile's build arg. A local dev run (`vite dev`,
 * `vitest`) sets neither, so both fall back: `dev` with no parenthesis at all, since a revision-
 * less version has nothing to disambiguate.
 */
const DEV_VERSION = 'dev';
const SHORT_REVISION_LENGTH = 7;

export type ZamfonoVersion = {
  /** `ZAMFONO_VERSION`, or `'dev'` when unset. */
  version: string;
  /** The full `ZAMFONO_REVISION`, or `''` when unset — `/metrics` wants the full commit. */
  revision: string;
  /** `<version> (<short revision>)`, or just `<version>` without a revision. */
  display: string;
};

/** Compose's own `${VAR:-default}` (§6.3 "Compose stack"): unset and empty both take `fallback`. */
function trimmedOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}

/**
 * Reads `ZAMFONO_VERSION`/`ZAMFONO_REVISION` off `env` (`process.env`, or SvelteKit's
 * `$env/dynamic/private` in api) into the three forms api, core, /metrics and the MCP
 * `serverInfo` each want. Typed as a whole environment: SvelteKit types its `env` with the
 * variables set where the types were generated, which need not include either of these two.
 */
export function resolveVersion(
  env: Readonly<Record<string, string | undefined>>
): ZamfonoVersion {
  const version = trimmedOr(env.ZAMFONO_VERSION, DEV_VERSION);
  const revision = trimmedOr(env.ZAMFONO_REVISION, '');
  const display = revision
    ? `${version} (${revision.slice(0, SHORT_REVISION_LENGTH)})`
    : version;
  return { version, revision, display };
}
