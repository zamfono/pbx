<!--
  Mucki's panel: docked right of the page on wide screens (resizable by its left edge, 320–640 px),
  a right sheet over the page below 1100 px, and a full-screen sheet above the tab bar on phones.
  One conversation per persona; Mucki acts as the signed-in person.
-->
<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
  import X from '@lucide/svelte/icons/x';
  import { onMount, tick } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';
  import { go, router } from '#lib/state/router.svelte.js';
  import {
    currentActor,
    savePrefs,
    session
  } from '#lib/state/session.svelte.js';
  import IconButton from '#lib/ui/IconButton.svelte';

  import Markdown from './Markdown.svelte';
  import MessageView from './MessageView.svelte';
  import { mucki } from './mucki.svelte';
  import MuckiAvatar from './MuckiAvatar.svelte';
  import { starterChips, suggestionChips } from './scenarios';
  import type { Chip, Message } from './types';

  const MIN_WIDTH = 320;
  const MAX_WIDTH = 640;
  const DOCKED = '(min-width: 1100px)';
  const READ_OPERATION = /\.(list|get|info|getForwarding)$/u;

  let draft = $state('');
  let list = $state<HTMLDivElement>();
  let textarea = $state<HTMLTextAreaElement>();
  let docked = $state(true);
  let resizing = $state(false);
  let stick = true;

  const persona = $derived(session.persona);
  const actor = $derived(currentActor());
  const messages = $derived<Message[]>(mucki.histories[persona]);
  const busy = $derived(mucki.busyFor === persona);
  const answering = $derived(busy && mucki.awaitingAnswer(persona));
  const canUndo = $derived(
    messages.some(
      message =>
        message.kind === 'tool' &&
        message.state === 'done' &&
        !READ_OPERATION.test(message.operation)
    )
  );
  const chips = $derived(
    messages.length === 0
      ? []
      : suggestionChips(actor.role, router.route.path, { canUndo, max: 3 })
  );
  const welcomeName = $derived(
    actor.name.replace(/^Dr\.\s*/u, '').split(/\s+/u)[0] ?? actor.name
  );
  /** Changes whenever the list grows or the last message streams. */
  const scrollKey = $derived.by(() => {
    const last = messages.at(-1);
    const size =
      last?.kind === 'assistant'
        ? last.text.length
        : last?.kind === 'progress'
          ? last.items.filter(item => item.state !== 'pending').length
          : 0;
    return `${messages.length}:${size}:${mucki.thinking}:${last?.kind === 'tool' ? last.state : ''}`;
  });

  onMount(() => {
    const dockedQuery = window.matchMedia(DOCKED);
    docked = dockedQuery.matches;
    // A narrow screen starts with the page, not with the sheet over it.
    if (!docked && session.muckiOpen) {
      session.muckiOpen = false;
    }
    const onChange = (event: MediaQueryListEvent): void => {
      docked = event.matches;
    };
    dockedQuery.addEventListener('change', onChange);
    return () => dockedQuery.removeEventListener('change', onChange);
  });

  // A turn in flight belongs to the persona it started for.
  $effect(() => {
    mucki.follow(persona);
  });

  $effect(() => {
    void scrollKey;
    if (!session.muckiOpen) {
      return;
    }
    if (!stick) {
      return;
    }
    void tick().then(() =>
      requestAnimationFrame(() => {
        if (list !== undefined) {
          list.scrollTop = list.scrollHeight;
        }
      })
    );
  });

  /** Follows new messages while the person is at the bottom; scrolling up stops that. */
  function onscroll(): void {
    if (list !== undefined) {
      stick = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
    }
  }

  function close(): void {
    session.muckiOpen = false;
    savePrefs();
  }

  function send(text: string): void {
    if (text.trim() === '' || (busy && !answering)) {
      return;
    }
    stick = true;
    void mucki.send(text);
  }

  function submit(): void {
    const text = draft;
    if (text.trim() === '' || (busy && !answering)) {
      return;
    }
    draft = '';
    void tick().then(resize);
    send(text);
  }

  function onchip(chip: Chip): void {
    const text = chip.prompt ?? chip.label;
    if (chip.paste === true) {
      // A chip that pastes puts its text into the composer, for the person to send.
      draft = text;
      void tick().then(() => {
        textarea?.focus();
        resize();
      });
    } else {
      send(text);
    }
  }

  /** Leaves the sheet after a navigation on narrow screens, so the page shows. */
  function afterNavigate(): void {
    if (!docked) {
      session.muckiOpen = false;
    }
  }

  function show(path: string, highlight?: string): void {
    go(path, highlight === undefined ? {} : { highlight });
    afterNavigate();
  }

  function resize(): void {
    if (textarea === undefined) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function startResize(event: PointerEvent): void {
    if (!docked) {
      return;
    }
    event.preventDefault();
    resizing = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent): void {
    if (!resizing) {
      return;
    }
    session.muckiWidth = Math.round(
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, window.innerWidth - event.clientX)
      )
    );
  }

  function endResize(): void {
    if (resizing) {
      resizing = false;
      savePrefs();
    }
  }

  function resizeByKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? step : -step;
      session.muckiWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, session.muckiWidth + delta)
      );
      savePrefs();
    }
  }

  function onWindowKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && session.muckiOpen && !docked) {
      close();
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if session.muckiOpen}
  {#if !docked}
    <button
      type="button"
      class="scrim"
      aria-label={t('mucki.close')}
      tabindex="-1"
      onclick={close}
    ></button>
  {/if}
  <aside
    class="mucki"
    class:docked
    class:resizing
    aria-label={t('mucki.panel')}
  >
    {#if docked}
      <button
        type="button"
        class="handle"
        aria-label={t('mucki.resize')}
        title={t('mucki.resize')}
        onpointerdown={startResize}
        onpointermove={moveResize}
        onpointerup={endResize}
        onpointercancel={endResize}
        onkeydown={resizeByKey}
      ></button>
    {/if}

    <header>
      <MuckiAvatar size={36} {busy} />
      <div class="who">
        <strong>{t('mucki.title')}</strong>
        <span
          >{t('mucki.actsAs', {
            name: actor.name,
            role: t(`role.${actor.role}`)
          })}</span
        >
      </div>
      <IconButton
        icon={MessageSquarePlus}
        label={t('mucki.newConversation')}
        size="sm"
        disabled={messages.length === 0}
        onclick={() => mucki.newConversation(persona)}
      />
      <IconButton icon={X} label={t('mucki.close')} size="sm" onclick={close} />
    </header>

    <div class="messages" bind:this={list} aria-live="polite" {onscroll}>
      {#if messages.length === 0}
        <div class="welcome">
          <MuckiAvatar size={56} />
          <div class="bubble">
            <Markdown
              text={t(`mucki.welcome.${actor.role}`, { name: welcomeName })}
              onnavigate={afterNavigate}
            />
          </div>
          <div class="starters">
            {#each starterChips(actor.role) as chip (chip.label)}
              <button type="button" class="starter" onclick={() => onchip(chip)}
                >{chip.label}</button
              >
            {/each}
          </div>
        </div>
      {:else}
        {#each messages as message, index (message.id)}
          {@const groupStart =
            message.kind !== 'user' &&
            (index === 0 || messages[index - 1]?.kind === 'user')}
          <div class="row" class:mine={message.kind === 'user'}>
            {#if message.kind !== 'user'}
              <span class="gutter">
                {#if groupStart}<MuckiAvatar size={26} />{/if}
              </span>
            {/if}
            <div class="content">
              <MessageView
                {message}
                {onchip}
                ondecide={(id, confirmed) => mucki.decide(id, confirmed)}
                onshow={show}
                onnavigate={afterNavigate}
              />
            </div>
          </div>
        {/each}
        {#if busy && mucki.thinking}
          <div class="row">
            <span class="gutter"></span>
            <div class="thinking" role="status">
              <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
              {t('mucki.thinking')}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <footer>
      {#if chips.length > 0 && !busy}
        <div class="chips" aria-label={t('mucki.suggestions')}>
          {#each chips as chip (chip.label)}
            <button
              type="button"
              class="suggestion"
              onclick={() => onchip(chip)}>{chip.label}</button
            >
          {/each}
        </div>
      {/if}
      <form
        class="composer"
        onsubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          bind:this={textarea}
          bind:value={draft}
          rows="1"
          placeholder={t('mucki.placeholder')}
          aria-label={t('mucki.placeholder')}
          {onkeydown}
          oninput={resize}></textarea>
        <button
          type="submit"
          class="send"
          aria-label={t('mucki.send')}
          title={t('mucki.send')}
          disabled={draft.trim() === '' || (busy && !answering)}
        >
          <ArrowUp size={18} />
        </button>
      </form>
      <p class="hint">{t('mucki.disclaimer')}</p>
    </footer>
  </aside>
{/if}

<style>
  .mucki {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--mucki-bg);
    border-left: 1px solid var(--line);
    min-height: 0;
    font-size: var(--text-md);
  }
  .mucki.docked {
    flex: none;
    width: var(--mucki-width);
  }
  .mucki.resizing {
    user-select: none;
  }
  .handle {
    position: absolute;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    z-index: 2;
  }
  .handle::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: transparent;
    transition: background 0.15s var(--ease);
  }
  .handle:hover::after,
  .handle:focus-visible::after,
  .resizing .handle::after {
    background: var(--mucki);
  }
  .handle:focus-visible {
    outline: none;
  }

  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 12px 12px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .who strong {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 800;
  }
  .who span {
    font-size: var(--text-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .row.mine {
    justify-content: flex-end;
  }
  .gutter {
    width: 26px;
    flex: none;
  }
  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mine .content {
    align-items: flex-end;
  }

  .welcome {
    margin: auto 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
    padding: 12px 6px;
  }
  .welcome .bubble {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    line-height: 1.5;
    text-align: left;
  }
  .starters {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .starter {
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: left;
    padding: 9px 13px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .starter:hover {
    border-color: var(--mucki);
    background: var(--mucki-soft);
  }

  .thinking {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-style: italic;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  .dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--mucki);
    animation: bounce 1s ease-in-out infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.15s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.3s;
  }

  footer {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--line);
    background: var(--mucki-bg);
  }
  .chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 1px;
  }
  .suggestion {
    flex: none;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--line-strong);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 5px 11px;
    border-radius: var(--radius-pill);
    cursor: pointer;
  }
  .suggestion:hover {
    border-color: var(--mucki);
    color: var(--mucki-text);
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--surface);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-md);
    padding: 6px 6px 6px 12px;
    transition: border-color 0.15s var(--ease);
  }
  .composer:focus-within {
    border-color: var(--mucki);
  }
  textarea {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: 1.45;
    padding: 6px 0;
    max-height: 180px;
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  .send {
    display: grid;
    place-items: center;
    flex: none;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: var(--mucki);
    color: var(--on-mucki);
    cursor: pointer;
    transition:
      background 0.15s var(--ease),
      opacity 0.15s var(--ease);
  }
  .send:hover:not(:disabled) {
    background: var(--mucki-hover);
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .hint {
    margin: 0;
    font-size: 10.5px;
    color: var(--text-faint);
    text-align: center;
  }

  .scrim {
    display: none;
  }

  @media (max-width: 1099px) {
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 74;
      border: 0;
      padding: 0;
      background: var(--overlay);
      animation: fade 0.2s var(--ease);
    }
    .mucki {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 75;
      width: min(var(--mucki-width), calc(100vw - 48px));
      box-shadow: var(--shadow-lg);
      animation: slide 0.25s var(--ease);
    }
  }
  @media (max-width: 760px) {
    .scrim {
      display: none;
    }
    .mucki {
      left: 0;
      width: auto;
      bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom));
      border-left: 0;
      box-shadow: none;
      animation: rise 0.25s var(--ease);
    }
    .messages {
      padding: 14px 12px 8px;
    }
  }

  @keyframes bounce {
    0%,
    80%,
    100% {
      transform: translateY(0);
      opacity: 0.5;
    }
    40% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      transform: translateY(16px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dots i,
    .mucki,
    .scrim {
      animation: none;
    }
  }
</style>
