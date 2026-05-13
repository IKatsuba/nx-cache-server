import type { Context, Hono } from 'hono';

import {
  computeHitRateSeries,
  parseDurationMs,
} from '../metrics/cacheHitRate.ts';
import type { AppEnv } from '../types.ts';

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPct(x: number | null) {
  if (x === null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(1)}%`;
}

function renderHitRateSvg(
  points: Array<{ ts: number; hitRate: number | null }>,
) {
  const width = 720;
  const height = 180;
  const padL = 44, padR = 12, padT = 14, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const defined = points.filter((p) => p.hitRate !== null) as Array<
    { ts: number; hitRate: number }
  >;
  if (points.length === 0 || defined.length === 0) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#0b1020" rx="10" />
      <text x="${width / 2}" y="${
      height / 2
    }" fill="#cbd5e1" font-family="ui-sans-serif,system-ui" font-size="14" text-anchor="middle">
        Not enough data yet
      </text>
    </svg>`;
  }

  const minTs = points[0].ts;
  const maxTs = points[points.length - 1].ts || (minTs + 1);

  const x = (ts: number) =>
    padL + ((ts - minTs) / Math.max(1, maxTs - minTs)) * plotW;
  const y = (hr: number) => padT + (1 - Math.max(0, Math.min(1, hr))) * plotH;

  // Build a path, breaking on nulls
  let d = '';
  let penDown = false;
  for (const p of points) {
    if (p.hitRate === null) {
      penDown = false;
      continue;
    }
    const px = x(p.ts);
    const py = y(p.hitRate);
    d += `${penDown ? ' L' : ' M'}${px.toFixed(2)} ${py.toFixed(2)}`;
    penDown = true;
  }

  // Use ISO 8601 UTC - client handles localization
  const startLabel = new Date(minTs).toISOString().slice(11, 16);
  const endLabel = new Date(maxTs).toISOString().slice(11, 16);

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#0b1020" rx="10" />
    <g opacity="0.25" stroke="#94a3b8">
      <line x1="${padL}" y1="${padT}" x2="${width - padR}" y2="${padT}" />
      <line x1="${padL}" y1="${padT + plotH / 2}" x2="${width - padR}" y2="${
    padT + plotH / 2
  }" />
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${
    padT + plotH
  }" />
    </g>

    <g fill="#cbd5e1" font-family="ui-sans-serif,system-ui" font-size="12">
      <text x="10" y="${padT + 4}">100%</text>
      <text x="14" y="${padT + plotH / 2 + 4}">50%</text>
      <text x="18" y="${padT + plotH + 4}">0%</text>

      <text x="${padL}" y="${height - 10}">${startLabel}</text>
      <text x="${width - padR}" y="${
    height - 10
  }" text-anchor="end">${endLabel}</text>
    </g>

    <path d="${d}" fill="none" stroke="#60a5fa" stroke-width="2.5" />
  </svg>`;
}

// deno-lint-ignore no-explicit-any
export function registerMetricsRoutes(app: Hono<AppEnv>, auth: () => any) {
  // Conditionally apply auth based on METRICS_AUTH env var (default: true)
  const metricsAuth = Deno.env.get('METRICS_AUTH')?.toLowerCase() !== 'false';

  // JSON time series
  // deno-lint-ignore no-explicit-any
  const jsonHandler = (c: Context<AppEnv, any>) => {
    const now = Date.now();
    const windowMs = parseDurationMs(c.req.query('window'), 6 * 60 * 60_000); // 6h
    const bucketMs = parseDurationMs(c.req.query('bucket'), 60_000); // 1m

    const computed = computeHitRateSeries(now, windowMs, bucketMs);

    return c.json({
      window: {
        start: new Date(computed.start).toISOString(),
        end: new Date(computed.end).toISOString(),
        bucketMs: computed.bucketMs,
      },
      totals: computed.totals,
      series: computed.points.map((p) => ({
        ts: new Date(p.ts).toISOString(),
        hits: p.hits,
        misses: p.misses,
        requests: p.requests,
        hitRate: p.hitRate,
      })),
    });
  };

  // Tiny HTML chart (inline SVG)
  // deno-lint-ignore no-explicit-any
  const chartHandler = (c: Context<AppEnv, any>) => {
    const now = Date.now();
    const windowMs = parseDurationMs(c.req.query('window'), 6 * 60 * 60_000);
    const bucketMs = parseDurationMs(c.req.query('bucket'), 60_000);

    const computed = computeHitRateSeries(now, windowMs, bucketMs);
    const svg = renderHitRateSvg(
      computed.points.map((p) => ({ ts: p.ts, hitRate: p.hitRate })),
    );

    const title = `NX Cache hit rate (${formatPct(computed.totals.hitRate)})`;

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:18px;background:#020617;color:#e2e8f0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;">
  <div style="max-width:760px;margin:0 auto;">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;">
      <div>
        <div style="font-size:16px;font-weight:600;">${escapeHtml(title)}</div>
        <div style="font-size:12px;color:#94a3b8;">
          window=${escapeHtml(String(c.req.query('window') ?? '6h'))}, bucket=${
      escapeHtml(String(c.req.query('bucket') ?? '1m'))
    }
        </div>
      </div>
      <div style="text-align:right;font-size:12px;color:#94a3b8;">
        <div>hits: ${computed.totals.hits}</div>
        <div>misses: ${computed.totals.misses}</div>
        <div>req: ${computed.totals.requests}</div>
      </div>
    </div>

    ${svg}

    <div style="margin-top:10px;font-size:12px;color:#94a3b8;">Refresh the page to update.</div>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };

  if (metricsAuth) {
    app.get('/v1/metrics/json', auth(), jsonHandler);
    app.get('/v1/metrics/chart', auth(), chartHandler);
  } else {
    app.get('/v1/metrics/json', jsonHandler);
    app.get('/v1/metrics/chart', chartHandler);
  }
}
