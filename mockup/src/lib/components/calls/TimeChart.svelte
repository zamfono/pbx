<!--
  A hand-drawn SVG chart of a `stats.query` series: bars or a line over the buckets, a light
  grid, a few axis labels, a hover readout and a screen-reader table of every value. Colours come
  from the tokens, so it follows light and dark.
-->
<script lang="ts">
  import { t } from '#lib/i18n/index.svelte.js';

  type Bucket = { start: string; value: number | null };
  type Props = {
    buckets: Bucket[];
    kind?: 'bar' | 'line';
    /** Formats a value for the axis and readout. */
    format: (value: number) => string;
    /** Formats a bucket start for the x axis (short) and readout (long). */
    tick: (start: string) => string;
    long?: (start: string) => string;
    /** Fixed top of the scale (1 for rates); otherwise a round number above the maximum. */
    max?: number;
    height?: number;
    label: string;
    tone?: 'primary' | 'ok' | 'info' | 'warn';
    compact?: boolean;
  };

  let {
    buckets,
    kind = 'bar',
    format,
    tick,
    long,
    max,
    height = 220,
    label,
    tone = 'primary',
    compact = false
  }: Props = $props();

  let width = $state(600);
  let hover = $state<number | null>(null);

  const PAD = $derived(
    compact
      ? { top: 6, right: 4, bottom: 4, left: 4 }
      : { top: 12, right: 12, bottom: 28, left: 44 }
  );
  const innerW = $derived(Math.max(10, width - PAD.left - PAD.right));
  const innerH = $derived(Math.max(10, height - PAD.top - PAD.bottom));

  function niceMax(value: number): number {
    if (value <= 0) {
      return 1;
    }
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const steps = [1, 2, 2.5, 5, 10];
    const step = steps.find(candidate => candidate * magnitude >= value) ?? 10;
    return step * magnitude;
  }

  const top = $derived(
    max ?? niceMax(Math.max(0, ...buckets.map(bucket => bucket.value ?? 0)))
  );
  const slot = $derived(buckets.length > 0 ? innerW / buckets.length : innerW);
  const y = (value: number): number =>
    PAD.top + innerH - (Math.min(value, top) / top) * innerH;
  const x = (index: number): number => PAD.left + slot * index + slot / 2;
  const grid = $derived([0, 0.25, 0.5, 0.75, 1].map(part => part * top));
  const labelEvery = $derived(
    Math.max(
      1,
      Math.ceil(buckets.length / Math.max(2, Math.floor(innerW / 64)))
    )
  );
  const barW = $derived(Math.max(2, Math.min(36, slot * 0.66)));

  const path = $derived.by(() => {
    let d = '';
    let pen = false;
    buckets.forEach((bucket, index) => {
      if (bucket.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(index).toFixed(1)},${y(bucket.value).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const area = $derived.by(() => {
    const points = buckets
      .map((bucket, index) => ({ index, value: bucket.value }))
      .filter(point => point.value !== null);
    if (points.length < 2) {
      return '';
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) {
      return '';
    }
    return `M${x(first.index)},${PAD.top + innerH} ${points.map(point => `L${x(point.index).toFixed(1)},${y(point.value ?? 0).toFixed(1)}`).join(' ')} L${x(last.index)},${PAD.top + innerH} Z`;
  });

  const readout = $derived(hover === null ? null : buckets[hover]);
</script>

<figure class="chart {tone}" class:compact>
  <div class="frame" bind:clientWidth={width}>
    <svg {width} {height} role="img" aria-label={label}>
      {#if !compact}
        {#each grid as value (value)}
          <line
            class="grid"
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={y(value)}
            y2={y(value)}
          />
          <text class="axis" x={PAD.left - 8} y={y(value) + 4} text-anchor="end"
            >{format(value)}</text
          >
        {/each}
      {/if}
      {#if kind === 'bar'}
        {#each buckets as bucket, index (bucket.start)}
          {#if bucket.value !== null && bucket.value > 0}
            <rect
              class="bar"
              class:dim={hover !== null && hover !== index}
              x={x(index) - barW / 2}
              y={y(bucket.value)}
              width={barW}
              height={Math.max(1, PAD.top + innerH - y(bucket.value))}
              rx={Math.min(6, barW / 3)}
            />
          {/if}
        {/each}
      {:else}
        {#if area}<path class="area" d={area} />{/if}
        <path class="line" d={path} />
        {#each buckets as bucket, index (bucket.start)}
          {#if bucket.value !== null}
            <circle
              class="point"
              class:on={hover === index}
              cx={x(index)}
              cy={y(bucket.value)}
              r={hover === index ? 5 : compact ? 0 : 3}
            />
          {/if}
        {/each}
      {/if}
      {#if !compact}
        <line
          class="base"
          x1={PAD.left}
          x2={PAD.left + innerW}
          y1={PAD.top + innerH}
          y2={PAD.top + innerH}
        />
        {#each buckets as bucket, index (bucket.start)}
          {#if index % labelEvery === 0}
            <text class="axis" x={x(index)} y={height - 8} text-anchor="middle"
              >{tick(bucket.start)}</text
            >
          {/if}
        {/each}
      {/if}
      {#each buckets as bucket, index (bucket.start)}
        <rect
          class="hit"
          role="presentation"
          x={PAD.left + slot * index}
          y={PAD.top}
          width={slot}
          height={innerH}
          onpointerenter={() => (hover = index)}
          onpointerleave={() => (hover = null)}
        />
      {/each}
    </svg>
    {#if readout && hover !== null}
      <div
        class="readout"
        style:left="{Math.min(Math.max(x(hover), 60), width - 60)}px"
      >
        <span class="xs muted">{(long ?? tick)(readout.start)}</span>
        <strong class="nums"
          >{readout.value === null
            ? t('calls.stats.noData')
            : format(readout.value)}</strong
        >
      </div>
    {/if}
  </div>
  <table class="sr-only">
    <caption>{label}</caption>
    <tbody>
      {#each buckets as bucket (bucket.start)}
        <tr
          ><th scope="row">{(long ?? tick)(bucket.start)}</th><td
            >{bucket.value === null
              ? t('calls.stats.noData')
              : format(bucket.value)}</td
          ></tr
        >
      {/each}
    </tbody>
  </table>
</figure>

<style>
  .chart {
    position: relative;
    --series: var(--primary);
    --series-soft: var(--primary-soft);
    margin: 0;
  }
  .chart.ok {
    --series: var(--ok);
    --series-soft: var(--ok-soft);
  }
  .chart.info {
    --series: var(--info);
    --series-soft: var(--info-soft);
  }
  .chart.warn {
    --series: var(--warn);
    --series-soft: var(--warn-soft);
  }
  .frame {
    position: relative;
    width: 100%;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--line);
    stroke-dasharray: 3 4;
  }
  .base {
    stroke: var(--line-strong);
  }
  .axis {
    fill: var(--text-faint);
    font-size: 11px;
    font-family: var(--font-body);
  }
  .bar {
    fill: var(--series);
    transition: opacity 0.15s var(--ease);
  }
  .bar.dim {
    opacity: 0.45;
  }
  .line {
    fill: none;
    stroke: var(--series);
    stroke-width: 2.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .area {
    fill: var(--series-soft);
    opacity: 0.7;
  }
  .point {
    fill: var(--surface);
    stroke: var(--series);
    stroke-width: 2;
  }
  .point.on {
    fill: var(--series);
  }
  .hit {
    fill: transparent;
  }
  .readout {
    position: absolute;
    top: -6px;
    transform: translate(-50%, -100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4px 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    pointer-events: none;
    white-space: nowrap;
    z-index: 2;
  }
</style>
