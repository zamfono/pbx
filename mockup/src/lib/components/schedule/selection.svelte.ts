/**
 * Block selection and the exact-time popover of the schedule week grid: a click selects a block,
 * a further click on the selected block toggles its popover, and Delete/Backspace on a focused
 * block removes it.
 */
import type { WeekDrag } from './drag.svelte';
import {
  removeRange,
  setRange,
  type DayRange,
  type Week,
  type Weekday
} from './hours';

type BlockRef = { weekday: Weekday; index: number };

export class WeekSelection {
  selected = $state<BlockRef>();
  editing = $state<BlockRef>();
  editingAnchor = $state<HTMLElement | null>(null);

  readonly editingRange = $derived.by(() =>
    this.editing === undefined
      ? undefined
      : this.#week()[this.editing.weekday].at(this.editing.index)
  );

  readonly #dragging: WeekDrag;
  readonly #week: () => Week;
  readonly #onChange: (week: Week) => void;

  constructor(
    dragging: WeekDrag,
    week: () => Week,
    onChange: (week: Week) => void
  ) {
    this.#dragging = dragging;
    this.#week = week;
    this.#onChange = onChange;
  }

  isSelected = (weekday: Weekday, index: number): boolean =>
    this.selected?.weekday === weekday && this.selected.index === index;

  onBlockClick = (event: MouseEvent, weekday: Weekday, index: number) => {
    if (this.#dragging.suppressClick) {
      this.#dragging.suppressClick = false;
      return;
    }

    if (!this.isSelected(weekday, index)) {
      this.selected = { weekday, index };
      this.closeEditor();
      return;
    }

    if (this.editing !== undefined) {
      this.closeEditor();
      return;
    }

    this.editingAnchor = event.currentTarget as HTMLElement;
    this.editing = { weekday, index };
  };

  /** Removes the block at `weekday`/`index` (the focused one), unless its popover is open. */
  deleteBlock = (weekday: Weekday, index: number) => {
    if (this.editing !== undefined) {
      return;
    }

    const week = this.#week();
    this.selected = undefined;
    if (week[weekday].at(index) !== undefined) {
      this.#onChange(removeRange(week, weekday, index));
    }
  };

  /** Forgets the selection, e.g. after a drawn range re-sorted the day and shifted the indices. */
  clear = () => {
    this.selected = undefined;
    this.closeEditor();
  };

  closeEditor = () => {
    this.editing = undefined;
    this.editingAnchor = null;
  };

  updateEditing = (edge: keyof DayRange, value: string) => {
    if (this.editing !== undefined) {
      this.#onChange(
        setRange(this.#week(), this.editing.weekday, this.editing.index, {
          [edge]: value
        })
      );
    }
  };

  deleteEditing = () => {
    if (this.editing !== undefined) {
      const { weekday, index } = this.editing;
      this.closeEditor();
      this.selected = undefined;
      this.#onChange(removeRange(this.#week(), weekday, index));
    }
  };
}
