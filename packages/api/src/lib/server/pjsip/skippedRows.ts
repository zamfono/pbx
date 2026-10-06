// The rows the render leaves out (§3.1 "Config propagation"): a value it cannot write into
// Asterisk's configuration takes its whole row out of the files, the other rows still rendered.

/** The kinds of row the render writes from. */
export const SKIPPED_ROW_TYPES = [
  'user',
  'device',
  'ringGroup',
  'parkingSlot',
  'trunk',
  'audioAsset'
] as const;

/**
 * A row the render left out, since a value of it cannot be written into the config (§3.1 "Config
 * propagation"): the object's type and id and the value's field, `<object>.<column>`; never the
 * value itself.
 */
export type SkippedRow = {
  type: (typeof SKIPPED_ROW_TYPES)[number];
  id: string;
  field: string;
};

/** A value of a row the render cannot write out; the render leaves that row out. */
export class UnrenderableValueError extends Error {
  constructor(readonly field: string) {
    super(`render: unrenderable value for ${field}`);
  }
}

/**
 * The sections of every row of `rows` the render can write, in order; a row with a value it
 * cannot is left out whole and added to `skipped`, so one such row never keeps the others from
 * Asterisk (§3.1 "Config propagation").
 */
export function renderRows<Row>(
  rows: readonly Row[],
  identify: (row: Row) => Pick<SkippedRow, 'type' | 'id'>,
  renderRow: (row: Row) => string[],
  skipped: SkippedRow[]
): string[] {
  return rows.flatMap(row => {
    try {
      return renderRow(row);
    } catch (error) {
      if (!(error instanceof UnrenderableValueError)) {
        throw error;
      }
      skipped.push({ ...identify(row), field: error.field });
      return [];
    }
  });
}
