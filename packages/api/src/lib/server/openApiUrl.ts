/** Where clients read the OpenAPI document (§10.3), and the build's variant of it with host control. */
export const OPENAPI_PATH = '/api/v1/openapi.json';
export const OPENAPI_HOST_CONTROL_PATH = '/api/v1/openapi-host-control.json';

/**
 * The URL adapter-node's handler is to serve for request URL `url` on a stack whose `.env` says
 * `hostControl`: the document's variant with the operations of host control in place of the
 * document while `HOST_CONTROL=true` (§6.3 "Host control"), `url` itself otherwise, and
 * `undefined`, a 404, for the variant's own path, which no stack offers as such.
 */
export function openApiUrl(
  url: string,
  hostControl: boolean
): string | undefined {
  const [pathname = '', ...query] = url.split('?');
  if (pathname === OPENAPI_HOST_CONTROL_PATH) {
    return undefined;
  }
  if (pathname === OPENAPI_PATH && hostControl) {
    return [OPENAPI_HOST_CONTROL_PATH, ...query].join('?');
  }
  return url;
}
