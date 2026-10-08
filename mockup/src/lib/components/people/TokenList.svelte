<!--
  A person's personal access tokens (`personalAccessTokens.*`): bearer tokens a server application
  (a CRM, a script) acts as the person with. The value is shown once; revoking stops it at once.
  Neither is undone. An owner's tokens are owner-only.
-->
<script lang="ts">
  import KeySquare from '@lucide/svelte/icons/key-square';
  import Plus from '@lucide/svelte/icons/plus';

  import { read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import { allowed } from '#lib/api/ops/core.js';
  import type { PersonalAccessToken } from '#lib/api/types.js';
  import { now as demoNow, nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import { formatDate, formatRelative, t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import OneTimeValue from '#lib/ui/OneTimeValue.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import { fieldErrors } from './people';

  let { userId }: { userId: string } = $props();

  const actor = $derived(currentActor());
  const user = $derived(userById(userId));
  const tokens = $derived(
    read<{ items: PersonalAccessToken[] }>(
      'personalAccessTokens.list',
      { userId },
      { items: [] }
    )
      .items.slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
  const canCreate = $derived(
    allowed('personalAccessTokens.create', { userId }, actor)
  );
  const cannotLogIn = $derived(
    user !== undefined &&
      (user.email === null || (user.role === 'owner' && !user.passwordSet))
  );

  type Status = 'active' | 'expired' | 'revoked';
  const statusOf = (token: PersonalAccessToken): Status =>
    token.revokedAt !== null
      ? 'revoked'
      : token.expiresAt !== null &&
          token.expiresAt <= demoNowDate().toISOString()
        ? 'expired'
        : 'active';
  const TONE: Record<Status, 'ok' | 'neutral' | 'danger'> = {
    active: 'ok',
    expired: 'neutral',
    revoked: 'danger'
  };

  type Expiry = 'never' | '30' | '90' | '365' | 'date';
  let creating = $state(false);
  let draft = $state<{ name: string; expiry: Expiry; date: string }>({
    name: '',
    expiry: '90',
    date: ''
  });
  let errors = $state<Record<string, string>>({});
  let created = $state<{ name: string; token: string } | null>(null);

  function expiresAt(): string | null {
    if (draft.expiry === 'never') {
      return null;
    }
    if (draft.expiry === 'date') {
      return draft.date === ''
        ? null
        : new Date(`${draft.date}T23:59:59`).toISOString();
    }
    return new Date(
      demoNow() + Number(draft.expiry) * 86_400_000
    ).toISOString();
  }

  async function create(): Promise<void> {
    const result = await run<PersonalAccessToken & { token: string }>(
      'personalAccessTokens.create',
      { userId, name: draft.name, expiresAt: expiresAt() },
      {
        success: 'people.tokens.created',
        successParams: { name: draft.name },
        quietErrors: true
      }
    );
    if (!result.ok) {
      errors = fieldErrors(result.error, '_');
      return;
    }
    creating = false;
    highlight(result.value.id);
    created = { name: result.value.name, token: result.value.token };
  }

  const columns = $derived([
    { key: 'name', label: t('field.personalAccessToken.name'), primary: true },
    { key: 'status', label: t('common.status') },
    { key: 'expires', label: t('field.personalAccessToken.expiresAt') },
    { key: 'used', label: t('people.tokens.lastUsed') },
    { key: 'created', label: t('common.createdAt'), hideOnMobile: true },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : []),
    { key: 'actions', label: '', align: 'right' as const, width: '110px' }
  ]);
</script>

<div class="tokens">
  <div class="row spread">
    <p class="small muted intro">{t('people.tokens.intro')}</p>
    {#if canCreate && !cannotLogIn}
      <Button
        variant="primary"
        icon={Plus}
        op="personalAccessTokens.create"
        onclick={() => {
          draft = { name: '', expiry: '90', date: '' };
          errors = {};
          creating = true;
        }}
      >
        {t('people.tokens.add')}
      </Button>
    {/if}
  </div>
  {#if cannotLogIn}
    <p class="hint small">{t('people.tokens.cannotLogIn')}</p>
  {/if}

  <DataTable
    rows={tokens}
    {columns}
    rowKey={row => row.id}
    caption={t('people.tab.tokens')}
  >
    {#snippet cell(row, key)}
      {@const status = statusOf(row)}
      {#if key === 'name'}
        <span class="strong" class:struck={status !== 'active'}>{row.name}</span
        >
      {:else if key === 'status'}
        <Badge tone={TONE[status]} dot
          >{t(`people.tokens.status.${status}`)}</Badge
        >
      {:else if key === 'expires'}
        <span class="small" class:muted={row.expiresAt === null}
          >{row.expiresAt === null
            ? t('common.never')
            : formatDate(row.expiresAt)}</span
        >
      {:else if key === 'used'}
        <span class="small muted"
          >{row.lastUsedAt === null
            ? t('people.tokens.neverUsed')
            : formatRelative(row.lastUsedAt)}</span
        >
      {:else if key === 'created'}
        <span class="small muted">{formatDate(row.createdAt)}</span>
      {:else if key === 'id'}
        <code class="xs faint row-id" title={row.id}>{row.id}</code>
      {:else if key === 'actions'}
        {#if status === 'active' && allowed('personalAccessTokens.revoke', { id: row.id }, actor)}
          <Button
            size="sm"
            variant="danger"
            op="personalAccessTokens.revoke"
            onclick={() =>
              run(
                'personalAccessTokens.revoke',
                { id: row.id },
                {
                  success: 'people.tokens.revoked',
                  successParams: { name: row.name }
                }
              )}
          >
            {t('people.tokens.revoke')}
          </Button>
        {/if}
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={KeySquare}
        title={t('people.tokens.empty')}
        body={t('people.tokens.emptyBody')}
      />
    {/snippet}
  </DataTable>
</div>

<Drawer
  open={creating}
  title={t('people.tokens.add')}
  subtitle={t('people.tokens.addIntro')}
  onclose={() => (creating = false)}
>
  <div class="stack">
    <FormField
      entity="personalAccessToken"
      key="name"
      own
      error={errors.name ?? null}
      required
    >
      {#snippet children()}
        <TextInput
          id="personalAccessToken-name"
          value={draft.name}
          placeholder="crm-sync"
          oninput={name => (draft = { ...draft, name })}
          invalid={errors.name !== undefined}
          onenter={create}
        />
      {/snippet}
    </FormField>
    <FormField
      entity="personalAccessToken"
      key="expiresAt"
      own
      error={errors.expiresAt ?? null}
    >
      {#snippet children()}
        <div class="stack" style="--gap: 8px">
          <Segmented
            size="sm"
            value={draft.expiry}
            options={[
              { value: '30', label: t('people.tokens.days', { n: 30 }) },
              { value: '90', label: t('people.tokens.days', { n: 90 }) },
              { value: '365', label: t('people.tokens.year') },
              { value: 'never', label: t('common.never') },
              { value: 'date', label: t('people.tokens.pickDate') }
            ]}
            onchange={expiry => (draft = { ...draft, expiry })}
          />
          {#if draft.expiry === 'date'}
            <TextInput
              id="personalAccessToken-expiresAt"
              type="date"
              value={draft.date}
              oninput={date => (draft = { ...draft, date })}
            />
          {/if}
        </div>
      {/snippet}
    </FormField>
    {#if errors._}<p class="form-error" role="alert">{errors._}</p>{/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creating = false)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="personalAccessTokens.create" onclick={create}
      >{t('common.create')}</Button
    >
  {/snippet}
</Drawer>

<Dialog
  open={created !== null}
  title={t('people.tokens.createdTitle', { name: created?.name ?? '' })}
  onclose={() => (created = null)}
>
  {#if created !== null}
    <div class="stack">
      <p class="small muted">{t('people.tokens.createdIntro')}</p>
      <OneTimeValue
        value={created.token}
        label={t('people.tokens.value')}
        note={t('people.tokens.once')}
      />
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="primary" onclick={() => (created = null)}
      >{t('people.done')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .row-id {
    display: inline-block;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
  .tokens {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .intro {
    margin: 0;
    max-width: 60ch;
  }
  .hint {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    background: var(--warn-soft);
    color: var(--warn);
    border-radius: var(--radius-sm);
    font-weight: 700;
  }
  .struck {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
</style>
