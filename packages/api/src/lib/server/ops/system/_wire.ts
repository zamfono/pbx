import { z } from 'zod';

const RUN_STATES = ['idle', 'running', 'succeeded', 'failed'] as const;

const runFields = {
  state: z.enum(RUN_STATES),
  from: z.string().optional(),
  to: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional()
};

/** The updater's record of a run (`UpdateState`, §6.3 "Updates"), with who asked for it. */
export const updateStateOut = z.union([
  z.object({
    ...runFields,
    trigger: z.literal('manual'),
    by: z.string().describe('The owner who asked for the run.')
  }),
  z.object({ ...runFields, trigger: z.enum(['automatic', 'host']) }),
  z.object(runFields)
]);

/** The updater's `GET /status` (`UpdaterStatus`, §6.3 "Updates"). */
export const updaterStatusOut = z.object({
  current: z.string().nullable(),
  latest: z
    .object({ version: z.string(), url: z.string(), publishedAt: z.string() })
    .nullable(),
  latestError: z
    .string()
    .optional()
    .describe('Why latest is null when GitHub could not be asked.'),
  updatable: z
    .boolean()
    .describe(
      'Whether latest is newer and non-breaking: what system.update takes.'
    ),
  breaking: z
    .boolean()
    .describe(
      'Whether latest is newer and breaking: update.sh on the host takes it.'
    ),
  last: updateStateOut,
  unavailable: z
    .string()
    .optional()
    .describe('Why the updater cannot update at all.')
});

/** A process's version (`ZamfonoVersion`, §7 "Version"). */
export const versionOut = z.object({
  version: z.string(),
  revision: z.string(),
  display: z.string()
});
