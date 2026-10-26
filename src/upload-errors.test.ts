import { assertEquals } from '@std/assert';
import { app } from './index.ts';

for (
  const [code, storageStatus, expectedStatus] of [
    ['PreconditionFailed', 412, 409],
    ['ConditionalRequestConflict', 409, 503],
  ] as const
) {
  Deno.test(`upload translates S3 ${code} to HTTP ${expectedStatus}`, async () => {
    const storage = Deno.serve({ port: 0, onListen() {} }, async (request) => {
      if (request.method === 'HEAD') {
        return new Response(null, { status: 404 });
      }
      await request.body?.cancel();
      return new Response(`<Error><Code>${code}</Code></Error>`, {
        status: storageStatus,
        headers: { 'Content-Type': 'application/xml' },
      });
    });
    try {
      const response = await app.fetch(
        new Request('http://localhost/v1/cache/key', {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Length': '4',
          },
          body: 'data',
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
      assertEquals(response.status, expectedStatus);
      await response.body?.cancel();
    } finally {
      await storage.shutdown();
    }
  });
}
