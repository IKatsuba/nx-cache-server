export type CacheBucket = {
  ts: number; // bucket start timestamp (ms)
  hits: number;
  misses: number;
  requests: number;
};

export type CacheHitRatePoint = {
  ts: number;
  hits: number;
  misses: number;
  requests: number;
  hitRate: number | null;
};

export type CacheHitRateSeries = {
  start: number;
  end: number;
  bucketMs: number;
  points: CacheHitRatePoint[];
  totals: {
    hits: number;
    misses: number;
    requests: number;
    hitRate: number | null;
  };
};

const DEFAULT_BUCKET_MS = 60_000; // 1 minute
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000; // 24 hours

const cacheBuckets = new Map<number, CacheBucket>();

function floorToBucket(ts: number, bucketMs: number) {
  return Math.floor(ts / bucketMs) * bucketMs;
}

function pruneOldBuckets(now: number, retentionMs: number) {
  const cutoff = now - retentionMs;
  for (const key of cacheBuckets.keys()) {
    if (key < cutoff) cacheBuckets.delete(key);
  }
}

/**
 * Record GET cache outcomes:
 * - 200 => hit
 * - 404 => miss
 * Other statuses count as request only (unless you decide otherwise later).
 */
export function recordCacheGetOutcome(
  status: number,
  now = Date.now(),
  bucketMs = DEFAULT_BUCKET_MS,
) {
  const bucketTs = floorToBucket(now, bucketMs);
  const existing = cacheBuckets.get(bucketTs) ?? {
    ts: bucketTs,
    hits: 0,
    misses: 0,
    requests: 0,
  };

  existing.requests += 1;
  if (status === 200) existing.hits += 1;
  else if (status === 404) existing.misses += 1;

  cacheBuckets.set(bucketTs, existing);
  pruneOldBuckets(now, DEFAULT_RETENTION_MS);
}

export function parseDurationMs(
  input: string | null | undefined,
  fallbackMs: number,
): number {
  if (!input) return fallbackMs;
  const v = input.trim().toLowerCase();

  // supports: 30m, 6h, 1d, 900s, 60000 (ms)
  const m = v.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!m) return fallbackMs;

  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';

  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 60 * 60_000;
    case 'd':
      return n * 24 * 60 * 60_000;
    default:
      return fallbackMs;
  }
}

export function computeHitRateSeries(
  now: number,
  windowMs: number,
  bucketMs: number,
): CacheHitRateSeries {
  const start = now - windowMs;

  // Aggregate into requested bucket size (can be coarser than storage bucket)
  const series = new Map<number, CacheBucket>();

  for (const b of cacheBuckets.values()) {
    if (b.ts < start || b.ts > now) continue;

    const ts = floorToBucket(b.ts, bucketMs);
    const agg = series.get(ts) ?? { ts, hits: 0, misses: 0, requests: 0 };
    agg.hits += b.hits;
    agg.misses += b.misses;
    agg.requests += b.requests;
    series.set(ts, agg);
  }

  const points: CacheHitRatePoint[] = Array.from(series.values())
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: b.ts,
      hits: b.hits,
      misses: b.misses,
      requests: b.requests,
      hitRate: b.requests ? b.hits / b.requests : null,
    }));

  const totals = points.reduce(
    (acc, p) => {
      acc.hits += p.hits;
      acc.misses += p.misses;
      acc.requests += p.requests;
      return acc;
    },
    { hits: 0, misses: 0, requests: 0 },
  );

  return {
    start,
    end: now,
    bucketMs,
    points,
    totals: {
      ...totals,
      hitRate: totals.requests ? totals.hits / totals.requests : null,
    },
  };
}
