<!--
  Plays a voicemail or recording. Recordings are stereo (§10.2): left the recorded person, right
  what they heard. "Both" plays them as recorded, one side per ear; a solo side plays on both
  ears.
-->
<script lang="ts">
  import Download from '@lucide/svelte/icons/download';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';

  import { clipUrl } from '#lib/api/audio.js';
  import { formatDuration, t } from '#lib/i18n/index.svelte.js';

  type Props = {
    clip: string | null;
    durationS: number;
    stereo?: boolean;
    leftLabel?: string;
    rightLabel?: string;
    filename?: string;
    onplay?: () => void;
  };

  let {
    clip,
    durationS,
    stereo = false,
    leftLabel,
    rightLabel,
    filename,
    onplay
  }: Props = $props();
  const url = $derived(clipUrl(clip));
  let audio = $state<HTMLAudioElement>();
  let playing = $state(false);
  let current = $state(0);
  let duration = $state(0);
  let channel = $state<'both' | 'left' | 'right'>('both');

  let context: AudioContext | null = null;
  /** Gain from each recorded side (left, right) to each output ear. */
  let routes: {
    leftToLeft: GainNode;
    leftToRight: GainNode;
    rightToLeft: GainNode;
    rightToRight: GainNode;
  } | null = null;

  function ensureGraph(): void {
    if (!stereo || context !== null || audio === undefined) {
      return;
    }
    const graph = new AudioContext();
    context = graph;
    const source = graph.createMediaElementSource(audio);
    const splitter = graph.createChannelSplitter(2);
    const merger = graph.createChannelMerger(2);
    const route = (from: number, to: number): GainNode => {
      const gain = graph.createGain();
      splitter.connect(gain, from);
      gain.connect(merger, 0, to);
      return gain;
    };
    source.connect(splitter);
    routes = {
      leftToLeft: route(0, 0),
      leftToRight: route(0, 1),
      rightToLeft: route(1, 0),
      rightToRight: route(1, 1)
    };
    merger.connect(graph.destination);
    applyChannel();
  }

  function applyChannel(): void {
    if (routes !== null) {
      routes.leftToLeft.gain.value = channel === 'right' ? 0 : 1;
      routes.leftToRight.gain.value = channel === 'left' ? 1 : 0;
      routes.rightToLeft.gain.value = channel === 'right' ? 1 : 0;
      routes.rightToRight.gain.value = channel === 'left' ? 0 : 1;
    }
  }

  $effect(() => () => {
    void context?.close();
    context = null;
  });

  async function toggle(): Promise<void> {
    if (audio === undefined) {
      return;
    }
    ensureGraph();
    await context?.resume();
    if (audio.paused) {
      await audio.play();
      onplay?.();
    } else {
      audio.pause();
    }
  }

  const total = $derived(
    duration > 0 && Number.isFinite(duration) ? duration : durationS
  );
  const progress = $derived(total > 0 ? (current / total) * 100 : 0);
</script>

<div class="player">
  {#if url}
    <audio
      bind:this={audio}
      src={url}
      preload="metadata"
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      onended={() => (playing = false)}
      ontimeupdate={() => (current = audio?.currentTime ?? 0)}
      onloadedmetadata={() => (duration = audio?.duration ?? 0)}
    ></audio>
  {/if}
  <button
    type="button"
    class="play"
    onclick={toggle}
    disabled={!url}
    aria-label={playing ? t('audio.pause') : t('audio.play')}
  >
    {#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}
  </button>
  <div class="track">
    <input
      type="range"
      min="0"
      max={total}
      step="0.1"
      value={current}
      aria-label={t('audio.seek')}
      style:--progress="{progress}%"
      oninput={event => {
        if (audio) {
          audio.currentTime = Number(event.currentTarget.value);
        }
      }}
    />
    <span class="time nums"
      >{formatDuration(current)} / {formatDuration(total)}</span
    >
  </div>
  {#if stereo}
    <div class="channels" role="radiogroup" aria-label={t('audio.channels')}>
      {#each [['both', t('audio.both')], ['left', leftLabel ?? t('audio.left')], ['right', rightLabel ?? t('audio.right')]] as [value, label] (value)}
        <button
          type="button"
          role="radio"
          aria-checked={channel === value}
          class:on={channel === value}
          onclick={() => {
            ensureGraph();
            channel = value as typeof channel;
            applyChannel();
          }}>{label}</button
        >
      {/each}
    </div>
  {/if}
  {#if url}
    <a
      class="dl"
      href={url}
      download={filename ?? `${clip}.mp3`}
      title={t('audio.download')}
      aria-label={t('audio.download')}><Download size={16} /></a
    >
  {/if}
</div>

<style>
  .player {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .play {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border: 0;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    cursor: pointer;
    flex: none;
    box-shadow: var(--shadow-primary);
  }
  .play:disabled {
    opacity: 0.4;
  }
  .track {
    flex: 1;
    min-width: 160px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  input[type='range'] {
    flex: 1;
    appearance: none;
    height: 6px;
    border-radius: var(--radius-pill);
    background: linear-gradient(
      to right,
      var(--primary) var(--progress),
      var(--surface-3) var(--progress)
    );
    cursor: pointer;
  }
  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--primary);
    border: 2px solid var(--surface);
  }
  .time {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .channels {
    display: inline-flex;
    padding: 2px;
    background: var(--surface-3);
    border-radius: var(--radius-pill);
  }
  .channels button {
    border: 0;
    background: transparent;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    cursor: pointer;
  }
  .channels button.on {
    background: var(--surface);
    color: var(--primary);
  }
  .dl {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--text-muted);
  }
  .dl:hover {
    background: var(--surface-3);
    color: var(--text);
  }
</style>
