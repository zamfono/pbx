<!--
  The trunk order (`trunks.setOrder`, §9.4 "Trunk order"): emergency calls try the emergency trunks
  in this order, skipping unreachable ones. The order names every trunk; only emergency trunks are
  ever tried.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Siren from '@lucide/svelte/icons/siren';

  import { run } from '#lib/actions.svelte.js';
  import type { Trunk } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';

  import TrunkStatus from './TrunkStatus.svelte';

  let { trunks }: { trunks: Trunk[] } = $props();

  /** The order being edited; null shows the stored order. */
  let edited = $state<string[] | null>(null);
  const order = $derived(edited ?? trunks.map(trunk => trunk.id));
  const rows = $derived(
    order
      .map(id => trunks.find(trunk => trunk.id === id))
      .filter((trunk): trunk is Trunk => trunk !== undefined)
  );
  const changed = $derived(
    edited !== null && edited.join() !== trunks.map(trunk => trunk.id).join()
  );

  /** Which attempt an emergency call makes over `trunk`; null for a trunk it never tries. */
  const attemptOf = (trunk: Trunk, index: number): number | null =>
    trunk.emergency
      ? rows.slice(0, index + 1).filter(row => row.emergency).length
      : null;

  function move(index: number, delta: number): void {
    const next = [...order];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      edited = next;
    }
  }

  async function save(): Promise<void> {
    if (
      edited !== null &&
      (
        await run(
          'trunks.setOrder',
          { trunkIds: edited },
          { success: 'trunks.orderSaved' }
        )
      ).ok
    ) {
      edited = null;
    }
  }
</script>

<Card
  title={t('trunks.order.title')}
  description={t('trunks.order.body')}
  icon={Siren}
>
  {#snippet actions()}
    {#if changed}
      <Button size="sm" variant="ghost" onclick={() => (edited = null)}
        >{t('trunks.discard')}</Button
      >
      <Button size="sm" variant="primary" op="trunks.setOrder" onclick={save}
        >{t('trunks.order.save')}</Button
      >
    {/if}
  {/snippet}
  <ol class="order">
    {#each rows as trunk, index (trunk.id)}
      {@const position = attemptOf(trunk, index)}
      <li class:muted={!trunk.emergency}>
        <span class="pos nums" class:on={position !== null}
          >{position ?? '–'}</span
        >
        <span class="name grow truncate">{trunk.name}</span>
        {#if trunk.emergency}
          <TrunkStatus {trunk} since={false} />
        {:else}
          <span class="xs">{t('trunks.order.notEmergency')}</span>
        {/if}
        <IconButton
          icon={ArrowUp}
          size="sm"
          label={t('common.moveUp')}
          disabled={index === 0}
          onclick={() => move(index, -1)}
        />
        <IconButton
          icon={ArrowDown}
          size="sm"
          label={t('common.moveDown')}
          disabled={index === rows.length - 1}
          onclick={() => move(index, 1)}
        />
      </li>
    {/each}
  </ol>
</Card>

<style>
  .order {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  li.muted {
    color: var(--text-muted);
  }
  .pos {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--surface-3);
    font-size: var(--text-xs);
    font-weight: 800;
  }
  .pos.on {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .name {
    font-weight: 700;
  }
  .xs {
    white-space: nowrap;
  }
</style>
