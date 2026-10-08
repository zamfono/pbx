<!--
  Trunks (`trunks.*`, admin): the provider connections calls leave and arrive through. The list
  shows each trunk's live status and the order emergency calls try them in (`trunks.setOrder`);
  `/trunks/:id` edits one, `/trunks/new` creates one.
-->
<script lang="ts">
  import Cable from '@lucide/svelte/icons/cable';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Siren from '@lucide/svelte/icons/siren';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { page } from '$app/state';

  import { read, run } from '#lib/actions.svelte.js';
  import { NO_EMERGENCY_TRUNK_WARNING } from '#lib/api/ops/areas/trunks.js';
  import type { OutboundRoute, Trunk } from '#lib/api/types.js';
  import EmergencyOrder from '#lib/components/numbers/EmergencyOrder.svelte';
  import TrunkCard from '#lib/components/numbers/TrunkCard.svelte';
  import TrunkForm from '#lib/components/numbers/TrunkForm.svelte';
  import TrunkStatus from '#lib/components/numbers/TrunkStatus.svelte';
  import { formatDateTime, t } from '#lib/i18n/index.svelte.js';
  import { go, href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';

  const params = $derived(page.params as Record<string, string>);

  const trunks = $derived(
    read<{ items: Trunk[] }>('trunks.list', {}, { items: [] }).items
  );
  const routes = $derived(
    read<{ items: OutboundRoute[] }>('outboundRoutes.list', {}, { items: [] })
      .items
  );
  const creating = $derived(params.id === 'new');
  const trunk = $derived(
    params.id === undefined || creating
      ? null
      : read<Trunk | null>('trunks.get', { id: params.id }, null)
  );
  /** The stored configuration the form starts from; a change from elsewhere (undo, Mucki) reloads
   * it. Live status is left out, so status events never reset an edit. */
  const formKey = $derived.by(() => {
    if (trunk === null) {
      return '';
    }
    const {
      status: _status,
      statusChangedAt: _changed,
      registeredAt: _registered,
      ...config
    } = trunk;
    return JSON.stringify(config);
  });
  const routeCount = (id: string): number =>
    routes.filter(route => route.trunkId === id).length;
  const noEmergency = $derived(
    trunks.length > 0 && !trunks.some(row => row.emergency)
  );

  let reregistering = $state(false);

  async function reregister(target: Trunk): Promise<void> {
    reregistering = true;
    await run(
      'trunks.reregister',
      { id: target.id },
      { success: 'trunks.reregistering', successParams: { name: target.name } }
    );
    setTimeout(() => (reregistering = false), 1800);
  }

  async function remove(target: Trunk): Promise<void> {
    const result = await run<{ id: string; warnings: string[] }>(
      'trunks.delete',
      { id: target.id },
      {
        success: 'trunks.deleted',
        successParams: { name: target.name }
      }
    );
    if (result.ok) {
      if (result.value.warnings.includes(NO_EMERGENCY_TRUNK_WARNING)) {
        toast({ tone: 'info', title: t('trunks.warning.noEmergency') });
      }
      go('/trunks');
    }
  }
</script>

{#if params.id === undefined}
  <PageHeader title={t('nav.trunks')} subtitle={t('trunks.subtitle')}>
    {#snippet actions()}
      <Button
        variant="primary"
        icon={Plus}
        op="trunks.create"
        href={href('/trunks/new')}>{t('trunks.add')}</Button
      >
    {/snippet}
  </PageHeader>

  {#if noEmergency}
    <div class="alert" role="alert">
      <TriangleAlert size={18} />
      <span>{t('trunks.warning.noEmergency')}</span>
    </div>
  {/if}

  {#if trunks.length === 0}
    <EmptyState
      icon={Cable}
      title={t('trunks.empty')}
      body={t('trunks.emptyBody')}
    >
      {#snippet action()}
        <Button variant="primary" icon={Plus} href={href('/trunks/new')}
          >{t('trunks.add')}</Button
        >
      {/snippet}
    </EmptyState>
  {:else}
    <div class="layout">
      <div class="cards">
        {#each trunks as row (row.id)}
          <TrunkCard trunk={row} routes={routeCount(row.id)} />
        {/each}
      </div>
      <aside class="side">
        <EmergencyOrder {trunks} />
        <p class="hint">
          {t('trunks.routesHint')}
          <a href={href('/outbound-routes')}>{t('nav.outboundRoutes')}</a>
        </p>
      </aside>
    </div>
  {/if}
{:else if creating}
  <PageHeader
    title={t('trunks.add')}
    subtitle={t('trunks.addSubtitle')}
    back={{ href: href('/trunks'), label: t('nav.trunks') }}
  />
  <TrunkForm trunk={null} />
{:else if trunk === null}
  <EmptyState
    icon={Cable}
    title={t('trunks.notFound')}
    body={t('trunks.notFoundBody')}
  >
    {#snippet action()}
      <Button href={href('/trunks')}>{t('nav.trunks')}</Button>
    {/snippet}
  </EmptyState>
{:else}
  <PageHeader
    title={trunk.name}
    back={{ href: href('/trunks'), label: t('nav.trunks') }}
  >
    {#snippet meta()}
      <TrunkStatus {trunk} />
      {#if trunk.emergency}<Badge tone="danger" icon={Siren}
          >{t('trunks.emergencyBadge')}</Badge
        >{/if}
      {#if trunk.authMode === 'registration' && trunk.registeredAt}
        <span class="small muted"
          >{t('trunks.lastRegisteredAt', {
            at: formatDateTime(trunk.registeredAt)
          })}</span
        >
      {/if}
      {#if isExpert()}<code class="xs faint">{trunk.id}</code>{/if}
    {/snippet}
    {#snippet actions()}
      {#if trunk.authMode === 'registration'}
        <Button
          icon={RefreshCw}
          loading={reregistering}
          op="trunks.reregister"
          onclick={() => reregister(trunk)}>{t('trunks.reregister')}</Button
        >
      {/if}
      <Button
        variant="danger"
        icon={Trash2}
        op="trunks.delete"
        onclick={() => remove(trunk)}>{t('common.delete')}</Button
      >
    {/snippet}
  </PageHeader>
  {#key formKey}
    <TrunkForm {trunk} />
  {/key}
{/if}

<style>
  .alert {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 700;
  }
  .layout {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }
  .cards {
    flex: 999 1 420px;
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
    min-width: 0;
  }
  .side {
    flex: 1 1 300px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
