<!--
  Tenant settings (`settings.get`, `settings.update`, §11.4), one tab per topic. Every card saves
  its own fields; owner-only fields are plain text for admins, or hidden (design §3.2). The SIP
  ban thresholds live on the SIP protection page.
-->
<script lang="ts">
  import BellRing from '@lucide/svelte/icons/bell-ring';
  import Building2 from '@lucide/svelte/icons/building-2';
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import Cloud from '@lucide/svelte/icons/cloud';
  import Globe from '@lucide/svelte/icons/globe';
  import Hash from '@lucide/svelte/icons/hash';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Mail from '@lucide/svelte/icons/mail';
  import PhoneCall from '@lucide/svelte/icons/phone-call';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Siren from '@lucide/svelte/icons/siren';
  import Timer from '@lucide/svelte/icons/timer';
  import Trash from '@lucide/svelte/icons/trash';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import UserRoundCheck from '@lucide/svelte/icons/user-round-check';
  import { page } from '$app/state';

  import { read } from '#lib/actions.svelte.js';
  import { liveAudio, liveDids, liveUsers } from '#lib/api/lookup.js';
  import { SSO_RESET_FIELDS } from '#lib/api/ops/areas/settings.js';
  import { E164 } from '#lib/api/ops/validate.js';
  import {
    CALL_LOG_LEVELS,
    FEATURE_CODE_KEYS,
    LANGUAGES,
    type CallLogLevel,
    type FeatureCodes,
    type SystemInfo
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import CodecList from '#lib/components/system/CodecList.svelte';
  import CronField from '#lib/components/system/CronField.svelte';
  import InfoList from '#lib/components/system/InfoList.svelte';
  import SettingsCard from '#lib/components/system/SettingsCard.svelte';
  import {
    savedSettings,
    SettingsForm
  } from '#lib/components/system/settingsForm.svelte.js';
  import {
    formatPhone,
    formatRelative,
    i18n,
    t
  } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import SecretInput from '#lib/ui/SecretInput.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';
  import TagInput from '#lib/ui/TagInput.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  const TAB_IDS = [
    'general',
    'calls',
    'featureCodes',
    'mail',
    'signIn',
    'retention',
    'updates',
    'ringotel'
  ] as const;
  const TAB_ICONS = {
    general: Building2,
    calls: PhoneCall,
    featureCodes: Hash,
    mail: Mail,
    signIn: KeyRound,
    retention: Trash,
    updates: RefreshCw,
    ringotel: Cloud
  };
  const active = $derived(
    (TAB_IDS as readonly string[]).includes(params.tab ?? '')
      ? (params.tab as (typeof TAB_IDS)[number])
      : 'general'
  );
  const tabs = $derived(
    TAB_IDS.map(id => ({
      id,
      label: t(`settings.tab.${id}`),
      icon: TAB_ICONS[id]
    }))
  );

  const settings = $derived(savedSettings());
  const system = $derived(read<SystemInfo | null>('system.info', {}, null));
  const isOwner = $derived(currentActor().role === 'owner');

  const company = new SettingsForm(['companyName', 'mainDidId', 'language']);
  const region = new SettingsForm(['country', 'timezone']);
  const calls = new SettingsForm([
    'clir',
    'rejectAnonymous',
    'holdMohAudioId',
    'codecs',
    'callLogLevel'
  ]);
  const limits = new SettingsForm(['voicemailMaxS', 'parkingTimeoutS']);
  const fallback = new SettingsForm(['fallbackTarget']);
  const codes = new SettingsForm(['featureCodes']);
  const emergency = new SettingsForm(['emergencyNumbers']);
  const mail = new SettingsForm([
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'smtpUser',
    'smtpPassword',
    'mailFrom',
    'smtpCheckIntervalS'
  ]);
  const mfa = new SettingsForm(['mfaRequiredForAll']);
  const sso = new SettingsForm([
    'ssoProvider',
    'ssoLabel',
    'ssoIssuer',
    'ssoClientId',
    'ssoTenantId',
    'ssoAllowedDomain',
    'ssoClientSecret'
  ]);
  const retention = new SettingsForm([
    'recordingRetentionDays',
    'softDeleteRetentionDays',
    'auditRetentionDays'
  ]);
  const updates = new SettingsForm(['autoUpdate', 'tlsReloadHour']);
  const schedule = new SettingsForm(['backupCron']);
  const ringotel = new SettingsForm(['ringotelMaxRegs', 'ringotelApiToken']);

  const COUNTRIES = [
    'DE',
    'AT',
    'CH',
    'LI',
    'LU',
    'BE',
    'NL',
    'FR',
    'IT',
    'ES',
    'PT',
    'GB',
    'IE',
    'DK',
    'SE',
    'NO',
    'FI',
    'PL',
    'CZ',
    'SK',
    'HU',
    'SI',
    'HR',
    'US',
    'CA'
  ];
  const regionNames = $derived(
    new Intl.DisplayNames([i18n.locale], { type: 'region' })
  );
  const countryOptions = $derived.by(() => {
    const current = region.get('country') ?? 'DE';
    const codes = COUNTRIES.includes(current)
      ? COUNTRIES
      : [current, ...COUNTRIES];
    return codes
      .map(code => ({
        value: code,
        label: `${regionNames.of(code) ?? code} (${code})`
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label, i18n.locale));
  });
  const timezoneOptions = $derived([
    { value: null as string | null, label: t('settings.timezone.stack') },
    ...Intl.supportedValuesOf('timeZone').map(zone => ({
      value: zone as string | null,
      label: zone.replaceAll('_', ' ')
    }))
  ]);
  const languageOptions = $derived(
    LANGUAGES.map(language => ({
      value: language,
      label: t(`settings.language.${language}`)
    }))
  );
  const didOptions = $derived(
    liveDids()
      .filter(did => E164.test(did.number))
      .map(did => ({
        value: did.id,
        label: `${formatPhone(did.number)}${did.label ? ` · ${did.label}` : ''}`
      }))
  );
  const mohOptions = $derived([
    { value: null as string | null, label: t('settings.moh.builtin') },
    ...liveAudio('moh').map(asset => ({
      value: asset.id as string | null,
      label: asset.label
    }))
  ]);
  const logLevelOptions = $derived(
    CALL_LOG_LEVELS.map(level => ({
      value: level,
      label: t(`settings.callLogLevel.${level}`)
    }))
  );
  const hourOptions = $derived([
    { value: null as number | null, label: t('settings.tlsReloadHour.none') },
    ...Array.from({ length: 24 }, (_, hour) => ({
      value: hour as number | null,
      label: `${String(hour).padStart(2, '0')}:00`
    }))
  ]);
  const ssoProviderOptions = $derived(
    [null, 'microsoft', 'google', 'oidc'].map(provider => ({
      value: provider as 'microsoft' | 'google' | 'oidc' | null,
      label: t(`settings.sso.provider.${provider ?? 'none'}`)
    }))
  );

  const didLabel = (id: string | undefined): string =>
    didOptions.find(option => option.value === id)?.label ?? '—';
  const days = (value: number | null | undefined): string =>
    value === null || value === undefined
      ? t('settings.retention.forever')
      : t('settings.retention.days', { days: value });
  const featureCodes = $derived(
    (codes.get('featureCodes') ?? settings?.featureCodes) as FeatureCodes
  );
  const ssoProvider = $derived(sso.get('ssoProvider') ?? null);
  const boundUsers = $derived(liveUsers().filter(user => user.ssoBound).length);
  const ssoResets = $derived(
    SSO_RESET_FIELDS.some(field => field in sso.changes) && boundUsers > 0
  );
  const relay = $derived(system?.mail ?? null);
  const digitsOnly = (value: string): string | null =>
    /^[0-9]+$/u.test(value) ? null : t('settings.emergency.digits');
</script>

<PageHeader title={t('nav.settings')} subtitle={t('settings.subtitle')} />

<Tabs {tabs} {active} hrefFor={id => `#/settings/${id}`} />

{#if settings !== null}
  {#if active === 'general'}
    <div class="grid-2">
      <SettingsCard
        form={company}
        title={t('settings.card.company')}
        description={t('settings.card.companyBody')}
        icon={Building2}
      >
        <FormField
          entity="settings"
          key="companyName"
          error={company.error('companyName')}
          required
        >
          {#snippet children(editable)}
            {#if editable}
              <TextInput
                id="settings-companyName"
                value={company.get('companyName') ?? ''}
                invalid={company.error('companyName') !== null}
                oninput={value => company.set('companyName', value)}
              />
            {:else}
              <DisplayValue>{settings.companyName}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="mainDidId"
          error={company.error('mainDidId')}
        >
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="settings-mainDidId"
                value={company.get('mainDidId') ?? ''}
                options={didOptions}
                onchange={value => company.set('mainDidId', value)}
              />
            {:else}
              <DisplayValue>{didLabel(settings.mainDidId)}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
        <FormField entity="settings" key="language">
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="settings-language"
                value={company.get('language') ?? 'de'}
                options={languageOptions}
                onchange={value => company.set('language', value)}
              />
            {:else}
              <DisplayValue
                >{t(`settings.language.${settings.language}`)}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
      </SettingsCard>

      <SettingsCard
        form={region}
        title={t('settings.card.region')}
        description={t('settings.card.regionBody')}
        icon={Globe}
      >
        <FormField
          entity="settings"
          key="country"
          error={region.error('country')}
        >
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="settings-country"
                value={region.get('country') ?? 'DE'}
                options={countryOptions}
                onchange={value => region.set('country', value)}
              />
            {:else}
              <DisplayValue
                >{regionNames.of(settings.country) ??
                  settings.country}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="timezone"
          error={region.error('timezone')}
        >
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="settings-timezone"
                value={region.get('timezone') ?? null}
                options={timezoneOptions}
                onchange={value => region.set('timezone', value)}
              />
            {:else}
              <DisplayValue
                >{settings.timezone ??
                  t('settings.timezone.stack')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField entity="settings" key="extLength">
          {#snippet children()}
            <DisplayValue
              >{t('settings.extLength.value', {
                digits: settings.extLength
              })}</DisplayValue
            >
          {/snippet}
        </FormField>
      </SettingsCard>
    </div>
  {:else if active === 'calls'}
    <div class="grid-2">
      <SettingsCard
        form={calls}
        title={t('settings.card.calls')}
        description={t('settings.card.callsBody')}
        icon={PhoneCall}
      >
        <FormField entity="settings" key="clir">
          {#snippet children(editable)}
            <Switch
              id="settings-clir"
              checked={calls.get('clir') ?? false}
              disabled={!editable}
              label={t('settings.clir.switch')}
              onchange={value => calls.set('clir', value)}
            />
          {/snippet}
        </FormField>
        <FormField entity="settings" key="rejectAnonymous">
          {#snippet children(editable)}
            <Switch
              id="settings-rejectAnonymous"
              checked={calls.get('rejectAnonymous') ?? false}
              disabled={!editable}
              label={t('settings.rejectAnonymous.switch')}
              onchange={value => calls.set('rejectAnonymous', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="holdMohAudioId"
          error={calls.error('holdMohAudioId')}
        >
          {#snippet children()}
            <Select
              id="settings-holdMohAudioId"
              value={calls.get('holdMohAudioId') ?? null}
              options={mohOptions}
              onchange={value => calls.set('holdMohAudioId', value)}
            />
          {/snippet}
        </FormField>
        <FormField entity="settings" key="codecs" error={calls.error('codecs')}>
          {#snippet children()}
            <CodecList
              value={calls.get('codecs') ?? []}
              onchange={value => calls.set('codecs', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="callLogLevel"
          error={calls.error('callLogLevel')}
        >
          {#snippet children()}
            <Segmented
              value={(calls.get('callLogLevel') ?? 'events') as CallLogLevel}
              options={logLevelOptions}
              ariaLabel={t('field.settings.callLogLevel')}
              onchange={value => calls.set('callLogLevel', value)}
            />
          {/snippet}
        </FormField>
      </SettingsCard>

      <div class="stack">
        <SettingsCard
          form={limits}
          title={t('settings.card.limits')}
          description={t('settings.card.limitsBody')}
          icon={Timer}
        >
          <div class="grid-2" style="--gap: 12px">
            <FormField
              entity="settings"
              key="voicemailMaxS"
              error={limits.error('voicemailMaxS')}
            >
              {#snippet children()}
                <NumberInput
                  id="settings-voicemailMaxS"
                  value={limits.get('voicemailMaxS') ?? 180}
                  min={1}
                  max={86400}
                  suffix={t('common.seconds')}
                  onchange={value => limits.set('voicemailMaxS', value ?? 1)}
                />
              {/snippet}
            </FormField>
            <FormField
              entity="settings"
              key="parkingTimeoutS"
              error={limits.error('parkingTimeoutS')}
            >
              {#snippet children()}
                <NumberInput
                  id="settings-parkingTimeoutS"
                  value={limits.get('parkingTimeoutS') ?? 300}
                  min={1}
                  max={86400}
                  suffix={t('common.seconds')}
                  onchange={value => limits.set('parkingTimeoutS', value ?? 1)}
                />
              {/snippet}
            </FormField>
          </div>
        </SettingsCard>

        <SettingsCard
          form={fallback}
          title={t('settings.card.fallback')}
          description={t('settings.card.fallbackBody')}
          icon={PhoneForwarded}
        >
          <FormField
            entity="settings"
            key="fallbackTarget"
            error={fallback.error('fallbackTarget')}
          >
            {#snippet children(editable)}
              {#if editable}
                <ForwardTargetPicker
                  id="settings-fallbackTarget"
                  value={fallback.get('fallbackTarget') ?? null}
                  nullable
                  nullLabel={t('settings.fallback.none')}
                  onchange={value => fallback.set('fallbackTarget', value)}
                />
              {:else}
                <DisplayValue
                  ><ForwardTargetLabel
                    target={settings.fallbackTarget}
                    nullLabel={t('settings.fallback.none')}
                  /></DisplayValue
                >
              {/if}
            {/snippet}
          </FormField>
        </SettingsCard>
      </div>
    </div>
  {:else if active === 'featureCodes'}
    <div class="stack">
      <SettingsCard
        form={codes}
        title={t('settings.card.featureCodes')}
        description={t('settings.card.featureCodesBody')}
        icon={Hash}
      >
        <FormField
          entity="settings"
          key="featureCodes"
          error={codes.error('featureCodes')}
        >
          {#snippet children(editable)}
            <div class="codes">
              {#each FEATURE_CODE_KEYS as key (key)}
                {@const error = codes.error(`featureCodes.${key}`)}
                <div class="code-row" class:invalid={error !== null}>
                  <div class="code-text">
                    <label for="fc-{key}" class="strong"
                      >{t(`settings.fc.${key}`)}</label
                    >
                    <span class="xs muted">{t(`settings.fc.${key}.help`)}</span>
                    {#if error !== null}<span class="xs danger">{error}</span
                      >{/if}
                  </div>
                  {#if editable}
                    <TextInput
                      id="fc-{key}"
                      mono
                      value={featureCodes[key]}
                      invalid={error !== null}
                      oninput={value =>
                        codes.set('featureCodes', {
                          ...featureCodes,
                          [key]: value.trim()
                        })}
                    />
                  {:else}
                    <code>{featureCodes[key]}</code>
                  {/if}
                </div>
              {/each}
            </div>
          {/snippet}
        </FormField>
      </SettingsCard>

      <SettingsCard
        form={emergency}
        title={t('settings.card.emergency')}
        description={t('settings.card.emergencyBody')}
        icon={Siren}
      >
        <FormField
          entity="settings"
          key="emergencyNumbers"
          error={emergency.error('emergencyNumbers')}
        >
          {#snippet children(editable)}
            {#if editable}
              <TagInput
                id="settings-emergencyNumbers"
                values={emergency.get('emergencyNumbers') ?? []}
                placeholder="112"
                validate={digitsOnly}
                onchange={values => emergency.set('emergencyNumbers', values)}
              />
            {:else}
              <DisplayValue mono
                >{settings.emergencyNumbers.join(', ')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
      </SettingsCard>
    </div>
  {:else if active === 'mail'}
    <div class="grid-2">
      <SettingsCard
        form={mail}
        title={t('settings.card.mail')}
        description={t('settings.card.mailBody')}
        icon={Mail}
      >
        <div class="grid-2" style="--gap: 12px">
          <FormField
            entity="settings"
            key="smtpHost"
            error={mail.error('smtpHost')}
          >
            {#snippet children(editable)}
              {#if editable}
                <TextInput
                  id="settings-smtpHost"
                  mono
                  value={mail.get('smtpHost') ?? ''}
                  placeholder="smtp.example.com"
                  oninput={value =>
                    mail.set('smtpHost', value.trim() === '' ? null : value)}
                />
              {:else}
                <DisplayValue mono
                  >{settings.smtpHost ??
                    t('settings.mail.noRelay')}</DisplayValue
                >
              {/if}
            {/snippet}
          </FormField>
          <FormField
            entity="settings"
            key="smtpPort"
            error={mail.error('smtpPort')}
          >
            {#snippet children(editable)}
              {#if editable}
                <NumberInput
                  id="settings-smtpPort"
                  value={mail.get('smtpPort') ?? 465}
                  min={1}
                  max={65535}
                  onchange={value => mail.set('smtpPort', value ?? 465)}
                />
              {:else}
                <DisplayValue mono>{settings.smtpPort}</DisplayValue>
              {/if}
            {/snippet}
          </FormField>
        </div>
        <FormField entity="settings" key="smtpSecurity">
          {#snippet children(editable)}
            {#if editable}
              <Segmented
                value={mail.get('smtpSecurity') ?? 'tls'}
                options={[
                  { value: 'tls', label: t('settings.smtpSecurity.tls') },
                  {
                    value: 'starttls',
                    label: t('settings.smtpSecurity.starttls')
                  }
                ]}
                ariaLabel={t('field.settings.smtpSecurity')}
                onchange={value => mail.set('smtpSecurity', value)}
              />
            {:else}
              <DisplayValue
                >{t(
                  `settings.smtpSecurity.${settings.smtpSecurity}`
                )}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="smtpUser"
          error={mail.error('smtpUser')}
        >
          {#snippet children(editable)}
            {#if editable}
              <TextInput
                id="settings-smtpUser"
                mono
                value={mail.get('smtpUser') ?? ''}
                autocomplete="off"
                oninput={value =>
                  mail.set('smtpUser', value.trim() === '' ? null : value)}
              />
            {:else}
              <DisplayValue mono>{settings.smtpUser ?? '—'}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
        <FormField entity="settings" key="smtpPassword">
          {#snippet children()}
            <SecretInput
              id="settings-smtpPassword"
              isSet={settings.smtpPasswordSet}
              bind:value={
                () => mail.get('smtpPassword'),
                value => mail.set('smtpPassword', value)
              }
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="mailFrom"
          error={mail.error('mailFrom')}
        >
          {#snippet children(editable)}
            {#if editable}
              <TextInput
                id="settings-mailFrom"
                value={mail.get('mailFrom') ?? ''}
                placeholder={t('settings.mail.fromPlaceholder')}
                oninput={value =>
                  mail.set('mailFrom', value.trim() === '' ? null : value)}
              />
            {:else}
              <DisplayValue>{settings.mailFrom ?? '—'}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="smtpCheckIntervalS"
          error={mail.error('smtpCheckIntervalS')}
        >
          {#snippet children()}
            <NumberInput
              id="settings-smtpCheckIntervalS"
              value={mail.get('smtpCheckIntervalS') ?? null}
              nullable
              min={60}
              max={86400}
              suffix={t('common.seconds')}
              placeholder={t('settings.smtpCheck.none')}
              onchange={value => mail.set('smtpCheckIntervalS', value)}
            />
          {/snippet}
        </FormField>
      </SettingsCard>

      <div class="stack">
        <div class="relay" class:bad={relay !== null && !relay.ok}>
          <BellRing size={18} />
          <div>
            {#if relay === null}
              <strong>{t('settings.mail.statusNone')}</strong>
              <span class="small muted"
                >{t('settings.mail.statusNoneBody')}</span
              >
            {:else if relay.ok}
              <strong>{t('settings.mail.statusOk')}</strong>
              <span class="small muted"
                >{t('settings.mail.checkedAt', {
                  at: formatRelative(relay.at)
                })}</span
              >
            {:else}
              <strong
                >{t('settings.mail.statusFailing', {
                  class: relay.error
                    ? t(`system.relayError.${relay.error.class}`)
                    : ''
                })}</strong
              >
              <span class="small">{relay.error?.message ?? ''}</span>
              <span class="small muted"
                >{t('settings.mail.checkedAt', {
                  at: formatRelative(relay.at)
                })}</span
              >
            {/if}
          </div>
        </div>
        <p class="small muted">{t('settings.mail.templatesHint')}</p>
        <div>
          <Button size="sm" variant="soft" href="#/mail-templates" icon={Mail}
            >{t('nav.mailTemplates')}</Button
          >
        </div>
      </div>
    </div>
  {:else if active === 'signIn'}
    <div class="grid-2">
      <SettingsCard
        form={mfa}
        title={t('settings.card.mfa')}
        description={t('settings.card.mfaBody')}
        icon={ShieldCheck}
      >
        <FormField entity="settings" key="mfaRequiredForAll">
          {#snippet children(editable)}
            {#if editable}
              <Switch
                id="settings-mfaRequiredForAll"
                checked={mfa.get('mfaRequiredForAll') ?? false}
                label={t('settings.mfa.switch')}
                onchange={value => mfa.set('mfaRequiredForAll', value)}
              />
            {:else}
              <DisplayValue
                >{settings.mfaRequiredForAll
                  ? t('settings.mfa.on')
                  : t('settings.mfa.off')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
      </SettingsCard>

      <SettingsCard
        form={sso}
        title={t('settings.card.sso')}
        description={t('settings.card.ssoBody')}
        icon={UserRoundCheck}
      >
        <FormField entity="settings" key="ssoProvider">
          {#snippet children(editable)}
            {#if editable}
              <Segmented
                value={ssoProvider}
                options={ssoProviderOptions}
                ariaLabel={t('field.settings.ssoProvider')}
                onchange={value => sso.set('ssoProvider', value)}
              />
            {:else}
              <DisplayValue
                >{t(
                  `settings.sso.provider.${settings.ssoProvider ?? 'none'}`
                )}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        {#if ssoProvider !== null}
          <FormField
            entity="settings"
            key="ssoLabel"
            error={sso.error('ssoLabel')}
            required={ssoProvider === 'oidc'}
          >
            {#snippet children(editable)}
              {#if editable}
                <TextInput
                  id="settings-ssoLabel"
                  value={sso.get('ssoLabel') ?? ''}
                  placeholder={t('settings.sso.labelPlaceholder')}
                  oninput={value =>
                    sso.set('ssoLabel', value.trim() === '' ? null : value)}
                />
              {:else}
                <DisplayValue
                  >{settings.ssoLabel ??
                    t('settings.sso.labelDefault')}</DisplayValue
                >
              {/if}
            {/snippet}
          </FormField>
          <FormField
            entity="settings"
            key="ssoIssuer"
            error={sso.error('ssoIssuer')}
            required={ssoProvider === 'oidc'}
          >
            {#snippet children()}
              <TextInput
                id="settings-ssoIssuer"
                mono
                value={sso.get('ssoIssuer') ?? ''}
                placeholder="https://login.example.com"
                oninput={value =>
                  sso.set('ssoIssuer', value.trim() === '' ? null : value)}
              />
            {/snippet}
          </FormField>
          <FormField
            entity="settings"
            key="ssoClientId"
            error={sso.error('ssoClientId')}
            required
          >
            {#snippet children()}
              <TextInput
                id="settings-ssoClientId"
                mono
                value={sso.get('ssoClientId') ?? ''}
                oninput={value =>
                  sso.set('ssoClientId', value.trim() === '' ? null : value)}
              />
            {/snippet}
          </FormField>
          {#if ssoProvider === 'microsoft'}
            <FormField
              entity="settings"
              key="ssoTenantId"
              error={sso.error('ssoTenantId')}
              required
            >
              {#snippet children()}
                <TextInput
                  id="settings-ssoTenantId"
                  mono
                  value={sso.get('ssoTenantId') ?? ''}
                  oninput={value =>
                    sso.set('ssoTenantId', value.trim() === '' ? null : value)}
                />
              {/snippet}
            </FormField>
          {/if}
          <FormField entity="settings" key="ssoClientSecret">
            {#snippet children()}
              <SecretInput
                id="settings-ssoClientSecret"
                isSet={settings.ssoClientSecretSet}
                bind:value={
                  () => sso.get('ssoClientSecret'),
                  value => sso.set('ssoClientSecret', value)
                }
              />
            {/snippet}
          </FormField>
          <FormField
            entity="settings"
            key="ssoAllowedDomain"
            error={sso.error('ssoAllowedDomain')}
          >
            {#snippet children(editable)}
              {#if editable}
                <TextInput
                  id="settings-ssoAllowedDomain"
                  mono
                  prefix="@"
                  value={sso.get('ssoAllowedDomain') ?? ''}
                  placeholder="example.com"
                  oninput={value =>
                    sso.set(
                      'ssoAllowedDomain',
                      value.trim() === '' ? null : value
                    )}
                />
              {:else}
                <DisplayValue mono
                  >{settings.ssoAllowedDomain
                    ? `@${settings.ssoAllowedDomain}`
                    : t('settings.sso.anyDomain')}</DisplayValue
                >
              {/if}
            {/snippet}
          </FormField>
        {/if}
        {#if ssoResets}
          <p class="warning small">
            <TriangleAlert size={16} />{t('settings.sso.resetWarning', {
              count: boundUsers
            })}
          </p>
        {/if}
      </SettingsCard>
    </div>
  {:else if active === 'retention'}
    <SettingsCard
      form={retention}
      title={t('settings.card.retention')}
      description={t('settings.card.retentionBody')}
      icon={Trash}
    >
      <div class="grid-3" style="--gap: 16px">
        <FormField
          entity="settings"
          key="recordingRetentionDays"
          error={retention.error('recordingRetentionDays')}
        >
          {#snippet children()}
            <NumberInput
              id="settings-recordingRetentionDays"
              value={retention.get('recordingRetentionDays') ?? null}
              nullable
              min={1}
              max={36500}
              suffix={t('common.days')}
              placeholder={t('settings.retention.forever')}
              onchange={value => retention.set('recordingRetentionDays', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="softDeleteRetentionDays"
          error={retention.error('softDeleteRetentionDays')}
        >
          {#snippet children()}
            <NumberInput
              id="settings-softDeleteRetentionDays"
              value={retention.get('softDeleteRetentionDays') ?? null}
              nullable
              min={1}
              max={36500}
              suffix={t('common.days')}
              placeholder={t('settings.retention.forever')}
              onchange={value =>
                retention.set('softDeleteRetentionDays', value)}
            />
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="auditRetentionDays"
          error={retention.error('auditRetentionDays')}
        >
          {#snippet children(editable)}
            {#if editable}
              <NumberInput
                id="settings-auditRetentionDays"
                value={retention.get('auditRetentionDays') ?? null}
                nullable
                min={30}
                max={36500}
                suffix={t('common.days')}
                placeholder={t('settings.retention.forever')}
                onchange={value => retention.set('auditRetentionDays', value)}
              />
            {:else}
              <DisplayValue>{days(settings.auditRetentionDays)}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
      </div>
    </SettingsCard>
  {:else if active === 'updates'}
    <div class="grid-2">
      <SettingsCard
        form={updates}
        title={t('settings.card.updates')}
        description={t('settings.card.updatesBody')}
        icon={RefreshCw}
      >
        <FormField entity="settings" key="autoUpdate">
          {#snippet children(editable)}
            {#if editable}
              <Switch
                id="settings-autoUpdate"
                checked={updates.get('autoUpdate') ?? false}
                label={t('settings.autoUpdate.switch')}
                onchange={value => updates.set('autoUpdate', value)}
              />
            {:else}
              <DisplayValue
                >{settings.autoUpdate
                  ? t('settings.autoUpdate.on')
                  : t('settings.autoUpdate.off')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="settings"
          key="tlsReloadHour"
          error={updates.error('tlsReloadHour')}
        >
          {#snippet children()}
            <Select
              id="settings-tlsReloadHour"
              value={updates.get('tlsReloadHour') ?? null}
              options={hourOptions}
              onchange={value => updates.set('tlsReloadHour', value)}
            />
          {/snippet}
        </FormField>
        <div>
          <Button size="sm" variant="soft" href="#/system" icon={RefreshCw}
            >{t('nav.system')}</Button
          >
        </div>
      </SettingsCard>

      <SettingsCard
        form={schedule}
        title={t('settings.card.backupSchedule')}
        description={t('settings.card.backupScheduleBody')}
        icon={CalendarClock}
      >
        <FormField
          entity="settings"
          key="backupCron"
          error={schedule.error('backupCron')}
        >
          {#snippet children()}
            <CronField
              value={schedule.get('backupCron') ?? ''}
              timezone={settings.timezone}
              invalid={schedule.error('backupCron') !== null}
              onchange={value => schedule.set('backupCron', value)}
            />
          {/snippet}
        </FormField>
        <div>
          <Button size="sm" variant="soft" href="#/backups" icon={CalendarClock}
            >{t('nav.backups')}</Button
          >
        </div>
      </SettingsCard>
    </div>
  {:else if active === 'ringotel'}
    <div class="grid-2">
      <SettingsCard
        form={ringotel}
        title={t('settings.card.ringotel')}
        description={t('settings.card.ringotelBody')}
        icon={Cloud}
      >
        <InfoList
          items={[
            {
              label: t('settings.ringotel.status'),
              value: settings.ringotelOrgId
                ? t('settings.ringotel.connected')
                : t('settings.ringotel.notConnected')
            },
            ...(isExpert()
              ? [
                  {
                    label: t('settings.ringotel.orgId'),
                    value: settings.ringotelOrgId ?? '—',
                    mono: true
                  },
                  {
                    label: t('settings.ringotel.branchId'),
                    value: settings.ringotelBranchId ?? '—',
                    mono: true
                  }
                ]
              : [])
          ]}
        />
        <FormField
          entity="settings"
          key="ringotelMaxRegs"
          error={ringotel.error('ringotelMaxRegs')}
        >
          {#snippet children(editable)}
            {#if editable}
              <NumberInput
                id="settings-ringotelMaxRegs"
                value={ringotel.get('ringotelMaxRegs') ?? 3}
                min={1}
                onchange={value => ringotel.set('ringotelMaxRegs', value ?? 1)}
              />
            {:else}
              <DisplayValue
                >{t('settings.ringotel.maxRegsValue', {
                  count: settings.ringotelMaxRegs
                })}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField entity="settings" key="ringotelApiToken">
          {#snippet children()}
            <SecretInput
              id="settings-ringotelApiToken"
              isSet={settings.ringotelApiTokenSet}
              bind:value={
                () => ringotel.get('ringotelApiToken'),
                value => ringotel.set('ringotelApiToken', value)
              }
            />
          {/snippet}
        </FormField>
        {#if system?.ringotel.profilePending}
          <Badge tone="info" dot>{t('settings.ringotel.pushPending')}</Badge>
        {/if}
        {#if isOwner}
          <div>
            <Button size="sm" variant="soft" href="#/ringotel" icon={Cloud}
              >{t('nav.ringotel')}</Button
            >
          </div>
        {/if}
      </SettingsCard>
    </div>
  {/if}
{/if}

<style>
  .codes {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .code-row {
    display: grid;
    grid-template-columns: 1fr 150px;
    gap: var(--space-4);
    align-items: center;
    padding: 10px 14px;
  }
  .code-row + .code-row {
    border-top: 1px solid var(--line);
  }
  .code-row.invalid {
    background: var(--danger-soft);
  }
  .code-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .code-row code {
    font-size: var(--text-md);
    font-weight: 600;
  }
  .danger {
    color: var(--danger);
    font-weight: 700;
  }
  .relay {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: var(--ok-soft);
    color: var(--text);
  }
  .relay :global(svg) {
    flex: none;
    color: var(--ok);
    margin-top: 2px;
  }
  .relay.bad {
    background: var(--danger-soft);
  }
  .relay.bad :global(svg) {
    color: var(--danger);
  }
  .relay div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .warning {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--text);
  }
  .warning :global(svg) {
    flex: none;
    color: var(--warn);
    margin-top: 1px;
  }
  @media (max-width: 560px) {
    .code-row {
      grid-template-columns: 1fr;
      gap: var(--space-2);
    }
  }
</style>
