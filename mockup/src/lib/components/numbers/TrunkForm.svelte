<!--
  Creates (`trunks.create`) or edits (`trunks.update`) a SIP trunk, every field of the API in four
  sections: provider and sign-in, caller ID and forwarding, capacity, and the Expert internals. An
  update sends only what changed; the password is write-only.
-->
<script lang="ts">
  import Gauge from '@lucide/svelte/icons/gauge';
  import IdCard from '@lucide/svelte/icons/id-card';
  import Plug from '@lucide/svelte/icons/plug';
  import Wrench from '@lucide/svelte/icons/wrench';

  import { errorText, run } from '#lib/actions.svelte.js';
  import type { ApiError } from '#lib/api/errors.js';
  import {
    NO_EMERGENCY_TRUNK_WARNING,
    SRV_DISABLED_WARNING,
    type TrunkWriteOutput
  } from '#lib/api/ops/areas/trunks.js';
  import { store } from '#lib/api/store.svelte.js';
  import type {
    Codec,
    LogLevelOverride,
    Trunk,
    TrunkHost
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import LogLevelField from '#lib/components/LogLevelField.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import SecretInput from '#lib/ui/SecretInput.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import CodecsEditor from './CodecsEditor.svelte';
  import ForwardedCallerIdExplainer from './ForwardedCallerIdExplainer.svelte';
  import HostsEditor from './HostsEditor.svelte';
  import OptionCards from './OptionCards.svelte';

  type Props = {
    /** The trunk to edit; null creates one. */
    trunk: Trunk | null;
  };

  let { trunk }: Props = $props();

  type Draft = {
    name: string;
    emergency: boolean | null;
    authMode: Trunk['authMode'];
    username: string;
    inboundAuth: boolean;
    transport: Trunk['transport'];
    srtp: boolean;
    tlsVerify: boolean;
    qualify: boolean;
    diversion: Trunk['diversion'];
    forwardedCallerId: Trunk['forwardedCallerId'];
    outboundProxy: string;
    registerExpiryS: number | null;
    registerRetryS: number | null;
    inboundNumberFormat: Trunk['inboundNumberFormat'];
    callerIdFormat: Trunk['callerIdFormat'];
    callerIdHeader: Trunk['callerIdHeader'];
    clir: boolean | null;
    codecs: Codec[] | null;
    maxChannels: number | null;
    hosts: TrunkHost[];
    logLevel: LogLevelOverride | null;
    logLevelExpiresAt: string | null;
  };

  function initial(): Draft {
    if (trunk === null) {
      return {
        name: '',
        emergency: null,
        authMode: 'registration',
        username: '',
        inboundAuth: false,
        transport: 'udp',
        srtp: false,
        tlsVerify: true,
        qualify: true,
        diversion: 'off',
        forwardedCallerId: 'own',
        outboundProxy: '',
        registerExpiryS: null,
        registerRetryS: null,
        inboundNumberFormat: 'e164',
        callerIdFormat: 'e164',
        callerIdHeader: 'from',
        clir: null,
        codecs: null,
        maxChannels: null,
        hosts: [{ host: '', port: null, direction: 'both' }],
        logLevel: null,
        logLevelExpiresAt: null
      };
    }
    return {
      name: trunk.name,
      emergency: trunk.emergency,
      authMode: trunk.authMode,
      username: trunk.username ?? '',
      inboundAuth: trunk.inboundAuth,
      transport: trunk.transport,
      srtp: trunk.srtp,
      tlsVerify: trunk.tlsVerify,
      qualify: trunk.qualify,
      diversion: trunk.diversion,
      forwardedCallerId: trunk.forwardedCallerId,
      outboundProxy: trunk.outboundProxy ?? '',
      registerExpiryS: trunk.registerExpiryS,
      registerRetryS: trunk.registerRetryS,
      inboundNumberFormat: trunk.inboundNumberFormat,
      callerIdFormat: trunk.callerIdFormat,
      callerIdHeader: trunk.callerIdHeader,
      clir: trunk.clir,
      codecs: trunk.codecs === null ? null : [...trunk.codecs],
      maxChannels: trunk.maxChannels,
      hosts: trunk.hosts.map(host => ({ ...host })),
      logLevel: trunk.logLevel,
      logLevelExpiresAt: trunk.logLevelExpiresAt
    };
  }

  let base = $state(initial());
  let draft = $state(initial());
  /** The wire's write-only password: undefined keeps it, null clears it, a string sets it. */
  let password = $state<string | null | undefined>(undefined);
  let errors = $state<Record<string, string>>({});
  let problem = $state<string | null>(null);
  let saving = $state(false);

  const credentials = $derived(
    draft.authMode === 'registration' || draft.inboundAuth
  );
  const passwordStored = $derived(trunk !== null && trunk.passwordSet);
  const dirty = $derived(
    trunk === null ||
      JSON.stringify(draft) !== JSON.stringify(base) ||
      password !== undefined
  );
  const tenantClir = $derived(store.db.settings.clir);

  const error = (field: string): string | null => errors[field] ?? null;

  function setTransport(transport: Trunk['transport']): void {
    draft.transport = transport;
    if (transport !== 'tls') {
      // SDES-SRTP needs TLS (§9.4 "Signaling"): a trunk leaving TLS leaves SRTP too.
      draft.srtp = false;
    }
  }

  function setHeader(header: Trunk['callerIdHeader']): void {
    draft.callerIdHeader = header;
    if (header === 'from' && draft.clir === true) {
      draft.clir = null;
    }
    if (header !== 'from') {
      draft.forwardedCallerId = 'own';
    }
  }

  function setDiversion(diversion: Trunk['diversion']): void {
    draft.diversion = diversion;
    if (diversion === 'off') {
      draft.forwardedCallerId = 'own';
    }
  }

  /** The create input: every field, the optional ones only where they apply. */
  function createInput(): Record<string, unknown> {
    const input: Record<string, unknown> = {
      name: draft.name,
      emergency: draft.emergency ?? undefined,
      authMode: draft.authMode,
      inboundAuth: draft.inboundAuth,
      transport: draft.transport,
      srtp: draft.srtp,
      tlsVerify: draft.tlsVerify,
      qualify: draft.qualify,
      diversion: draft.diversion,
      forwardedCallerId: draft.forwardedCallerId,
      inboundNumberFormat: draft.inboundNumberFormat,
      callerIdFormat: draft.callerIdFormat,
      callerIdHeader: draft.callerIdHeader,
      clir: draft.clir,
      codecs: draft.codecs ?? undefined,
      maxChannels: draft.maxChannels ?? undefined,
      hosts: draft.hosts
    };
    if (credentials) {
      input.username = draft.username.trim() || undefined;
      input.password =
        typeof password === 'string' && password !== '' ? password : undefined;
    }
    if (draft.authMode === 'registration') {
      input.registerExpiryS = draft.registerExpiryS ?? undefined;
      input.registerRetryS = draft.registerRetryS ?? undefined;
    }
    if (draft.outboundProxy.trim() !== '') {
      input.outboundProxy = draft.outboundProxy.trim();
    }
    return input;
  }

  /** The update input: the fields that differ from the trunk as loaded. */
  function updateInput(id: string): Record<string, unknown> {
    const input: Record<string, unknown> = { id };
    const same = (a: unknown, b: unknown): boolean =>
      JSON.stringify(a) === JSON.stringify(b);
    const keys = [
      'name',
      'emergency',
      'authMode',
      'inboundAuth',
      'transport',
      'srtp',
      'tlsVerify',
      'qualify',
      'diversion',
      'forwardedCallerId',
      'inboundNumberFormat',
      'callerIdFormat',
      'callerIdHeader',
      'clir',
      'codecs',
      'maxChannels',
      'hosts'
    ] as const;
    for (const key of keys) {
      if (!same(draft[key], base[key])) {
        input[key] = draft[key];
      }
    }
    if (credentials && draft.username !== base.username) {
      input.username = draft.username.trim() || null;
    }
    if (credentials && password !== undefined) {
      input.password = password === '' ? null : password;
    }
    if (draft.authMode === 'registration') {
      if (draft.registerExpiryS !== base.registerExpiryS) {
        input.registerExpiryS = draft.registerExpiryS;
      }
      if (draft.registerRetryS !== base.registerRetryS) {
        input.registerRetryS = draft.registerRetryS;
      }
    }
    if (draft.outboundProxy !== base.outboundProxy) {
      input.outboundProxy = draft.outboundProxy.trim() || null;
    }
    if (
      draft.logLevel !== base.logLevel ||
      draft.logLevelExpiresAt !== base.logLevelExpiresAt
    ) {
      input.logLevel = draft.logLevel;
      input.logLevelExpiresAt =
        draft.logLevel === null ? null : draft.logLevelExpiresAt;
    }
    return input;
  }

  function showWarnings(warnings: string[]): void {
    for (const warning of warnings) {
      const key =
        warning === NO_EMERGENCY_TRUNK_WARNING
          ? 'trunks.warning.noEmergency'
          : warning === SRV_DISABLED_WARNING
            ? 'trunks.warning.srv'
            : null;
      toast({ tone: 'info', title: key === null ? warning : t(key) });
    }
  }

  function fail(apiError: ApiError): void {
    const text = errorText(apiError);
    if (apiError.field !== null) {
      errors = { [apiError.field]: text };
      problem = text;
    }
  }

  async function save(): Promise<void> {
    saving = true;
    errors = {};
    problem = null;
    const result =
      trunk === null
        ? await run<TrunkWriteOutput>('trunks.create', createInput(), {
            success: 'trunks.created',
            successParams: { name: draft.name }
          })
        : await run<TrunkWriteOutput>('trunks.update', updateInput(trunk.id), {
            success: 'trunks.saved',
            successParams: { name: draft.name }
          });
    saving = false;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    showWarnings(result.value.warnings);
    if (trunk === null) {
      go(`/trunks/${result.value.trunk.id}`, {
        highlight: result.value.trunk.id
      });
    } else {
      base = initial();
      draft = initial();
      password = undefined;
    }
  }

  function discard(): void {
    if (trunk === null) {
      go('/trunks');
      return;
    }
    draft = initial();
    password = undefined;
    errors = {};
    problem = null;
  }

  const step = (index: number, title: string): string =>
    trunk === null ? `${index} · ${title}` : title;
</script>

<div class="form">
  <Card
    title={step(1, t('trunks.section.basics'))}
    description={t('trunks.section.basicsBody')}
    icon={Plug}
  >
    <div class="stack">
      <div class="grid-2">
        <FormField entity="trunk" key="name" error={error('name')} required>
          <TextInput
            id="trunk-name"
            bind:value={draft.name}
            placeholder={t('trunks.namePlaceholder')}
            invalid={error('name') !== null}
          />
        </FormField>
        <FormField
          entity="trunk"
          key="emergency"
          id="trunk-emergency"
          error={error('emergency')}
          required
        >
          <Segmented
            value={draft.emergency}
            ariaLabel={t('field.trunk.emergency')}
            options={[
              { value: true, label: t('trunks.emergencyYes') },
              { value: false, label: t('trunks.emergencyNo') }
            ]}
            onchange={value => (draft.emergency = value)}
          />
        </FormField>
      </div>

      <FormField
        entity="trunk"
        key="authMode"
        id="trunk-authMode"
        error={error('authMode')}
        required
      >
        <OptionCards
          id="trunk-authMode"
          name="trunk-authMode"
          value={draft.authMode}
          options={[
            {
              value: 'registration',
              label: t('trunks.authMode.registration'),
              description: t('trunks.authMode.registrationBody')
            },
            {
              value: 'ip',
              label: t('trunks.authMode.ip'),
              description: t('trunks.authMode.ipBody')
            }
          ]}
          onchange={value => (draft.authMode = value)}
        />
      </FormField>

      {#if credentials}
        <div class="grid-2">
          <FormField
            entity="trunk"
            key="username"
            error={error('username')}
            required
          >
            <TextInput
              id="trunk-username"
              mono
              bind:value={draft.username}
              autocomplete="off"
              invalid={error('username') !== null}
            />
          </FormField>
          <FormField
            entity="trunk"
            key="password"
            error={error('password')}
            required
          >
            <SecretInput
              id="trunk-password"
              isSet={passwordStored}
              bind:value={password}
              clearable={false}
            />
          </FormField>
        </div>
      {/if}

      <FormField entity="trunk" key="hosts" error={error('hosts')} required>
        <HostsEditor
          hosts={draft.hosts}
          authMode={draft.authMode}
          invalid={error('hosts') !== null}
          onchange={hosts => (draft.hosts = hosts)}
        />
      </FormField>

      <FormField
        entity="trunk"
        key="transport"
        id="trunk-transport"
        error={error('transport')}
      >
        <Segmented
          value={draft.transport}
          ariaLabel={t('field.trunk.transport')}
          options={[
            { value: 'udp', label: 'UDP' },
            { value: 'tcp', label: 'TCP' },
            { value: 'tls', label: t('trunks.transportTls') }
          ]}
          onchange={setTransport}
        />
      </FormField>
    </div>
  </Card>

  <Card
    title={step(2, t('trunks.section.callerId'))}
    description={t('trunks.section.callerIdBody')}
    icon={IdCard}
  >
    <div class="stack">
      <FormField
        entity="trunk"
        key="callerIdHeader"
        id="trunk-callerIdHeader"
        error={error('callerIdHeader')}
      >
        <OptionCards
          id="trunk-callerIdHeader"
          name="trunk-callerIdHeader"
          value={draft.callerIdHeader}
          options={[
            {
              value: 'from',
              label: t('trunks.header.from'),
              description: t('trunks.header.fromBody')
            },
            {
              value: 'pai',
              label: t('trunks.header.pai'),
              description: t('trunks.header.paiBody')
            },
            {
              value: 'both',
              label: t('trunks.header.both'),
              description: t('trunks.header.bothBody')
            }
          ]}
          onchange={setHeader}
        />
      </FormField>

      <div class="grid-2">
        <FormField
          entity="trunk"
          key="callerIdFormat"
          id="trunk-callerIdFormat"
          error={error('callerIdFormat')}
        >
          <Segmented
            value={draft.callerIdFormat}
            ariaLabel={t('field.trunk.callerIdFormat')}
            options={[
              { value: 'e164', label: t('trunks.format.e164') },
              { value: 'national', label: t('trunks.format.national') }
            ]}
            onchange={value => (draft.callerIdFormat = value)}
          />
        </FormField>
        <FormField
          entity="trunk"
          key="inboundNumberFormat"
          id="trunk-inboundNumberFormat"
          error={error('inboundNumberFormat')}
        >
          <Segmented
            value={draft.inboundNumberFormat}
            ariaLabel={t('field.trunk.inboundNumberFormat')}
            options={[
              { value: 'e164', label: t('trunks.format.e164') },
              { value: 'national', label: t('trunks.format.national') }
            ]}
            onchange={value => (draft.inboundNumberFormat = value)}
          />
        </FormField>
      </div>

      <FormField
        entity="trunk"
        key="clir"
        id="trunk-clir"
        error={error('clir')}
      >
        <div class="stack" style="--gap: 6px">
          <Segmented
            value={draft.clir}
            ariaLabel={t('field.trunk.clir')}
            options={[
              {
                value: null,
                label: t('trunks.clir.inherit', {
                  value: tenantClir
                    ? t('trunks.clir.withhold')
                    : t('trunks.clir.show')
                })
              },
              { value: false, label: t('trunks.clir.show') },
              { value: true, label: t('trunks.clir.withhold') }
            ]}
            onchange={value => (draft.clir = value)}
          />
          {#if draft.callerIdHeader === 'from'}<span class="note"
              >{t('trunks.clir.needsPai')}</span
            >{/if}
        </div>
      </FormField>

      <FormField
        entity="trunk"
        key="diversion"
        id="trunk-diversion"
        error={error('diversion')}
      >
        <Segmented
          value={draft.diversion}
          ariaLabel={t('field.trunk.diversion')}
          options={[
            { value: 'off', label: t('trunks.diversion.off') },
            { value: 'last', label: t('trunks.diversion.last') },
            { value: 'all', label: t('trunks.diversion.all') }
          ]}
          onchange={setDiversion}
        />
      </FormField>

      <FormField
        entity="trunk"
        key="forwardedCallerId"
        id="trunk-forwardedCallerId"
        error={error('forwardedCallerId')}
      >
        {@const locked =
          draft.callerIdHeader !== 'from' || draft.diversion === 'off'}
        <div class="stack" style="--gap: 10px">
          <OptionCards
            id="trunk-forwardedCallerId"
            name="trunk-forwardedCallerId"
            value={draft.forwardedCallerId}
            options={[
              {
                value: 'own',
                label: t('trunks.forwarded.own'),
                description: t('trunks.forwarded.ownBody')
              },
              {
                value: 'original',
                label: t('trunks.forwarded.original'),
                description: t('trunks.forwarded.originalBody'),
                disabled: locked
              },
              {
                value: 'originalPreferred',
                label: t('trunks.forwarded.originalPreferred'),
                description: t('trunks.forwarded.originalPreferredBody'),
                disabled: locked
              }
            ]}
            onchange={value => (draft.forwardedCallerId = value)}
          />
          {#if locked}
            <span class="note">{t('trunks.forwarded.needs')}</span>
          {/if}
          <ForwardedCallerIdExplainer mode={draft.forwardedCallerId} />
        </div>
      </FormField>
    </div>
  </Card>

  <Card
    title={step(3, t('trunks.section.capacity'))}
    description={t('trunks.section.capacityBody')}
    icon={Gauge}
  >
    <FormField entity="trunk" key="maxChannels" error={error('maxChannels')}>
      <NumberInput
        id="trunk-maxChannels"
        nullable
        min={1}
        value={draft.maxChannels}
        placeholder={t('common.unlimited')}
        suffix={t('trunks.calls')}
        onchange={value => (draft.maxChannels = value)}
      />
    </FormField>
  </Card>

  {#if isExpert()}
    <Card
      title={t('trunks.section.expert')}
      description={t('trunks.section.expertBody')}
      icon={Wrench}
      expert
    >
      <div class="stack">
        <div class="grid-2">
          <FormField
            entity="trunk"
            key="inboundAuth"
            error={error('inboundAuth')}
          >
            <Switch
              id="trunk-inboundAuth"
              bind:checked={draft.inboundAuth}
              label={t('trunks.inboundAuthSwitch')}
            />
          </FormField>
          <FormField entity="trunk" key="srtp" error={error('srtp')}>
            <Switch
              id="trunk-srtp"
              bind:checked={draft.srtp}
              disabled={draft.transport !== 'tls'}
              label={t('trunks.srtpSwitch')}
              description={draft.transport !== 'tls'
                ? t('trunks.srtpNeedsTls')
                : undefined}
            />
          </FormField>
          <FormField entity="trunk" key="tlsVerify" error={error('tlsVerify')}>
            <Switch
              id="trunk-tlsVerify"
              bind:checked={draft.tlsVerify}
              label={t('trunks.tlsVerifySwitch')}
              description={draft.transport !== 'tls'
                ? t('trunks.onlyTls')
                : undefined}
            />
          </FormField>
          <FormField entity="trunk" key="qualify" error={error('qualify')}>
            <Switch
              id="trunk-qualify"
              bind:checked={draft.qualify}
              label={t('trunks.qualifySwitch')}
              description={draft.authMode !== 'ip'
                ? t('trunks.onlyIp')
                : undefined}
            />
          </FormField>
        </div>
        <FormField
          entity="trunk"
          key="outboundProxy"
          error={error('outboundProxy')}
        >
          <TextInput
            id="trunk-outboundProxy"
            mono
            bind:value={draft.outboundProxy}
            placeholder="sip:proxy.example.com;lr"
            invalid={error('outboundProxy') !== null}
          />
        </FormField>
        {#if draft.authMode === 'registration'}
          <div class="grid-2">
            <FormField
              entity="trunk"
              key="registerExpiryS"
              error={error('registerExpiryS')}
            >
              <NumberInput
                id="trunk-registerExpiryS"
                nullable
                min={1}
                max={86400}
                value={draft.registerExpiryS}
                placeholder={t('common.default')}
                suffix="s"
                onchange={value => (draft.registerExpiryS = value)}
              />
            </FormField>
            <FormField
              entity="trunk"
              key="registerRetryS"
              error={error('registerRetryS')}
            >
              <NumberInput
                id="trunk-registerRetryS"
                nullable
                min={1}
                max={86400}
                value={draft.registerRetryS}
                placeholder={t('common.default')}
                suffix="s"
                onchange={value => (draft.registerRetryS = value)}
              />
            </FormField>
          </div>
        {/if}
        <FormField
          entity="trunk"
          key="codecs"
          id="trunk-codecs"
          error={error('codecs')}
        >
          <CodecsEditor
            value={draft.codecs}
            onchange={codecs => (draft.codecs = codecs)}
          />
        </FormField>
        {#if trunk !== null}
          <LogLevelField
            id="trunk-logLevel"
            level={draft.logLevel}
            expiresAt={draft.logLevelExpiresAt}
            onchange={(level, expiresAt) => {
              draft.logLevel = level;
              draft.logLevelExpiresAt = expiresAt;
            }}
          />
        {/if}
      </div>
    </Card>
  {/if}

  {#if dirty}
    <div class="savebar" role="region" aria-label={t('trunks.saveBar')}>
      <span
        class="savebar-text"
        class:problem={problem !== null}
        role={problem !== null ? 'alert' : undefined}
      >
        {problem ??
          (trunk === null ? t('trunks.createHint') : t('trunks.unsaved'))}
      </span>
      <Button variant="ghost" onclick={discard}
        >{trunk === null ? t('common.cancel') : t('trunks.discard')}</Button
      >
      <Button
        variant="primary"
        loading={saving}
        op={trunk === null ? 'trunks.create' : 'trunks.update'}
        onclick={save}
      >
        {trunk === null ? t('trunks.create') : t('common.save')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .note {
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
