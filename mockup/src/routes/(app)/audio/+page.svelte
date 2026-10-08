<!--
  The audio library (`audio.*`, admin): greetings, hold music, mailbox greetings and
  announcements, grouped by kind, with where each is used. Uploads take a WAV or MP3 file of at
  most 50 MB, which the phone system converts for playback; afterwards only the label changes.
  The demo has no sound files for its sample assets; a file uploaded in this session plays.
-->
<script module lang="ts">
  import { SvelteMap } from 'svelte/reactivity';

  /** Object URLs of the files uploaded in this browser session, by asset id. */
  const sessionClips = new SvelteMap<string, string>();
</script>

<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import FileAudio from '@lucide/svelte/icons/file-audio';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import Music from '@lucide/svelte/icons/music';
  import Pause from '@lucide/svelte/icons/pause';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Play from '@lucide/svelte/icons/play';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Voicemail from '@lucide/svelte/icons/voicemail';
  import Waves from '@lucide/svelte/icons/waves';
  import type { Component } from 'svelte';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import {
    audioReferences,
    MAX_UPLOAD_BYTES,
    type AudioUpload
  } from '#lib/api/ops/areas/audio.js';
  import { store } from '#lib/api/store.svelte.js';
  import {
    AUDIO_KINDS,
    type AudioAsset,
    type AudioKind
  } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import {
    formatBytes,
    formatDate,
    formatDuration,
    t
  } from '#lib/i18n/index.svelte.js';
  import { refHref } from '#lib/links.js';
  import { highlight, router } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Dialog from '#lib/ui/Dialog.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const ICONS: Record<AudioKind, Component> = {
    greeting: Waves,
    moh: Music,
    vmGreeting: Voicemail,
    announcement: Megaphone
  };
  const BARS = 36;
  const TRANSCODE_MS = 1400;
  const BYTES_PER_SECOND_MP3 = 16_000;

  const assets = $derived(
    read<{ items: AudioAsset[] }>('audio.list', {}, { items: [] }).items
  );
  const byKind = $derived(
    AUDIO_KINDS.map(kind => ({
      kind,
      items: assets.filter(asset => asset.kind === kind)
    }))
  );

  /** A stable pseudo-waveform per asset: the demo has no sample data to draw. */
  function bars(id: string): number[] {
    let hash = 0;
    for (const char of id) {
      hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    }
    return Array.from({ length: BARS }, (_, index) => {
      hash = (Math.imul(hash ^ (hash >>> 15), 2246822507) + index) >>> 0;
      const envelope = Math.sin((Math.PI * (index + 0.5)) / BARS) * 0.55 + 0.35;
      return Math.max(
        0.12,
        Math.min(1, envelope * (0.45 + (hash % 1000) / 1600))
      );
    });
  }

  /* ---------------- playback ---------------- */

  let player = $state<HTMLAudioElement>();
  let playingId = $state<string | null>(null);
  let paused = $state(true);
  let progress = $state(0);

  async function toggle(asset: AudioAsset): Promise<void> {
    const url = sessionClips.get(asset.id);
    if (player === undefined || url === undefined) {
      return;
    }
    if (playingId === asset.id && !paused) {
      player.pause();
      return;
    }
    if (playingId !== asset.id) {
      player.src = url;
      progress = 0;
    }
    playingId = asset.id;
    await player.play();
  }

  /* ---------------- upload ---------------- */

  type Picked = { file: File; mimeType: string; durationS: number };
  let uploading = $state(false);
  let picked = $state<Picked | null>(null);
  let kind = $state<AudioKind>('announcement');
  let label = $state('');
  let uploadError = $state<{ field: string | null; text: string } | null>(null);
  let phase = $state<'idle' | 'transcoding'>('idle');
  let dragging = $state(false);

  function openUpload(preset: AudioKind = 'announcement'): void {
    picked = null;
    kind = preset;
    label = '';
    uploadError = null;
    phase = 'idle';
    uploading = true;
  }

  /** The declared MIME type, from the file or its extension. */
  function mimeOf(file: File): string {
    if (file.type !== '') {
      return file.type;
    }
    const name = file.name.toLowerCase();
    return name.endsWith('.wav')
      ? 'audio/wav'
      : name.endsWith('.mp3')
        ? 'audio/mpeg'
        : 'application/octet-stream';
  }

  /** The file's length, read by the browser; estimated from its size when it cannot decode it. */
  function measure(file: File): Promise<number> {
    return new Promise(resolve => {
      const probe = new Audio();
      const url = URL.createObjectURL(file);
      const done = (seconds: number): void => {
        URL.revokeObjectURL(url);
        resolve(seconds);
      };
      probe.preload = 'metadata';
      probe.onloadedmetadata = () =>
        done(
          Number.isFinite(probe.duration)
            ? probe.duration
            : file.size / BYTES_PER_SECOND_MP3
        );
      probe.onerror = () => done(file.size / BYTES_PER_SECOND_MP3);
      probe.src = url;
    });
  }

  async function pick(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return;
    }
    uploadError = null;
    if (file.size > MAX_UPLOAD_BYTES) {
      picked = null;
      uploadError = {
        field: 'upload',
        text: t('groups.audio.tooLarge', { size: formatBytes(file.size) })
      };
      return;
    }
    picked = { file, mimeType: mimeOf(file), durationS: await measure(file) };
    if (label.trim() === '') {
      label = file.name.replace(/\.[^.]+$/u, '').replace(/[_-]+/gu, ' ');
    }
  }

  async function submit(): Promise<void> {
    if (picked === null) {
      uploadError = { field: 'upload', text: t('groups.audio.pickFile') };
      return;
    }
    const upload: AudioUpload = {
      filename: picked.file.name,
      mimeType: picked.mimeType,
      sizeBytes: picked.file.size,
      durationS: picked.durationS
    };
    phase = 'transcoding';
    await new Promise(resolve => setTimeout(resolve, TRANSCODE_MS));
    const result = await run<AudioAsset>(
      'audio.create',
      { kind, label, upload },
      {
        success: 'groups.audio.created',
        successParams: { name: label },
        quietErrors: true
      }
    );
    phase = 'idle';
    if (result.ok) {
      sessionClips.set(result.value.id, URL.createObjectURL(picked.file));
      uploading = false;
      highlight(result.value.id);
    } else {
      uploadError = {
        field: result.error.field,
        text: errorText(result.error)
      };
    }
  }

  /* ---------------- rename ---------------- */

  let renaming = $state<AudioAsset | null>(null);
  let newLabel = $state('');
  let renameError = $state<string | null>(null);

  function openRename(asset: AudioAsset): void {
    renaming = asset;
    newLabel = asset.label;
    renameError = null;
  }

  async function rename(): Promise<void> {
    if (renaming === null) {
      return;
    }
    const result = await run(
      'audio.update',
      { id: renaming.id, label: newLabel },
      { success: 'groups.audio.renamed', quietErrors: true }
    );
    if (result.ok) {
      renaming = null;
    } else {
      renameError = errorText(result.error);
    }
  }
