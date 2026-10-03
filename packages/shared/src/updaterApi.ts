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
  /** Who asked: an owner through `system.update` (`by` names them), the automatic update, or
   * `update.sh` run on the host. Absent while no run is recorded. */
  trigger?: 'manual' | 'automatic' | 'host';
  by?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

/** `GET /status`. */
export type UpdaterStatus = {
  current: string | null;
  latest: { version: string; url: string; publishedAt: string } | null;
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

/** Who asks for a run in `POST /update`'s body, recorded with it: `api`, for an owner or for its
 * automatic update. `by` is optional. */
export type RunRequester = { trigger: 'manual' | 'automatic'; by?: string };
