import {
  HTTP_UNPROCESSABLE_CONTENT,
  validateFeatureCodes,
  type FeatureCodes
} from '@zamfono/shared';

import { recordChange } from '../runner.js';
import { OpError, type Context } from '../types.js';
import type { SettingsRow } from './_shared.js';

function parseFeatureCodes(input: Record<string, string>): FeatureCodes {
  try {
    return validateFeatureCodes(input);
  } catch (err) {
    throw new OpError(
      HTTP_UNPROCESSABLE_CONTENT,
      err instanceof Error ? err.message : 'featureCodes: invalid'
    );
  }
}

/** Replaces the fixed-key `featureCodes` object wholesale, fully validated (§9.3). */
export function applyFeatureCodes(
  ctx: Context,
  before: SettingsRow,
  featureCodes: Record<string, string> | undefined,
  columns: Record<string, unknown>
): void {
  if (featureCodes === undefined) {
    return;
  }
  const validated = parseFeatureCodes(featureCodes);
  const json = JSON.stringify(validated);
  if (json !== before.featureCodesJson) {
    recordChange(ctx, {
      field: 'featureCodes',
      from: JSON.parse(before.featureCodesJson) as FeatureCodes,
      to: validated
    });
    columns.featureCodesJson = json;
  }
}
