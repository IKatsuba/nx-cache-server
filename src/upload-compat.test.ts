import { assertEquals } from '@std/assert';
import { app } from './index.ts';

for (
  const [code, status, message, expected] of [
    ['NotImplemented', 501, 'A header you provided is not implemented', 200],
    ['InvalidRequest', 400, 'If-None-Match is not supported', 200],
    ['AccessDenied', 403, 'Access denied', 500],
    ['InvalidRequest', 400, 'Invalid checksum', 500],
  ] as const
) {
  Deno.test(`upload compatibility: ${code} (${message})`, async () => {
    const storage = Deno.serve({ port: 0, onListen() {} }, async (request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 404 });
      await request.body?.cancel();
      if (!request.headers.has('if-none-match')) return new Response(null);
      return new Response(
        `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
        {
          status,
          headers: { 'Content-Type': 'application/xml' },
        },
      );
    });
    try {
      const response = await app.fetch(
        new Request('http://localhost/v1/cache/key', {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Length': '8',
          },
          body: 'artifact',
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
      assertEquals(response.status, expected);
      await response.body?.cancel();
    } finally {
      await storage.shutdown();
    }
  });
}
