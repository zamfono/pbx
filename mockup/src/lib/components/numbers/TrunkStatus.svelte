<!--
  A trunk's live status (§9.4 "Provisioning and status"): registered or reachable, unreachable,
  unmonitored or unknown, with how long it has been so.
-->
<script lang="ts">
  import type { Trunk } from '#lib/api/types.js';
  import { formatRelative, t } from '#lib/i18n/index.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';

  let {
    trunk,
    since = true
  }: {
    trunk: Pick<Trunk, 'status' | 'statusChangedAt' | 'authMode'>;
    since?: boolean;
  } = $props();

  const TONES = {
    registered: 'ok',
    unreachable: 'danger',
    unmonitored: 'neutral',
    unknown: 'warn'
  } as const;
  const label = $derived(
    trunk.status === 'registered' && trunk.authMode === 'ip'
      ? t('trunks.status.reachable')
      : t(`trunks.status.${trunk.status}`)
  );
</script>

<span class="status">
  <Badge tone={TONES[trunk.status]} dot>{label}</Badge>
  {#if since && trunk.statusChangedAt}
    <span class="since"
      >{t('trunks.since', {
        when: formatRelative(trunk.statusChangedAt)
      })}</span
    >
  {/if}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .since {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
