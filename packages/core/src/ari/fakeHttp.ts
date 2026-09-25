// Pure HTTP helpers for FakeAri, split out to keep fake.ts under the file size limit.
import type http from 'node:http';

export type RouteResult = { status: number; body: unknown };

/** Splits `<prefix><id>` or `<prefix><id>/<action>` into its id and action segments. */
export function splitResource(
  path: string,
  prefix: string
): { id: string; action: string } {
  const rest = path.slice(prefix.length);
  const slashIndex = rest.indexOf('/');
  return slashIndex === -1
    ? { id: rest, action: '' }
    : { id: rest.slice(0, slashIndex), action: rest.slice(slashIndex + 1) };
}

export function parseBody(chunks: Buffer[]): unknown {
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

export function sendResult(
  response: http.ServerResponse,
  result: RouteResult
): void {
  if (result.body === undefined) {
    response.writeHead(result.status);
    response.end();
    return;
  }
  response.writeHead(result.status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(result.body));
}
