<!--
  Outbound routes (`outboundRoutes.list`, `outboundRoutes.replace`, admin): which trunk carries an
  outgoing call and which number it shows. Routes are edited here and saved as one ordered list;
  a call takes the first route that matches it and falls through to the next when that trunk
  cannot carry it.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Route from '@lucide/svelte/icons/route';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import { liveTrunks } from '#lib/api/lookup.js';
  import type { RouteWire } from '#lib/api/ops/areas/outboundRoutes.js';
  import type { Member } from '#lib/api/types.js';
  import type { DraftRoute } from '#lib/components/numbers/format.js';
  import RouteCard from '#lib/components/numbers/RouteCard.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';

  const stored = $derived(
    read<{ items: RouteWire[] }>('outboundRoutes.list', {}, { items: [] }).items
  );
  const storedDrafts = $derived(stored.map(toDraft));

  /** The list being edited; null shows the stored list. */
  let edited = $state<DraftRoute[] | null>(null);
  const routes = $derived(edited ?? storedDrafts);
  const dirty = $derived(
    edited !== null &&
      JSON.stringify(edited.map(toInput)) !==
        JSON.stringify(storedDrafts.map(toInput))
  );
  let problem = $state<string | null>(null);
  let saving = $state(false);
  let nextKey = 0;

  const lastIsCatchAll = $derived.by(() => {
    const last = routes.at(-1);
    return (
      last !== undefined &&
      last.members.length === 0 &&
      last.numbers.length === 0
    );
  });
  const catchAllIndex = $derived(
    routes.findIndex(
      route => route.members.length === 0 && route.numbers.length === 0
    )
  );
  const shadowed = $derived(
    catchAllIndex !== -1 && catchAllIndex < routes.length - 1
  );

  function toDraft(route: RouteWire): DraftRoute {
    return {
      key: route.id,
      id: route.id,
      trunkId: route.trunkId,
      callerIdDidId: route.callerIdDidId,
      members: [
        ...route.users.map((id): Member => ({ kind: 'user', id })),
        ...route.userGroups.map((id): Member => ({ kind: 'userGroup', id }))
      ],
      numbers: route.numbers.map(entry => ({ ...entry }))
    };
  }

  function toInput(route: DraftRoute): Record<string, unknown> {
    return {
      ...(route.id === undefined ? {} : { id: route.id }),
      trunkId: route.trunkId,
      callerIdDidId: route.callerIdDidId,
      users: route.members
        .filter(member => member.kind === 'user')
        .map(member => member.id),
      userGroups: route.members
        .filter(member => member.kind === 'userGroup')
        .map(member => member.id),
      numbers: route.numbers.map(entry => ({
        number: entry.number,
        isPrefix: entry.isPrefix
      }))
    };
  }

  function edit(next: DraftRoute[]): void {
    edited = next;
    problem = null;
  }

  function update(index: number, route: DraftRoute): void {
    edit(
      routes.map((existing, position) =>
        position === index ? route : existing
      )
    );
  }

  function move(index: number, delta: number): void {
    const next = [...routes];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      edit(next);
    }
  }

  function add(): void {
    nextKey += 1;
    const trunk = liveTrunks()[0];
    const route: DraftRoute = {
      key: `new-${nextKey}`,
      trunkId: trunk?.id ?? '',
      callerIdDidId: null,
      members: [],
      numbers: []
    };
    // A new route goes above the catch-all, which stays last as the default.
    const at = lastIsCatchAll ? routes.length - 1 : routes.length;
    edit([...routes.slice(0, at), route, ...routes.slice(at)]);
  }

  async function save(): Promise<void> {
    saving = true;
    problem = null;
    const result = await run(
      'outboundRoutes.replace',
      { routes: routes.map(toInput) },
      { success: 'outboundRoutes.saved' }
    );
    saving = false;
    if (result.ok) {
      edited = null;
    } else if (result.error.field !== null) {
      problem = errorText(result.error);
    }
  }
</script>

<PageHeader
  title={t('nav.outboundRoutes')}
  subtitle={t('outboundRoutes.subtitle')}
