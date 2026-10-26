import { assertEquals } from '@std/assert';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from './index.ts';

type Storage = (request: Request) => Response | Promise<Response>;

const s3Error = (code: string, status: number) =>
  new Response(`<Error><Code>${code}</Code></Error>`, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  });

async function withStorage(
  storage: Storage,
  run: (endpoint: string) => Promise<void>,
) {
  const server = Deno.serve({ port: 0, onListen() {} }, storage);
  try {
    await run(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
  }
}

function cacheRequest(
  endpoint: string,
  method: string,
  init: { body?: string; token?: string; failOpen?: boolean } = {},
) {
  const headers = new Headers({
    Authorization: `Bearer ${init.token ?? 'test-token'}`,
  });
  if (init.body !== undefined) {
    headers.set('Content-Length', String(init.body.length));
  }
  return app.fetch(
    new Request('http://localhost/v1/cache/hash', {
      method,
      headers,
      body: init.body,
    }),
    {
      NX_CACHE_ACCESS_TOKEN: 'test-token',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      S3_BUCKET_NAME: 'cache',
      S3_ENDPOINT_URL: endpoint,
      NX_CACHE_FAIL_OPEN: init.failOpen,
    },
  );
}

for (
  const [name, storage] of [
    ['an S3 server error', () => s3Error('InternalError', 500)],
    ['S3 throttling', () => s3Error('SlowDown', 503)],
    ['an S3 permission error', () => s3Error('AccessDenied', 403)],
    ['an S3 credential error', () => s3Error('InvalidAccessKeyId', 403)],
  ] as const
) {
  Deno.test(`GET treats ${name} as a cache miss`, async () => {
    await withStorage(storage, async (endpoint) => {
      const response = await cacheRequest(endpoint, 'GET');
      assertEquals(response.status, 404);
      await response.body?.cancel();
    });
  });
}

Deno.test('GET treats unreachable storage as a cache miss', async () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const response = await cacheRequest(`http://127.0.0.1:${port}`, 'GET');
  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test('GET treats storage that sends no headers within 5s as a cache miss', async () => {
  const release = Promise.withResolvers<void>();
  await withStorage(async () => {
    await release.promise;
    return new Response('late');
  }, async (endpoint) => {
    try {
      const started = Date.now();
      const response = await cacheRequest(endpoint, 'GET');
      assertEquals(response.status, 404);
      await response.body?.cancel();
      const elapsed = Date.now() - started;
      assertEquals(elapsed >= 4_900 && elapsed < 8_000, true, `${elapsed}ms`);
    } finally {
      release.resolve();
    }
  });
});

Deno.test('GET streams a slow body past the header timeout', async () => {
  await withStorage(() =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('first,'));
          // Real clock on purpose: the body must outlive the server's 5s
          // header timeout, which fake timers cannot drive across fetch().
          await delay(5_500);
          controller.enqueue(new TextEncoder().encode('last'));
          controller.close();
        },
      }),
    ), async (endpoint) => {
    const response = await cacheRequest(endpoint, 'GET');
    assertEquals(response.status, 200);
    assertEquals(await response.text(), 'first,last');
  });
});

Deno.test('GET keeps 401 for a bad client token during a storage outage', async () => {
  await withStorage(() => s3Error('InternalError', 500), async (endpoint) => {
    const response = await cacheRequest(endpoint, 'GET', { token: 'wrong' });
    assertEquals(response.status, 401);
    await response.body?.cancel();
  });
});

const STORED_NOTHING = 'Cache storage unavailable; artifact not stored';

for (
  const [name, storage] of [
    [
      'the duplicate check fails',
      (request: Request) =>
        request.method === 'HEAD'
          ? new Response(null, { status: 500 })
          : new Response(null),
    ],
    ['the S3 upload is denied', async (request: Request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 404 });
      await request.body?.cancel();
      return s3Error('AccessDenied', 403);
    }],
    ['the S3 upload fails with a server error', async (request: Request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 404 });
      await request.body?.cancel();
      return s3Error('InternalError', 500);
    }],
  ] as const
) {
  Deno.test(`PUT returns non-fatal 403 when ${name}`, async () => {
    await withStorage(storage, async (endpoint) => {
      const response = await cacheRequest(endpoint, 'PUT', { body: 'data' });
      assertEquals(response.status, 403);
      assertEquals(await response.text(), STORED_NOTHING);
    });
  });
}

