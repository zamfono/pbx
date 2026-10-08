/**
 * The pointer drag engine of the schedule week grid: drawing a new range on a day column, moving
 * or resizing an existing block, and pushing the axis out while a drag holds an edge. It owns the
 * axis bounds, since a drag widens them beyond the stored ranges.
 */
import {
  clickedRange,
  drawnRange,
  gridBounds,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  movedRange,
  resizedRange,
  timeToMinutes,
  withRange
} from './grid';
import { setRange, type DayRange, type Week, type Weekday } from './hours';

/** Pointer travel below this stays a click: it selects or edits instead of starting a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Dragging within this distance of the axis edge pushes the boundary out … */
const EDGE_THRESHOLD_MINUTES = 15;
/** … by one hour at a time, at most this often, so the axis grows at a followable pace. */
const EDGE_EXTEND_REPEAT_MS = 250;

export type DragKind = 'draw' | 'move' | 'resize-start' | 'resize-end';

type DragState = {
  kind: DragKind;
  weekday: Weekday;
  index: number;
  anchor: number;
  grabOffset: number;
  moved: boolean;
  pointerId: number;
  preview: DayRange | undefined;
  startY: number;
};

export class WeekDrag {
  drag = $state<DragState>();
  /** Set when a block drag ended after moving, so the click that follows it is swallowed. */
  suppressClick = false;

  /**
   * Extra axis hours a drag has pushed beyond the stored ranges; cleared when the drag ends, when
   * the committed range itself keeps the axis extended.
   */
  extension = $state({ start: 0, end: 0 });

  readonly bounds = $derived.by(() => {
    const base = gridBounds(this.#week());
    return {
      start: Math.max(base.start - this.extension.start, 0),
      end: Math.min(base.end + this.extension.end, MINUTES_PER_DAY)
    };
  });
  readonly axisSpan = $derived(this.bounds.end - this.bounds.start);

  readonly #week: () => Week;
  readonly #onChange: (week: Week, kind: DragKind) => void;
  #dragColumn: HTMLElement | null = null;
  #lastEdgeExtend = 0;

  constructor(
    week: () => Week,
    onChange: (week: Week, kind: DragKind) => void
  ) {
    this.#week = week;
    this.#onChange = onChange;
  }

  #minutesAt = (column: HTMLElement, clientY: number): number => {
    const rect = column.getBoundingClientRect();
    return (
      this.bounds.start + ((clientY - rect.top) / rect.height) * this.axisSpan
    );
  };

  /** The stored range, or the drag's live preview while this block is being moved or resized. */
  shownRange = (weekday: Weekday, index: number, range: DayRange): DayRange =>
    this.drag !== undefined &&
    this.drag.kind !== 'draw' &&
    this.drag.moved &&
    this.drag.preview !== undefined &&
    this.drag.weekday === weekday &&
    this.drag.index === index
      ? this.drag.preview
      : range;

  beginDraw = (event: PointerEvent, weekday: Weekday) => {
    if (event.button !== 0 || this.drag !== undefined) {
      return;
    }

    const column = event.currentTarget as HTMLElement;
    this.#dragColumn = column;
    column.setPointerCapture(event.pointerId);
    this.drag = {
      kind: 'draw',
      weekday,
      index: -1,
      anchor: this.#minutesAt(column, event.clientY),
      grabOffset: 0,
      moved: false,
      pointerId: event.pointerId,
      preview: undefined,
      startY: event.clientY
    };
  };

  beginBlockDrag = (
    event: PointerEvent,
    weekday: Weekday,
    index: number,
    kind: Exclude<DragKind, 'draw'>
  ) => {
    if (event.button !== 0 || this.drag !== undefined) {
      return;
    }

    event.stopPropagation();

    const handle = event.currentTarget as HTMLElement;
    const column = handle.closest('[data-day-column]');
    if (!(column instanceof HTMLElement)) {
      return;
    }

    this.#dragColumn = column;
    handle.setPointerCapture(event.pointerId);

    const at = this.#minutesAt(column, event.clientY);
    const range = this.#week()[weekday][index];
    const startMinute =
      range === undefined ? undefined : timeToMinutes(range.start);

    this.drag = {
      kind,
      weekday,
      index,
      anchor: at,
      grabOffset:
        kind === 'move' && startMinute !== undefined ? at - startMinute : 0,
      moved: false,
      pointerId: event.pointerId,
      preview: undefined,
      startY: event.clientY
    };
  };

  #dragPreview = (state: DragState, at: number): DayRange | undefined => {
    const ranges = this.#week()[state.weekday];

    switch (state.kind) {
      case 'move':
        return movedRange(
          ranges,
          state.index,
          at - state.grabOffset,
          this.bounds
        );
      case 'resize-start':
        return resizedRange(ranges, state.index, 'start', at, this.bounds);
      case 'resize-end':
        return resizedRange(ranges, state.index, 'end', at, this.bounds);
      default:
        return drawnRange(ranges, state.anchor, at, this.bounds);
    }
  };

  move = (event: PointerEvent) => {
    if (event.pointerId !== this.drag?.pointerId || this.#dragColumn === null) {
      return;
    }

    if (
      !this.drag.moved &&
      Math.abs(event.clientY - this.drag.startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }

    const at = this.#minutesAt(this.#dragColumn, event.clientY);

    // Holding the drag at an axis edge pushes the boundary out, one hour per repeat interval, up
    // to 00:00 and 24:00; clamping picks up the widened bounds on the following pointer events.
    if (event.timeStamp - this.#lastEdgeExtend >= EDGE_EXTEND_REPEAT_MS) {
      if (
        at <= this.bounds.start + EDGE_THRESHOLD_MINUTES &&
        this.bounds.start > 0
      ) {
        this.#lastEdgeExtend = event.timeStamp;
        this.extension = {
          ...this.extension,
          start: this.extension.start + MINUTES_PER_HOUR
        };
      } else if (
        at >= this.bounds.end - EDGE_THRESHOLD_MINUTES &&
        this.bounds.end < MINUTES_PER_DAY
      ) {
        this.#lastEdgeExtend = event.timeStamp;
        this.extension = {
          ...this.extension,
          end: this.extension.end + MINUTES_PER_HOUR
        };
      }
    }

    this.drag = {
      ...this.drag,
      moved: true,
      preview: this.#dragPreview(this.drag, at)
    };
  };

  end = (event: PointerEvent) => {
    if (event.pointerId !== this.drag?.pointerId) {
      return;
    }

    const ended = this.drag;
    const week = this.#week();

    this.drag = undefined;
    this.#dragColumn = null;

    if (ended.kind === 'draw') {
      const range = ended.moved
        ? ended.preview
        : clickedRange(week[ended.weekday], ended.anchor, this.bounds);

      if (range !== undefined) {
        this.#onChange(withRange(week, ended.weekday, range), 'draw');
      }
    } else {
      this.suppressClick = ended.moved;

      if (ended.moved && ended.preview !== undefined) {
        this.#onChange(
          setRange(week, ended.weekday, ended.index, ended.preview),
          ended.kind
        );
      }
    }

    this.extension = { start: 0, end: 0 };
  };

  cancel = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointerId) {
      this.drag = undefined;
      this.#dragColumn = null;
      this.extension = { start: 0, end: 0 };
    }
  };
}
