<!--
  Numbers (`dids.*`, `didBlocks.*`, admin): the company's phone numbers and where their calls go,
  and the number blocks that group them and catch the numbers nobody was given. The main number
  leads the page, since it is what the company presents when nothing else decides.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import Hash from '@lucide/svelte/icons/hash';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Star from '@lucide/svelte/icons/star';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { page } from '$app/state';

  import { read, run } from '#lib/actions.svelte.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Did, DidBlock, OutboundRoute } from '#lib/api/types.js';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import BlockDrawer from '#lib/components/numbers/BlockDrawer.svelte';
  import {
    blockPattern,
    blockSize,
    isNumeric
  } from '#lib/components/numbers/format.js';
  import NumberDrawer from '#lib/components/numbers/NumberDrawer.svelte';
  import { formatNumber, formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { href, router } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';

  const params = $derived(page.params as Record<string, string>);

  const tab = $derived(params.tab === 'blocks' ? 'blocks' : 'numbers');

  const dids = $derived(
    read<{ items: Did[] }>('dids.list', {}, { items: [] }).items
  );
  const blocks = $derived(
    read<{ items: DidBlock[] }>('didBlocks.list', {}, { items: [] }).items
  );
  const routes = $derived(
    read<{ items: OutboundRoute[] }>('outboundRoutes.list', {}, { items: [] })
      .items
  );

  const mainDidId = $derived(store.db.settings.mainDidId);
  const mainDid = $derived(dids.find(did => did.id === mainDidId));
  /** Main number first, then numbers in order, provider strings last. */
  const sorted = $derived(
    [...dids].sort((a, b) => {
      const rank = (did: Did): number =>
        did.id === mainDidId ? 0 : isNumeric(did.number) ? 1 : 2;
      return rank(a) - rank(b) || a.number.localeCompare(b.number);
    })
  );

  /** Who presents each number as caller ID: users and outbound routes. */
  const callerIdUsers = $derived.by(() => {
    const byDid: Record<string, string[]> = {};
    for (const user of store.db.users) {
      if (user.deletedAt === null && user.callerIdDidId !== null) {
        byDid[user.callerIdDidId] = [
          ...(byDid[user.callerIdDidId] ?? []),
          user.name
        ];
      }
    }
    return byDid;
  });
  const callerIdRoutes = (didId: string): number =>
    routes.filter(route => route.callerIdDidId === didId).length;

  const inBlock = (block: DidBlock, number: string): boolean =>
    number.startsWith(block.base) &&
    (block.digits === null ||
      number.length === block.base.length + block.digits);
  const blockOf = (number: string): DidBlock | undefined =>
    blocks
      .filter(block => inBlock(block, number))
      .sort((a, b) => b.base.length - a.base.length)[0];
  const didsIn = (block: DidBlock): Did[] =>
    sorted.filter(did => inBlock(block, did.number));

  let editingNumber = $state<{ did: Did | null } | null>(null);
  let editingBlock = $state<{ block: DidBlock | null } | null>(null);

  const columns = $derived([
    { key: 'number', label: t('field.did.number'), primary: true },
    { key: 'label', label: t('field.did.label') },
    { key: 'target', label: t('numbers.callsGoTo') },
    { key: 'block', label: t('numbers.block'), hideOnMobile: true },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : []),
    { key: 'actions', label: '', align: 'right' as const, width: '96px' }
  ]);

  function suffix(block: DidBlock, number: string): string {
    return block.digits === null
      ? number.slice(block.base.length) || '·'
      : number.slice(block.base.length);
  }
</script>

