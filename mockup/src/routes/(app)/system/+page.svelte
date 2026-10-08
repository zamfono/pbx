<!--
  System & updates (`system.info`, `system.checkUpdate`, `system.update`, §6.3, §7): the versions
  running, the latest release and how the last update went, the update itself (owners, after a
  backup within the hour), and the health of mail, Ringotel and the configuration render.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Cloud from '@lucide/svelte/icons/cloud';
  import DatabaseBackup from '@lucide/svelte/icons/database-backup';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import FileWarning from '@lucide/svelte/icons/file-warning';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Mail from '@lucide/svelte/icons/mail';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Rocket from '@lucide/svelte/icons/rocket';
  import Server from '@lucide/svelte/icons/server';
  import Wrench from '@lucide/svelte/icons/wrench';

  import { read, run } from '#lib/actions.svelte.js';
  import type { BackupRunWire } from '#lib/api/ops/areas/backups.js';
  import { VERSION_PATTERN } from '#lib/api/ops/areas/system.js';
  import { allowed } from '#lib/api/ops/core.js';
  import type { SystemInfo } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import InfoList from '#lib/components/system/InfoList.svelte';
  import {
    formatDate,
    formatDateTime,
    formatRelative,
    t
  } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const HOUR_MS = 3_600_000;

  const info = $derived(read<SystemInfo | null>('system.info', {}, null));
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
  let now = $state(demoNow());
  $effect(() => {
    const timer = setInterval(() => (now = demoNow()), 15_000);
    return () => clearInterval(timer);
  });
  const backupFresh = $derived(
    lastGood !== null && now - new Date(lastGood).getTime() <= HOUR_MS
  );
  const backupRunning = $derived(runs.some(each => each.status === 'running'));
  const canUpdate = $derived(allowed('system.update', {}, currentActor()));
  const update = $derived(info?.update ?? null);
  const last = $derived(update?.last ?? null);
  let checking = $state(false);
  let version = $state('');

  async function check(): Promise<void> {
    checking = true;
    const result = await run<SystemInfo['update']>('system.checkUpdate', {});
    checking = false;
    if (result.ok) {
      toast({
        tone: 'info',
        title:
          result.value.updatable && result.value.latest
            ? t('system.check.available', {
                version: result.value.latest.version
              })
            : t('system.check.current'),
        operation: 'system.checkUpdate'
      });
    }
  }

  async function startUpdate(): Promise<void> {
    const input =
      isExpert() && VERSION_PATTERN.test(version.trim())
        ? { version: version.trim() }
        : {};
    await run('system.update', input, { success: 'system.update.started' });
  }

  const skippedColumns = $derived([
    { key: 'type', label: t('system.skipped.type'), primary: true },
    { key: 'id', label: t('common.id') },
    { key: 'field', label: t('system.skipped.field') }
  ]);
</script>

