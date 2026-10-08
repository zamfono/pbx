<!--
  SIP protection (Expert, §5.6): the addresses banned for failed SIP attempts (`sipBans.*`), the
  allowlist of sources never banned (`sipAllowlist.*`), and the ban rules (`settings.sipBan*`).
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import { userName } from '#lib/api/lookup.js';
  import type { SipAllowlistEntryWire } from '#lib/api/ops/areas/sipAllowlist.js';
  import type { SipBanState, SipBanWire } from '#lib/api/ops/areas/sipBans.js';
  import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import BanStepsEditor from '#lib/components/system/BanStepsEditor.svelte';
  import DurationInput from '#lib/components/system/DurationInput.svelte';
  import SettingsCard from '#lib/components/system/SettingsCard.svelte';
  import { SettingsForm } from '#lib/components/system/settingsForm.svelte.js';
  import {
    formatDate,
    formatDateTime,
    formatRelative,
    formatSeconds,
    t
  } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  let banState = $state<SipBanState>('active');
  const bans = $derived(
    read<{ items: SipBanWire[] }>(
      'sipBans.list',
      { state: banState },
      { items: [] }
    ).items
  );
  const activeCount = $derived(
    read<{ items: SipBanWire[] }>(
      'sipBans.list',
      { state: 'active' },
      { items: [] }
    ).items.length
  );
  const allowlist = $derived(
    read<{ items: SipAllowlistEntryWire[] }>(
      'sipAllowlist.list',
      {},
      { items: [] }
    ).items
  );

  const rules = new SettingsForm([
    'sipBanFailures',
    'sipBanWindowS',
    'sipBanSuccessExemptS',
    'sipBanLookbackS',
    'sipBanSteps'
  ]);
  const steps = $derived(rules.get('sipBanSteps') ?? []);
  const nowIso = demoNowDate().toISOString();

  let draft = $state({ address: '', label: '' });
  let draftError = $state<string | null>(null);

  async function addEntry(): Promise<void> {
    const result = await run<SipAllowlistEntryWire>(
      'sipAllowlist.create',
      { address: draft.address, label: draft.label || null },
      {
        success: 'sipProtection.allow.added',
        successParams: { address: draft.address },
        quietErrors: true
      }
    );
    if (result.ok) {
      highlight(result.value.id);
      draft = { address: '', label: '' };
      draftError = null;
    } else {
      draftError = errorText(result.error);
    }
  }

  const stepText = (seconds: number | null): string =>
    seconds === null
      ? t('sipProtection.steps.permanentShort')
      : formatSeconds(seconds);
  const summary = $derived(
    steps.length === 0
      ? t('sipProtection.rules.off')
      : t('sipProtection.rules.summary', {
          failures: rules.get('sipBanFailures') ?? 0,
          window: formatSeconds(rules.get('sipBanWindowS') ?? 0),
          steps: steps.map(stepText).join(' → ')
        })
  );

  const banColumns = $derived([
    { key: 'address', label: t('sipProtection.bans.address'), primary: true },
    { key: 'step', label: t('sipProtection.bans.step') },
    {
      key: 'failures',
      label: t('sipProtection.bans.failures'),
      align: 'right' as const
    },
    { key: 'since', label: t('sipProtection.bans.since'), hideOnMobile: true },
    { key: 'until', label: t('sipProtection.bans.until') },
    { key: 'actions', label: '', align: 'right' as const, width: '120px' }
  ]);
  const allowColumns = $derived([
    {
      key: 'address',
      label: t('field.sipAllowlistEntry.address'),
      primary: true
    },
    { key: 'label', label: t('field.sipAllowlistEntry.label') },
    { key: 'created', label: t('common.createdAt'), hideOnMobile: true },
    { key: 'actions', label: '', align: 'right' as const, width: '60px' }
  ]);
</script>

<PageHeader
  title={t('nav.sipProtection')}
  subtitle={t('sipProtection.subtitle')}
