<!--
  AI & API: connecting an AI assistant over MCP, webhooks (`webhooks.*`, §10.6), personal access
  tokens for scripts, and in Expert mode the REST API's OpenAPI document.
-->
<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';
  import FileJson from '@lucide/svelte/icons/file-json';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import Webhook from '@lucide/svelte/icons/webhook';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type { WebhookWire } from '#lib/api/ops/areas/webhooks.js';
  import {
    EVENT_TYPES,
    type EventType,
    type SystemInfo
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import CopyCommand from '#lib/components/system/CopyCommand.svelte';
  import { formatDateTime, formatRelative, t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import SecretInput from '#lib/ui/SecretInput.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const system = $derived(read<SystemInfo | null>('system.info', {}, null));
  const domain = $derived(system?.stack.domain ?? 'tel.example.com');
  const mcpUrl = $derived(`https://${domain}/mcp`);
  const hooks = $derived(
    read<{ items: WebhookWire[] }>('webhooks.list', {}, { items: [] }).items
  );

  type Draft = {
    id: string | null;
    url: string;
    secret: string | null | undefined;
    allEvents: boolean;
    eventTypes: EventType[];
    active: boolean;
  };
  let editing = $state<Draft | null>(null);
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);

  function openCreate(): void {
    editing = {
      id: null,
      url: '',
      secret: '',
      allEvents: true,
      eventTypes: [],
      active: false
    };
    errors = {};
  }

  function openEdit(hook: WebhookWire): void {
    editing = {
      id: hook.id,
      url: hook.url,
      secret: undefined,
      allEvents: hook.eventTypes === null,
      eventTypes: hook.eventTypes ?? [],
      active: hook.active
    };
    errors = {};
  }

  function generateSecret(): void {
    if (editing !== null) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      editing.secret = Array.from(bytes, byte =>
        byte.toString(16).padStart(2, '0')
      ).join('');
    }
  }

  function toggleEvent(type: EventType, on: boolean): void {
    if (editing !== null) {
      editing.eventTypes = on
        ? EVENT_TYPES.filter(
            each => each === type || editing?.eventTypes.includes(each)
          )
        : editing.eventTypes.filter(each => each !== type);
    }
  }

  async function save(): Promise<void> {
    if (editing === null) {
      return;
    }
    const eventTypes = editing.allEvents ? null : editing.eventTypes;
    saving = true;
    const result =
      editing.id === null
        ? await run<WebhookWire>(
            'webhooks.create',
            { url: editing.url, secret: editing.secret ?? '', eventTypes },
            { success: 'integrations.webhook.created' }
          )
        : await run<WebhookWire>(
            'webhooks.update',
            {
              id: editing.id,
              url: editing.url,
              eventTypes,
              active: editing.active,
              ...(editing.secret === undefined || editing.secret === null
                ? {}
                : { secret: editing.secret })
            },
            { success: 'integrations.webhook.saved' }
          );
    saving = false;
    if (result.ok) {
      highlight(result.value.id);
      editing = null;
    } else if (result.error.field !== null) {
      errors = { [result.error.field]: errorText(result.error) };
    }
  }

  const columns = $derived([
    { key: 'url', label: t('field.webhook.url'), primary: true },
    { key: 'events', label: t('field.webhook.eventTypes') },
    { key: 'status', label: t('integrations.webhook.delivery') },
    { key: 'active', label: t('field.webhook.active'), width: '90px' },
    { key: 'actions', label: '', align: 'right' as const, width: '96px' }
  ]);
</script>

<PageHeader
  title={t('nav.integrations')}
  subtitle={t('integrations.subtitle')}
/>

