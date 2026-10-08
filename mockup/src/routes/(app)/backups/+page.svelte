<!--
  Backups (`backups.targets.*`, `backups.runs.*`, §6.5): the schedule (`settings.backupCron`), the
  restic targets with their location, credentials and forget policy, "Back up now" per target, and
  the run history.
-->
<script lang="ts">
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import DatabaseBackup from '@lucide/svelte/icons/database-backup';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import {
    CREDENTIALS_BY_KIND,
    DEFAULT_FORGET,
    PARAMS_BY_KIND,
    targetLocation,
    type BackupParams,
    type BackupRunWire,
    type BackupSecret,
    type BackupTargetWire
  } from '#lib/api/ops/areas/backups.js';
  import {
    BACKUP_TARGET_KINDS,
    type BackupForget,
    type BackupTargetKind,
    type Settings
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import {
    cronNextRuns,
    cronSentence
  } from '#lib/components/system/cronText.js';
  import {
    formatBytes,
    formatDateTime,
    formatDuration,
    formatRelative,
    t
  } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Menu from '#lib/ui/Menu.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const settings = $derived(read<Settings | null>('settings.get', {}, null));
  const targets = $derived(
    read<{ items: BackupTargetWire[] }>(
      'backups.targets.list',
      {},
      { items: [] }
    ).items
  );
  const runs = $derived(
    read<{ items: BackupRunWire[] }>('backups.runs.list', {}, { items: [] })
      .items
  );
  const lastGood = $derived(
    runs
      .filter(each => each.status === 'ok' && each.finishedAt !== null)
      .map(each => each.finishedAt as string)
      .sort()
      .at(-1) ?? null
  );
  const nextRun = $derived(
    settings === null
      ? []
      : cronNextRuns(settings.backupCron, settings.timezone, 1)
  );

  let runFilter = $state<string>('');
  const shownRuns = $derived(
    runs
      .filter(each => runFilter === '' || each.targetId === runFilter)
      .slice(0, 40)
  );
  const targetName = (id: string): string => {
    const target = targets.find(each => each.id === id);
    return target === undefined
      ? t('backups.deletedTarget')
      : `${t(`backups.kind.${target.kind}`)} · ${targetLocation(target)}`;
  };
  const latestRun = (targetId: string): BackupRunWire | undefined =>
    runs.find(each => each.targetId === targetId);
  const forgetOf = (target: BackupTargetWire): BackupForget =>
    (target.params.forget as BackupForget | undefined) ?? DEFAULT_FORGET;
  const duration = (each: BackupRunWire): string =>
    each.finishedAt === null
      ? '—'
      : formatDuration(
          (new Date(each.finishedAt).getTime() -
            new Date(each.startedAt).getTime()) /
            1000
        );

  /* ---------- create / edit ---------- */
  type Draft = {
    id: string | null;
    kind: BackupTargetKind;
    params: Record<string, string>;
    forget: BackupForget;
    enabled: boolean;
    changeSecret: boolean;
    secret: Required<BackupSecret>;
  };
  const blankSecret = (): Required<BackupSecret> => ({
    resticPassword: '',
    username: '',
    password: '',
    accessKeyId: '',
    secretAccessKey: ''
  });
  let draft = $state<Draft | null>(null);
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);
  const originalKind = $derived(
    draft?.id === null
      ? null
      : (targets.find(each => each.id === draft?.id)?.kind ?? null)
  );
  const secretRequired = $derived(
    draft !== null &&
      (draft.id === null ||
        (originalKind !== null &&
          CREDENTIALS_BY_KIND[originalKind].join() !==
            CREDENTIALS_BY_KIND[draft.kind].join()))
  );

  function openCreate(): void {
    draft = {
      id: null,
      kind: 'sftp',
      params: {},
      forget: { ...DEFAULT_FORGET },
      enabled: true,
      changeSecret: true,
      secret: blankSecret()
    };
    errors = {};
  }

  function openEdit(target: BackupTargetWire): void {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(target.params)) {
      if (typeof value === 'string') {
        params[key] = value;
      }
    }
    draft = {
      id: target.id,
      kind: target.kind,
      params,
      forget: { ...forgetOf(target) },
      enabled: target.enabled,
      changeSecret: false,
      secret: blankSecret()
    };
    errors = {};
  }

  async function save(): Promise<void> {
    if (draft === null) {
      return;
    }
    const params: BackupParams = { forget: { ...draft.forget } };
    for (const { key } of PARAMS_BY_KIND[draft.kind]) {
      const value = draft.params[key]?.trim() ?? '';
      if (value !== '') {
        params[key] = value;
      }
    }
    const secret: BackupSecret = {
      resticPassword: draft.secret.resticPassword
    };
    for (const field of CREDENTIALS_BY_KIND[draft.kind]) {
      secret[field] = draft.secret[field];
    }
    const sendSecret = draft.changeSecret || secretRequired;
    saving = true;
    const result =
      draft.id === null
        ? await run<BackupTargetWire>(
            'backups.targets.create',
            { kind: draft.kind, params, secret, enabled: draft.enabled },
            { success: 'backups.target.created' }
          )
        : await run<BackupTargetWire>(
            'backups.targets.update',
            {
              id: draft.id,
              kind: draft.kind,
              params,
              enabled: draft.enabled,
              ...(sendSecret ? { secret } : {})
            },
            { success: 'backups.target.saved' }
          );
    saving = false;
    if (result.ok) {
      highlight(result.value.id);
      draft = null;
    } else if (result.error.field !== null) {
      errors = { [result.error.field]: errorText(result.error) };
    }
  }

  async function backUpNow(target: BackupTargetWire): Promise<void> {
    const result = await run<BackupRunWire>(
      'backups.runs.start',
      { targetId: target.id },
      {
        success: 'backups.run.started',
        successParams: { target: targetName(target.id) }
      }
    );
    if (result.ok) {
      highlight(result.value.id);
    }
  }

  const kindOptions = $derived(
    BACKUP_TARGET_KINDS.map(kind => ({
      value: kind,
      label: t(`backups.kind.${kind}`)
    }))
  );
  const runFilterOptions = $derived([
    { value: '', label: t('backups.runs.allTargets') },
    ...targets.map(target => ({
      value: target.id,
      label: targetName(target.id)
    }))
  ]);
  const runColumns = $derived([
    { key: 'started', label: t('backups.runs.started'), primary: true },
    { key: 'target', label: t('backups.runs.target') },
    { key: 'status', label: t('common.status') },
    { key: 'duration', label: t('backups.runs.duration'), hideOnMobile: true },
    { key: 'added', label: t('backups.runs.added'), align: 'right' as const },
    {
      key: 'total',
      label: t('backups.runs.total'),
      align: 'right' as const,
      hideOnMobile: true
    },
    ...(isExpert()
      ? [
          {
            key: 'snapshot',
            label: t('backups.runs.snapshot'),
            hideOnMobile: true
          }
        ]
      : [])
  ]);
