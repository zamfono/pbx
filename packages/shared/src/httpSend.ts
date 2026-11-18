/**
 * The one function that sends an HTTP request an admin configured (§3.1 "Outbound targets",
 * §10.6): a webhook delivery, an after-call request and a call flow's HTTP request. One request,
 * no retry and no redirect followed; the caller decides what a failure means. Why one failed is
 * a short reason naming the HTTP status or the class of error.
 */
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { HTTP_OK } from './httpStatus.js';
import {
  FORBIDDEN_ADDRESS_CODE,
  literalRefusal,
  PLAINTEXT_PUBLIC_CODE,
  PLAINTEXT_PUBLIC_REASON,
  urlLookup,
  type TargetPolicy
} from './outboundTargets.js';

/** The methods a request may have; `GET` and `DELETE` send no body. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Whether a request of `method` carries a body. */
export function sendsBody(method: HttpMethod): boolean {
  return method !== 'GET' && method !== 'DELETE';
}

/** The header a signed request carries: the HMAC-SHA256 of its body under the secret, in hex. */
export const SIGNATURE_HEADER = 'X-Zamfono-Signature';

/** `body`'s signature under `secret` (§10.6). */
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// A 2xx is an answer; a 3xx is not, since no redirect is followed.
const HTTP_MULTIPLE_CHOICES = 300;

/** Whether `status` is a 2xx. */
export function isSuccess(status: number): boolean {
  return status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES;
}

const RESPONSE_TOO_LARGE_CODE = 'ERR_RESPONSE_TOO_LARGE';

export type HttpSend = {
  method: HttpMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  /** Sent unless the method sends none; signed, body or not, when `secret` is given. */
  body?: string;
  contentType?: string;
  secret?: string | null;
  timeoutMs: number;
  /** The addresses the request may connect to; `null` connects to any, for a test's receiver
   * on loopback. */
  policy: TargetPolicy | null;
  /** Reads the response body up to this many bytes and fails a longer one; left out, the body
   * is discarded. */
  maxResponseBytes?: number;
};

/** The receiver's answer: its status, and its body where one was asked for. */
export type HttpAnswer = { status: number; body: string | null };

/**
 * Sends `send` over `node:http(s)` rather than `fetch`, whose socket takes no `lookup`: the
 * host's addresses are checked against the policy as the socket connects (`targetLookup`), an
 * address literal before, and a plaintext URL connects to a private address alone. A redirect is
 * not followed, so it cannot lead where the check did not look: its 3xx is the answer. Rejects
 * when the receiver never answered, its body is too large or the deadline passed.
 */
export function sendHttpRequest(send: HttpSend): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const target = new URL(send.url);
    const refusal =
      send.policy === null ? null : literalRefusal(target, send.policy);
    if (refusal !== null) {
      reject(refusal);
      return;
    }
    const body = sendsBody(send.method) ? (send.body ?? '') : '';
    const headers: Record<string, string> = { ...send.headers };
    if (sendsBody(send.method) && send.contentType !== undefined) {
      headers['Content-Type'] = send.contentType;
    }
    if (typeof send.secret === 'string') {
      headers[SIGNATURE_HEADER] = signBody(send.secret, body);
    }
    const limit = send.maxResponseBytes;
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      {
        method: send.method,
        headers,
        signal: AbortSignal.timeout(send.timeoutMs),
        ...(send.policy === null
          ? {}
          : { lookup: urlLookup(target, send.policy) })
      },
      response => {
        const status = response.statusCode ?? 0;
        if (limit === undefined) {
          response.resume();
          resolve({ status, body: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            reject(
              Object.assign(new Error('response too large'), {
                code: RESPONSE_TOO_LARGE_CODE
              })
            );
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        });
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.end(sendsBody(send.method) ? body : undefined);
  });
}

// The `code`s Node's DNS lookup, its TLS layer and its sockets fail a request with.
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/u;
const SOCKET_REASONS: Record<string, string> = {
  [FORBIDDEN_ADDRESS_CODE]: 'forbidden address',
  [PLAINTEXT_PUBLIC_CODE]: PLAINTEXT_PUBLIC_REASON,
  [RESPONSE_TOO_LARGE_CODE]: 'response too large',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable'
};

/** The `code` of `error` or of the error it wraps. */
function errorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/** A failed response's reason: its HTTP status. */
export function httpReason(status: number): string {
  return `HTTP ${String(status)}`;
}

/** Why a request that never got a usable response failed: a timeout, DNS, an address the stack
 * refuses to connect to (§3.1 "Outbound targets"), TLS, the connection. */
export function errorReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  const code = errorCode(error);
  if (code === undefined) {
    return 'network error';
  }
  if (DNS_CODES.has(code)) {
    return 'DNS lookup failed';
  }
  if (TLS_CODE.test(code)) {
    return `TLS error ${code}`;
  }
  return SOCKET_REASONS[code] ?? `network error ${code}`;
}
