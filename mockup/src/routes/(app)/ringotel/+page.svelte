<!--
  Ringotel setup (`provisioning.ringotelOptions`, `ringotelSetup`, `ringotelAdopt`, §10.4), owner
  only: connects the phone system to a Ringotel organization so app devices are provisioned
  automatically. Setup and adoption apply to a system not yet connected.
-->
<script lang="ts">
  import Building from '@lucide/svelte/icons/building';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Cloud from '@lucide/svelte/icons/cloud';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Link2 from '@lucide/svelte/icons/link-2';
  import Smartphone from '@lucide/svelte/icons/smartphone';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type {
    RingotelIds,
    RingotelPackage,
    RingotelRegion
  } from '#lib/api/ops/areas/provisioning.js';
  import type { Settings, SystemInfo } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import InfoList from '#lib/components/system/InfoList.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const settings = $derived(read<Settings | null>('settings.get', {}, null));
  const system = $derived(read<SystemInfo | null>('system.info', {}, null));
  const offer = $derived(
    read<{ regions: RingotelRegion[]; packages: RingotelPackage[] }>(
      'provisioning.ringotelOptions',
      {},
      { regions: [], packages: [] }
    )
  );
  const connected = $derived(
    settings !== null &&
      (settings.ringotelOrgId !== null || settings.ringotelBranchId !== null)
  );

  let showSetup = $state(false);
  let mode = $state<'setup' | 'adopt'>('setup');
  let setup = $state({ domain: '', region: '3', packageid: 1 });
  let adopt = $state({ orgId: '', domain: '', branchId: '' });
  let errors = $state<Record<string, string>>({});
  let busy = $state(false);

  const regionOptions = $derived(
    offer.regions.map(region => ({ value: region.id, label: region.name }))
  );
  const packageOptions = $derived(
    offer.packages.map(item => ({
      value: item.id,
      label:
        item.maxregs === undefined
          ? item.name
          : t('ringotel.package', { name: item.name, regs: item.maxregs })
    }))
  );

  async function submit(): Promise<void> {
    busy = true;
    errors = {};
    const result =
      mode === 'setup'
        ? await run<RingotelIds>(
            'provisioning.ringotelSetup',
            {
              domain: setup.domain,
              region: setup.region,
              packageid: setup.packageid
            },
            { success: 'ringotel.connectedToast' }
          )
        : await run<RingotelIds>(
            'provisioning.ringotelAdopt',
            {
              orgId: adopt.orgId,
              domain: adopt.domain,
              ...(adopt.branchId.trim() ? { branchId: adopt.branchId } : {})
            },
            { success: 'ringotel.adoptedToast' }
          );
    busy = false;
    if (!result.ok && result.error.field !== null) {
      errors = { [result.error.field]: errorText(result.error) };
    }
  }
</script>

<PageHeader title={t('nav.ringotel')} subtitle={t('ringotel.subtitle')} />

