<!--
  One message of a Mucki conversation, by kind: the person's text, Mucki's reply (with quick
  replies while it asks), tool, confirmation and progress cards, refusals, errors, Show me links,
  one-time values and audio.
-->
<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import { t } from '#lib/i18n/index.svelte.js';
  import AudioPlayer from '#lib/ui/AudioPlayer.svelte';
  import OneTimeValue from '#lib/ui/OneTimeValue.svelte';

  import ConfirmCard from './ConfirmCard.svelte';
  import Markdown from './Markdown.svelte';
  import ProgressCard from './ProgressCard.svelte';
  import ToolCard from './ToolCard.svelte';
  import type { Chip, Message } from './types';

  type Props = {
    message: Message;
    onchip: (chip: Chip) => void;
    ondecide: (id: string, confirmed: boolean) => void;
    onshow: (path: string, highlight?: string) => void;
    onnavigate: () => void;
  };

  let { message, onchip, ondecide, onshow, onnavigate }: Props = $props();
</script>

{#if message.kind === 'user'}
  <div class="user">{message.text}</div>
{:else if message.kind === 'assistant'}
  <div class="assistant" class:streaming={message.streaming}>
    <Markdown text={message.text} {onnavigate} />
  </div>
  {#if message.options && message.options.length > 0 && !message.streaming}
    <div class="options">
      {#each message.options as chip (chip.label)}
        <button type="button" class="chip" onclick={() => onchip(chip)}
          >{chip.label}</button
        >
      {/each}
    </div>
  {/if}
{:else if message.kind === 'tool'}
  <ToolCard {message} />
{:else if message.kind === 'confirm'}
  <ConfirmCard
    {message}
    ondecide={confirmed => ondecide(message.id, confirmed)}
  />
{:else if message.kind === 'progress'}
  <ProgressCard {message} />
{:else if message.kind === 'refusal'}
  <div class="notice refusal" role="note">
    <ShieldAlert size={17} />
    <div>
      <strong>{t('mucki.refusal.title')}</strong>
      <Markdown text={message.text} {onnavigate} />
    </div>
  </div>
{:else if message.kind === 'error'}
  <div class="notice error" role="alert">
    <TriangleAlert size={17} />
    <div>
      <strong>{t('mucki.error.title')}</strong>
      <Markdown text={message.text} {onnavigate} />
    </div>
  </div>
{:else if message.kind === 'link'}
  <button
    type="button"
    class="show-me"
    aria-label={t('mucki.showMeLabel', { label: message.label })}
    onclick={() => onshow(message.path, message.highlight)}
  >
    <span class="show-label">{t('mucki.showMe')}</span>
    <span class="show-target">{message.label}</span>
    <ArrowUpRight size={16} />
  </button>
{:else if message.kind === 'secret'}
  <div class="card">
    <OneTimeValue
      value={message.value}
      label={`${message.label} · ${t('mucki.secret.label')}`}
      note={message.note}
    />
  </div>
{:else if message.kind === 'audio'}
  <div class="card audio">
    <strong>{message.title}</strong>
    <AudioPlayer
      clip={message.clip}
      durationS={message.durationS}
      stereo={message.stereo === true}
    />
  </div>
{/if}

<style>
  .user {
    align-self: flex-end;
    max-width: 88%;
    background: var(--mucki);
    color: var(--on-mucki);
    padding: 9px 13px;
    border-radius: var(--radius-md) var(--radius-md) 4px var(--radius-md);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-weight: 500;
    box-shadow: var(--shadow-sm);
  }
  .assistant {
    background: var(--surface);
    border: 1px solid var(--line);
    padding: 10px 13px;
    border-radius: 4px var(--radius-md) var(--radius-md) var(--radius-md);
    line-height: 1.5;
  }
  .streaming :global(.md > :last-child)::after {
    content: '';
    display: inline-block;
    width: 7px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -2px;
    border-radius: 2px;
    background: var(--mucki);
    animation: caret 0.9s steps(2) infinite;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border: 1.5px solid var(--mucki);
    background: var(--surface);
    color: var(--mucki-text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 700;
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    cursor: pointer;
    text-align: left;
    transition:
      background 0.15s var(--ease),
      transform 0.15s var(--ease);
  }
  .chip:hover {
    background: var(--mucki-soft);
  }
  .chip:active {
    transform: scale(0.97);
  }
  .notice {
    display: flex;
    gap: 10px;
    padding: 10px 13px;
    border-radius: var(--radius-md);
    line-height: 1.5;
  }
  .notice > :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .notice strong {
    display: block;
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }
  .refusal {
    background: var(--danger-soft);
    color: var(--text);
  }
  .refusal > :global(svg),
  .refusal strong {
    color: var(--danger);
  }
  .error {
    background: var(--warn-soft);
  }
  .error > :global(svg),
  .error strong {
    color: var(--warn);
  }
  .show-me {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    border: 0;
    background: var(--mucki-soft);
    color: var(--mucki-text);
    font: inherit;
    padding: 7px 12px 7px 14px;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: background 0.15s var(--ease);
  }
  .show-me:hover {
    background: color-mix(in srgb, var(--mucki) 22%, var(--mucki-soft));
  }
  .show-label {
    font-weight: 800;
    font-size: var(--text-sm);
  }
  .show-target {
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: 12px 14px;
  }
  .audio {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .audio strong {
    font-size: var(--text-sm);
  }
  @keyframes caret {
    50% {
      opacity: 0;
    }
  }
</style>
