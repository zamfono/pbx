<!--
  The landing after a sign-in with no client to return to: one line confirming it, the command that
  connects an MCP client (§10.5), and the way to the security page.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';

  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go, href } from '#lib/state/router.svelte.js';
  import { session, signIn } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import OneTimeValue from '#lib/ui/OneTimeValue.svelte';

  const command = $derived(
    `claude mcp add --transport http zamfono https://${store.db.system.stack.domain}/mcp`
  );
  const company = $derived(store.db.settings.companyName);

  /** The demo signs the persona in on the way out, as the real sign-in already did. */
  function enter(path: string): void {
    if (!session.signedIn) {
      signIn(session.persona);
    }
    go(path);
  }
</script>

<span class="icon" aria-hidden="true"><CircleCheck size={28} /></span>
<header class="head">
  <h1>{t('auth.done.title')}</h1>
  <p class="sub">{t('auth.done.message', { company })}</p>
</header>
<OneTimeValue value={command} label={t('auth.done.mcpHint')} />
<div class="buttons">
  <Button
    variant="primary"
    size="lg"
    iconRight={ArrowRight}
    onclick={() => enter('/overview')}>{t('auth.done.toApp')}</Button
  >
  <a
    class="security"
    href={href('/me/security')}
    onclick={event => {
      event.preventDefault();
      enter('/me/security');
    }}><ShieldCheck size={16} /> {t('auth.done.security')}</a
  >
</div>

<style>
  .icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 16px;
    background: var(--lime);
    color: var(--on-lime);
    transform: rotate(-4deg);
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sub {
    color: var(--text-muted);
  }
  .buttons {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
  .security {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: var(--text-sm);
  }
</style>
