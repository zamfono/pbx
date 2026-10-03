/** The HTTP status codes api and core answer with or read from a response, named as in RFC 9110 §15. */
export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_ACCEPTED = 202;
export const HTTP_NO_CONTENT = 204;
export const HTTP_FOUND = 302;
export const HTTP_SEE_OTHER = 303;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_CONTENT_TOO_LARGE = 413;
export const HTTP_UNPROCESSABLE_CONTENT = 422;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_INTERNAL_SERVER_ERROR = 500;
export const HTTP_BAD_GATEWAY = 502;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** The media type of an RFC 9457 problem details body. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
