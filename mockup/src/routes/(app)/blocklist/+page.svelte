<!--
  The blocklist (`blockedNumbers.*`, admin): numbers and prefixes whose inbound calls are refused.
  Reference page for the mockup's patterns: read through `read`, write through `run`, fields from
  the registry, operations named for Expert mode.
-->
<script lang="ts">
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type { BlockedNumber } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import { formatDate, formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const rows = $derived(
    read<{ items: BlockedNumber[] }>('blockedNumbers.list', {}, { items: [] })
      .items
  );

  let creating = $state(false);
  let draft = $state({ number: '', isPrefix: false, label: '' });
  let error = $state<string | null>(null);

  async function create(): Promise<void> {
    const result = await run<BlockedNumber>(
      'blockedNumbers.create',
      { ...draft, label: draft.label || null },
      {
        success: 'blocklist.created',
        successParams: { number: draft.number },
        quietErrors: true
      }
    );
    if (result.ok) {
      creating = false;
      highlight(result.value.id);
      draft = { number: '', isPrefix: false, label: '' };
      error = null;
    } else {
      error = errorText(result.error);
    }
  }

  const columns = $derived([
    { key: 'number', label: t('field.blockedNumber.number'), primary: true },
    { key: 'match', label: t('blocklist.match') },
    { key: 'label', label: t('field.blockedNumber.label') },
    { key: 'created', label: t('common.createdAt'), hideOnMobile: true },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : []),
    { key: 'actions', label: '', align: 'right' as const, width: '60px' }
  ]);
</script>

<PageHeader title={t('nav.blocklist')} subtitle={t('blocklist.subtitle')}>
  {#snippet actions()}
    <Button
      variant="primary"
      icon={Plus}
      op="blockedNumbers.create"
      onclick={() => (creating = true)}>{t('blocklist.add')}</Button
    >
  {/snippet}
</PageHeader>

<DataTable {rows} {columns} rowKey={row => row.id} caption={t('nav.blocklist')}>
  {#snippet cell(row, key)}
    {#if key === 'number'}
      <span class="mono strong"
        >{formatPhone(row.number)}{row.isPrefix ? '…' : ''}</span
      >
    {:else if key === 'match'}
      <Badge tone={row.isPrefix ? 'warn' : 'neutral'}
        >{row.isPrefix ? t('blocklist.prefix') : t('blocklist.exact')}</Badge
      >
    {:else if key === 'label'}
      <span class="muted">{row.label ?? '—'}</span>
    {:else if key === 'created'}
      <span class="muted small">{formatDate(row.createdAt)}</span>
    {:else if key === 'id'}
      <code class="xs faint">{row.id}</code>
    {:else if key === 'actions'}
      <IconButton
        icon={Trash2}
        variant="danger"
        label={t('common.delete')}
        onclick={() =>
          run(
            'blockedNumbers.delete',
            { id: row.id },
            { success: 'blocklist.deleted' }
          )}
      />
    {/if}
  {/snippet}
  {#snippet empty()}
    <EmptyState
      icon={PhoneOff}
      title={t('blocklist.empty')}
      body={t('blocklist.emptyBody')}
    />
  {/snippet}
</DataTable>

<Drawer
  open={creating}
  title={t('blocklist.add')}
  onclose={() => (creating = false)}
>
  <div class="stack">
    <FormField entity="blockedNumber" key="number" {error} required>
      {#snippet children()}
        <TextInput
          id="blockedNumber-number"
          mono
          type="tel"
          placeholder="+4980012345"
          bind:value={draft.number}
          invalid={error !== null}
          onenter={create}
        />
      {/snippet}
    </FormField>
    <FormField entity="blockedNumber" key="isPrefix">
      {#snippet children()}
        <Switch
          id="blockedNumber-isPrefix"
          bind:checked={draft.isPrefix}
          label={t('blocklist.prefixSwitch')}
        />
      {/snippet}
    </FormField>
    <FormField entity="blockedNumber" key="label">
      {#snippet children()}
        <TextInput
          id="blockedNumber-label"
          bind:value={draft.label}
          placeholder={t('blocklist.labelPlaceholder')}
        />
      {/snippet}
    </FormField>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creating = false)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="blockedNumbers.create" onclick={create}
      >{t('blocklist.add')}</Button
    >
  {/snippet}
</Drawer>
