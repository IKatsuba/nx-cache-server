import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from 'hono/logger';

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const app = new Hono<{
  Bindings: {
    NX_CACHE_ACCESS_TOKEN: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    S3_BUCKET_NAME: string;
    S3_ENDPOINT_URL: string;
    /** Defaults to true: storage failures degrade instead of failing Nx. */
    NX_CACHE_FAIL_OPEN?: boolean;
  };
  Variables: {
    s3: S3Client;
  };
}>();

app.use(async (c, next) => {
  c.set(
    's3',
    new S3Client({
      region: c.env.AWS_REGION,
      endpoint: c.env.S3_ENDPOINT_URL,
      credentials: {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
      // Without these a stalled S3 connection hangs the request forever.
      // requestTimeout is an idle timeout, so large uploads are unaffected.
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 30_000,
      },
    }),
  );

  await next();
});

const auth = () =>
  createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const token = authHeader.split(' ')[1];

    if (token !== c.env.NX_CACHE_ACCESS_TOKEN) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    await next();
  });

app.use(logger());

app.get('/health', () => {
  return new Response('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

// Readiness, unlike /health liveness, proves the bucket is reachable so the
// orchestrator can route around pods that lost storage access.
app.get('/ready', async (c) => {
  try {
    await c.get('s3').send(
      new HeadBucketCommand({ Bucket: c.env.S3_BUCKET_NAME }),
      { abortSignal: AbortSignal.timeout(2_000) },
    );
    return c.text('OK', 200);
  } catch (error: unknown) {
    console.error('Readiness check failed; storage unavailable:', error);
    return c.text('Storage unavailable', 503);
  }
});

// Nx treats only GET 404 as a miss and only PUT 403/409 as non-fatal; any
// other failure fails the Nx run. By default (fail-open) storage problems
// therefore become a GET miss or a PUT 403. Fail-closed returns 503 instead.
// Every degraded response is logged so outages stay visible to operators.
const storageFailure = (
  method: 'GET' | 'PUT',
  hash: string,
  error: unknown,
  failOpen = true,
) => {
  console.error(`Storage unavailable during ${method} ${hash}:`, error);
  if (!failOpen) {
    return new Response('Cache storage unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  return method === 'GET'
    ? cacheMiss()
    : new Response('Cache storage unavailable; artifact not stored', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
};

app.put('/v1/cache/:hash', auth(), async (c) => {
  try {
    const hash = c.req.param('hash');

    const contentLength = c.req.header('Content-Length');
    if (contentLength === undefined || Number.isNaN(Number(contentLength))) {
      return new Response('Content-Length header is required', {
        status: 411,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    try {
      await c.get('s3').send(
        new HeadObjectCommand({
          Bucket: c.env.S3_BUCKET_NAME,
          Key: hash,
        }),
      );

      return new Response('Cannot override an existing record', {
        status: 409,
        headers: { 'Content-Type': 'text/plain' },
      });
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'NotFound')) {
        return storageFailure('PUT', hash, error, c.env.NX_CACHE_FAIL_OPEN);
      }
    }

    const body = await c.req.arrayBuffer();

    try {
      await c.get('s3').send(
        new PutObjectCommand({
          Bucket: c.env.S3_BUCKET_NAME,
          Key: hash,
          Body: new Uint8Array(body),
        }),
      );
    } catch (error: unknown) {
      return storageFailure('PUT', hash, error, c.env.NX_CACHE_FAIL_OPEN);
    }

    return new Response('Successfully uploaded', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error: unknown) {
    console.error('Upload error:', error);
    return new Response('Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

const STORAGE_HEADERS_TIMEOUT_MS = 5_000;

function cacheMiss() {
  return new Response('The record was not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  });
}

app.get('/v1/cache/:hash', auth(), async (c) => {
  const hash = c.req.param('hash');
  const headersTimeout = new AbortController();
  const timer = setTimeout(
    () => headersTimeout.abort(),
    STORAGE_HEADERS_TIMEOUT_MS,
  );
  try {
    const url = await getSignedUrl(
      c.get('s3'),
      new GetObjectCommand({ Bucket: c.env.S3_BUCKET_NAME, Key: hash }),
      { expiresIn: 18000 },
    );

    const response = await fetch(url, { signal: headersTimeout.signal });
    // Only the wait for headers is bounded; the body may stream for longer.
    clearTimeout(timer);

    if (response.status === 404) {
      // S3 also answers 404 for a missing bucket; only NoSuchKey is a miss.
      const errorBody = await response.text();
      if (errorBody.includes('<Code>NoSuchBucket</Code>')) {
        return storageFailure(
          'GET',
          hash,
          'S3 bucket not found',
          c.env.NX_CACHE_FAIL_OPEN,
        );
      }
      return cacheMiss();
    }

    if (!response.ok) {
      await response.body?.cancel();
      return storageFailure(
        'GET',
        hash,
        `S3 returned ${response.status}`,
        c.env.NX_CACHE_FAIL_OPEN,
      );
    }

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
    });
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) {
      headers.set('Content-Length', contentLength);
    }

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (error: unknown) {
    clearTimeout(timer);
    return storageFailure('GET', hash, error, c.env.NX_CACHE_FAIL_OPEN);
  }
});

if (import.meta.main) {
  const port = parseInt(Deno.env.get('PORT') || '3000');

  const failOpenSetting = Deno.env.get('NX_CACHE_FAIL_OPEN') ?? 'true';
  if (failOpenSetting !== 'true' && failOpenSetting !== 'false') {
    console.error('NX_CACHE_FAIL_OPEN must be "true" or "false"');
    Deno.exit(1);
  }

  const certPath = Deno.env.get('TLS_CERT_PATH');
  const keyPath = Deno.env.get('TLS_KEY_PATH');

  if (Boolean(certPath) !== Boolean(keyPath)) {
    console.error(
      'TLS misconfiguration: TLS_CERT_PATH and TLS_KEY_PATH must be set together',
    );
    Deno.exit(1);
  }

  let tls = {};
  if (certPath && keyPath) {
    try {
      tls = {
        cert: Deno.readTextFileSync(certPath),
        key: Deno.readTextFileSync(keyPath),
      };
    } catch (e) {
      console.error(
        `TLS misconfiguration: cannot read cert/key: ${
          e instanceof Error ? e.message : e
        }`,
      );
      Deno.exit(1);
    }
  }

  console.log(`Server running on port ${port}${certPath ? ' over HTTPS' : ''}`);

  Deno.serve({ port, ...tls }, (req) =>
    app.fetch(req, {
      NX_CACHE_ACCESS_TOKEN: Deno.env.get('NX_CACHE_ACCESS_TOKEN'),
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
      S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL'),
      NX_CACHE_FAIL_OPEN: failOpenSetting === 'true',
    }));
}
