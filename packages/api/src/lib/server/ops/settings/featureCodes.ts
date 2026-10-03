import type { FeatureCodes } from '@zamfono/shared';

import { recordChange } from '../audit.js';
import type { Context } from '../types.js';
import type { SettingsColumns, SettingsRow } from './_shared.js';

/** Replaces the fixed-key `featureCodes` object wholesale, fully validated (§9.3). */
export function applyFeatureCodes(
  ctx: Context,
  before: SettingsRow,
  featureCodes: FeatureCodes | undefined,
  columns: SettingsColumns
): void {
  if (featureCodes === undefined) {
    return;
  }
  const json = JSON.stringify(featureCodes);
  if (json !== before.featureCodesJson) {
    recordChange(ctx, {
      field: 'featureCodes',
      from: JSON.parse(before.featureCodesJson) as FeatureCodes,
      to: featureCodes
    });
    columns.featureCodesJson = json;
  }
}
