/**
 * What `api`'s updater (§6.3 "Updates", packages/api's `lib/server/updater/`) reads and answers:
 * an update's record, who asked for it, the update status and the host agent's report of the host.
 */

/**
 * An update's record in the stack directory's `.update/state.json`, which `update.sh` writes for
 * every run, the host agent's and one started on the host alike.
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

/** Who asks in `POST /update`'s body: a `RunRequester`, and for an owner's run whether it may
 * take a breaking release, which the automatic update never does. */
export type UpdateRequester =
  RunRequester | { trigger: 'manual'; by: string; breaking: boolean };

/** Who asked for a recorded run: a `RunRequester`, or `update.sh` run on the host. Absent from
 * the record while it holds no run. */
export type RunTrigger = RunRequester | { trigger: 'host' };

/** `GET /status` and `POST /check`. */
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
  /** Whether `latest` is newer and breaking: `POST /update` with `breaking`, or `update.sh` on
   * the host, takes it. */
  breaking: boolean;
  last: UpdateState;
  /** Why the stack cannot be updated through `api` at all, such as no host agent. */
  unavailable?: string;
};

/**
 * `GET /host`, `POST /host/updates` and `POST /host/reboot` (§6.3 "Host control"), only while
 * `HOST_CONTROL` is `true`: what the host agent reports of the host the stack runs on.
 */
export type HostStatus = {
  /** Since when the host waits for a reboot, by `/run/reboot-required`, and the packages
   * `reboot-required.pkgs` names; `null` while it waits for none. */
  rebootRequired: { since: string; packages: string[] } | null;
  /** Whether the host's unattended upgrades are Zamfono's (`setup/host-updates.sh`'s apt file);
   * `null` on a host without apt. */
  updates: boolean | null;
  /** Why the host may not be rebooted from the stack: a Podman stack without its boot unit would
   * not come back. */
  rebootRefused?: string;
};
