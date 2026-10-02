/**
 * What `api` counts in process for `GET /metrics` (§7 "Metrics"), reported into from wherever the
 * counted thing happens: API request latency and failed config propagations, since `api` started.
 */

/* eslint-disable no-magic-numbers -- Prometheus's suggested latency-histogram bucket bounds, meaningful only as this literal list */
const API_REQUEST_SECONDS_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
] as const;
/* eslint-enable no-magic-numbers */

// Module-level accumulator (§7 "API latency"): the request pipeline reports into it from
// wherever it runs; this module only holds and renders the counts.
const apiRequestSeconds = {
  bucketCounts: API_REQUEST_SECONDS_BUCKETS.map(() => 0),
  sum: 0,
  count: 0
};

/** Records one completed API request's duration for the `zamfono_api_request_seconds` histogram. */
export function recordApiRequestSeconds(seconds: number): void {
  apiRequestSeconds.sum += seconds;
  apiRequestSeconds.count += 1;
  API_REQUEST_SECONDS_BUCKETS.forEach((bound, index) => {
    if (seconds <= bound) {
      const count = apiRequestSeconds.bucketCounts[index];
      // `bucketCounts` is built from this same bucket list, so every index here is in range.
      if (count === undefined) {
        throw new Error(`metrics: bucket index out of range: ${index}`);
      }
      apiRequestSeconds.bucketCounts[index] = count + 1;
    }
  });
}

// The config propagations that failed since `api` started (§3.1), counted where they fail.
let configPropagationFailures = 0;

/** Counts one failed config propagation for `zamfono_config_propagation_failures_total`. */
export function recordConfigPropagationFailure(): void {
  configPropagationFailures += 1;
}

/** The `zamfono_config_propagation_failures_total` counter. */
export function configPropagationFailureLines(): string[] {
  return [
    '# TYPE zamfono_config_propagation_failures_total counter',
    `zamfono_config_propagation_failures_total ${configPropagationFailures}`
  ];
}

/** The `zamfono_api_request_seconds` histogram. */
export function apiRequestHistogramLines(): string[] {
  const lines = ['# TYPE zamfono_api_request_seconds histogram'];
  API_REQUEST_SECONDS_BUCKETS.forEach((bound, index) => {
    lines.push(
      `zamfono_api_request_seconds_bucket{le="${bound}"} ${apiRequestSeconds.bucketCounts[index]}`
    );
  });
  lines.push(
    `zamfono_api_request_seconds_bucket{le="+Inf"} ${apiRequestSeconds.count}`,
    `zamfono_api_request_seconds_sum ${apiRequestSeconds.sum}`,
    `zamfono_api_request_seconds_count ${apiRequestSeconds.count}`
  );
  return lines;
}