>
  {#snippet actions()}
    <Button
      variant="primary"
      icon={Plus}
      disabled={liveTrunks().length === 0}
      onclick={add}>{t('outboundRoutes.add')}</Button
    >
  {/snippet}
</PageHeader>

<div class="layout">
  <div class="list">
    {#if shadowed}
      <div class="alert" role="status">
        <TriangleAlert size={18} />
        <span
          >{t('outboundRoutes.catchAllNotLast', {
            position: catchAllIndex + 1
          })}</span
        >
      </div>
    {:else if routes.length > 0 && !lastIsCatchAll}
      <div class="alert" role="status">
        <TriangleAlert size={18} />
        <span>{t('outboundRoutes.noCatchAll')}</span>
      </div>
    {/if}

    {#if routes.length === 0}
      <EmptyState
        icon={Route}
        title={t('outboundRoutes.empty')}
        body={t('outboundRoutes.emptyBody')}
      >
        {#snippet action()}
          {#if liveTrunks().length === 0}
            <Button href={href('/trunks/new')}>{t('trunks.add')}</Button>
          {:else}
            <Button variant="primary" icon={Plus} onclick={add}
              >{t('outboundRoutes.add')}</Button
            >
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <ol class="routes">
        {#each routes as route, index (route.key)}
          <li>
            <RouteCard
              {route}
              position={index + 1}
              count={routes.length}
              onchange={next => update(index, next)}
              onmove={delta => move(index, delta)}
              onremove={() =>
                edit(routes.filter((_, position) => position !== index))}
            />
            {#if index < routes.length - 1}
              <span class="next" aria-hidden="true"
                >{t('outboundRoutes.thenNext')}</span
              >
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    {#if dirty}
      <div class="savebar" role="region" aria-label={t('outboundRoutes.save')}>
        <span
          class="savebar-text"
          class:problem={problem !== null}
          role={problem !== null ? 'alert' : undefined}
        >
          {problem ?? t('outboundRoutes.unsaved')}
        </span>
        <Button
          variant="ghost"
          onclick={() => {
            edited = null;
            problem = null;
          }}>{t('trunks.discard')}</Button
        >
        <Button
          variant="primary"
          loading={saving}
          op="outboundRoutes.replace"
          onclick={save}>{t('outboundRoutes.save')}</Button
        >
      </div>
    {/if}
  </div>

  <aside class="side">
    <Card title={t('outboundRoutes.how.title')} icon={Route}>
      <ol class="how">
        <li>{t('outboundRoutes.how.order')}</li>
        <li>{t('outboundRoutes.how.match')}</li>
        <li>
          {t('outboundRoutes.how.fallthrough')}
          <ul>
            <li>{t('outboundRoutes.how.unreachable')}</li>
            <li>{t('outboundRoutes.how.channels')}</li>
            <li>{t('outboundRoutes.how.refused')}</li>
            <li>{t('outboundRoutes.how.clir')}</li>
          </ul>
        </li>
        <li>{t('outboundRoutes.how.catchAll')}</li>
      </ol>
      <p class="emergency">
        {t('outboundRoutes.how.emergency')}
        <a href={href('/trunks')}>{t('nav.trunks')}</a>
      </p>
    </Card>
  </aside>
</div>

<style>
  .layout {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    align-items: flex-start;
  }
  .list {
    flex: 999 1 480px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .routes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .routes > li {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .next {
    align-self: center;
    margin: 6px 0;
    padding: 2px 12px;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
    border-left: 2px dashed var(--line-strong);
    border-right: 2px dashed var(--line-strong);
  }
  .alert {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .side {
    flex: 1 1 280px;
    min-width: 0;
    position: sticky;
    top: var(--space-4);
  }
  .how {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  .how ul {
    margin: 4px 0 0;
    padding-left: 1.1em;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .emergency {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .savebar {
    position: sticky;
    bottom: var(--space-3);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1.5px solid var(--primary);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
  }
  .savebar-text {
    flex: 1 1 200px;
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--text-muted);
  }
  .savebar-text.problem {
    color: var(--danger);
  }
  @media (max-width: 640px) {
    .savebar {
      bottom: calc(var(--tabbar-height) + var(--space-2));
    }
    .savebar {
      justify-content: flex-end;
      padding: var(--space-2) var(--space-3);
    }
    .savebar-text:not(.problem) {
      display: none;
    }
  }
</style>
