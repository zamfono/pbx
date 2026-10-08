<!--
  One trunk in the trunk list: status, how it signs in and connects, its hosts and capacity, and
  re-registration for a registration trunk.
-->
<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Siren from '@lucide/svelte/icons/siren';

  import { run } from '#lib/actions.svelte.js';
  import type { Trunk } from '#lib/api/types.js';
  import { formatRelative, formatTime, t } from '#lib/i18n/index.svelte.js';
  import { href, router } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';

  import { hostLabel } from './format';
  import TrunkStatus from './TrunkStatus.svelte';

  let { trunk, routes }: { trunk: Trunk; routes: number } = $props();

  let busy = $state(false);

  async function reregister(): Promise<void> {
    busy = true;
    await run(
      'trunks.reregister',
      { id: trunk.id },
      { success: 'trunks.reregistering', successParams: { name: trunk.name } }
    );
    setTimeout(() => (busy = false), 1800);
  }
</script>

<article
  class="trunk"
  class:flash={router.highlight === trunk.id}
  class:down={trunk.status === 'unreachable'}
>
  <header>
    <div class="titles">
      <h3><a href={href(`/trunks/${trunk.id}`)}>{trunk.name}</a></h3>
      <div class="badges">
        {#if trunk.emergency}<Badge tone="danger" icon={Siren}
            >{t('trunks.emergencyBadge')}</Badge
          >{/if}
        <Badge>{t(`trunks.authMode.${trunk.authMode}`)}</Badge>
        <Badge
          tone={trunk.transport === 'tls' ? 'ok' : 'neutral'}
          icon={trunk.transport === 'tls' ? Lock : undefined}
        >
          {trunk.transport.toUpperCase()}{trunk.srtp ? ' · SRTP' : ''}
        </Badge>
      </div>
    </div>
    <TrunkStatus {trunk} since={false} />
  </header>

  <ul class="hosts">
    {#each trunk.hosts as host, index (index)}
      <li>
        <span class="mono truncate">{hostLabel(host)}</span>
        {#if host.direction !== 'both'}<span class="direction"
            >{t(`trunks.direction.${host.direction}`)}</span
          >{/if}
      </li>
    {/each}
  </ul>

  <dl class="facts">
    <div>
      <dt>{t('trunks.statusSince')}</dt>
      <dd>
        {trunk.statusChangedAt ? formatRelative(trunk.statusChangedAt) : '—'}
      </dd>
    </div>
    {#if trunk.authMode === 'registration'}
      <div>
        <dt>{t('trunks.lastRegistered')}</dt>
        <dd>{trunk.registeredAt ? formatTime(trunk.registeredAt) : '—'}</dd>
      </div>
    {/if}
    <div>
      <dt>{t('field.trunk.maxChannels')}</dt>
      <dd>
        {trunk.maxChannels === null
          ? t('common.unlimited')
          : t('trunks.channels', { count: trunk.maxChannels })}
      </dd>
    </div>
    <div>
      <dt>{t('trunks.usedBy')}</dt>
      <dd>{t('trunks.routeCount', { count: routes })}</dd>
    </div>
  </dl>

  <footer>
    {#if isExpert()}<code class="xs faint truncate">{trunk.id}</code>{/if}
    <span class="grow"></span>
    {#if trunk.authMode === 'registration'}
      <Button
        size="sm"
        variant="soft"
        icon={RefreshCw}
        loading={busy}
        op="trunks.reregister"
        onclick={reregister}>{t('trunks.reregister')}</Button
      >
    {/if}
    <Button size="sm" variant="secondary" href={href(`/trunks/${trunk.id}`)}
      >{t('trunks.open')}</Button
    >
  </footer>
</article>

<style>
  .trunk {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }
  .trunk.down {
    border-color: var(--danger);
  }
  .trunk.flash {
    animation: flash 2.4s var(--ease);
  }
  @keyframes flash {
    0%,
    40% {
      box-shadow: 0 0 0 3px var(--lime);
    }
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  h3 {
    font-size: var(--text-xl);
    font-weight: 800;
  }
  h3 a {
    color: var(--text);
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hosts {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-sm);
  }
  .hosts li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .direction {
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex: none;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: var(--space-2) var(--space-3);
    margin: 0;
  }
  dt {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  footer code {
    max-width: 50%;
  }
</style>
