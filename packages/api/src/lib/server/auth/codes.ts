import { createHash, randomBytes } from 'node:crypto';

import { TtlMap } from '../ttlMap.js';

// §5.2: authorization codes live in `api`'s memory for 60 seconds, single-use.
export const CODE_TTL_MS = 60_000;
const CODE_BYTES = 32;

type IssueParams = {
  userId: string;
  clientId: string;
  redirectUri: string;
  /** The authorization request sent no `redirect_uri` (OAuth 2.1 §2.3.2), `redirectUri` being
   *  the client's single registered one; the token request may then omit it too. */
  redirectUriDefaulted?: boolean;
  codeChallenge: string;
  scope: string;
};

/** In-memory, single-use PKCE authorization codes (§5.2); an `api` restart voids every code. */
export class AuthCodeStore {
  readonly #now: () => number;
  readonly #codes: TtlMap<string, IssueParams>;

  constructor(now: () => number) {
    this.#now = now;
    this.#codes = new TtlMap(now);
  }

  /** Issues a code for `params`, valid for 60 seconds. */
  issue(params: IssueParams): string {
    const code = randomBytes(CODE_BYTES).toString('base64url');
    this.#codes.set(code, params, this.#now() + CODE_TTL_MS);
    return code;
  }

  /**
   * Redeems `code` once, verifying it against `clientId`, `redirectUri` and the S256 PKCE
   * verifier. The code is consumed whether or not the verification succeeds. A `redirectUri` of
   * `null`, a token request without one, passes only for a code whose authorization request sent
   * none either: OAuth 2.1 §10.2 has the server enforce the parameter as RFC 6749 §4.1.3 does,
   * required when the authorization request included it and identical when present.
   */
  redeem(
    code: string,
    codeVerifier: string,
    clientId: string,
    redirectUri: string | null
  ): { userId: string } | null {
    const record = this.#codes.get(code);
    this.#codes.delete(code);
    if (!record) {
      return null;
    }
    const redirectUriMatches =
      redirectUri === null
        ? record.redirectUriDefaulted === true
        : record.redirectUri === redirectUri;
    if (record.clientId !== clientId || !redirectUriMatches) {
      return null;
    }
    const computedChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    if (computedChallenge !== record.codeChallenge) {
      return null;
    }
    return { userId: record.userId };
  }
}

/**
 * Shared across the token endpoint (§5.2) and the login/consent page (§5.2 "Authentication
 * pages"), since a code issued by one must be redeemable by the other within the same process.
 */
export const authCodeStore = new AuthCodeStore(Date.now);
