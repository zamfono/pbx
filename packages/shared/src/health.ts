/**
 * The health document `api`'s and `core`'s `GET /healthz` answer (§6.3 "Health"):
 * `application/health+json` after draft-inadarei-api-health-check-06. `api` parses `core`'s with
 * `healthDocumentSchema` and copies its checks into its own.
 */
import { z } from 'zod';

import { HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from './httpStatus.js';

export const HEALTH_CONTENT_TYPE = 'application/health+json';

/** In order of severity: a document's status is the worst of its checks'. */
const HEALTH_STATUSES = ['pass', 'warn', 'fail'] as const;
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthCheckSchema = z.object({
  status: healthStatusSchema,
  observedValue: z.union([z.string(), z.number()]).optional(),
  /** A short fixed word, never a host name, address or a server's message. */
  output: z.string().optional(),
  /** ISO 8601 UTC, when a background check last ran. */
  time: z.string().optional()
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

/** Keyed `<component>:<measurement>`, each an array of one check. */
export const healthChecksSchema = z.record(
  z.string(),
  z.tuple([healthCheckSchema])
);
export type HealthChecks = z.infer<typeof healthChecksSchema>;

export const healthDocumentSchema = z.object({
  status: healthStatusSchema,
  checks: healthChecksSchema
});
export type HealthDocument = z.infer<typeof healthDocumentSchema>;

/** The document of `checks`, its status the worst of theirs (`pass` for none). */
export function healthDocument(checks: HealthChecks): HealthDocument {
  const found = Object.values(checks).map(([check]) => check.status);
  const status =
    HEALTH_STATUSES.findLast(severity => found.includes(severity)) ?? 'pass';
  return { status, checks };
}

/** 200 for `pass` and `warn`, 503 for `fail`. */
export function healthHttpStatus(document: HealthDocument): number {
  return document.status === 'fail' ? HTTP_SERVICE_UNAVAILABLE : HTTP_OK;
}