>
  {#snippet meta()}
    <Badge tone={activeCount > 0 ? 'warn' : 'ok'} dot
      >{t('sipProtection.activeCount', { count: activeCount })}</Badge
    >
  {/snippet}
</PageHeader>

<div class="stack" style="--gap: 24px">
  <Card
    title={t('sipProtection.bans.title')}
    description={t('sipProtection.bans.body')}
    icon={ShieldAlert}
    padded={false}
  >
    <div class="toolbar">
      <Segmented
        size="sm"
        bind:value={banState}
        options={[
          { value: 'active', label: t('sipProtection.bans.active') },
          { value: 'ended', label: t('sipProtection.bans.ended') },
          { value: 'all', label: t('common.all') }
        ]}
        ariaLabel={t('sipProtection.bans.title')}
      />
    </div>
    <div class="table-pad">
      <DataTable
        rows={bans}
        columns={banColumns}
        rowKey={row => row.id}
        caption={t('sipProtection.bans.title')}
      >
        {#snippet cell(row, key)}
          {#if key === 'address'}
            <span class="mono strong">{row.address}</span>
          {:else if key === 'step'}
            <Badge tone={row.expiresAt === null ? 'danger' : 'warn'}
              >{t('sipProtection.bans.stepN', { n: row.step })}</Badge
            >
          {:else if key === 'failures'}
            <span class="nums">{row.failures}</span>
          {:else if key === 'since'}
            <span class="small muted" title={formatDateTime(row.createdAt)}
              >{formatDate(row.createdAt)}</span
            >
          {:else if key === 'until'}
            {#if row.liftedAt !== null}
              <span class="small"
                >{t('sipProtection.bans.liftedBy', {
                  at: formatDate(row.liftedAt),
                  by: row.liftedBy ? userName(row.liftedBy) : '—'
                })}</span
              >
            {:else if row.expiresAt === null}
              <span class="small strong"
                >{t('sipProtection.bans.permanent')}</span
              >
            {:else if row.expiresAt > nowIso}
              <span class="small" title={formatDateTime(row.expiresAt)}
                >{t('sipProtection.bans.expires', {
                  at: formatRelative(row.expiresAt)
                })}</span
              >
            {:else}
              <span class="small muted"
                >{t('sipProtection.bans.expired', {
                  at: formatDate(row.expiresAt)
                })}</span
              >
            {/if}
          {:else if key === 'actions'}
            {#if row.liftedAt === null && (row.expiresAt === null || row.expiresAt > nowIso)}
              <Button
                size="sm"
                variant="ghost"
                icon={ShieldOff}
                op="sipBans.lift"
                onclick={() =>
                  run(
                    'sipBans.lift',
                    { id: row.id },
                    {
                      success: 'sipProtection.bans.lifted',
                      successParams: { address: row.address }
                    }
                  )}
              >
                {t('sipProtection.bans.lift')}
              </Button>
            {/if}
          {/if}
        {/snippet}
        {#snippet empty()}
          <EmptyState
            icon={ShieldCheck}
            title={banState === 'active'
              ? t('sipProtection.bans.emptyActive')
              : t('sipProtection.bans.empty')}
          />
        {/snippet}
      </DataTable>
    </div>
  </Card>

  <div class="grid-2">
    <Card
      title={t('sipProtection.allow.title')}
      description={t('sipProtection.allow.body')}
      icon={ShieldCheck}
    >
      <div class="add">
        <FormField
          entity="sipAllowlistEntry"
          key="address"
          error={draftError}
          required
        >
          {#snippet children()}
            <TextInput
              id="sipAllowlistEntry-address"
              mono
              placeholder="198.51.100.0/24"
              bind:value={draft.address}
              invalid={draftError !== null}
              onenter={addEntry}
            />
          {/snippet}
        </FormField>
        <FormField entity="sipAllowlistEntry" key="label">
          {#snippet children()}
            <TextInput
              id="sipAllowlistEntry-label"
              placeholder={t('sipProtection.allow.labelPlaceholder')}
              bind:value={draft.label}
              onenter={addEntry}
            />
          {/snippet}
        </FormField>
        <div class="add-action">
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            op="sipAllowlist.create"
            onclick={addEntry}>{t('sipProtection.allow.add')}</Button
          >
        </div>
      </div>
      <DataTable
        rows={allowlist}
        columns={allowColumns}
        rowKey={row => row.id}
        dense
        caption={t('sipProtection.allow.title')}
      >
        {#snippet cell(row, key)}
          {#if key === 'address'}
            <span class="mono strong">{row.address}</span>
          {:else if key === 'label'}
            <span class="muted small">{row.label ?? '—'}</span>
          {:else if key === 'created'}
            <span class="muted small">{formatDate(row.createdAt)}</span>
          {:else if key === 'actions'}
            <IconButton
              icon={Trash2}
              variant="danger"
              label={t('common.delete')}
              onclick={() =>
                run(
                  'sipAllowlist.delete',
                  { id: row.id },
                  { success: 'sipProtection.allow.deleted' }
                )}
            />
          {/if}
        {/snippet}
        {#snippet empty()}
          <p class="small muted">{t('sipProtection.allow.empty')}</p>
        {/snippet}
      </DataTable>
    </Card>

    <SettingsCard
      form={rules}
      title={t('sipProtection.rules.title')}
      description={summary}
      icon={SlidersHorizontal}
      expert
    >
      <div class="grid-2" style="--gap: 12px">
        <FormField
          entity="settings"
          key="sipBanFailures"
          error={rules.error('sipBanFailures')}
        >
          {#snippet children()}
            <NumberInput
              id="settings-sipBanFailures"
              value={rules.get('sipBanFailures') ?? 10}
              min={1}
              onchange={value => rules.set('sipBanFailures', value ?? 1)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="sipBanWindowS"
          error={rules.error('sipBanWindowS')}
        >
          {#snippet children()}
            <DurationInput
              id="settings-sipBanWindowS"
              value={rules.get('sipBanWindowS') ?? 3600}
              min={1}
              onchange={value => rules.set('sipBanWindowS', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="sipBanSuccessExemptS"
          error={rules.error('sipBanSuccessExemptS')}
        >
          {#snippet children()}
            <DurationInput
              id="settings-sipBanSuccessExemptS"
              value={rules.get('sipBanSuccessExemptS') ?? 86400}
              onchange={value => rules.set('sipBanSuccessExemptS', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="sipBanLookbackS"
          error={rules.error('sipBanLookbackS')}
        >
          {#snippet children()}
            <DurationInput
              id="settings-sipBanLookbackS"
              value={rules.get('sipBanLookbackS') ?? 2592000}
              min={1}
              onchange={value => rules.set('sipBanLookbackS', value)}
            />
          {/snippet}
        </FormField>
      </div>
      <FormField
        entity="settings"
        key="sipBanSteps"
        error={rules.error('sipBanSteps')}
      >
        {#snippet children()}
          <BanStepsEditor
            value={steps}
            invalid={rules.error('sipBanSteps') !== null}
            onchange={value => rules.set('sipBanSteps', value)}
          />
        {/snippet}
      </FormField>
    </SettingsCard>
  </div>
</div>

<style>
  .toolbar {
    padding: var(--space-3) var(--space-4) 0;
  }
  .table-pad {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
  /* Address and note side by side, top-aligned (only the address has help text), the button below. */
  .add {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    align-items: start;
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--line);
  }
  .add-action {
    grid-column: 1 / -1;
  }
</style>
