/**
 * How screens call operations: `run` passes the signed-in person and channel `ui`, asks the
 * confirmation an operation needs (§10.3 `confirm`), reports success with Undo where the audit entry
 * allows it (§5.8), and turns refusals into a toast naming what blocks them.
 */
import { ApiError } from '#lib/api/errors.js';
import {
  call,
  ConfirmationRequired,
  type ConfirmInfo
} from '#lib/api/ops/core.js';
import { store } from '#lib/api/store.svelte.js';
import { dictionaries, i18n, t } from '#lib/i18n/index.svelte.js';
import { currentActor } from '#lib/state/session.svelte.js';
import { confirmDialog, toast } from '#lib/state/ui.svelte.js';

export type RunResult<O> =
  { ok: true; value: O } | { ok: false; error: ApiError };

export type RunOptions = {
  /** i18n key of the success toast; omit for no toast (reads, inline saves with their own feedback). */
  success?: string;
  successParams?: Record<string, string | number>;
  /** Don't toast errors (the form shows them inline). Field errors are never toasted. */
  quietErrors?: boolean;
};

/** The confirmation dialog for `info`; true when confirmed. */
export function askConfirmation(info: ConfirmInfo): Promise<boolean> {
  return confirmDialog({
    title: t(`confirm.${info.key}.title`, info.params),
    body: t(`confirm.${info.key}.body`, info.params),
    confirmLabel: t(`confirm.${info.key}.action`, info.params),
    cancelLabel: t('common.cancel'),
    tone: info.destructive === true ? 'danger' : 'primary',
    note: info.irreversible === true ? t('confirm.irreversible') : null
  });
}

/** A field's label for an error message: the registry label `field.<entity>.<name>` of any
 * entity, else the name itself. */
function fieldLabel(name: string): string {
  const suffix = `.${name}`;
  const key = Object.keys(dictionaries[i18n.locale]).find(
    candidate => candidate.startsWith('field.') && candidate.endsWith(suffix)
  );
  return key === undefined ? name : t(key);
}

export function errorText(error: ApiError): string {
  const params: Record<string, string | number> = {
    ...error.params,
    message: error.message
  };
  for (const name of ['field', 'fields'] as const) {
    const value = params[name];
    if (typeof value === 'string') {
      params[name] = value.split(/,\s*/u).map(fieldLabel).join(', ');
    }
  }
  return t(`errors.${error.code}`, params);
}

export async function run<O = unknown>(
  name: string,
  input: unknown,
  options: RunOptions = {}
): Promise<RunResult<O>> {
  const actor = currentActor();
  const auditBefore = store.db.audit[0]?.id;
  let confirmed = false;
  for (;;) {
    try {
      const value = call<O>(name, input, { actor, channel: 'ui', confirmed });
      const entry = store.db.audit[0];
      const audited =
        entry !== undefined && entry.id !== auditBefore ? entry : null;
      if (options.success !== undefined) {
        toast({
          tone: 'success',
          title: t(options.success, options.successParams),
          operation: name,
          action:
            audited?.undoable === true
              ? {
                  label: t('common.undo'),
                  run: () =>
                    void run(
                      'audit.undo',
                      { id: audited.id },
                      { success: 'audit.undone' }
                    )
                }
              : null
        });
      }
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ConfirmationRequired && !confirmed) {
        if (!(await askConfirmation(error.info))) {
          return { ok: false, error };
        }
        confirmed = true;
        continue;
      }
      if (!(error instanceof ApiError)) {
        throw error;
      }
      if (options.quietErrors !== true && error.field === null) {
        toast({
          tone: 'error',
          title: errorText(error),
          refs: error.refs,
          operation: name
        });
      }
      return { ok: false, error };
    }
  }
}

/** Reads through an operation as the signed-in person, without toasts: the value, or `fallback`
 * when the operation refuses. Reactive when called inside `$derived`. */
export function read<O>(name: string, input: unknown, fallback: O): O {
  void store.revision;
  try {
    return call<O>(name, input, { actor: currentActor(), channel: 'ui' });
  } catch (error) {
    if (error instanceof ApiError) {
      return fallback;
    }
    throw error;
  }
}