</script>

<PageHeader title={t('nav.backups')} subtitle={t('backups.subtitle')}>
  {#snippet actions()}
    <Button
      variant="primary"
      icon={Plus}
      op="backups.targets.create"
      onclick={openCreate}>{t('backups.target.add')}</Button
    >
  {/snippet}
</PageHeader>

<div class="stack" style="--gap: 24px">
  <Card title={t('backups.schedule.title')} icon={CalendarClock}>
    {#snippet actions()}
      <Button size="sm" variant="ghost" href="#/settings/updates"
        >{t('backups.schedule.change')}</Button
      >
    {/snippet}
    <div class="schedule">
      <div>
        <span class="xs muted strong">{t('backups.schedule.when')}</span>
        <strong
          >{settings === null ? '—' : cronSentence(settings.backupCron)}</strong
        >
        {#if isExpert() && settings !== null}<code class="xs faint"
            >{settings.backupCron}</code
          >{/if}
      </div>
      <div>
        <span class="xs muted strong">{t('backups.schedule.next')}</span>
        <strong>{nextRun[0] ?? '—'}</strong>
      </div>
      <div>
        <span class="xs muted strong">{t('backups.schedule.lastGood')}</span>
        <strong title={formatDateTime(lastGood)}
          >{lastGood === null
            ? t('backups.schedule.never')
            : formatRelative(lastGood)}</strong
        >
      </div>
    </div>
    <p class="xs muted hint">{t('backups.schedule.hint')}</p>
  </Card>

  {#if targets.length === 0}
    <Card>
      <EmptyState
        icon={DatabaseBackup}
        title={t('backups.targets.empty')}
        body={t('backups.targets.emptyBody')}
      />
    </Card>
  {:else}
    <div class="grid-2">
      {#each targets as target (target.id)}
        {@const last = latestRun(target.id)}
        {@const forget = forgetOf(target)}
        <section class="target" class:disabled={!target.enabled}>
          <header>
            <span class="icon"><HardDrive size={18} /></span>
            <div class="grow">
              <div class="row" style="--gap: 6px">
                <Badge tone="primary">{t(`backups.kind.${target.kind}`)}</Badge>
                {#if !target.enabled}<Badge tone="neutral"
                    >{t('backups.target.disabled')}</Badge
                  >{/if}
              </div>
              <h3 class="location mono">{targetLocation(target)}</h3>
              {#if typeof target.params.path === 'string' && target.kind !== 'local'}<span
                  class="xs muted mono">{target.params.path}</span
                >{/if}
            </div>
            <Menu
              label={t('common.more')}
              items={[
                {
                  label: t('common.edit'),
                  icon: Pencil,
                  op: 'backups.targets.update',
                  onclick: () => openEdit(target)
                },
                {
                  label: t('common.delete'),
                  icon: Trash2,
                  danger: true,
                  op: 'backups.targets.delete',
                  onclick: () =>
                    run(
                      'backups.targets.delete',
                      { id: target.id },
                      { success: 'backups.target.deleted' }
                    )
                }
              ]}
            />
          </header>
          <div class="facts">
            <div>
              <span class="xs muted">{t('backups.target.lastRun')}</span>
              {#if last === undefined}
                <span class="small">{t('backups.schedule.never')}</span>
              {:else if last.status === 'running'}
                <span class="small run running"
                  ><LoaderCircle size={14} class="spin" />{t(
                    'backups.status.running'
                  )}</span
                >
              {:else if last.status === 'ok'}
                <span
                  class="small run ok"
                  title={formatDateTime(last.finishedAt)}
                  ><CircleCheck size={14} />{formatRelative(
                    last.finishedAt
                  )}</span
                >
              {:else}
                <span class="small run failed" title={last.error ?? ''}
                  ><CircleX size={14} />{t('backups.status.failedAt', {
                    at: formatRelative(last.startedAt)
                  })}</span
                >
              {/if}
            </div>
            <div>
              <span class="xs muted">{t('backups.target.size')}</span>
              <span class="small nums"
                >{formatBytes(
                  runs.find(
                    each =>
                      each.targetId === target.id && each.bytesTotal !== null
                  )?.bytesTotal
                )}</span
              >
            </div>
            <div>
              <span class="xs muted">{t('backups.target.keeps')}</span>
              <span class="small"
                >{t('backups.forget.summary', { ...forget })}</span
              >
            </div>
          </div>
          <footer>
            <Switch
              id="target-enabled-{target.id}"
              size="sm"
              checked={target.enabled}
              label={t('backups.target.scheduled')}
              onchange={enabled =>
                run(
                  'backups.targets.update',
                  { id: target.id, enabled },
                  {
                    success: enabled
                      ? 'backups.target.enabledToast'
                      : 'backups.target.disabledToast'
                  }
                )}
            />
            <Button
              size="sm"
              variant="soft"
              icon={Play}
              op="backups.runs.start"
              loading={last?.status === 'running'}
              onclick={() => backUpNow(target)}>{t('backups.run.now')}</Button
            >
          </footer>
          {#if isExpert()}<code class="xs faint id">{target.id}</code>{/if}
        </section>
      {/each}
    </div>
  {/if}

  <Card title={t('backups.runs.title')} icon={DatabaseBackup} padded={false}>
    <div class="filter">
      <Select
        id="run-filter"
        bind:value={runFilter}
        options={runFilterOptions}
      />
    </div>
    <div class="table-pad">
      <DataTable
        rows={shownRuns}
        columns={runColumns}
        rowKey={row => row.id}
        dense
        caption={t('backups.runs.title')}
      >
        {#snippet cell(row, key)}
          {#if key === 'started'}
            <span class="small strong" title={formatDateTime(row.startedAt)}
              >{formatDateTime(row.startedAt)}</span
            >
          {:else if key === 'target'}
            <span class="small">{targetName(row.targetId)}</span>
          {:else if key === 'status'}
            {#if row.status === 'running'}
              <Badge tone="info" icon={LoaderCircle}
                >{t('backups.status.running')}</Badge
              >
            {:else if row.status === 'ok'}
              <Badge tone="ok" icon={CircleCheck}
                >{t('backups.status.ok')}</Badge
              >
            {:else}
              <span class="failed-cell">
                <Badge tone="danger" icon={CircleX}
                  >{t('backups.status.failed')}</Badge
                >
                {#if row.error}<span class="xs mono muted err">{row.error}</span
                  >{/if}
              </span>
            {/if}
          {:else if key === 'duration'}
            <span class="small nums muted">{duration(row)}</span>
          {:else if key === 'added'}
            <span class="small nums"
              >{row.bytesAdded === null
                ? '—'
                : `+${formatBytes(row.bytesAdded)}`}</span
            >
          {:else if key === 'total'}
            <span class="small nums muted">{formatBytes(row.bytesTotal)}</span>
          {:else if key === 'snapshot'}
            <code class="xs faint">{row.snapshotId ?? '—'}</code>
          {/if}
        {/snippet}
        {#snippet empty()}
          <EmptyState icon={DatabaseBackup} title={t('backups.runs.empty')} />
        {/snippet}
      </DataTable>
    </div>
  </Card>
</div>

<Drawer
  open={draft !== null}
  title={draft?.id === null
    ? t('backups.target.add')
    : t('backups.target.edit')}
  subtitle={t('backups.target.drawerBody')}
  onclose={() => (draft = null)}
>
  {#if draft !== null}
    <div class="stack">
      <FormField entity="backupTarget" key="kind" error={errors.kind ?? null}>
        {#snippet children()}
          {#if draft !== null}
            <Select
              id="backupTarget-kind"
              bind:value={draft.kind}
              options={kindOptions}
            />
          {/if}
        {/snippet}
      </FormField>
      <p class="xs muted">{t(`backups.kind.${draft.kind}.help`)}</p>

      <FormField entity="backupTarget" key="params">
        {#snippet children()}
          {#if draft !== null}
            <div class="stack" style="--gap: 12px">
              {#each PARAMS_BY_KIND[draft.kind] as param (param.key)}
                <Field
                  label={t(`backups.param.${param.key}`)}
                  id="backup-param-{param.key}"
                  required={param.required}
                  error={errors[`params.${param.key}`] ?? null}
                >
                  <TextInput
                    id="backup-param-{param.key}"
                    mono
                    placeholder={t(
                      `backups.param.${param.key}.placeholder.${draft.kind}`
                    )}
                    value={draft.params[param.key] ?? ''}
                    invalid={errors[`params.${param.key}`] !== undefined}
                    oninput={value => {
                      if (draft !== null) {
                        draft.params[param.key] = value;
                      }
                    }}
                  />
                </Field>
              {/each}
              <div class="forget">
                <span class="small strong">{t('backups.forget.title')}</span>
                <span class="xs muted">{t('backups.forget.help')}</span>
                <div class="grid-3" style="--gap: 8px">
                  <Field
                    label={t('backups.forget.keepDaily')}
                    id="forget-daily"
                  >
                    <NumberInput
                      id="forget-daily"
                      min={0}
                      bind:value={draft.forget.keepDaily}
                    />
                  </Field>
                  <Field
                    label={t('backups.forget.keepWeekly')}
                    id="forget-weekly"
                  >
                    <NumberInput
                      id="forget-weekly"
                      min={0}
                      bind:value={draft.forget.keepWeekly}
                    />
                  </Field>
                  <Field
                    label={t('backups.forget.keepMonthly')}
                    id="forget-monthly"
                  >
                    <NumberInput
                      id="forget-monthly"
                      min={0}
                      bind:value={draft.forget.keepMonthly}
                    />
                  </Field>
                </div>
              </div>
            </div>
          {/if}
        {/snippet}
      </FormField>

      <FormField entity="backupTarget" key="secret" required>
        {#snippet children()}
          {#if draft !== null}
            {#if draft.id !== null && !secretRequired && !draft.changeSecret}
              <div class="row">
                <Badge tone="ok">{t('secret.set')}</Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => draft !== null && (draft.changeSecret = true)}
                  >{t('backups.secret.change')}</Button
                >
              </div>
            {:else}
              <div class="stack" style="--gap: 12px">
                {#if draft.id !== null}<p class="xs muted">
                    {t('backups.secret.replaceHelp')}
                  </p>{/if}
                <Field
                  label={t('backups.secret.resticPassword')}
                  id="secret-restic"
                  required
                  help={t('backups.secret.resticPasswordHelp')}
                  error={errors['secret.resticPassword'] ?? null}
                >
                  <TextInput
                    id="secret-restic"
                    type="password"
                    autocomplete="new-password"
                    bind:value={draft.secret.resticPassword}
                  />
                </Field>
                {#each CREDENTIALS_BY_KIND[draft.kind] as field (field)}
                  <Field
                    label={t(`backups.secret.${field}`)}
                    id="secret-{field}"
                    required
                    error={errors[`secret.${field}`] ?? null}
                  >
                    <TextInput
                      id="secret-{field}"
                      type={field === 'username' || field === 'accessKeyId'
                        ? 'text'
                        : 'password'}
                      mono={field !== 'password' && field !== 'secretAccessKey'}
                      autocomplete="off"
                      bind:value={draft.secret[field]}
                    />
                  </Field>
                {/each}
              </div>
            {/if}
          {/if}
        {/snippet}
      </FormField>

      <FormField entity="backupTarget" key="enabled">
        {#snippet children()}
          {#if draft !== null}
            <Switch
              id="backupTarget-enabled"
              bind:checked={draft.enabled}
              label={t('backups.target.scheduled')}
            />
          {/if}
        {/snippet}
      </FormField>
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (draft = null)}
      >{t('common.cancel')}</Button
    >
    <Button
      variant="primary"
      loading={saving}
      op={draft?.id === null
        ? 'backups.targets.create'
        : 'backups.targets.update'}
      onclick={save}
    >
      {draft?.id === null ? t('backups.target.add') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .schedule {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
    gap: var(--space-4);
  }
  .schedule div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hint {
    margin-top: var(--space-4);
  }
  .target {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .target.disabled {
    background: var(--surface-2);
  }
  .target header {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .location {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    font-weight: 500;
    letter-spacing: 0;
    margin-top: 6px;
    overflow-wrap: anywhere;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .facts div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .run {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
  }
  .run.ok {
    color: var(--ok);
  }
  .run.failed {
    color: var(--danger);
  }
  .run.running {
    color: var(--info);
  }
  .run :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .target footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .id {
    margin-top: -8px;
  }
  .filter {
    padding: var(--space-3) var(--space-4) 0;
    max-width: 360px;
  }
  .table-pad {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
  .failed-cell {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
  }
  .err {
    overflow-wrap: anywhere;
  }
  .forget {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
  }
  @media (max-width: 520px) {
    .facts {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
