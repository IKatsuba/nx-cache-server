import { assertEquals } from '@std/assert';
import { app } from './index.ts';

Deno.test('storage receives upload bytes before the client finishes sending', async () => {
  const receivedPrefix = Promise.withResolvers<void>();
  let sourceFinished = false;
  let streamedBeforeEof = false;
  let stored = '';
  // A deadline releases the old buffering deadlock; progress uses a real signal,
  // not a guessed delay. A streaming implementation never waits for this timer.
  const deadline = setTimeout(() => receivedPrefix.resolve(), 5_000);
  const storage = Deno.serve({ port: 0, onListen() {} }, async (request) => {
    if (request.method === 'HEAD') return new Response(null, { status: 404 });
    for await (const chunk of request.body!) {
      streamedBeforeEof ||= !sourceFinished;
      receivedPrefix.resolve();
      stored += new TextDecoder().decode(chunk);
    }
    return new Response(null);
  });
  try {
    const response = await app.fetch(
      new Request('http://localhost/v1/cache/streamed', {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-token', 'Content-Length': '15' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
            controller.enqueue(new TextEncoder().encode('middle'));
          },
          async pull(controller) {
            await receivedPrefix.promise;
            sourceFinished = true;
            controller.enqueue(new TextEncoder().encode('last'));
            controller.close();
          },
        }, { highWaterMark: 0 }),
      }),
      {
        NX_CACHE_ACCESS_TOKEN: 'test-token',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        S3_BUCKET_NAME: 'cache',
        S3_ENDPOINT_URL: `http://127.0.0.1:${storage.addr.port}`,
      },
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(
      streamedBeforeEof,
      true,
      'storage must receive bytes before client EOF',
    );
    assertEquals(stored, 'firstmiddlelast');
  } finally {
    clearTimeout(deadline);
    receivedPrefix.resolve();
    await storage.shutdown();
  }
});

Deno.test('a client body error fails its upload without an unhandled stream error', async () => {
  const storage = Deno.serve({ port: 0, onListen() {} }, async (request) => {
    if (request.method === 'HEAD') return new Response(null, { status: 404 });
    try {
      await request.arrayBuffer();
      return new Response(null);
    } catch {
      // A failed source must close the upstream request before it can commit.
      return new Response(null, { status: 400 });
    }
  });
  try {
    const response = await app.fetch(
      new Request('http://localhost/v1/cache/broken', {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-token', 'Content-Length': '15' },
        body: new ReadableStream({
          pull(controller) {
            controller.error(new Error('client disconnected'));
          },
        }, { highWaterMark: 0 }),
      }),
      {
        NX_CACHE_ACCESS_TOKEN: 'test-token',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        S3_BUCKET_NAME: 'cache',
        S3_ENDPOINT_URL: `http://127.0.0.1:${storage.addr.port}`,
      },
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
  } finally {
    await storage.shutdown();
  }
});

Deno.test('an upstream rejection cancels the unfinished client body', async () => {
  const cancelled = Promise.withResolvers<void>();
  const storage = Deno.serve({ port: 0, onListen() {} }, (request) => {
    if (request.method === 'HEAD') return new Response(null, { status: 404 });
    return new Response('<Error><Code>AccessDenied</Code></Error>', {
      status: 403,
      headers: { 'Content-Type': 'application/xml' },
    });
  });
  // Bound cleanup failures without adding a delay on the successful path.
  const deadline = setTimeout(
    () => cancelled.reject(new Error('source was not cancelled')),
    5_000,
  );
  try {
    const response = await app.fetch(
      new Request('http://localhost/v1/cache/rejected', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Length': '1048576',
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      }),
      {
        NX_CACHE_ACCESS_TOKEN: 'test-token',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        S3_BUCKET_NAME: 'cache',
        S3_ENDPOINT_URL: `http://127.0.0.1:${storage.addr.port}`,
      },
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
    await cancelled.promise;
  } finally {
    clearTimeout(deadline);
    await storage.shutdown();
  }
});
