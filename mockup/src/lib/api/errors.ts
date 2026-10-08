/**
 * The API's problem answers (§10.3): the status, a stable code the UI translates, the API's own
 * English message, and for a refused delete or undo the rows that block it.
 */

export type BlockingRef = {
  /** Entity kind as the audit log names it: `user`, `ringGroup`, `did`, … */
  kind: string;
  id: string;
  label: string;
};

export type ProblemStatus = 400 | 403 | 404 | 409 | 422 | 428 | 429 | 503;

export class ApiError extends Error {
  readonly status: ProblemStatus;
  /** i18n key under `errors.*`; `params` fill its placeholders. */
  readonly code: string;
  readonly params: Record<string, string | number>;
  readonly refs: BlockingRef[];
  /** The field a validation error belongs to, for inline form messages. */
  readonly field: string | null;

  constructor(
    status: ProblemStatus,
    code: string,
    message: string,
    options: {
      params?: Record<string, string | number>;
      refs?: BlockingRef[];
      field?: string;
    } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = options.params ?? {};
    this.refs = options.refs ?? [];
    this.field = options.field ?? null;
  }
}

export const forbidden = (message = 'forbidden'): ApiError =>
  new ApiError(403, 'forbidden', message);

export const notFound = (what: string, id: string): ApiError =>
  new ApiError(404, 'notFound', `${what} '${id}' not found`, {
    params: { what, id }
  });

export const invalid = (
  field: string,
  code: string,
  message: string,
  params: Record<string, string | number> = {}
): ApiError => new ApiError(422, code, message, { field, params });

export const conflict = (
  code: string,
  message: string,
  refs: BlockingRef[] = [],
  params: Record<string, string | number> = {}
): ApiError => new ApiError(409, code, message, { refs, params });