<PageHeader title={t('nav.numbers')} subtitle={t('numbers.subtitle')}>
  {#snippet actions()}
    {#if tab === 'numbers'}
      <Button
        variant="primary"
        icon={Plus}
        op="dids.create"
        onclick={() => (editingNumber = { did: null })}
        >{t('numbers.add')}</Button
      >
    {:else}
      <Button
        variant="primary"
        icon={Plus}
        op="didBlocks.create"
        onclick={() => (editingBlock = { block: null })}
        >{t('numbers.addBlock')}</Button
      >
    {/if}
  {/snippet}
</PageHeader>

{#if mainDid}
  <section class="main-number" aria-label={t('numbers.mainNumber')}>
    <span class="star"><Star size={20} /></span>
    <div class="main-body">
      <span class="eyebrow">{t('numbers.mainNumber')}</span>
      <button
        type="button"
        class="main-value mono"
        onclick={() => (editingNumber = { did: mainDid })}
        >{formatPhone(mainDid.number)}</button
      >
      <span class="main-meta">
        {#if mainDid.label}<span>{mainDid.label}</span><span
            class="sep"
            aria-hidden="true">·</span
          >{/if}
        <ArrowRight size={14} />
        <ForwardTargetLabel target={mainDid.target} />
      </span>
    </div>
    <p class="main-note">
      {t('numbers.mainNumberNote')}
      <a href={href('/settings')}>{t('numbers.mainNumberChange')}</a>
    </p>
  </section>
{/if}

<Tabs
  active={tab}
  hrefFor={id => href(id === 'numbers' ? '/numbers' : `/numbers/${id}`)}
  tabs={[
    {
      id: 'numbers',
      label: t('numbers.tab.numbers'),
      icon: Hash,
      count: dids.length
    },
    {
      id: 'blocks',
      label: t('numbers.tab.blocks'),
      icon: Grid3x3,
      count: blocks.length
    }
  ]}
/>

{#if tab === 'numbers'}
  <DataTable
    rows={sorted}
    {columns}
    rowKey={row => row.id}
    caption={t('numbers.tab.numbers')}
    onRowClick={row => (editingNumber = { did: row })}
  >
    {#snippet cell(row, key)}
      {#if key === 'number'}
        {@const users = callerIdUsers[row.id] ?? []}
        {@const routeCount = callerIdRoutes(row.id)}
        <span class="number-cell">
          <span class="mono strong">{formatPhone(row.number)}</span>
          {#if row.id === mainDidId}<Badge tone="primary" icon={Star}
              >{t('numbers.mainBadge')}</Badge
            >{/if}
          {#if users.length > 0}
            <Badge tone="info" title={users.join(', ')}
              >{t('numbers.callerIdOf', { count: users.length })}</Badge
            >
          {/if}
          {#if routeCount > 0}<Badge tone="info"
              >{t('numbers.callerIdOfRoutes', { count: routeCount })}</Badge
            >{/if}
          {#if !isNumeric(row.number)}<Badge>{t('numbers.verbatim')}</Badge
            >{/if}
        </span>
      {:else if key === 'label'}
        <span class="muted">{row.label ?? '—'}</span>
      {:else if key === 'target'}
        <ForwardTargetLabel target={row.target} />
      {:else if key === 'block'}
        {@const block = blockOf(row.number)}
        {#if block}
          <a
            class="small"
            href={href('/numbers/blocks')}
            onclick={event => event.stopPropagation()}
            >{block.label ?? blockPattern(block)}</a
          >
        {:else}
          <span class="faint">—</span>
        {/if}
      {:else if key === 'id'}
        <code class="xs faint id-cell" title={row.id}>{row.id}</code>
      {:else if key === 'actions'}
        <span class="row nowrap actions">
          <IconButton
            icon={Pencil}
            label={t('common.edit')}
            onclick={event => {
              event.stopPropagation();
              editingNumber = { did: row };
            }}
          />
          {#if row.id !== mainDidId}
            <IconButton
              icon={Trash2}
              variant="danger"
              label={t('common.delete')}
              onclick={event => {
                event.stopPropagation();
                void run(
                  'dids.delete',
                  { id: row.id },
                  {
                    success: 'numbers.deleted',
                    successParams: { number: formatPhone(row.number) }
                  }
                );
              }}
            />
          {/if}
        </span>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={Hash}
        title={t('numbers.empty')}
        body={t('numbers.emptyBody')}
      />
    {/snippet}
  </DataTable>
{:else}
  <p class="intro">{t('numbers.blocksIntro')}</p>
  {#if blocks.length === 0}
    <EmptyState
      icon={Grid3x3}
      title={t('numbers.blocksEmpty')}
      body={t('numbers.blocksEmptyBody')}
    />
  {:else}
    <div class="blocks">
      {#each blocks as block (block.id)}
        {@const inside = didsIn(block)}
        {@const size = blockSize(block)}
        <div class="block-card" class:flash={router.highlight === block.id}>
          <Card
            title={blockPattern(block)}
            description={block.label ?? undefined}
            icon={Grid3x3}
          >
            {#snippet actions()}
              <IconButton
                icon={Pencil}
                label={t('common.edit')}
                onclick={() => (editingBlock = { block })}
              />
              <IconButton
                icon={Trash2}
                variant="danger"
                label={t('common.delete')}
                onclick={() =>
                  void run(
                    'didBlocks.delete',
                    { id: block.id },
                    { success: 'numbers.blockDeleted' }
                  )}
              />
            {/snippet}
            <dl class="facts">
              <div>
                <dt>{t('field.didBlock.digits')}</dt>
                <dd>
                  {#if size === null}
                    {t('numbers.openEnded')}
                  {:else}
                    {t('numbers.digitsSummary', {
                      digits: block.digits ?? 0,
                      count: formatNumber(size)
                    })}
                  {/if}
                </dd>
              </div>
              <div>
                <dt>{t('numbers.assigned')}</dt>
                <dd>
                  {size === null
                    ? formatNumber(inside.length)
                    : t('numbers.assignedOf', {
                        count: inside.length,
                        total: formatNumber(size)
                      })}
                </dd>
              </div>
              <div class="wide">
                <dt>{t('field.didBlock.fallbackTarget')}</dt>
                <dd>
                  {#if block.fallbackTarget}
                    <ForwardTargetLabel target={block.fallbackTarget} />
                  {:else}
                    <span class="row" style="--gap: 6px">
                      <span class="muted">{t('numbers.companyFallback')}:</span>
                      <ForwardTargetLabel
                        target={store.db.settings.fallbackTarget}
                        nullLabel={t('numbers.noFallback')}
                      />
                    </span>
                  {/if}
                </dd>
              </div>
            </dl>
            {#if inside.length > 0}
              <ul class="members">
                {#each inside as did (did.id)}
                  <li>
                    <button
                      type="button"
                      class="member"
                      onclick={() => (editingNumber = { did })}
                      title={formatPhone(did.number)}
                    >
                      <span class="mono strong"
                        >{suffix(block, did.number)}</span
                      >
                      <span class="member-target"
                        ><ForwardTargetLabel
                          target={did.target}
                          link={false}
                        /></span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="small muted">{t('numbers.blockNoNumbers')}</p>
            {/if}
            {#if isExpert()}<p class="xs faint id">
                {t('common.id')}: <code>{block.id}</code>
              </p>{/if}
          </Card>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if editingNumber}
  {#key editingNumber.did?.id ?? 'new'}
    <NumberDrawer
      did={editingNumber.did}
      {blocks}
      onclose={() => (editingNumber = null)}
    />
  {/key}
{/if}
{#if editingBlock}
  {#key editingBlock.block?.id ?? 'new'}
    <BlockDrawer
      block={editingBlock.block}
      onclose={() => (editingBlock = null)}
    />
  {/key}
{/if}

<style>
  .main-number {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-5);
    margin-bottom: var(--space-5);
    border-radius: var(--radius-md);
    background: var(--primary);
    color: var(--on-primary);
    box-shadow: var(--shadow-primary);
  }
  .star {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--lime);
    color: var(--on-lime);
  }
  .main-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .eyebrow {
    font-size: var(--text-xs);
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.8;
  }
  .main-value {
    align-self: flex-start;
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font-size: var(--text-3xl);
    font-weight: 500;
    letter-spacing: -0.02em;
    white-space: nowrap;
    cursor: pointer;
  }
  .main-value:hover {
    text-decoration: underline;
    text-decoration-thickness: 2px;
  }
  .main-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: var(--text-sm);
  }
  .main-meta :global(a),
  .main-meta :global(.kind) {
    color: inherit;
  }
  .main-meta :global(.icon) {
    background: rgb(255 255 255 / 18%);
    color: inherit;
  }
  .sep {
    opacity: 0.6;
  }
  .main-note {
    flex: 1 1 240px;
    max-width: 360px;
    font-size: var(--text-sm);
    opacity: 0.9;
    line-height: 1.45;
  }
  .main-note a {
    color: var(--lime);
    font-weight: 700;
  }
  .number-cell {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .actions {
    justify-content: flex-end;
  }
  .id-cell {
    display: block;
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .intro {
    color: var(--text-muted);
    max-width: 75ch;
    margin-bottom: var(--space-4);
  }
  .blocks {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  }
  .block-card {
    border-radius: var(--radius-md);
  }
  .block-card :global(h3) {
    font-family: var(--font-mono);
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .block-card.flash {
    animation: flash 2.4s var(--ease);
  }
  @keyframes flash {
    0%,
    40% {
      box-shadow: 0 0 0 3px var(--lime);
    }
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }
  .facts .wide {
    grid-column: 1 / -1;
  }
  dt {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: 2px;
  }
  dd {
    margin: 0;
    font-size: var(--text-sm);
  }
  .members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .member {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 4px 10px 4px 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .member:hover {
    border-color: var(--primary);
  }
  .member .mono {
    background: var(--primary-soft);
    color: var(--primary);
    border-radius: var(--radius-pill);
    padding: 1px 8px;
  }
  .member-target {
    min-width: 0;
    overflow: hidden;
  }
  .member-target :global(.kind) {
    display: none;
  }
  .member-target :global(.icon) {
    display: none;
  }
  .id {
    margin-top: var(--space-3);
  }
  @media (max-width: 640px) {
    .main-number {
      padding: var(--space-4);
      gap: var(--space-3);
    }
    .main-value {
      font-size: var(--text-2xl);
    }
  }
</style>
