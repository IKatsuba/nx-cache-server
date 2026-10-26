import { assertEquals } from '@std/assert';
import { startEmulator } from '../scripts/start-emulator.ts';
import { app } from './index.ts';

Deno.test('read-only credentials retrieve trusted artifacts but cannot upload', async () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const storage = await startEmulator({ port, bucket: 'nx-cloud' });
  const env = {
    NX_CACHE_ACCESS_TOKEN: 'trusted-token',
    NX_CACHE_READ_ONLY_TOKEN: 'reader-token',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    S3_BUCKET_NAME: 'nx-cloud',
    S3_ENDPOINT_URL: storage.url,
  };
  try {
    const key = crypto.randomUUID();
    const url = `http://localhost/v1/cache/${key}`;
    const trusted = await app.fetch(
      new Request(url, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer trusted-token',
          'Content-Length': '7',
        },
        body: 'trusted',
      }),
      env,
    );
    assertEquals(trusted.status, 200);
    await trusted.body?.cancel();

    const read = await app.fetch(
      new Request(url, {
        headers: { Authorization: 'Bearer reader-token' },
      }),
      env,
    );
    assertEquals(read.status, 200);
    assertEquals(await read.text(), 'trusted');

    const denied = await app.fetch(
      new Request(`${url}-denied`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer reader-token',
          'Content-Length': '4',
        },
        body: new ReadableStream({
          pull() {
            throw new Error('unauthorized upload body must not be read');
          },
        }, { highWaterMark: 0 }),
      }),
      env,
    );
    assertEquals(denied.status, 403);
    await denied.body?.cancel();
    const absent = await app.fetch(
      new Request(`${url}-denied`, {
        headers: { Authorization: 'Bearer trusted-token' },
      }),
      env,
    );
    assertEquals(absent.status, 404);
    await absent.body?.cancel();

    for (const token of ['', 'wrong', 'reader-token extra']) {
      const invalid = await app.fetch(
        new Request(url, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      );
      assertEquals(invalid.status, 401);
      await invalid.body?.cancel();
    }
  } finally {
    await storage.close();
  }
});

Deno.test('invalid server token configuration fails closed without storage access', async () => {
  for (
    const [trusted, reader] of [
      ['', 'reader'],
      ['trusted', ''],
      ['same', 'same'],
      ['trusted token', 'reader'],
    ]
  ) {
    const response = await app.fetch(
      new Request('http://localhost/v1/cache/key', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${reader}`, 'Content-Length': '4' },
        body: 'data',
      }),
      {
        NX_CACHE_ACCESS_TOKEN: trusted,
        ...{ NX_CACHE_READ_ONLY_TOKEN: reader },
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        S3_BUCKET_NAME: 'cache',
        S3_ENDPOINT_URL: 'http://127.0.0.1:1',
      },
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
  }
});
