<!--
  Demo only: the identity provider's account chooser after "Sign in with …", simulated. Picking an
  account returns to the page signed in; an SSO sign-in skips the second step, since the
  provider's own MFA applies (§5.2).
-->
<script lang="ts">
  import Globe from '@lucide/svelte/icons/globe';

  import { t } from '#lib/i18n/index.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';

  type Account = { id: string; name: string; email: string };
  type Props = {
    open: boolean;
    provider: string;
    /** The provider's sign-in host, as the address bar would show it. */
    host: string;
    appName: string;
    accounts: Account[];
    onpick: (account: Account | null) => void;
  };
  let { open, provider, host, appName, accounts, onpick }: Props = $props();

  let element = $state<HTMLDialogElement>();
  let picked = $state<string | null>(null);
  const REDIRECT_MS = 700;

  $effect(() => {
    if (element === undefined) {
      return;
    }
    if (open && !element.open) {
      picked = null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  });

  function pick(account: Account): void {
    picked = account.id;
    setTimeout(() => onpick(account), REDIRECT_MS);
  }
</script>

<dialog
  bind:this={element}
  aria-label={t('auth.sso.pickTitle')}
  oncancel={event => {
    event.preventDefault();
    onpick(null);
  }}
>
  {#if open}
    <div class="sheet">
      <div class="url">
        <Globe size={13} /> <span class="truncate">{host}</span>
      </div>
      <div class="body">
        <span class="provider">{provider}</span>
        <h2>{t('auth.sso.pickTitle')}</h2>
        <p class="sub">{t('auth.sso.pickSubtitle', { app: appName })}</p>
        <ul>
          {#each accounts as account (account.id)}
            <li>
              <button
                type="button"
                disabled={picked !== null}
                class:picked={picked === account.id}
                onclick={() => pick(account)}
              >
                <Avatar name={account.name} size={34} />
                <span class="who">
                  <span class="name truncate">{account.name}</span>
                  <span class="email truncate">{account.email}</span>
                </span>
                {#if picked === account.id}<span
                    class="spinner"
                    aria-hidden="true"
                  ></span>{/if}
              </button>
            </li>
          {/each}
        </ul>
        <p class="demo">{t('auth.sso.demoNote')}</p>
        <button type="button" class="cancel" onclick={() => onpick(null)}
          >{t('common.cancel')}</button
        >
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog {
    border: 0;
    padding: 0;
    background: transparent;
    width: 400px;
    max-width: calc(100vw - 32px);
  }
  dialog::backdrop {
    background: var(--overlay);
    backdrop-filter: blur(3px);
  }
  .sheet {
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
  }
  .url {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--surface-3);
    border-bottom: 1px solid var(--line);
  }
  .body {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .provider {
    font-weight: 700;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  h2 {
    font-family: inherit;
    font-weight: 600;
    font-size: var(--text-xl);
    letter-spacing: 0;
  }
  .sub {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--line);
  }
  li button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 6px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  li button:hover:not(:disabled),
  li button.picked {
    background: var(--surface-3);
  }
  li button:disabled:not(.picked) {
    opacity: 0.5;
    cursor: default;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 600;
  }
  .email {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .demo {
    font-size: var(--text-xs);
    color: var(--text-faint);
    margin-top: var(--space-2);
  }
  .cancel {
    align-self: flex-end;
    border: 1px solid var(--line-strong);
    background: var(--surface);
    padding: 6px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--info);
    border-right-color: transparent;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
