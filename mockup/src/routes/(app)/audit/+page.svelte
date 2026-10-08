<!--
  The audit log (`audit.list`, `audit.undo`, §5.7, §5.8): who changed what, when and how, each
  change as a field diff, with Undo where the API allows it. Expert mode adds the channel, the MCP
  client, the raw operation name and ids.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Bot from '@lucide/svelte/icons/bot';
  import Clock from '@lucide/svelte/icons/clock';
  import FilterX from '@lucide/svelte/icons/filter-x';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Undo2 from '@lucide/svelte/icons/undo-2';

  import { read, run } from '#lib/actions.svelte.js';
  import type {
    AuditEntryWire,
    AuditListInput,
    AuditState
  } from '#lib/api/ops/areas/audit.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { AUDIT_CHANNELS, type AuditChannel } from '#lib/api/types.js';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import {
    changeVisible,
    entityLabel,
    fieldLabel,
    isForwardTarget,
    kindLabel,
    operationText,
    valueText
  } from '#lib/components/system/auditText.js';
  import { formatDateTime, formatRelative, t } from '#lib/i18n/index.svelte.js';
  import { entityPath } from '#lib/links.js';
  import { highlight, router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Field from '#lib/ui/Field.svelte';
  import OpBadge from '#lib/ui/OpBadge.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const PAGE = 40;

  let stateFilter = $state<AuditState>('live');
  let entityKind = $state('');
  let actorUserId = $state('');
  let operation = $state('');
  let channel = $state<AuditChannel | ''>('');
  let clientId = $state('');
  let from = $state('');
  let to = $state('');
  let shown = $state(PAGE);

  const filters = $derived<AuditListInput>({
    state: stateFilter,
    ...(entityKind ? { entityKind } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(operation ? { operation } : {}),
    ...(isExpert() && channel ? { channel } : {}),
    ...(isExpert() && clientId ? { clientId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {})
  });
  const entries = $derived(
    read<{ items: AuditEntryWire[] }>('audit.list', filters, { items: [] })
      .items
  );
  const everything = $derived(
    read<{ items: AuditEntryWire[] }>(
      'audit.list',
      { state: 'all' },
      { items: [] }
    ).items
  );
  const byId = $derived(new Map(everything.map(entry => [entry.id, entry])));
  const filtered = $derived(
    Object.keys(filters).length > 1 || stateFilter !== 'live'
  );

  const sortedOptions = (
    pairs: [string, string][]
  ): { value: string; label: string }[] =>
    [...new Map(pairs)]
      .map(([value, label]) => ({ value, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  const kindOptions = $derived([
    { value: '', label: t('audit.filter.anyKind') },
    ...sortedOptions(
      everything.map(entry => [entry.entityKind, kindLabel(entry.entityKind)])
    )
  ]);
  const actorOptions = $derived([
    { value: '', label: t('audit.filter.anyone') },
    ...sortedOptions(
      everything.map(entry => [entry.actorUserId, entry.actorUserName])
    )
  ]);
  const operationOptions = $derived([
    { value: '', label: t('audit.filter.anyOperation') },
    ...sortedOptions(
      everything.map(entry => [
        entry.operation,
        isExpert() ? entry.operation : operationText(entry)
      ])
    )
  ]);
  const channelOptions = $derived([
    { value: '' as AuditChannel | '', label: t('audit.filter.anyChannel') },
    ...AUDIT_CHANNELS.map(each => ({
      value: each as AuditChannel | '',
      label: t(`audit.channel.${each}`)
    }))
  ]);
  const clientOptions = $derived([
    { value: '', label: t('audit.filter.anyClient') },
    ...sortedOptions(
      everything
        .filter(entry => entry.clientId !== null)
        .map(entry => [
          entry.clientId as string,
          entry.clientName ?? (entry.clientId as string)
        ])
    )
  ]);
  const stateOptions = $derived(
    (['live', 'undone', 'all'] as const).map(value => ({
      value,
      label: t(`audit.state.${value}`)
    }))
  );

  function reset(): void {
    stateFilter = 'live';
    entityKind = '';
    actorUserId = '';
    operation = '';
    channel = '';
    clientId = '';
    from = '';
    to = '';
  }

  function showEntry(id: string): void {
    if (!entries.some(entry => entry.id === id)) {
      reset();
      stateFilter = 'all';
    }
    highlight(id);
    requestAnimationFrame(() =>
      document
        .getElementById(`audit-${id}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    );
  }

  const canUndo = (entry: AuditEntryWire): boolean =>
    entry.undoable &&
    entry.undoneAt === null &&
    allowed('audit.undo', { id: entry.id }, currentActor());
  /** Pages for the kinds `entityPath` does not name. */
  const OWN_PATHS: Record<string, string> = {
    system: '/system',
    backupRun: '/backups',
    mailTemplate: '/mail-templates',
    sipBan: '/sip-protection'
  };
  const entityHref = (entry: AuditEntryWire): string | null =>
    entityPath(entry.entityKind, entry.entityId ?? '') ??
    OWN_PATHS[entry.entityKind] ??
    null;
</script>

<PageHeader title={t('nav.audit')} subtitle={t('audit.subtitle')} />

<section class="filters" aria-label={t('common.filter')}>
  <Segmented
    bind:value={stateFilter}
    options={stateOptions}
    size="sm"
    ariaLabel={t('audit.filter.state')}
  />
  <div class="filter-grid">
    <Field label={t('audit.filter.kind')} id="audit-kind"
      ><Select
        id="audit-kind"
        bind:value={entityKind}
        options={kindOptions}
      /></Field
    >
    <Field label={t('audit.filter.actor')} id="audit-actor"
      ><Select
        id="audit-actor"
        bind:value={actorUserId}
        options={actorOptions}
      /></Field
    >
    <Field label={t('audit.filter.operation')} id="audit-operation"
      ><Select
        id="audit-operation"
        bind:value={operation}
        options={operationOptions}
      /></Field
    >
    <Field label={t('audit.filter.from')} id="audit-from"
      ><TextInput id="audit-from" type="date" bind:value={from} /></Field
    >
    <Field label={t('audit.filter.to')} id="audit-to"
      ><TextInput id="audit-to" type="date" bind:value={to} /></Field
    >
    {#if isExpert()}
      <Field label={t('audit.filter.channel')} id="audit-channel" expert
        ><Select
          id="audit-channel"
          bind:value={channel}
          options={channelOptions}
        /></Field
      >
      <Field label={t('audit.filter.client')} id="audit-client" expert
        ><Select
          id="audit-client"
          bind:value={clientId}
          options={clientOptions}
        /></Field
      >
    {/if}
  </div>
  {#if filtered}
    <div>
      <Button size="sm" variant="ghost" icon={FilterX} onclick={reset}
        >{t('audit.filter.reset')}</Button
      >
    </div>
  {/if}
</section>

{#if entries.length === 0}
  <EmptyState
    icon={ScrollText}
    title={t('audit.empty')}
    body={filtered ? t('audit.emptyFiltered') : undefined}
  />
{:else}
  <ol class="log">
    {#each entries.slice(0, shown) as entry (entry.id)}
      {@const href = entityHref(entry)}
      {@const changes = entry.changes.filter(change =>
        changeVisible(entry.entityKind, change.field, isExpert())
      )}
      {@const reverted =
        entry.revertsId === null ? undefined : byId.get(entry.revertsId)}
      <li
        id="audit-{entry.id}"
        class="entry"
        class:undone={entry.undoneAt !== null}
        class:flash={router.highlight === entry.id}
      >
        <div class="who">
          {#if entry.channel === 'job'}
            <span class="system-avatar"><Clock size={16} /></span>
          {:else}
            <Avatar name={entry.actorUserName} size={34} />
          {/if}
        </div>
        <div class="body">
          <div class="headline">
            <span class="sentence">
              <strong>{entry.actorUserName}</strong>
              <span class="muted">·</span>
              <span>{operationText(entry)}</span>
            </span>
            <span
              class="time small muted"
              title={formatDateTime(entry.createdAt)}
              >{formatRelative(entry.createdAt)}</span
            >
          </div>
          <div class="meta">
            {#if href !== null}
              <a class="entity" {href}
                >{entityLabel(entry.entityKind, entry.entityId)}<ArrowRight
                  size={13}
                /></a
              >
            {:else}
              <span class="entity plain"
                >{entityLabel(entry.entityKind, entry.entityId)}</span
              >
            {/if}
            {#if entry.channel === 'mcp'}
              <Badge tone="mucki" icon={Bot}
                >{entry.clientName ?? t('audit.channel.mcp')}</Badge
              >
            {/if}
            {#if isExpert()}
              <Badge tone="neutral">{t(`audit.channel.${entry.channel}`)}</Badge
              >
              <OpBadge op={entry.operation} />
            {/if}
            {#if entry.undoneAt !== null}
              <Badge
                tone="warn"
                icon={Undo2}
                title={formatDateTime(entry.undoneAt)}
                >{t('audit.undoneBadge', {
                  at: formatRelative(entry.undoneAt)
                })}</Badge
              >
            {/if}
            {#if reverted !== undefined}
              <button
                type="button"
                class="link small"
                onclick={() => showEntry(reverted.id)}
                >{t('audit.reverts', { what: operationText(reverted) })}</button
              >
            {/if}
            {#if !entry.undoable && entry.revertsId === null && entry.undoneAt === null}
              <span class="xs faint">{t('audit.notUndoable')}</span>
            {/if}
          </div>
          {#if changes.length > 0}
            <dl class="diff">
              {#each changes as change, index (`${change.field}:${index}`)}
                <div class="change">
                  <dt>
                    {fieldLabel(entry.entityKind, change.field)}
                    {#if isExpert() && fieldLabel(entry.entityKind, change.field) !== change.field}<code
                        class="xs faint">{change.field}</code
                      >{/if}
                  </dt>
                  <dd>
                    <span class="from">
                      {#if isForwardTarget(change.from)}<ForwardTargetLabel
                          target={change.from}
                          link={false}
                        />{:else}{valueText(change.from)}{/if}
                    </span>
                    <ArrowRight size={13} class="arrow" />
                    <span class="to">
                      {#if isForwardTarget(change.to)}<ForwardTargetLabel
                          target={change.to}
                          link={false}
                        />{:else}{valueText(change.to)}{/if}
                    </span>
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}
          {#if isExpert()}
            <div class="ids xs faint">
              <code>{entry.id}</code>
              {#if entry.entityId}<code
                  >{entry.entityKind}:{entry.entityId}</code
                >{/if}
              {#if entry.clientId}<code>{entry.clientId}</code>{/if}
            </div>
          {/if}
        </div>
        <div class="act">
          {#if canUndo(entry)}
            <Button
              size="sm"
              variant="secondary"
              icon={Undo2}
              op="audit.undo"
              onclick={() =>
                run(
                  'audit.undo',
                  { id: entry.id },
                  { success: 'audit.undone' }
                )}>{t('common.undo')}</Button
            >
          {/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if entries.length > shown}
    <div class="more">
      <Button variant="ghost" onclick={() => (shown += PAGE)}
        >{t('audit.more', { count: entries.length - shown })}</Button
      >
    </div>
  {/if}
{/if}

<style>
  .filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
    padding: var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr));
    gap: var(--space-3);
  }
  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .entry {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    gap: var(--space-3);
    padding: var(--space-4);
    scroll-margin: 80px;
  }
  .entry + .entry {
    border-top: 1px solid var(--line);
  }
  .entry.undone .sentence,
  .entry.undone .diff {
    opacity: 0.6;
  }
  .entry.undone .sentence span:last-child {
    text-decoration: line-through;
  }
  .system-avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .headline {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    align-items: baseline;
    flex-wrap: wrap;
  }
  .sentence {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .time {
    white-space: nowrap;
  }
  .meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .entity {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-sm);
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .entity.plain {
    color: var(--text-muted);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--primary);
    cursor: pointer;
    font-weight: 600;
  }
  .link:hover {
    text-decoration: underline;
  }
  .diff {
    margin: 4px 0 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
  }
  .change {
    display: grid;
    grid-template-columns: minmax(120px, 30%) 1fr;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }
  dt {
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .from {
    color: var(--text-muted);
    text-decoration: line-through;
    text-decoration-color: var(--text-faint);
    overflow-wrap: anywhere;
  }
  .to {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  dd :global(.arrow) {
    color: var(--text-faint);
    flex: none;
  }
  .ids {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .act {
    display: flex;
    align-items: flex-start;
  }
  .more {
    display: flex;
    justify-content: center;
    margin-top: var(--space-4);
  }
  @media (max-width: 640px) {
    .entry {
      grid-template-columns: 34px minmax(0, 1fr);
    }
    .act {
      grid-column: 2;
    }
    .change {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