</script>

<audio
  bind:this={player}
  onplay={() => (paused = false)}
  onpause={() => (paused = true)}
  onended={() => ((playingId = null), (progress = 0))}
  ontimeupdate={() =>
    (progress =
      player !== undefined && player.duration > 0
        ? player.currentTime / player.duration
        : 0)}
></audio>

<PageHeader title={t('nav.audio')} subtitle={t('groups.audio.subtitle')}>
  {#snippet actions()}
    <Button
      variant="primary"
      icon={Upload}
      op="audio.create"
      onclick={() => openUpload()}>{t('groups.audio.upload')}</Button
    >
  {/snippet}
</PageHeader>

<div class="kinds">
  {#each byKind as section (section.kind)}
    <Card
      title={t(`groups.audio.kind.${section.kind}`)}
      icon={ICONS[section.kind]}
      description={t(`groups.audio.kind.${section.kind}.desc`)}
    >
      {#snippet actions()}
        <Button
          size="sm"
          variant="ghost"
          icon={Upload}
          op="audio.create"
          onclick={() => openUpload(section.kind)}>{t('common.add')}</Button
        >
      {/snippet}
      {#if section.items.length === 0}
        <p class="small muted">{t('groups.audio.none')}</p>
      {:else}
        <ul class="assets">
          {#each section.items as asset (asset.id)}
            {@const clip = sessionClips.get(asset.id)}
            {@const refs = audioReferences(store.db, asset.id)}
            {@const isPlaying = playingId === asset.id && !paused}
            <li class:flash={router.highlight === asset.id}>
              <button
                type="button"
                class="play"
                disabled={clip === undefined}
                title={clip === undefined
                  ? t('groups.audio.noFile')
                  : isPlaying
                    ? t('audio.pause')
                    : t('audio.play')}
                aria-label={clip === undefined
                  ? t('groups.audio.noFile')
                  : isPlaying
                    ? t('audio.pause')
                    : t('audio.play')}
                onclick={() => toggle(asset)}
              >
                {#if isPlaying}<Pause size={15} />{:else}<Play size={15} />{/if}
              </button>
              <div class="info">
                <div class="title-row">
                  <span class="label strong truncate">{asset.label}</span>
                  {#if asset.bundled}
                    <Badge tone="lime" title={t('groups.audio.bundledHelp')}
                      >{t('groups.audio.bundled')}</Badge
                    >
                  {/if}
                </div>
                <svg
                  class="wave"
                  class:live={clip !== undefined}
                  viewBox="0 0 {BARS * 4} 24"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {#each bars(asset.id) as height, index (index)}
                    <rect
                      x={index * 4}
                      y={12 - height * 11}
                      width="2.4"
                      height={height * 22}
                      rx="1.2"
                      class:done={playingId === asset.id &&
                        index / BARS < progress}
                    />
                  {/each}
                </svg>
                <div class="meta xs muted">
                  <span class="nums">{formatDuration(asset.durationS)}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    >{asset.bundled
                      ? t('groups.audio.since', {
                          date: formatDate(asset.createdAt)
                        })
                      : t('groups.audio.uploaded', {
                          date: formatDate(asset.createdAt)
                        })}</span
                  >
                  {#if isExpert()}<code class="faint">{asset.id}</code>{/if}
                </div>
              </div>
              <div class="uses">
                {#if refs.length === 0}
                  <span class="xs faint">{t('groups.audio.unused')}</span>
                {:else}
                  <span class="xs muted">{t('groups.audio.usedBy')}</span>
                  {#each refs as ref (`${ref.kind}:${ref.id}:${ref.label}`)}
                    <a class="chip" href={refHref(ref) ?? undefined}
                      >{ref.label}</a
                    >
                  {/each}
                {/if}
              </div>
              <div class="tools">
                <IconButton
                  icon={Pencil}
                  size="sm"
                  label={t('groups.audio.rename')}
                  onclick={() => openRename(asset)}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  variant="danger"
                  label={t('common.delete')}
                  onclick={() =>
                    run(
                      'audio.delete',
                      { id: asset.id },
                      {
                        success: 'groups.audio.deleted',
                        successParams: { name: asset.label }
                      }
                    )}
                />
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      {#if section.kind === 'moh'}
        <p class="note xs muted">{t('groups.audio.mohNote')}</p>
      {/if}
    </Card>
  {/each}
</div>

<Drawer
  open={uploading}
  title={t('groups.audio.upload')}
  subtitle={t('groups.audio.uploadSub')}
  onclose={() => phase === 'idle' && (uploading = false)}
>
  <div class="stack">
    <FormField
      entity="audio"
      key="upload"
      id="audio-file"
      error={uploadError?.field === 'upload' ? uploadError.text : null}
      required
    >
      {#snippet children()}
        <label
          class="drop"
          class:dragging
          class:has-file={picked !== null}
          for="audio-file"
          ondragover={event => {
            event.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={event => {
            event.preventDefault();
            dragging = false;
            void pick(event.dataTransfer?.files[0]);
          }}
        >
          <span class="drop-icon"
            >{#if picked === null}<Upload size={22} />{:else}<FileAudio
                size={22}
              />{/if}</span
          >
          {#if picked === null}
            <span class="strong">{t('groups.audio.dropTitle')}</span>
            <span class="xs muted">{t('groups.audio.dropHint')}</span>
          {:else}
            <span class="strong truncate">{picked.file.name}</span>
            <span class="xs muted nums"
              >{formatBytes(picked.file.size)} · {formatDuration(
                picked.durationS
              )} · {picked.mimeType}</span
            >
          {/if}
          <input
            id="audio-file"
            class="sr-only"
            type="file"
            accept=".wav,.mp3,audio/wav,audio/x-wav,audio/wave,audio/mpeg,audio/mp3"
            onchange={event => void pick(event.currentTarget.files?.[0])}
          />
        </label>
      {/snippet}
    </FormField>

    <FormField entity="audio" key="kind" id="audio-kind">
      {#snippet children()}
        <div
          class="kind-grid"
          role="radiogroup"
          aria-label={t('field.audio.kind')}
          id="audio-kind"
        >
          {#each AUDIO_KINDS as option (option)}
            {@const Glyph = ICONS[option]}
            <button
              type="button"
              role="radio"
              aria-checked={kind === option}
              class="kind-option"
              class:on={kind === option}
              onclick={() => (kind = option)}
            >
              <Glyph size={16} />
              <span>{t(`groups.audio.kind.${option}.one`)}</span>
            </button>
          {/each}
        </div>
      {/snippet}
    </FormField>
    {#if kind === 'moh'}
      <p class="note xs">{t('groups.audio.licenseNote')}</p>
    {/if}

    <FormField
      entity="audio"
      key="label"
      id="audio-label"
      error={uploadError?.field === 'label' ? uploadError.text : null}
      required
    >
      {#snippet children()}
        <TextInput
          id="audio-label"
          bind:value={label}
          placeholder={t('groups.audio.labelPlaceholder')}
          invalid={uploadError?.field === 'label'}
        />
      {/snippet}
    </FormField>

    {#if phase === 'transcoding'}
      <div class="transcode" role="status">
        <span class="small strong">{t('groups.audio.transcoding')}</span>
        <span class="bar"
          ><span class="fill" style:animation-duration="{TRANSCODE_MS}ms"
          ></span></span
        >
      </div>
    {/if}
    {#if uploadError !== null && uploadError.field !== 'upload' && uploadError.field !== 'label'}
      <p class="form-error" role="alert">{uploadError.text}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button
      variant="ghost"
      disabled={phase !== 'idle'}
      onclick={() => (uploading = false)}>{t('common.cancel')}</Button
    >
    <Button
      variant="primary"
      icon={Upload}
      loading={phase !== 'idle'}
      op="audio.create"
      onclick={submit}>{t('groups.audio.uploadAction')}</Button
    >
  {/snippet}
</Drawer>

<Dialog
  open={renaming !== null}
  title={t('groups.audio.rename')}
  size="sm"
  onclose={() => (renaming = null)}
>
  <FormField entity="audio" key="label" id="audio-rename" error={renameError}>
    {#snippet children()}
      <TextInput
        id="audio-rename"
        bind:value={newLabel}
        invalid={renameError !== null}
        onenter={rename}
      />
    {/snippet}
  </FormField>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (renaming = null)}
      >{t('common.cancel')}</Button
    >
    <Button variant="primary" op="audio.update" onclick={rename}
      >{t('common.save')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .kinds {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr));
    align-items: start;
  }
  .assets {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .assets li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      'play info tools'
      'play uses tools';
    column-gap: var(--space-3);
    row-gap: 6px;
    align-items: center;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }
  .assets li:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .play {
    grid-area: play;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    cursor: pointer;
    box-shadow: var(--shadow-primary);
  }
  .play:disabled {
    background: var(--surface-3);
    color: var(--text-faint);
    box-shadow: none;
    cursor: not-allowed;
  }
  .info {
    grid-area: info;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .wave {
    width: 100%;
    max-width: 260px;
    height: 20px;
    color: var(--line-strong);
  }
  .wave rect {
    fill: currentColor;
  }
  .wave.live {
    color: color-mix(in srgb, var(--primary) 45%, var(--line));
  }
  .wave rect.done {
    fill: var(--primary);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .uses {
    grid-area: uses;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
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
  .tools {
    grid-area: tools;
    display: flex;
    gap: 2px;
  }
  .note {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--text-muted);
  }
  .drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: var(--space-5) var(--space-4);
    border: 2px dashed var(--line-strong);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    text-align: center;
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .drop:hover,
  .drop.dragging {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .drop.has-file {
    border-style: solid;
    border-color: color-mix(in srgb, var(--primary) 45%, var(--line));
  }
  .drop:focus-within {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .drop .truncate {
    max-width: 100%;
  }
  .drop-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--surface);
    color: var(--primary);
    box-shadow: var(--shadow-sm);
    margin-bottom: 4px;
  }
  .kind-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }
  .kind-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 10px var(--space-3);
    border: 1.5px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }
  .kind-option.on {
    border-color: var(--primary);
    background: var(--primary-soft);
    color: var(--primary);
  }
  .kind-option:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .transcode {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    width: 100%;
    background: var(--primary);
    transform-origin: left;
    animation: grow linear forwards;
  }
  @keyframes grow {
    from {
      transform: scaleX(0.04);
    }
    to {
      transform: scaleX(1);
    }
  }
  .form-error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  @media (max-width: 560px) {
    .assets li {
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        'play info'
        'uses uses'
        'tools tools';
    }
    .tools {
      justify-content: flex-end;
    }
  }
</style>
