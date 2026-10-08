<!--
  A person's profile (`users.update`) in cards, each saved on its own with only the fields it
  changed: who they are, how calls reach them, their mailbox, find-me. Field visibility and
  self-service come from the registry; a value the person may not change shows as plain text.
-->
<script lang="ts">
  import PhoneCall from '@lucide/svelte/icons/phone-call';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import UserRound from '@lucide/svelte/icons/user-round';
  import Voicemail from '@lucide/svelte/icons/voicemail';

  import { run } from '#lib/actions.svelte.js';
  import { audioById, didById, liveAudio, liveDids } from '#lib/api/lookup.js';
  import { E164 } from '#lib/api/ops/validate.js';
  import { store } from '#lib/api/store.svelte.js';
  import {
    ROLES,
    type FindMeLeg,
    type LogLevelOverride,
    type Role,
    type User
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import LogLevelField from '#lib/components/LogLevelField.svelte';
  import { formatDuration, formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import RoleChip from '#lib/ui/RoleChip.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import FindMeEditor from './FindMeEditor.svelte';
  import { changedFields, fieldErrors } from './people';

  let { user }: { user: User } = $props();

  const actor = $derived(currentActor());
  const own = $derived(user.id === actor.id);
  /** An owner's e-mail, where their reset link goes, is owner-only (`_updateAccess.ts`). */
  const emailLocked = $derived(user.role === 'owner' && actor.role !== 'owner');

  type Section = 'person' | 'calls' | 'mailbox' | 'findMe';
  let errors = $state<Record<Section, Record<string, string>>>({
    person: {},
    calls: {},
    mailbox: {},
    findMe: {}
  });
  let saving = $state<Section | null>(null);

  // Each card's saved values as text: a card's draft resets when they change (a save, an undo),
  // not when another card saves the same row.
  const personJson = $derived(
    JSON.stringify({
      name: user.name,
      email: user.email ?? '',
      extension: user.extension ?? '',
      role: user.role
    })
  );
  const personBase = $derived(
    JSON.parse(personJson) as {
      name: string;
      email: string;
      extension: string;
      role: Role;
    }
  );
  let person = $derived(
    JSON.parse(personJson) as {
      name: string;
      email: string;
      extension: string;
      role: Role;
    }
  );

  type Calls = Pick<
    User,
    | 'ringTimeoutS'
    | 'clir'
    | 'rejectAnonymous'
    | 'callerIdDidId'
    | 'recordCalls'
    | 'logLevel'
    | 'logLevelExpiresAt'
  >;
  const callsJson = $derived(
    JSON.stringify({
      ringTimeoutS: user.ringTimeoutS,
      clir: user.clir,
      rejectAnonymous: user.rejectAnonymous,
      callerIdDidId: user.callerIdDidId,
      recordCalls: user.recordCalls,
      logLevel: user.logLevel,
      logLevelExpiresAt: user.logLevelExpiresAt
    })
  );
  const callsBase = $derived(JSON.parse(callsJson) as Calls);
  let calls = $derived(JSON.parse(callsJson) as Calls);

  type Mailbox = Pick<
    User,
    | 'mailboxEnabled'
    | 'notifyMissedCalls'
    | 'mailboxMaxMessages'
    | 'mailboxAudioId'
  >;
  const mailboxJson = $derived(
    JSON.stringify({
      mailboxEnabled: user.mailboxEnabled,
      notifyMissedCalls: user.notifyMissedCalls,
      mailboxMaxMessages: user.mailboxMaxMessages,
      mailboxAudioId: user.mailboxAudioId
    })
  );
  const mailboxBase = $derived(JSON.parse(mailboxJson) as Mailbox);
  let mailbox = $derived(JSON.parse(mailboxJson) as Mailbox);

  const findMeJson = $derived(JSON.stringify(user.findMe));
  const findMeBase = $derived(JSON.parse(findMeJson) as FindMeLeg[]);
  let findMe = $derived(JSON.parse(findMeJson) as FindMeLeg[]);

  const personChanges = $derived(changedFields(personBase, person));
  const callsChanges = $derived(changedFields(callsBase, calls));
  const mailboxChanges = $derived(changedFields(mailboxBase, mailbox));
  const findMeDirty = $derived(
    JSON.stringify(findMeBase) !== JSON.stringify(findMe)
  );

  const numericDids = $derived(liveDids().filter(did => E164.test(did.number)));
  const mainNumber = $derived(
    didById(store.db.settings.mainDidId)?.number ?? null
  );
  const greetings = $derived(liveAudio('vmGreeting'));
  const inheritedClir = $derived(store.db.settings.clir);
  const inheritedReject = $derived(store.db.settings.rejectAnonymous);

  async function save(
    section: Section,
    patch: Record<string, unknown>
  ): Promise<void> {
    saving = section;
    const result = await run(
      'users.update',
      { id: user.id, ...patch },
      { success: 'people.profile.saved', quietErrors: true }
    );
    saving = null;
    errors[section] = result.ok ? {} : fieldErrors(result.error, '_');
  }

  function savePerson(): void {
    const patch: Record<string, unknown> = { ...personChanges };
    if ('email' in patch) {
      patch.email = person.email.trim() === '' ? null : person.email.trim();
    }
    if ('extension' in patch) {
      patch.extension =
        person.extension.trim() === '' ? null : person.extension.trim();
    }
    void save('person', patch);
  }

  const triOptions = (
    inherited: boolean,
    onLabel: string,
    offLabel: string
  ): { value: boolean | null; label: string }[] => [
    {
      value: null,
      label: t('people.inherit', { value: inherited ? onLabel : offLabel })
    },
    { value: true, label: onLabel },
    { value: false, label: offLabel }
  ];
</script>

{#snippet footer(
  section: Section,
  dirty: boolean,
  onsave: () => void,
  onreset: () => void
)}
  {#if dirty || errors[section]._}
    <div class="card-footer">
      {#if errors[section]._}<p class="form-error" role="alert">
          {errors[section]._}
        </p>{/if}
      <div class="row footer-actions">
        <Button variant="ghost" size="sm" onclick={onreset}
          >{t('people.discard')}</Button
        >
        <Button
          variant="primary"
          size="sm"
          op="users.update"
          loading={saving === section}
          disabled={!dirty}
          onclick={onsave}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  {/if}
{/snippet}

<div class="profile">
  <Card title={t('people.profile.person')} icon={UserRound}>
    <div class="grid-2">
      <FormField
        entity="user"
        key="name"
        {own}
        error={errors.person.name ?? null}
      >
        {#snippet children(editable)}
          {#if editable}
            <TextInput
              id="user-name"
              value={person.name}
              oninput={name => (person = { ...person, name })}
              invalid={errors.person.name !== undefined}
            />
          {:else}
            <DisplayValue>{user.name}</DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="user"
        key="email"
        {own}
        error={errors.person.email ?? null}
      >
        {#snippet children(editable)}
          {#if editable && !emailLocked}
            <TextInput
              id="user-email"
              type="email"
              value={person.email}
              placeholder={t('people.phoneOnly')}
              oninput={email => (person = { ...person, email })}
              invalid={errors.person.email !== undefined}
            />
          {:else}
            <DisplayValue>{user.email ?? t('people.phoneOnly')}</DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="user"
        key="extension"
        {own}
        error={errors.person.extension ?? null}
      >
        {#snippet children(editable)}
          {#if editable}
            <TextInput
              id="user-extension"
              mono
              value={person.extension}
              placeholder={t('people.noExtension')}
              oninput={extension => (person = { ...person, extension })}
              invalid={errors.person.extension !== undefined}
            />
          {:else}
            <DisplayValue mono
              >{user.extension ?? t('people.noExtension')}</DisplayValue
            >
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="user"
        key="role"
        {own}
        error={errors.person.role ?? null}
      >
        {#snippet children(editable)}
          {#if editable}
            <Select
              id="user-role"
              value={person.role}
              options={ROLES.map(role => ({
                value: role,
                label: t(`role.${role}`)
              }))}
              onchange={(role: Role) => (person = { ...person, role })}
            />
          {:else}
            <DisplayValue><RoleChip role={user.role} /></DisplayValue>
          {/if}
        {/snippet}
      </FormField>
    </div>
    {@render footer(
      'person',
      Object.keys(personChanges).length > 0,
      savePerson,
      () => {
        person = { ...personBase };
        errors.person = {};
      }
    )}
  </Card>

  <Card title={t('people.profile.calls')} icon={PhoneCall}>
    <div class="stack">
      <div class="grid-2">
        <FormField
          entity="user"
          key="ringTimeoutS"
          {own}
          error={errors.calls.ringTimeoutS ?? null}
        >
          {#snippet children(editable)}
            {#if editable}
              <NumberInput
                id="user-ringTimeoutS"
                value={calls.ringTimeoutS}
                min={1}
                max={86400}
                suffix={t('people.secondsShort')}
                onchange={value =>
                  (calls = { ...calls, ringTimeoutS: value ?? 1 })}
                invalid={errors.calls.ringTimeoutS !== undefined}
              />
            {:else}
              <DisplayValue
                >{user.ringTimeoutS} {t('people.secondsShort')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="user"
          key="callerIdDidId"
          {own}
          error={errors.calls.callerIdDidId ?? null}
        >
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="user-callerIdDidId"
                value={calls.callerIdDidId}
                options={[
                  {
                    value: null,
                    label: t('people.callerId.main', {
                      number: formatPhone(mainNumber)
                    })
                  },
                  ...numericDids.map(did => ({
                    value: did.id,
                    label: `${formatPhone(did.number)}${did.label ? ` · ${did.label}` : ''}`
                  }))
                ]}
                onchange={(callerIdDidId: string | null) =>
                  (calls = { ...calls, callerIdDidId })}
              />
            {:else}
              <DisplayValue mono>
                {user.callerIdDidId === null
                  ? t('people.callerId.main', {
                      number: formatPhone(mainNumber)
                    })
                  : formatPhone(didById(user.callerIdDidId)?.number)}
              </DisplayValue>
            {/if}
          {/snippet}
        </FormField>
      </div>
      <FormField
        entity="user"
        key="clir"
        {own}
        error={errors.calls.clir ?? null}
      >
        {#snippet children(editable)}
          {#if editable}
            <Segmented
              size="sm"
              value={calls.clir}
              options={triOptions(
                inheritedClir,
                t('people.clir.on'),
                t('people.clir.off')
              )}
              onchange={clir => (calls = { ...calls, clir })}
            />
          {:else}
            <DisplayValue>
              {user.clir === null
                ? t('people.inherit', {
                    value: inheritedClir
                      ? t('people.clir.on')
                      : t('people.clir.off')
                  })
                : user.clir
                  ? t('people.clir.on')
                  : t('people.clir.off')}
            </DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      <FormField
        entity="user"
        key="rejectAnonymous"
        {own}
        error={errors.calls.rejectAnonymous ?? null}
      >
        {#snippet children(editable)}
          {#if editable}
            <Segmented
              size="sm"
              value={calls.rejectAnonymous}
              options={triOptions(
                inheritedReject,
                t('people.reject.on'),
                t('people.reject.off')
              )}
              onchange={rejectAnonymous =>
                (calls = { ...calls, rejectAnonymous })}
            />
          {:else}
            <DisplayValue>
              {user.rejectAnonymous === null
                ? t('people.inherit', {
                    value: inheritedReject
                      ? t('people.reject.on')
                      : t('people.reject.off')
                  })
                : user.rejectAnonymous
                  ? t('people.reject.on')
                  : t('people.reject.off')}
            </DisplayValue>
          {/if}
        {/snippet}
      </FormField>
      <FormField entity="user" key="recordCalls" {own}>
        {#snippet children(editable)}
          {#if editable}
            <Switch
              id="user-recordCalls"
              checked={calls.recordCalls}
              label={t('people.recordCalls.switch')}
              onchange={recordCalls => (calls = { ...calls, recordCalls })}
            />
          {:else}
            <DisplayValue
              >{user.recordCalls
                ? t('people.recordCalls.on')
                : t('people.recordCalls.off')}</DisplayValue
            >
          {/if}
        {/snippet}
      </FormField>
      {#if isExpert() && actor.role !== 'user'}
        <LogLevelField
          id="user-logLevel"
          level={calls.logLevel}
          expiresAt={calls.logLevelExpiresAt}
          onchange={(
            logLevel: LogLevelOverride | null,
            logLevelExpiresAt: string | null
          ) => (calls = { ...calls, logLevel, logLevelExpiresAt })}
        />
      {/if}
    </div>
    {@render footer(
      'calls',
      Object.keys(callsChanges).length > 0,
      () => void save('calls', { ...callsChanges }),
      () => {
        calls = { ...callsBase };
        errors.calls = {};
      }
    )}
  </Card>

  <Card title={t('people.profile.mailbox')} icon={Voicemail}>
    <div class="stack">
      <FormField entity="user" key="mailboxEnabled" {own}>
        {#snippet children(editable)}
          {#if editable}
            <Switch
              id="user-mailboxEnabled"
              checked={mailbox.mailboxEnabled}
              label={t('people.mailbox.switch')}
              onchange={mailboxEnabled =>
                (mailbox = { ...mailbox, mailboxEnabled })}
            />
          {:else}
            <DisplayValue
              >{user.mailboxEnabled
                ? t('common.on')
                : t('common.off')}</DisplayValue
            >
          {/if}
        {/snippet}
      </FormField>
      <FormField entity="user" key="notifyMissedCalls" {own}>
        {#snippet children(editable)}
          {#if editable}
            <Switch
              id="user-notifyMissedCalls"
              checked={mailbox.notifyMissedCalls}
              label={t('people.notify.switch')}
              onchange={notifyMissedCalls =>
                (mailbox = { ...mailbox, notifyMissedCalls })}
            />
          {:else}
            <DisplayValue
              >{user.notifyMissedCalls
                ? t('common.on')
                : t('common.off')}</DisplayValue
            >
          {/if}
        {/snippet}
      </FormField>
      <div class="grid-2">
        <FormField
          entity="user"
          key="mailboxMaxMessages"
          {own}
          error={errors.mailbox.mailboxMaxMessages ?? null}
        >
          {#snippet children(editable)}
            {#if editable}
              <NumberInput
                id="user-mailboxMaxMessages"
                value={mailbox.mailboxMaxMessages}
                min={1}
                nullable
                placeholder={t('common.unlimited')}
                onchange={mailboxMaxMessages =>
                  (mailbox = { ...mailbox, mailboxMaxMessages })}
                invalid={errors.mailbox.mailboxMaxMessages !== undefined}
              />
            {:else}
              <DisplayValue
                >{user.mailboxMaxMessages ??
                  t('common.unlimited')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
        <FormField
          entity="user"
          key="mailboxAudioId"
          {own}
          error={errors.mailbox.mailboxAudioId ?? null}
        >
          {#snippet children(editable)}
            {#if editable}
              <Select
                id="user-mailboxAudioId"
                value={mailbox.mailboxAudioId}
                options={[
                  { value: null, label: t('people.greeting.default') },
                  ...greetings.map(asset => ({
                    value: asset.id,
                    label: `${asset.label} · ${formatDuration(asset.durationS)}`
                  }))
                ]}
                onchange={(mailboxAudioId: string | null) =>
                  (mailbox = { ...mailbox, mailboxAudioId })}
              />
            {:else}
              <DisplayValue
                >{audioById(user.mailboxAudioId)?.label ??
                  t('people.greeting.default')}</DisplayValue
              >
            {/if}
          {/snippet}
        </FormField>
      </div>
    </div>
    {@render footer(
      'mailbox',
      Object.keys(mailboxChanges).length > 0,
      () => void save('mailbox', { ...mailboxChanges }),
      () => {
        mailbox = { ...mailboxBase };
        errors.mailbox = {};
      }
    )}
  </Card>

  <Card
    title={t('field.user.findMe')}
    description={t('field.user.findMe.help')}
    icon={Smartphone}
  >
    <FormField
      entity="user"
      key="findMe"
      {own}
      label={t('people.findMe.legs')}
      error={errors.findMe.findMe ?? null}
    >
      {#snippet children(editable)}
        <FindMeEditor
          legs={findMe}
          {editable}
          onchange={legs => (findMe = legs)}
        />
      {/snippet}
    </FormField>
    {@render footer(
      'findMe',
      findMeDirty,
      () => void save('findMe', { findMe }),
      () => {
        findMe = findMeBase.map(leg => ({ ...leg }));
        errors.findMe = {};
      }
    )}
  </Card>
</div>

<style>
  .profile {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .card-footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
  .footer-actions {
    justify-content: flex-end;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
</style>