<PageHeader title={t('nav.system')} subtitle={t('system.subtitle')}>
  {#snippet actions()}
    <Button
      icon={RefreshCw}
      op="system.checkUpdate"
      loading={checking}
      onclick={check}>{t('system.check.now')}</Button
    >
  {/snippet}
</PageHeader>

{#if info !== null && update !== null && last !== null}
  {#if info.maintenance}
    <div class="banner maintenance" role="status">
      <LoaderCircle size={20} class="spin" />
      <div>
        <strong
          >{t('system.maintenance.title', { version: last.to ?? '' })}</strong
        >
        <span class="small">{t('system.maintenance.body')}</span>
      </div>
    </div>
  {/if}

  <div class="stack" style="--gap: 24px">
    <div class="grid-2">
      <Card title={t('system.update.title')} icon={Rocket}>
        {#if update.latest !== null && update.updatable && !info.maintenance}
          <div class="release">
            <span class="version">{update.latest.version}</span>
            <span class="small"
              >{t('system.update.available', {
                current: update.current ?? '—',
                date: formatDate(update.latest.publishedAt)
              })}</span
            >
            <a
              class="notes small"
              href={update.latest.url}
              target="_blank"
              rel="noreferrer"
              >{t('system.update.notes')}<ExternalLink size={13} /></a
            >
          </div>
          {#if canUpdate}
            <div class="update-box">
              <div class="rule" class:ok={backupFresh}>
                {#if backupFresh}
                  <CircleCheck size={16} />
                  <span
                    >{t('system.update.backupOk', {
                      at: formatRelative(lastGood)
                    })}</span
                  >
                {:else}
                  <DatabaseBackup size={16} />
                  <span
                    >{backupRunning
                      ? t('system.update.backupRunning')
                      : t('system.update.backupNeeded', {
                          at:
                            lastGood === null
                              ? t('backups.schedule.never')
                              : formatRelative(lastGood)
                        })}</span
                  >
                {/if}
              </div>
              {#if isExpert()}
                <FormField entity="systemUpdate" key="version">
                  {#snippet children()}
                    <TextInput
                      id="systemUpdate-version"
                      mono
                      placeholder={update?.latest?.version ?? '0.0.0'}
                      bind:value={version}
                    />
                  {/snippet}
                </FormField>
              {/if}
              <div class="row">
                <Button
                  variant="lime"
                  icon={Rocket}
                  op="system.update"
                  onclick={startUpdate}>{t('system.update.now')}</Button
                >
                {#if !backupFresh}
                  <Button variant="ghost" icon={DatabaseBackup} href="#/backups"
                    >{t('system.update.toBackups')}</Button
                  >
                {/if}
              </div>
            </div>
          {:else}
            <p class="small owner-note">{t('system.update.ownerOnly')}</p>
          {/if}
        {:else if update.latest !== null && update.breaking}
          <p class="small">
            {t('system.update.breaking', { version: update.latest.version })}
          </p>
        {:else if !info.maintenance}
          <div class="current">
            <CircleCheck size={20} />
            <span
              >{t('system.update.upToDate', {
                version: update.current ?? '—'
              })}</span
            >
          </div>
        {/if}
        <div class="last">
          <span class="xs muted strong">{t('system.update.last')}</span>
          {#if last.state === 'idle'}
            <span class="small">{t('system.update.never')}</span>
          {:else}
            <span class="small">
              {#if last.state === 'running'}<Badge
                  tone="info"
                  icon={LoaderCircle}>{t('system.update.state.running')}</Badge
                >
              {:else if last.state === 'succeeded'}<Badge
                  tone="ok"
                  icon={CircleCheck}>{t('system.update.state.succeeded')}</Badge
                >
              {:else}<Badge tone="danger" icon={CircleAlert}
                  >{t('system.update.state.failed')}</Badge
                >{/if}
              {t('system.update.lastLine', {
                from: last.from ?? '—',
                to: last.to ?? '—'
              })}
            </span>
            <span class="xs muted">
              {t(`system.update.trigger.${last.trigger ?? 'host'}`, {
                by: last.by ?? ''
              })} · {formatDateTime(last.finishedAt ?? last.startedAt)}
            </span>
          {/if}
        </div>
      </Card>

      <Card title={t('system.versions.title')} icon={Server}>
        <InfoList
          items={[
            {
              label: t('system.versions.api'),
              value: info.api.display,
              mono: true
            },
            {
              label: t('system.versions.core'),
              value: info.core?.display ?? t('system.versions.coreDown'),
              mono: true
            },
            {
              label: t('system.versions.apiStarted'),
              value: formatDateTime(info.api.startedAt)
            },
            {
              label: t('system.versions.asteriskStarted'),
              value: formatDateTime(info.core?.asteriskStartedAt)
            },
            {
              label: t('system.stack.domain'),
              value: info.stack.domain,
              mono: true
            },
            {
              label: t('system.stack.ipv4'),
              value: info.stack.ipv4,
              mono: true
            }
          ]}
        />
      </Card>
    </div>

    <div class="grid-3">
      <Card title={t('system.auto.title')} icon={RefreshCw}>
        <div class="status-line">
          <Badge tone={info.autoUpdate.enabled ? 'ok' : 'neutral'} dot
            >{info.autoUpdate.enabled ? t('common.on') : t('common.off')}</Badge
          >
          <span class="small muted"
            >{info.autoUpdate.enabled
              ? t('system.auto.onBody')
              : t('system.auto.offBody')}</span
          >
        </div>
        {#if info.autoUpdate.failed !== null}
          <p class="small problem">
            {t('system.auto.failed', {
              attempts: info.autoUpdate.failed.attempts,
              error: info.autoUpdate.failed.error
            })}
          </p>
        {/if}
        <a class="more small" href="#/settings/updates"
          >{t('system.goSettings')}<ArrowRight size={13} /></a
        >
      </Card>

      <Card title={t('system.mail.title')} icon={Mail}>
        <div class="status-line">
          {#if info.mail === null}
            <Badge tone="neutral">{t('system.mail.none')}</Badge>
          {:else if info.mail.ok}
            <Badge tone="ok" dot>{t('system.mail.ok')}</Badge>
            <span class="small muted">{formatRelative(info.mail.at)}</span>
          {:else}
            <Badge tone="danger" dot
              >{t(
                `system.relayError.${info.mail.error?.class ?? 'unreachable'}`
              )}</Badge
            >
            <span class="small muted">{info.mail.error?.message ?? ''}</span>
          {/if}
        </div>
        <a class="more small" href="#/settings/mail"
          >{t('system.goSettings')}<ArrowRight size={13} /></a
        >
      </Card>

      <Card title={t('system.ringotel.title')} icon={Cloud}>
        <div class="status-line">
          {#if info.ringotel.profilePending || info.ringotel.rosterPending}
            <Badge tone="info" icon={LoaderCircle}
              >{t('system.ringotel.pending')}</Badge
            >
            <span class="small muted">
              {[
                info.ringotel.profilePending
                  ? t('system.ringotel.profile')
                  : null,
                info.ringotel.rosterPending ? t('system.ringotel.roster') : null
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          {:else}
            <Badge tone="ok" dot>{t('system.ringotel.inSync')}</Badge>
          {/if}
        </div>
        <p class="xs muted">{t('system.ringotel.body')}</p>
      </Card>
    </div>

    {#if isExpert()}
      <Card
        title={t('system.skipped.title')}
        description={t('system.skipped.body')}
        icon={FileWarning}
        expert
      >
        {#if info.skippedConfigRows.length === 0}
          <div class="status-line">
            <Badge tone="ok" icon={Wrench}>{t('system.skipped.none')}</Badge>
          </div>
        {:else}
          <DataTable
            rows={info.skippedConfigRows}
            columns={skippedColumns}
            rowKey={row => `${row.type}:${row.id}:${row.field}`}
            dense
          >
            {#snippet cell(row, key)}
              {#if key === 'type'}<code>{row.type}</code
                >{:else if key === 'id'}<code class="xs">{row.id}</code
                >{:else}<code class="xs">{row.field}</code>{/if}
            {/snippet}
          </DataTable>
        {/if}
      </Card>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-4) var(--space-5);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-5);
  }
  .banner div {
    display: flex;
    flex-direction: column;
  }
  .maintenance {
    background: var(--warn-soft);
    color: var(--text);
  }
  .maintenance :global(svg) {
    color: var(--warn);
    flex: none;
  }
  :global(.spin) {
    animation: system-spin 1s linear infinite;
  }
  @keyframes system-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .release {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
  }
  .release .version {
    color: var(--primary);
  }
  .version {
    font-family: var(--font-display);
    font-size: var(--text-3xl);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .notes {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    font-weight: 700;
  }
  .update-box {
    margin-top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .rule {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
  }
  .rule.ok {
    background: var(--ok-soft);
  }
  .rule :global(svg) {
    color: var(--warn);
  }
  .rule.ok :global(svg) {
    color: var(--ok);
  }
  .rule :global(svg) {
    flex: none;
  }
  .owner-note {
    margin-top: var(--space-3);
    color: var(--text-muted);
  }
  .current {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    font-weight: 600;
  }
  .current :global(svg) {
    color: var(--ok);
  }
  .last {
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .last .small {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .status-line {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .problem {
    color: var(--danger);
    margin-bottom: var(--space-3);
  }
  .more {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    font-weight: 700;
  }
</style>
