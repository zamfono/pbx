import {
  HTTP_UNPROCESSABLE_CONTENT,
  isCallPlaceholder,
  isTemplate,
  templateNames,
  type Db
} from '@zamfono/shared';

import type { TargetSpec } from './forwardTargetType.js';
import { OpError } from './types.js';

/**
 * Throws 422 for a template among `templates` that reads a top-level name which is no value of a
 * call (§9.4 "Templates"): one of the call's placeholders or one of `more`. The syntax and the
 * helpers are the field's own schema's to check; this is the part that needs the database.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- reads the database once a name can be a row's
export async function assertTemplateNames(
  _db: Db,
  templates: readonly string[],
  more: readonly string[] = []
): Promise<void> {
  const unknown = templates
    .filter(isTemplate)
    .flatMap(templateNames)
    .find(name => !isCallPlaceholder(name) && !more.includes(name));
  if (unknown !== undefined) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      `template: unknown placeholder '${unknown}'`
    );
  }
}

/** The templates `spec` itself holds (§9.4 "Templates"), its fallback's left to its own row: the
 * templated address of its kind and a `sip` target's header values. */
export function targetTemplates(spec: TargetSpec): string[] {
  if (spec.kind === 'external') {
    return [spec.external];
  }
  if (spec.kind === 'sip') {
    return [spec.user, ...spec.headers.map(header => header.value)];
  }
  if (spec.kind === 'webSocket') {
    return [spec.url];
  }
  return spec.kind === 'extension' ? [spec.extension] : [];
}
