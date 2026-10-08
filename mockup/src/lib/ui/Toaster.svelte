<!--
  The toast stack: results of actions, with Undo and the references a refusal names.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Info from '@lucide/svelte/icons/info';
  import X from '@lucide/svelte/icons/x';

  import { t } from '#lib/i18n/index.svelte.js';
  import { refHref } from '#lib/links.js';
  import { dismissToast, ui } from '#lib/state/ui.svelte.js';
</script>

<div class="toaster" aria-live="polite">
  {#each ui.toasts as item (item.id)}
    <div
      class="toast {item.tone}"
      role={item.tone === 'error' ? 'alert' : 'status'}
    >
      <span class="icon">
        {#if item.tone === 'success'}<CircleCheck
            size={18}
          />{:else if item.tone === 'error'}<CircleAlert
            size={18}
          />{:else}<Info size={18} />{/if}
      </span>
      <div class="content">
        <p class="title">{item.title}</p>
        {#if item.body}<p class="text">{item.body}</p>{/if}
        {#if item.refs.length > 0}
          <ul class="refs">
            {#each item.refs as ref (ref.kind + ref.id)}
              {@const link = refHref(ref)}
              <li>
                {#if link}<a href={link} onclick={() => dismissToast(item.id)}
                    >{ref.label}</a
                  >{:else}{ref.label}{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      {#if item.action}
        {@const action = item.action}
        <button
          type="button"
          class="action"
          onclick={() => {
            action.run();
            dismissToast(item.id);
          }}>{action.label}</button
        >
      {/if}
      <button
        type="button"
        class="close"
        aria-label={t('common.close')}
        onclick={() => dismissToast(item.id)}><X size={15} /></button
      >
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(460px, calc(100vw - 24px));
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 12px 12px 14px;
    background: var(--text);
    color: var(--bg);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    animation: up 0.2s var(--ease);
  }
  @keyframes up {
    from {
      transform: translateY(10px);
      opacity: 0;
    }
  }
  .icon {
    margin-top: 1px;
  }
  .success .icon {
    color: var(--lime);
  }
  .error .icon {
    color: #ff8fa3;
  }
  .content {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .text {
    font-size: var(--text-sm);
    opacity: 0.8;
  }
  .refs {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: var(--text-sm);
  }
  .refs a {
    color: var(--lime);
  }
  .action {
    border: 0;
    background: var(--lime);
    color: var(--on-lime);
    font-weight: 800;
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    cursor: pointer;
    font-size: var(--text-sm);
  }
  .close {
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;
    padding: 4px;
  }
  @media (max-width: 760px) {
    .toaster {
      bottom: calc(var(--tabbar-height) + 16px);
    }
  }
</style>
