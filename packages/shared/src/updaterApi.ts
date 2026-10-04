/**
 * The updater's HTTP API (§6.3 "Updates"), which `api` calls on the stack's internal network:
 * `GET /status` and `POST /update`, each with `UPDATER_TOKEN`.
 */

/**
 * An update's record in the stack directory's `.update/state.json`, which the updater writes for
 * its own runs and `update.sh` on the host for its own, so it outlives the updater.
 */
export type UpdateState = {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  from?: string;
  to?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
} & (RunTrigger | { trigger?: undefined });

/** Who asks for a run in `POST /update`'s body, recorded with it: an owner through
 * `system.update`, whom `by` names, or `api`'s automatic update. */
export type RunRequester =
  { trigger: 'manual'; by: string } | { trigger: 'automatic' };

/** Who asked for a recorded run: a `RunRequester`, or `update.sh` run on the host. Absent from
 * the record while it holds no run. */
export type RunTrigger = RunRequester | { trigger: 'host' };

/** `GET /status`. */
export type UpdaterStatus = {
  current: string | null;
  /** On an `edge` stack, `commit` names main's newest build. */
  latest: {
    version: string;
    url: string;
    publishedAt: string;
    commit?: string;
  } | null;
  /** Why `latest` is null when GitHub could not be asked. */
  latestError?: string;
  /** Whether `latest` is newer than `current` and non-breaking: what `POST /update` takes. */
  updatable: boolean;
  /** Whether `latest` is newer and breaking: `update.sh` on the host takes it. */
  breaking: boolean;
  last: UpdateState;
  /** Why the updater cannot update at all, such as a container without Compose labels. */
  unavailable?: string;
};
