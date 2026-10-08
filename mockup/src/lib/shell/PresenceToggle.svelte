<!--
  The signed-in person's presence and do-not-disturb switch (`users.setPresence`, not audited).
-->
<script lang="ts">
  import { run } from '#lib/actions.svelte.js';
  import type { PresenceStatus } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Presence from '#lib/ui/Presence.svelte';

  /** `compact`: the top bar's variant, whose label gives way on narrow screens. */
  let {
    userId,
    status,
    compact = false
  }: { userId: string; status: PresenceStatus; compact?: boolean } = $props();
  const dnd = $derived(status === 'dnd');
</script>

<button
  type="button"
  class="presence"
  class:compact
  class:dnd
  title={dnd ? t('presence.dndOff') : t('presence.dndOn')}
  onclick={() => run('users.setPresence', { id: userId, dnd: !dnd })}
>
  <Presence {status} />
  <span class="text">{t(`presence.${status}`)}</span>
</button>

<style>
  .presence {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 36px;
    padding: 0 12px;
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-pill);
    background: var(--surface);
    font-weight: 700;
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--text);
  }
  .presence.dnd {
    border-color: var(--danger);
    background: var(--danger-soft);
    color: var(--danger);
  }
  @media (max-width: 1100px) {
    .compact .text {
      display: none;
    }
    .presence.compact {
      padding: 0 11px;
    }
  }
</style>
