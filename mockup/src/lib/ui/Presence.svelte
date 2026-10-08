<!--
  A presence dot (available, busy, offline, dnd), optionally with its label.
-->
<script lang="ts">
  import type { PresenceStatus } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';

  let {
    status,
    label = false,
    size = 9
  }: { status: PresenceStatus; label?: boolean; size?: number } = $props();
</script>

<span class="presence" title={t(`presence.${status}`)}>
  <span class="dot {status}" style:width="{size}px" style:height="{size}px"
  ></span>
  {#if label}<span class="text">{t(`presence.${status}`)}</span>{/if}
</span>

<style>
  .presence {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    border-radius: 50%;
    flex: none;
    box-shadow: 0 0 0 2px var(--surface);
  }
  .available {
    background: var(--presence-available);
  }
  .busy {
    background: var(--presence-busy);
  }
  .dnd {
    background: var(--presence-dnd);
  }
  .offline {
    background: var(--presence-offline);
  }
  .text {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
