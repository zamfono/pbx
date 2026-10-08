<!--
  One call of the history as a list row: direction, the other party, what happened, when and how
  long. Missed calls that came in show in the danger tone.
-->
<script lang="ts">
  import Disc3 from '@lucide/svelte/icons/disc-3';
  import PhoneMissed from '@lucide/svelte/icons/phone-missed';

  import { ringGroupById, userById } from '#lib/api/lookup.js';
  import type { CallOut } from '#lib/api/ops/areas/calls.js';
  import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import {
    formatDate,
    formatDuration,
    formatTime,
    t
  } from '#lib/i18n/index.svelte.js';
  import Icon from '#lib/ui/Icon.svelte';

  import CallStatusBadge from './CallStatusBadge.svelte';
  import {
    cameIn,
    counterpartOf,
    DIRECTION_ICON,
    isMissed,
    party,
    talkSeconds
  } from './labels';

  type Props = {
    call: CallOut;
    /** Whose side the row is told from; null for the whole company. */
    perspective: string | null;
    recorded?: boolean;
    selected?: boolean;
    onselect?: (call: CallOut) => void;
  };

  let {
    call,
    perspective,
    recorded = false,
    selected = false,
    onselect
  }: Props = $props();

  const other = $derived(party(counterpartOf(call, perspective)));
  const incoming = $derived(cameIn(call, perspective));
  const missed = $derived(incoming && isMissed(call));
  const glyph = $derived(missed ? PhoneMissed : DIRECTION_ICON[call.direction]);
  const today = $derived(
    formatDate(call.startedAt) === formatDate(demoNowDate().toISOString())
  );
  const context = $derived.by(() => {
    const parts: string[] = [];
    const group = ringGroupById(call.ringGroupId);
    if (group) {
      parts.push(t('calls.viaGroup', { name: group.name }));
    }
    if (
      call.answeredByUserId !== null &&
      call.answeredByUserId !== perspective &&
      (call.ringGroupId !== null || perspective === null)
    ) {
      parts.push(
        t('calls.answeredBy', {
          name: userById(call.answeredByUserId)?.name ?? '—'
        })
      );
    }
    if (parts.length === 0) {
      parts.push(
        t(
          `calls.direction.${incoming ? 'in' : call.direction === 'internal' ? 'internalOut' : 'out'}`
        )
      );
    }
    return parts.join(' · ');
  });
</script>

<button
  type="button"
  class="item"
  class:selected
  class:missed
  onclick={() => onselect?.(call)}
>
  <span class="dir" class:in={incoming}><Icon icon={glyph} size={17} /></span>
  <span class="who">
    <span class="name truncate" class:mono={other.name === null}
      >{other.name ?? other.number}</span
    >
    <span class="context truncate">{context}</span>
  </span>
  <span class="when">
    <span class="time nums"
      >{today ? formatTime(call.startedAt) : formatDate(call.startedAt)}</span
    >
    <span class="meta">
      {#if recorded}<span class="rec" title={t('calls.recorded')}
          ><Disc3 size={12} /></span
        >{/if}
      {#if call.status === 'answered'}
        <span class="nums">{formatDuration(talkSeconds(call))}</span>
      {:else}
        <CallStatusBadge status={call.status} />
      {/if}
    </span>
  </span>
</button>

<style>
  .item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 10px var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--text);
    transition: background 0.15s var(--ease);
  }
  .item:hover {
    background: var(--surface-2);
  }
  .item.selected {
    background: var(--primary-soft);
  }
  .dir {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .dir.in {
    background: var(--info-soft);
    color: var(--info);
  }
  .missed .dir {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .missed .name {
    color: var(--danger);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .name {
    font-weight: 700;
  }
  .context {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .when {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    flex: none;
    font-size: var(--text-sm);
  }
  .time {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .rec {
    color: var(--danger);
    display: inline-grid;
  }
</style>
