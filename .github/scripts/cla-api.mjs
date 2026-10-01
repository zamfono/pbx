// The slice of GitHub's REST API the CLA check (cla.mjs) uses, reached through github-script's
// `github.request` and `github.paginate` and read defensively: every response is `unknown` until a
// field is checked.

/** @typedef {(route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>} Request */
/** @typedef {(route: string) => Promise<unknown[]>} Paginate Every item of a list endpoint, all pages. */
/** @typedef {{ owner: string, repo: string }} Repo */
/** @typedef {{ id: number, login: string }} Person */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function record(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {unknown} error
 * @param {number} status
 * @returns {boolean}
 */
export function hasStatus(error, status) {
  return isRecord(error) && error.status === status;
}

/**
 * A GitHub account from an API object, or null for anything else (a commit whose e-mail address
 * no account claims has a null author).
 * @param {unknown} value
 * @returns {(Person & { bot: boolean }) | null}
 */
export function personOf(value) {
  const person = record(value);
  if (typeof person.id !== 'number' || typeof person.login !== 'string') {
    return null;
  }
  return { id: person.id, login: person.login, bot: person.type === 'Bot' };
}