{#if settings !== null}
  <div class="stack" style="--gap: 24px">
    <div class="grid-2">
      <Card title={t('ringotel.what.title')} icon={Smartphone}>
        <ul class="points small">
          <li>{t('ringotel.what.point1')}</li>
          <li>{t('ringotel.what.point2')}</li>
          <li>{t('ringotel.what.point3')}</li>
        </ul>
      </Card>

      <Card title={t('ringotel.status.title')} icon={Cloud}>
        <div class="state" class:ok={connected}>
          {#if connected}
            <CircleCheck size={20} />
            <div>
              <strong>{t('ringotel.status.connected')}</strong>
              <span class="small muted"
                >{t('ringotel.status.connectedBody')}</span
              >
            </div>
          {:else}
            <Cloud size={20} />
            <div>
              <strong>{t('ringotel.status.notConnected')}</strong>
              <span class="small muted"
                >{t('ringotel.status.notConnectedBody')}</span
              >
            </div>
          {/if}
        </div>
        <InfoList
          items={[
            {
              label: t('ringotel.status.org'),
              value: settings.ringotelOrgId ?? '—',
              mono: true
            },
            {
              label: t('ringotel.status.branch'),
              value: settings.ringotelBranchId ?? '—',
              mono: true
            },
            {
              label: t('field.settings.ringotelMaxRegs'),
              value: String(settings.ringotelMaxRegs)
            },
            {
              label: t('field.settings.ringotelApiToken'),
              value: settings.ringotelApiTokenSet
                ? t('secret.set')
                : t('ringotel.status.noToken')
            },
            {
              label: t('ringotel.status.sync'),
              value:
                system?.ringotel.profilePending ||
                system?.ringotel.rosterPending
                  ? t('system.ringotel.pending')
                  : t('system.ringotel.inSync')
            }
          ]}
        />
        <div class="row links">
          <Button
            size="sm"
            variant="ghost"
            icon={KeyRound}
            href="#/settings/ringotel">{t('ringotel.toSettings')}</Button
          >
        </div>
      </Card>
    </div>

    <Card
      title={connected
        ? t('ringotel.setup.titleConnected')
        : t('ringotel.setup.title')}
      description={connected
        ? t('ringotel.setup.connectedBody')
        : t('ringotel.setup.body')}
      icon={Link2}
    >
      {#snippet actions()}
        {#if connected}
          <Button
            size="sm"
            variant="ghost"
            iconRight={ChevronDown}
            onclick={() => (showSetup = !showSetup)}
            >{showSetup
              ? t('ringotel.setup.hide')
              : t('ringotel.setup.show')}</Button
          >
        {/if}
      {/snippet}
      {#if !connected || showSetup}
        {#if !settings.ringotelApiTokenSet}
          <p class="warning small">{t('ringotel.setup.needsToken')}</p>
        {/if}
        <Segmented
          bind:value={mode}
          options={[
            { value: 'setup', label: t('ringotel.setup.new') },
            { value: 'adopt', label: t('ringotel.setup.adopt') }
          ]}
          ariaLabel={t('ringotel.setup.title')}
        />
        <div class="form">
          {#if mode === 'setup'}
            <p class="small muted">{t('ringotel.setup.newBody')}</p>
            <FormField
              entity="ringotel"
              key="domain"
              error={errors.domain ?? null}
              required
            >
              {#snippet children()}
                <TextInput
                  id="ringotel-domain"
                  mono
                  suffix=".ringotel.co"
                  placeholder="brandtpartner"
                  bind:value={setup.domain}
                />
              {/snippet}
            </FormField>
            <div class="grid-2" style="--gap: 12px">
              <FormField
                entity="ringotel"
                key="region"
                error={errors.region ?? null}
                required
              >
                {#snippet children()}
                  <Select
                    id="ringotel-region"
                    bind:value={setup.region}
                    options={regionOptions}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="ringotel"
                key="packageid"
                error={errors.packageid ?? null}
                required
              >
                {#snippet children()}
                  <Select
                    id="ringotel-packageid"
                    bind:value={setup.packageid}
                    options={packageOptions}
                  />
                {/snippet}
              </FormField>
            </div>
            <div>
              <Button
                variant="primary"
                icon={Building}
                op="provisioning.ringotelSetup"
                loading={busy}
                onclick={submit}>{t('ringotel.setup.create')}</Button
              >
            </div>
          {:else}
            <p class="small muted">{t('ringotel.setup.adoptBody')}</p>
            <div class="grid-2" style="--gap: 12px">
              <FormField
                entity="ringotel"
                key="orgId"
                error={errors.orgId ?? null}
                required
              >
                {#snippet children()}
                  <TextInput
                    id="ringotel-orgId"
                    mono
                    bind:value={adopt.orgId}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="ringotel"
                key="domain"
                id="ringotel-adopt-domain"
                error={errors.domain ?? null}
                required
              >
                {#snippet children()}
                  <TextInput
                    id="ringotel-adopt-domain"
                    mono
                    suffix=".ringotel.co"
                    bind:value={adopt.domain}
                  />
                {/snippet}
              </FormField>
            </div>
            <FormField
              entity="ringotel"
              key="branchId"
              error={errors.branchId ?? null}
            >
              {#snippet children()}
                <TextInput
                  id="ringotel-branchId"
                  mono
                  placeholder={t('ringotel.setup.branchPlaceholder')}
                  bind:value={adopt.branchId}
                />
              {/snippet}
            </FormField>
            <div>
              <Button
                variant="primary"
                icon={Link2}
                op="provisioning.ringotelAdopt"
                loading={busy}
                onclick={submit}>{t('ringotel.setup.adoptAction')}</Button
              >
            </div>
          {/if}
        </div>
        {#if isExpert()}
          <p class="xs faint">{t('ringotel.setup.expert')}</p>
        {/if}
      {:else}
        <Badge tone="ok" icon={CircleCheck}
          >{t('ringotel.status.connected')}</Badge
        >
      {/if}
    </Card>
  </div>
{/if}

<style>
  .points {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .state {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    margin-bottom: var(--space-3);
  }
  .state div {
    display: flex;
    flex-direction: column;
  }
  .state :global(svg) {
    flex: none;
    color: var(--text-muted);
  }
  .state.ok {
    background: var(--ok-soft);
  }
  .state.ok :global(svg) {
    color: var(--ok);
  }
  .links {
    margin-top: var(--space-3);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-top: var(--space-4);
    max-width: 640px;
  }
  .warning {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    margin-bottom: var(--space-3);
  }
</style>
