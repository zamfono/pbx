<!--
  What a forwarded call over the trunk shows the person it is forwarded to (§9.4 "Forwarded
  calls"): the company's own number, or the original caller's ("CLIP no screening").
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Building2 from '@lucide/svelte/icons/building-2';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import UserRound from '@lucide/svelte/icons/user-round';

  import { didById } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Trunk } from '#lib/api/types.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';

  let { mode }: { mode: Trunk['forwardedCallerId'] } = $props();

  const CALLER = '+491715550177';
  const own = $derived(
    formatPhone(didById(store.db.settings.mainDidId)?.number ?? '')
  );
  const shown = $derived(mode === 'own' ? own : formatPhone(CALLER));
</script>

<div class="explainer">
  <div class="flow" aria-hidden="true">
    <span class="node"
      ><UserRound size={16} /><span class="mono">{formatPhone(CALLER)}</span
      ></span
    >
    <ArrowRight size={14} />
    <span class="node"
      ><Building2 size={16} /><span class="mono">{own}</span></span
    >
    <ArrowRight size={14} />
    <span class="node target"
      ><Smartphone size={16} /><span>{t('trunks.forwarded.display')}</span
      ><strong class="mono">{shown}</strong></span
    >
  </div>
  <p>
    {mode === 'own'
      ? t('trunks.forwarded.explainOwn')
      : t('trunks.forwarded.explainOriginal')}
  </p>
</div>

<style>
  .explainer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px dashed var(--line-strong);
  }
  .flow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--text-muted);
  }
  .node {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--text);
    font-size: var(--text-xs);
  }
  .node.target {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .node.target strong {
    color: var(--primary);
  }
  p {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
</style>
