<!--
  The exact-time popover of one week-grid block: start, end, removal and closing. It sits inside
  `container` (which must be positioned), beside the anchor block — right of it, or left when the
  container has no room. Escape, the done button and a pointer press outside close it; Escape
  and done return the focus to the block.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { t } from '#lib/i18n/index.svelte.js';

  import type { DayRange } from './hours';
  import RangeFields from './RangeFields.svelte';

  type Props = {
    id: string;
    day: string;
    anchor: HTMLElement | null;
    container: HTMLElement | undefined;
    range: DayRange;
    onClose: () => void;
    onDelete: () => void;
    onEdit: (edge: keyof DayRange, value: string) => void;
  };

  let { id, day, anchor, container, range, onClose, onDelete, onEdit }: Props =
    $props();

  const GAP_PX = 8;

  let popover = $state<HTMLDivElement>();
  let position = $state({ top: 0, left: 0 });

  const place = () => {
    if (anchor === null || container === undefined || popover === undefined) {
      return;
    }
    const block = anchor.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    const width = popover.offsetWidth;
    const right = block.right - frame.left + GAP_PX;
    const left =
      right + width <= frame.width
        ? right
        : Math.max(0, block.left - frame.left - GAP_PX - width);

    position = { top: Math.max(0, block.top - frame.top), left };
  };

  // Placement needs the rendered layout of block and popover, so it is measured after the DOM
  // updates; the block moves while its times are edited, hence the dependency on the range.
  $effect(() => {
    void range.start;
    void range.end;
    place();
  });

  /** Opening the popover moves the focus to its first field: the keyboard path to exact times. */
  const focusFirstField = (element: HTMLElement) => {
    element.querySelector('input')?.focus();
  };

  const closeToAnchor = () => {
    anchor?.focus();
    onClose();
  };
</script>

<svelte:window
  onresize={place}
  onkeydown={event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeToAnchor();
    }
  }}
/>

<svelte:document
  onpointerdown={event => {
    const target = event.target;
    if (
      target instanceof Node &&
      !popover?.contains(target) &&
      !anchor?.contains(target)
    ) {
      onClose();
    }
  }}
/>

<div
  bind:this={popover}
  {@attach focusFirstField}
  class="popover"
  role="dialog"
  aria-label={t('schedule.range.edit', { day })}
  style:top={`${position.top}px`}
  style:left={`${position.left}px`}
>
  <RangeFields {id} {day} {range} {onEdit} />
  <div class="actions">
    <button
      type="button"
      class="icon danger"
      aria-label={t('schedule.range.remove')}
      title={t('schedule.range.remove')}
      onclick={onDelete}
    >
      <Trash2 size={16} />
    </button>
    <button
      type="button"
      class="icon"
      aria-label={t('schedule.range.done')}
      title={t('schedule.range.done')}
      onclick={closeToAnchor}
    >
      <Check size={16} />
    </button>
  </div>
</div>

<style>
  .popover {
    position: absolute;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: max-content;
    max-width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }

  .actions {
    display: flex;
    gap: var(--space-1);
  }

  .icon {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }

  .icon:hover {
    background: var(--surface-3);
  }

  .icon.danger {
    color: var(--danger);
  }

  .icon.danger:hover {
    background: var(--danger-soft);
  }

  .icon:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
</style>
