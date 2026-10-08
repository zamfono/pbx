<!--
  Ring groups (`ringGroups.*`, admin): the list, a create drawer, and per group its settings,
  its forwarding rules for unanswered and unavailable calls, and its own opening hours and out of
  office. The extension is assigned on create and shown read-only.
-->
<script lang="ts">
  import ArrowDownWideNarrow from '@lucide/svelte/icons/arrow-down-wide-narrow';
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import Disc3 from '@lucide/svelte/icons/disc-3';
  import Music from '@lucide/svelte/icons/music';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import Plus from '@lucide/svelte/icons/plus';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Users from '@lucide/svelte/icons/users';
  import UsersRound from '@lucide/svelte/icons/users-round';
  import Voicemail from '@lucide/svelte/icons/voicemail';
  import { page } from '$app/state';
  import type { Component } from 'svelte';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type { BlockingRef } from '#lib/api/errors.js';
  import { liveAudio, userById, userGroupById } from '#lib/api/lookup.js';
  import {
    nextExtension,
    ringGroupReferences,
    type RingGroupUpdate
  } from '#lib/api/ops/areas/ringGroups.js';
  import { store } from '#lib/api/store.svelte.js';
  import type {
    AudioKind,
    ForwardTarget,
    Member,
    RingGroup,
    RingGroupForwardCondition,
    RingGroupForwardRule
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import LogLevelField from '#lib/components/LogLevelField.svelte';
  import MemberPicker from '#lib/components/MemberPicker.svelte';
  import ScopeSchedule from '#lib/components/schedule-scope/ScopeSchedule.svelte';
  import { scopeStatus } from '#lib/components/schedule-scope/status.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { refHref } from '#lib/links.js';
  import { go, highlight, href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import Tabs from '#lib/ui/Tabs.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  type Strategy = RingGroup['strategy'];
  const STRATEGIES: { value: Strategy; icon: Component }[] = [
    { value: 'simultaneous', icon: Users },
    { value: 'sequential', icon: ArrowDownWideNarrow },
    { value: 'random', icon: Shuffle }
  ];
  const AVATARS_SHOWN = 4;

  const groups = $derived(
    read<{ items: RingGroup[] }>('ringGroups.list', {}, { items: [] }).items
  );
  const groupId = $derived(params.id ?? null);
  const group = $derived(
    groupId === null
      ? null
      : read<RingGroup | null>('ringGroups.get', { id: groupId }, null)
  );
  const tab = $derived(params.tab ?? 'settings');

  /* ---------------- list ---------------- */

  const statusOf = (target: RingGroup) =>
    scopeStatus(store.db, { kind: 'ringGroup', id: target.id });

  const columns = $derived([
    { key: 'name', label: t('field.ringGroup.name'), primary: true },
    { key: 'strategy', label: t('field.ringGroup.strategy') },
    { key: 'members', label: t('field.ringGroup.members') },
    { key: 'features', label: t('groups.rg.features'), hideOnMobile: true },
    { key: 'now', label: t('groups.rg.now') },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : [])
  ]);

  /* ---------------- create ---------------- */

  let creating = $state(false);
  let createDraft = $state({
    name: '',
    strategy: 'simultaneous' as Strategy,
    members: [] as Member[],
    mailboxEnabled: false
  });
  let createError = $state<{ field: string | null; text: string } | null>(null);
  const previewExt = $derived(nextExtension(store.db));

  function openCreate(): void {
    createDraft = {
      name: '',
      strategy: 'simultaneous',
      members: [],
      mailboxEnabled: false
    };
    createError = null;
    creating = true;
  }

  async function create(): Promise<void> {
    const result = await run<RingGroup>(
      'ringGroups.create',
      { ...createDraft },
      {
        success: 'groups.rg.created',
        successParams: { name: createDraft.name },
        quietErrors: true
      }
    );
    if (result.ok) {
      creating = false;
      go(`/ring-groups/${result.value.id}`);
    } else {
      createError = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  /* ---------------- settings ---------------- */

  type Edit = Omit<RingGroupUpdate, 'id'>;
  /** Unsaved changes of the open group; reset when another group opens. */
  let edits = $derived.by<Edit>(() => {
    void groupId;
    return {};
  });
  let settingsError = $state<{ field: string | null; text: string } | null>(
    null
  );
  const current = $derived(
    group === null ? null : ({ ...group, ...edits } as RingGroup)
  );
  const dirty = $derived(Object.keys(edits).length > 0);

  function edit(patch: Edit): void {
    edits = { ...edits, ...patch };
    settingsError = null;
  }

  const fieldError = (field: string): string | null =>
    settingsError !== null && settingsError.field === field
      ? settingsError.text
      : null;

  async function saveSettings(): Promise<void> {
    if (group === null) {
      return;
    }
    const result = await run(
      'ringGroups.update',
      { id: group.id, ...edits },
      { success: 'groups.rg.saved', quietErrors: true }
    );
    if (result.ok) {
      edits = {};
      settingsError = null;
    } else {
      settingsError = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  const audioOptions = (kind: AudioKind, noneLabel: string) => [
    { value: null, label: noneLabel },
    ...liveAudio(kind).map(asset => ({ value: asset.id, label: asset.label }))
  ];

  async function remove(): Promise<void> {
    if (group === null) {
      return;
    }
    const result = await run(
      'ringGroups.delete',
      { id: group.id },
      { success: 'groups.rg.deleted', successParams: { name: group.name } }
    );
    if (result.ok) {
      go('/ring-groups');
    }
  }

  const reachedVia = $derived<BlockingRef[]>(
    group === null ? [] : ringGroupReferences(store.db, group.id)
  );

  /* ---------------- forwarding ---------------- */

  const CONDITIONS: RingGroupForwardCondition[] = ['unanswered', 'unavailable'];
  const forwarding = $derived(
    groupId === null
      ? []
      : read<{ rules: RingGroupForwardRule[] }>(
          'ringGroups.getForwarding',
          { id: groupId },
          { rules: [] }
        ).rules
  );
  let ruleEdits = $derived.by<RingGroupForwardRule[] | null>(() => {
    void groupId;
    return null;
  });
  let forwardingError = $state<string | null>(null);
  const rules = $derived(ruleEdits ?? forwarding);
  const ruleFor = (
    condition: RingGroupForwardCondition
  ): RingGroupForwardRule | undefined =>
    rules.find(rule => rule.condition === condition);

  function setRule(
    condition: RingGroupForwardCondition,
    target: ForwardTarget | null
  ): void {
    const others = rules.filter(rule => rule.condition !== condition);
    const next = target === null ? others : [...others, { condition, target }];
    ruleEdits = CONDITIONS.flatMap(item =>
      next.filter(rule => rule.condition === item)
    );
    forwardingError = null;
  }

  function defaultRuleTarget(): ForwardTarget {
    if (group !== null && group.mailboxEnabled) {
      return { kind: 'mailboxRingGroup', ringGroupId: group.id };
    }
    const other = groups.find(candidate => candidate.id !== groupId);
    return other === undefined
      ? { kind: 'external', external: '', record: false }
      : { kind: 'ringGroup', ringGroupId: other.id };
  }

  async function saveForwarding(): Promise<void> {
    if (groupId === null || ruleEdits === null) {
      return;
    }
    const result = await run(
      'ringGroups.setForwarding',
      { id: groupId, rules: ruleEdits },
      { success: 'groups.rg.forwardingSaved', quietErrors: true }
    );
    if (result.ok) {
      ruleEdits = null;
      forwardingError = null;
    } else {
      forwardingError = errorText(result.error);
    }
  }
</script>

{#snippet memberStack(target: RingGroup)}
  {@const users = target.members.filter(member => member.kind === 'user')}
  {@const userGroups = target.members.filter(
    member => member.kind === 'userGroup'
  )}
  <span class="members">
    {#if users.length > 0}
      <span class="avatars">
        {#each users.slice(0, AVATARS_SHOWN) as member (member.id)}
          <span class="avatar" title={userById(member.id)?.name}
            ><Avatar name={userById(member.id)?.name ?? '?'} size={26} /></span
          >
        {/each}
        {#if users.length > AVATARS_SHOWN}<span class="more nums"
            >+{users.length - AVATARS_SHOWN}</span
          >{/if}
      </span>
    {/if}
    {#each userGroups as member (member.id)}
      <Badge icon={UsersRound}>{userGroupById(member.id)?.name ?? '—'}</Badge>
    {/each}
    {#if target.members.length === 0}<span class="muted small"
        >{t('groups.rg.noMembers')}</span
      >{/if}
  </span>
{/snippet}

{#snippet nowBadge(target: RingGroup)}
  {@const status = statusOf(target)}
  {#if status.ooo !== null}
    <Badge tone="mucki" dot>{t('groups.rg.statusOoo')}</Badge>
  {:else if status.open === false}
    <Badge tone="warn" dot>{t('groups.rg.statusClosed')}</Badge>
  {:else}
    <Badge tone="ok" dot>{t('groups.rg.statusOpen')}</Badge>
  {/if}
{/snippet}

{#snippet strategyPicker(
  value: Strategy,
  onpick: (strategy: Strategy) => void,
  idPrefix: string
)}
  <div
    class="strategies"
    role="radiogroup"
    aria-label={t('field.ringGroup.strategy')}
    id={idPrefix}
  >
    {#each STRATEGIES as option (option.value)}
      {@const Glyph = option.icon}
      <button
        type="button"
        role="radio"
        aria-checked={value === option.value}
        class="strategy"
        class:on={value === option.value}
        onclick={() => onpick(option.value)}
      >
        <span class="strategy-icon"><Glyph size={18} /></span>
        <span class="strategy-title"
          >{t(`groups.rg.strategy.${option.value}`)}</span
        >
        <span class="strategy-desc"
          >{t(`groups.rg.strategy.${option.value}.desc`)}</span
        >
      </button>
    {/each}
  </div>
{/snippet}

{#if groupId === null}
  <PageHeader title={t('nav.ringGroups')} subtitle={t('groups.rg.subtitle')}>
    {#snippet actions()}
      <Button
        variant="primary"
        icon={Plus}
        op="ringGroups.create"
        onclick={openCreate}>{t('groups.rg.add')}</Button
      >
    {/snippet}
  </PageHeader>

  <DataTable
    rows={groups}
    {columns}
    rowKey={row => row.id}
    caption={t('nav.ringGroups')}
    onRowClick={row => go(`/ring-groups/${row.id}`)}
  >
    {#snippet cell(row, key)}
      {#if key === 'name'}
        <span class="row nowrap" style="--gap: 10px">
          <span class="ext mono">{row.ext}</span>
          <a class="strong" href={href(`/ring-groups/${row.id}`)}>{row.name}</a>
        </span>
      {:else if key === 'strategy'}
        <span class="small">{t(`groups.rg.strategy.${row.strategy}`)}</span>
      {:else if key === 'members'}
        {@render memberStack(row)}
      {:else if key === 'features'}
        <span class="row" style="--gap: 4px">
          {#if row.mailboxEnabled}<Badge icon={Voicemail} tone="info"
              >{t('groups.rg.mailbox')}</Badge
            >{/if}
          {#if row.recordCalls}<Badge icon={Disc3} tone="danger"
              >{t('groups.rg.recording')}</Badge
            >{/if}
          {#if row.mohAudioId !== null}<Badge icon={Music}
              >{t('groups.rg.music')}</Badge
            >{/if}
          {#if !row.mailboxEnabled && !row.recordCalls && row.mohAudioId === null}<span
              class="faint">—</span
            >{/if}
        </span>
      {:else if key === 'now'}
        {@render nowBadge(row)}
      {:else if key === 'id'}
        <code class="xs faint">{row.id}</code>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={RadioTower}
        title={t('groups.rg.empty')}
        body={t('groups.rg.emptyBody')}
      >
        {#snippet action()}
          <Button
            variant="primary"
            icon={Plus}
            op="ringGroups.create"
            onclick={openCreate}>{t('groups.rg.add')}</Button
          >
        {/snippet}
      </EmptyState>
    {/snippet}
  </DataTable>
{:else if group === null || current === null}
  <PageHeader
    title={t('nav.ringGroups')}
    back={{ href: href('/ring-groups'), label: t('nav.ringGroups') }}
  />
  <EmptyState
    icon={RadioTower}
    title={t('groups.rg.notFound')}
    body={t('groups.rg.notFoundBody')}
  />
{:else}
  <PageHeader
    title={group.name}
    back={{ href: href('/ring-groups'), label: t('nav.ringGroups') }}
  >
    {#snippet meta()}
      <span class="row" style="--gap: 6px">
        <Badge tone="primary"
          >{t('groups.rg.extShort', { ext: group.ext })}</Badge
        >
        <Badge>{t(`groups.rg.strategy.${group.strategy}`)}</Badge>
        {@render nowBadge(group)}
        {#if isExpert()}<code class="xs faint">{group.id}</code>{/if}
      </span>
    {/snippet}
    {#snippet actions()}
      <Button
        variant="ghost"
        icon={Trash2}
        op="ringGroups.delete"
        onclick={remove}>{t('common.delete')}</Button
      >
    {/snippet}
  </PageHeader>

  <Tabs
    active={tab}
    hrefFor={id => href(`/ring-groups/${group.id}/${id}`)}
    tabs={[
      {
        id: 'settings',
        label: t('groups.rg.tab.settings'),
        icon: SlidersHorizontal
      },
      {
        id: 'forwarding',
        label: t('groups.rg.tab.forwarding'),
        icon: PhoneForwarded,
        count: forwarding.length
      },
      {
        id: 'schedule',
        label: t('groups.rg.tab.schedule'),
        icon: CalendarClock
      }
    ]}
  />

  <div class="tab-body">
    {#if tab === 'forwarding'}
      <div class="stack">
        <Card
          title={t('groups.rg.forwardingTitle')}
          icon={PhoneForwarded}
          description={t('groups.rg.forwardingDesc')}
        >
          <div class="stack">
            {#each CONDITIONS as condition (condition)}
              {@const rule = ruleFor(condition)}
              <section class="rule" class:on={rule !== undefined}>
                <div class="rule-head">
                  <div class="grow">
                    <h4>{t(`groups.rg.condition.${condition}`)}</h4>
                    <p class="small muted">
                      {t(`groups.rg.condition.${condition}.desc`)}
                    </p>
                  </div>
                  <Switch
                    id={`rg-rule-${condition}`}
                    checked={rule !== undefined}
                    label={t('groups.rg.ruleOn')}
                    onchange={on =>
                      setRule(condition, on ? defaultRuleTarget() : null)}
                  />
                </div>
                {#if rule !== undefined}
                  <ForwardTargetPicker
                    id={`rg-rule-${condition}-target`}
                    value={rule.target}
                    onchange={target => setRule(condition, target)}
                  />
                {:else}
                  <p class="small fallback">
                    {condition === 'unanswered'
                      ? current.mailboxEnabled
                        ? t('groups.rg.noUnansweredMailbox')
                        : t('groups.rg.noUnansweredReject')
                      : t('groups.rg.noUnavailable')}
                  </p>
                {/if}
              </section>
            {/each}
            {#if forwardingError !== null}<p class="form-error" role="alert">
                {forwardingError}
              </p>{/if}
          </div>
        </Card>
        {#if ruleEdits !== null}
          <div class="save-bar">
            <span class="grow small strong">{t('groups.unsaved')}</span>
            <Button
              variant="ghost"
              onclick={() => ((ruleEdits = null), (forwardingError = null))}
              >{t('common.cancel')}</Button
            >
            <Button
              variant="primary"
              op="ringGroups.setForwarding"
              onclick={saveForwarding}>{t('common.save')}</Button
            >
          </div>
        {/if}
      </div>
    {:else if tab === 'schedule'}
      <ScopeSchedule scope={{ kind: 'ringGroup', id: group.id }} />
    {:else}
      <div class="stack">
        <div class="grid-2">
          <Card title={t('groups.rg.cardGeneral')} icon={RadioTower}>
            <div class="stack">
              <FormField
                entity="ringGroup"
                key="name"
                error={fieldError('name')}
                required
              >
                {#snippet children()}
                  <TextInput
                    id="ringGroup-name"
                    value={current.name}
                    invalid={fieldError('name') !== null}
                    oninput={name => edit({ name })}
                  />
                {/snippet}
              </FormField>
              <FormField entity="ringGroup" key="ext">
                {#snippet children()}
                  <DisplayValue mono>{group.ext}</DisplayValue>
                {/snippet}
              </FormField>
              <FormField entity="ringGroup" key="strategy">
                {#snippet children()}
                  {@render strategyPicker(
                    current.strategy,
                    strategy => edit({ strategy }),
                    'ringGroup-strategy'
                  )}
                {/snippet}
              </FormField>
              {#if reachedVia.length > 0}
                <div class="reached">
                  <span class="xs muted strong"
                    >{t('groups.rg.reachedVia')}</span
                  >
                  <span class="row" style="--gap: 6px">
                    {#each reachedVia as ref (`${ref.kind}:${ref.id}:${ref.label}`)}
                      <a class="chip" href={refHref(ref) ?? undefined}
                        ><PhoneIncoming size={12} /> {ref.label}</a
                      >
                    {/each}
                  </span>
                </div>
              {/if}
            </div>
          </Card>

          <Card
            title={t('field.ringGroup.members')}
            icon={Users}
            description={current.strategy === 'sequential'
              ? t('groups.rg.membersOrdered')
              : t('groups.rg.membersDesc')}
          >
            <FormField
              entity="ringGroup"
              key="members"
              error={fieldError('members')}
            >
              {#snippet children()}
                <MemberPicker
                  id="ringGroup-members"
                  members={current.members}
                  ordered={current.strategy === 'sequential'}
                  onchange={members => edit({ members })}
                />
              {/snippet}
            </FormField>
          </Card>
        </div>

        <div class="grid-2">
          <Card title={t('groups.rg.cardRinging')} icon={PhoneIncoming}>
            <div class="stack">
              <FormField
                entity="ringGroup"
                key="ringTimeoutS"
                error={fieldError('ringTimeoutS')}
              >
                {#snippet children()}
                  <NumberInput
                    id="ringGroup-ringTimeoutS"
                    value={current.ringTimeoutS}
                    min={1}
                    max={86400}
                    suffix={t('common.seconds')}
                    onchange={value =>
                      value !== null && edit({ ringTimeoutS: value })}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="ringGroup"
                key="ringTotalS"
                error={fieldError('ringTotalS')}
              >
                {#snippet children()}
                  <div class="stack" style="--gap: 8px">
                    <Switch
                      id="ringGroup-ringTotalS-on"
                      size="sm"
                      checked={current.ringTotalS !== null}
                      label={t('groups.rg.capOn')}
                      onchange={on =>
                        edit({
                          ringTotalS: on
                            ? Math.max(current.ringTimeoutS * 3, 60)
                            : null
                        })}
                    />
                    {#if current.ringTotalS !== null}
                      <NumberInput
                        id="ringGroup-ringTotalS"
                        value={current.ringTotalS}
                        min={1}
                        max={86400}
                        suffix={t('common.seconds')}
                        onchange={value =>
                          value !== null && edit({ ringTotalS: value })}
                      />
                    {/if}
                    {#if current.strategy === 'simultaneous'}<span
                        class="xs muted">{t('groups.rg.capSimultaneous')}</span
                      >{/if}
                  </div>
                {/snippet}
              </FormField>
              <FormField entity="ringGroup" key="skipBusy">
                {#snippet children()}
                  <Switch
                    id="ringGroup-skipBusy"
                    checked={current.skipBusy}
                    label={t('groups.rg.skipBusyLabel')}
                    onchange={skipBusy => edit({ skipBusy })}
                  />
                {/snippet}
              </FormField>
              <FormField entity="ringGroup" key="allowReject">
                {#snippet children()}
                  <Switch
                    id="ringGroup-allowReject"
                    checked={current.allowReject}
                    label={t('groups.rg.allowRejectLabel')}
                    onchange={allowReject => edit({ allowReject })}
                  />
                {/snippet}
              </FormField>
            </div>
          </Card>

          <Card
            title={t('groups.rg.cardAudio')}
            icon={Music}
            description={t('groups.rg.cardAudioDesc')}
          >
            <div class="stack">
              <FormField
                entity="ringGroup"
                key="greetingAudioId"
                error={fieldError('greetingAudioId')}
              >
                {#snippet children()}
                  <Select
                    id="ringGroup-greetingAudioId"
                    value={current.greetingAudioId}
                    options={audioOptions(
                      'greeting',
                      t('groups.rg.noGreeting')
                    )}
                    onchange={greetingAudioId => edit({ greetingAudioId })}
                  />
                {/snippet}
              </FormField>
              <FormField
                entity="ringGroup"
                key="mohAudioId"
                error={fieldError('mohAudioId')}
              >
                {#snippet children()}
                  <Select
                    id="ringGroup-mohAudioId"
                    value={current.mohAudioId}
                    options={audioOptions('moh', t('groups.rg.ringback'))}
                    onchange={mohAudioId => edit({ mohAudioId })}
                  />
                {/snippet}
              </FormField>
              <a class="small" href={href('/audio')}>{t('groups.rg.toAudio')}</a
              >
            </div>
          </Card>
        </div>

        <Card title={t('groups.rg.cardMailbox')} icon={Voicemail}>
          <div class="grid-2">
            <div class="stack">
              <FormField entity="ringGroup" key="mailboxEnabled">
                {#snippet children()}
                  <Switch
                    id="ringGroup-mailboxEnabled"
                    checked={current.mailboxEnabled}
                    label={t('groups.rg.mailboxLabel')}
                    onchange={mailboxEnabled => edit({ mailboxEnabled })}
                  />
                {/snippet}
              </FormField>
              <FormField entity="ringGroup" key="recordCalls">
                {#snippet children()}
                  <Switch
                    id="ringGroup-recordCalls"
                    checked={current.recordCalls}
                    label={t('groups.rg.recordLabel')}
                    onchange={recordCalls => edit({ recordCalls })}
                  />
                {/snippet}
              </FormField>
            </div>
            {#if current.mailboxEnabled}
              <div class="stack">
                <FormField
                  entity="ringGroup"
                  key="mailboxAudioId"
                  error={fieldError('mailboxAudioId')}
                >
                  {#snippet children()}
                    <Select
                      id="ringGroup-mailboxAudioId"
                      value={current.mailboxAudioId}
                      options={audioOptions(
                        'vmGreeting',
                        t('groups.rg.standardGreeting')
                      )}
                      onchange={mailboxAudioId => edit({ mailboxAudioId })}
                    />
                  {/snippet}
                </FormField>
                <FormField
                  entity="ringGroup"
                  key="mailboxMaxMessages"
                  error={fieldError('mailboxMaxMessages')}
                >
                  {#snippet children()}
                    <NumberInput
                      id="ringGroup-mailboxMaxMessages"
                      value={current.mailboxMaxMessages}
                      min={1}
                      nullable
                      placeholder={t('common.unlimited')}
                      onchange={mailboxMaxMessages =>
                        edit({ mailboxMaxMessages })}
                    />
                  {/snippet}
                </FormField>
              </div>
            {/if}
          </div>
        </Card>

        {#if isExpert()}
          <Card title={t('groups.rg.cardDiagnostics')} expert>
            <LogLevelField
              id="ringGroup-logLevel"
              level={current.logLevel}
              expiresAt={current.logLevelExpiresAt}
              onchange={(logLevel, logLevelExpiresAt) =>
                edit({ logLevel, logLevelExpiresAt })}
            />
          </Card>
        {/if}

        {#if settingsError !== null && settingsError.field === null}
          <p class="form-error" role="alert">{settingsError.text}</p>
        {/if}
        {#if dirty}
          <div class="save-bar">
            <span class="grow small strong">{t('groups.unsaved')}</span>
            <Button
              variant="ghost"
              onclick={() => ((edits = {}), (settingsError = null))}
              >{t('common.cancel')}</Button
            >
            <Button
              variant="primary"
              op="ringGroups.update"
              onclick={saveSettings}>{t('common.save')}</Button
            >
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<Drawer
  open={creating}
  title={t('groups.rg.add')}
  subtitle={t('groups.rg.addSub')}
  onclose={() => (creating = false)}
>
  <div class="stack">
    <FormField
      entity="ringGroup"
      key="name"
      id="rg-new-name"
      error={createError?.field === 'name' ? createError.text : null}
      required
    >
      {#snippet children()}
        <TextInput
          id="rg-new-name"
          bind:value={createDraft.name}
          placeholder={t('groups.rg.namePlaceholder')}
          invalid={createError?.field === 'name'}
          onenter={create}
        />
      {/snippet}
    </FormField>
    <FormField entity="ringGroup" key="ext" id="rg-new-ext">
      {#snippet children()}
        <DisplayValue mono>{previewExt ?? '—'}</DisplayValue>
        <p class="xs muted">{t('groups.rg.extAuto')}</p>
      {/snippet}
    </FormField>
    <FormField entity="ringGroup" key="strategy" id="rg-new-strategy">
      {#snippet children()}
        {@render strategyPicker(
          createDraft.strategy,
          strategy => (createDraft.strategy = strategy),
          'rg-new-strategy'
        )}
      {/snippet}
    </FormField>
    <FormField
      entity="ringGroup"
      key="members"
      id="rg-new-members"
      error={createError?.field === 'members' ? createError.text : null}
    >
      {#snippet children()}
        <MemberPicker
          id="rg-new-members"
          members={createDraft.members}
          ordered={createDraft.strategy === 'sequential'}
          onchange={members => (createDraft.members = members)}
        />
      {/snippet}
    </FormField>
    <FormField entity="ringGroup" key="mailboxEnabled" id="rg-new-mailbox">
      {#snippet children()}
        <Switch
          id="rg-new-mailbox"
          bind:checked={createDraft.mailboxEnabled}
          label={t('groups.rg.mailboxLabel')}
        />
      {/snippet}
    </FormField>
    {#if createError !== null && createError.field !== 'name' && createError.field !== 'members'}
      <p class="form-error" role="alert">{createError.text}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creating = false)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="ringGroups.create" onclick={create}
      >{t('common.create')}</Button
    >
  {/snippet}
</Drawer>

<style>
  .ext {
    display: inline-grid;
    place-items: center;
    min-width: 42px;
    padding: 3px 8px;
    border-radius: var(--radius-xs);
    background: var(--primary-soft);
    color: var(--primary);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .members {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .avatars {
    display: inline-flex;
    align-items: center;
  }
  .avatar {
    display: inline-flex;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--surface);
  }
  .avatar + .avatar {
    margin-left: -8px;
  }
  .more {
    margin-left: 6px;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
  }
  .tab-body {
    margin-top: var(--space-4);
  }
  .strategies {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .strategy {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--space-3);
    row-gap: 2px;
    align-items: center;
    padding: 10px var(--space-3);
    border: 1.5px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .strategy:hover {
    border-color: var(--line-strong);
  }
  .strategy.on {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .strategy:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .strategy-icon {
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--primary);
  }
  .strategy.on .strategy-icon {
    background: var(--primary);
    color: var(--on-primary);
  }
  .strategy-title {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .strategy-desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.35;
  }
  .reached {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .chip:hover {
    background: var(--primary-soft);
    color: var(--primary);
    text-decoration: none;
  }
  .rule {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .rule.on {
    border-color: color-mix(in srgb, var(--primary) 40%, var(--line));
  }
  .rule-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .rule h4 {
    font-size: var(--text-md);
  }
  .fallback {
    color: var(--text-muted);
    font-style: italic;
  }
  .save-bar {
    position: sticky;
    bottom: var(--space-3);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .form-error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  @media (max-width: 767px) {
    .save-bar {
      bottom: calc(var(--tabbar-height) + var(--space-3));
    }
  }
</style>
