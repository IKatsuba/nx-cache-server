import { Hono } from 'hono';
import { logger } from 'hono/logger';

import { auth } from './middleware/auth.ts';
import { s3Middleware } from './middleware/s3.ts';
import { registerCacheRoutes } from './routes/cache.ts';
import { registerMetricsRoutes } from './routes/metrics.ts';
import type { AppEnv } from './types.ts';

export const app = new Hono<AppEnv>();

app.use(s3Middleware());
app.use(logger());

app.get('/health', () => {
  return new Response('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

// original cache functionality, now registered from a module
registerCacheRoutes(app, auth);

// new metrics endpoints, separate module
registerMetricsRoutes(app, auth);

if (import.meta.main) {
  const port = parseInt(Deno.env.get('PORT') || '3000');
  console.log(`Server running on port ${port}`);

  Deno.serve({ port }, (req) =>
    app.fetch(req, {
      NX_CACHE_ACCESS_TOKEN: Deno.env.get('NX_CACHE_ACCESS_TOKEN'),
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
      S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL'),
      METRICS_AUTH: Deno.env.get('METRICS_AUTH') || 'true',
    }));
}