<div class="stack" style="--gap: 24px">
  <Card
    title={t('integrations.mcp.title')}
    description={t('integrations.mcp.body')}
    icon={Sparkles}
  >
    <div class="mcp">
      <div class="stack" style="--gap: 14px">
        <CopyCommand
          label="Claude Code"
          value={`claude mcp add --transport http zamfono ${mcpUrl}`}
        />
        <CopyCommand
          label="Codex"
          value={`codex mcp add zamfono --url ${mcpUrl}`}
        />
        <CopyCommand label={t('integrations.mcp.other')} value={mcpUrl} />
      </div>
      <ol class="steps">
        <li>
          <strong>{t('integrations.mcp.step1')}</strong><span
            >{t('integrations.mcp.step1Body')}</span
          >
        </li>
        <li>
          <strong>{t('integrations.mcp.step2')}</strong><span
            >{t('integrations.mcp.step2Body')}</span
          >
        </li>
        <li>
          <strong>{t('integrations.mcp.step3')}</strong><span
            >{t('integrations.mcp.step3Body')}</span
          >
        </li>
      </ol>
    </div>
    <div class="mucki">
      <span class="mucki-icon"><WandSparkles size={18} /></span>
      <p class="small">{t('integrations.mcp.mucki')}</p>
      <Button size="sm" variant="ghost" icon={ScrollText} href="#/audit"
        >{t('nav.audit')}</Button
      >
    </div>
  </Card>

  <Card
    title={t('integrations.webhooks.title')}
    description={t('integrations.webhooks.body')}
    icon={Webhook}
    padded={false}
  >
    <div class="toolbar">
      <Button
        variant="primary"
        size="sm"
        icon={Plus}
        op="webhooks.create"
        onclick={openCreate}>{t('integrations.webhook.add')}</Button
      >
    </div>
    <div class="table-pad">
      <DataTable
        rows={hooks}
        {columns}
        rowKey={row => row.id}
        caption={t('integrations.webhooks.title')}
      >
        {#snippet cell(row, key)}
          {#if key === 'url'}
            <span class="url-cell">
              <span class="mono small strong url">{row.url}</span>
              {#if isExpert()}<code class="xs faint">{row.id}</code>{/if}
            </span>
          {:else if key === 'events'}
            {#if row.eventTypes === null}
              <Badge tone="info">{t('integrations.webhook.allEvents')}</Badge>
            {:else}
              <span class="events">
                {#each row.eventTypes as type (type)}<code class="event"
                    >{type}</code
                  >{/each}
              </span>
            {/if}
          {:else if key === 'status'}
            {#if !row.active}
              <Badge tone="neutral">{t('integrations.webhook.inactive')}</Badge>
            {:else if row.lastStatus === 'failing'}
              <div class="status">
                <Badge tone="danger" dot
                  >{t('integrations.webhook.failingSince', {
                    since: formatRelative(row.failingSince)
                  })}</Badge
                >
                <span class="xs muted"
                  >{t('integrations.webhook.failedCount', {
                    count: row.failedDeliveries
                  })}</span
                >
                {#if row.lastError}<span class="xs mono danger-text"
                    >{row.lastError}</span
                  >{/if}
              </div>
            {:else if row.lastStatus === 'ok'}
              <div class="status">
                <Badge tone="ok" dot>{t('integrations.webhook.ok')}</Badge>
                <span
                  class="xs muted"
                  title={formatDateTime(row.lastDeliveryAt)}
                  >{t('integrations.webhook.lastDelivery', {
                    at: formatRelative(row.lastDeliveryAt)
                  })}</span
                >
                {#if row.lastError && row.lastErrorAt}
                  <span class="xs faint"
                    >{t('integrations.webhook.lastError', {
                      error: row.lastError,
                      at: formatDateTime(row.lastErrorAt)
                    })}</span
                  >
                {/if}
              </div>
            {:else}
              <Badge tone="neutral"
                >{t('integrations.webhook.noDelivery')}</Badge
              >
            {/if}
          {:else if key === 'active'}
            <Switch
              id="hook-active-{row.id}"
              size="sm"
              checked={row.active}
              label={row.active ? t('common.on') : t('common.off')}
              onchange={active =>
                run(
                  'webhooks.update',
                  { id: row.id, active },
                  {
                    success: active
                      ? 'integrations.webhook.activated'
                      : 'integrations.webhook.deactivated'
                  }
                )}
            />
          {:else if key === 'actions'}
            <span class="row nowrap" style="--gap: 2px">
              <IconButton
                icon={Pencil}
                label={t('common.edit')}
                onclick={() => openEdit(row)}
              />
              <IconButton
                icon={Trash2}
                variant="danger"
                label={t('common.delete')}
                onclick={() =>
                  run(
                    'webhooks.delete',
                    { id: row.id },
                    { success: 'integrations.webhook.deleted' }
                  )}
              />
            </span>
          {/if}
        {/snippet}
        {#snippet empty()}
          <EmptyState
            icon={Webhook}
            title={t('integrations.webhooks.empty')}
            body={t('integrations.webhooks.emptyBody')}
          />
        {/snippet}
      </DataTable>
    </div>
  </Card>

  <div class="grid-2">
    <Card
      title={t('integrations.tokens.title')}
      description={t('integrations.tokens.body')}
      icon={KeyRound}
    >
      <Button size="sm" variant="soft" icon={KeyRound} href="#/me/tokens"
        >{t('integrations.tokens.open')}</Button
      >
    </Card>
    {#if isExpert()}
      <Card
        title={t('integrations.rest.title')}
        description={t('integrations.rest.body')}
        icon={FileJson}
        expert
      >
        <div class="stack" style="--gap: 12px">
          <CopyCommand
            label={t('integrations.rest.openapi')}
            value={`https://${domain}/api/v1/openapi.json`}
          />
          <CopyCommand
            label={t('integrations.rest.base')}
            value={`https://${domain}/api/v1`}
          />
          <p class="xs muted">{t('integrations.rest.auth')}</p>
        </div>
      </Card>
    {/if}
  </div>
</div>

<Drawer
  open={editing !== null}
  title={editing?.id === null
    ? t('integrations.webhook.add')
    : t('integrations.webhook.edit')}
  subtitle={editing?.id === null
    ? t('integrations.webhook.createdInactive')
    : undefined}
  onclose={() => (editing = null)}
>
  {#if editing !== null}
    <div class="stack">
      <FormField entity="webhook" key="url" error={errors.url ?? null} required>
        {#snippet children()}
          {#if editing !== null}
            <TextInput
              id="webhook-url"
              type="url"
              mono
              placeholder="https://crm.example.com/hooks/zamfono"
              bind:value={editing.url}
              invalid={errors.url !== undefined}
            />
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="webhook"
        key="secret"
        error={errors.secret ?? null}
        required
      >
        {#snippet children()}
          {#if editing !== null}
            {#if editing.id === null}
              <div class="row nowrap">
                <div class="grow">
                  <TextInput
                    id="webhook-secret"
                    mono
                    value={editing.secret ?? ''}
                    autocomplete="off"
                    invalid={errors.secret !== undefined}
                    oninput={value => {
                      if (editing !== null) {
                        editing.secret = value;
                      }
                    }}
                  />
                </div>
                <Button
                  variant="soft"
                  size="sm"
                  icon={Bot}
                  onclick={generateSecret}
                  >{t('integrations.webhook.generate')}</Button
                >
              </div>
            {:else}
              <SecretInput
                id="webhook-secret"
                isSet={true}
                clearable={false}
                bind:value={editing.secret}
              />
            {/if}
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="webhook"
        key="eventTypes"
        error={errors.eventTypes ?? null}
      >
        {#snippet children()}
          {#if editing !== null}
            <div class="stack" style="--gap: 10px">
              <Switch
                id="webhook-all"
                bind:checked={editing.allEvents}
                label={t('integrations.webhook.allEvents')}
                description={t('integrations.webhook.allEventsHelp')}
              />
              {#if !editing.allEvents}
                <div class="event-grid">
                  {#each EVENT_TYPES as type (type)}
                    <label class="event-option">
                      <input
                        type="checkbox"
                        checked={editing.eventTypes.includes(type)}
                        onchange={event =>
                          toggleEvent(type, event.currentTarget.checked)}
                      />
                      <span>
                        <span class="strong small"
                          >{t(`integrations.event.${type}`)}</span
                        >
                        <code class="xs faint">{type}</code>
                      </span>
                    </label>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {/snippet}
      </FormField>
      {#if editing.id !== null}
        <FormField entity="webhook" key="active">
          {#snippet children()}
            {#if editing !== null}
              <Switch
                id="webhook-active"
                bind:checked={editing.active}
                label={t('integrations.webhook.activeSwitch')}
              />
            {/if}
          {/snippet}
        </FormField>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editing = null)}
      >{t('common.cancel')}</Button
    >
    <Button
      variant="primary"
      loading={saving}
      op={editing?.id === null ? 'webhooks.create' : 'webhooks.update'}
      onclick={save}
    >
      {editing?.id === null ? t('integrations.webhook.add') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .mcp {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .steps li {
    counter-increment: step;
    display: grid;
    grid-template-columns: 28px 1fr;
    column-gap: var(--space-3);
    font-size: var(--text-sm);
  }
  .steps li::before {
    content: counter(step);
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 800;
    font-size: var(--text-sm);
  }
  .steps span {
    color: var(--text-muted);
  }
  .mucki {
    margin-top: var(--space-5);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--mucki-soft);
    flex-wrap: wrap;
  }
  .mucki p {
    flex: 1;
    min-width: 200px;
  }
  .mucki-icon {
    color: var(--mucki-text);
    display: grid;
  }
  .toolbar {
    padding: var(--space-3) var(--space-4) 0;
  }
  .table-pad {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
  .url-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 200px;
  }
  .url {
    overflow-wrap: anywhere;
  }
  .events {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .event {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
  }
  .status {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
  }
  .danger-text {
    color: var(--danger);
  }
  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 6px;
  }
  .event-option {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .event-option span {
    display: flex;
    flex-direction: column;
  }
  .event-option input {
    margin-top: 3px;
    accent-color: var(--primary);
  }
  @media (max-width: 860px) {
    .mcp {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