Deno.test('PUT returns non-fatal 403 when storage is unreachable', async () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const response = await cacheRequest(`http://127.0.0.1:${port}`, 'PUT', {
    body: 'data',
  });
  assertEquals(response.status, 403);
  assertEquals(await response.text(), STORED_NOTHING);
});

Deno.test('PUT keeps 409 for an existing record', async () => {
  await withStorage(() => new Response(null), async (endpoint) => {
    const response = await cacheRequest(endpoint, 'PUT', { body: 'data' });
    assertEquals(response.status, 409);
    await response.body?.cancel();
  });
});

Deno.test('PUT keeps 401 for a bad client token during a storage outage', async () => {
  await withStorage(() => s3Error('InternalError', 500), async (endpoint) => {
    const response = await cacheRequest(endpoint, 'PUT', {
      body: 'data',
      token: 'wrong',
    });
    assertEquals(response.status, 401);
    await response.body?.cancel();
  });
});

function readyRequest(endpoint: string) {
  return app.fetch(new Request('http://localhost/ready'), {
    NX_CACHE_ACCESS_TOKEN: 'test-token',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_BUCKET_NAME: 'cache',
    S3_ENDPOINT_URL: endpoint,
  });
}

Deno.test('/ready reports 200 when the bucket is reachable', async () => {
  await withStorage(() => new Response(null), async (endpoint) => {
    const response = await readyRequest(endpoint);
    assertEquals(response.status, 200);
    assertEquals(await response.text(), 'OK');
  });
});

for (
  const [name, storage] of [
    ['bucket access is denied', () => new Response(null, { status: 403 })],
    ['the bucket is missing', () => new Response(null, { status: 404 })],
    ['storage fails', () => new Response(null, { status: 500 })],
  ] as const
) {
  Deno.test(`/ready reports 503 without details when ${name}`, async () => {
    await withStorage(storage, async (endpoint) => {
      const response = await readyRequest(endpoint);
      assertEquals(response.status, 503);
      assertEquals(await response.text(), 'Storage unavailable');
    });
  });
}

Deno.test('/ready reports 503 within 2s when storage does not respond', async () => {
  const release = Promise.withResolvers<void>();
  await withStorage(async () => {
    await release.promise;
    return new Response(null);
  }, async (endpoint) => {
    try {
      const started = Date.now();
      const response = await readyRequest(endpoint);
      assertEquals(response.status, 503);
      await response.body?.cancel();
      const elapsed = Date.now() - started;
      assertEquals(elapsed >= 1_900 && elapsed < 3_000, true, `${elapsed}ms`);
    } finally {
      release.resolve();
    }
  });
});

for (const method of ['GET', 'PUT']) {
  Deno.test(`${method} fails with 503 on storage errors when fail-open is disabled`, async () => {
    await withStorage(async (request) => {
      await request.body?.cancel();
      return s3Error('InternalError', 500);
    }, async (endpoint) => {
      const response = await cacheRequest(endpoint, method, {
        body: method === 'PUT' ? 'data' : undefined,
        failOpen: false,
      });
      assertEquals(response.status, 503);
      assertEquals(await response.text(), 'Cache storage unavailable');
    });
  });
}

Deno.test('GET keeps genuine cache misses as 404 when fail-open is disabled', async () => {
  await withStorage(() => s3Error('NoSuchKey', 404), async (endpoint) => {
    const response = await cacheRequest(endpoint, 'GET', { failOpen: false });
    assertEquals(response.status, 404);
    await response.body?.cancel();
  });
});

Deno.test('GET treats a missing bucket as a storage failure, not a miss', async () => {
  await withStorage(() => s3Error('NoSuchBucket', 404), async (endpoint) => {
    const failOpen = await cacheRequest(endpoint, 'GET');
    assertEquals(failOpen.status, 404);
    await failOpen.body?.cancel();
    const failClosed = await cacheRequest(endpoint, 'GET', { failOpen: false });
    assertEquals(failClosed.status, 503);
    assertEquals(await failClosed.text(), 'Cache storage unavailable');
  });
});
