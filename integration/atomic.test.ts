import { assertEquals } from '@std/assert';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { app } from '../src/index.ts';

// Optional atomic-write capability contract. Normal upload compatibility does
// not depend on this capability. See README.md for configuration.
Deno.test('concurrent uploads create exactly one immutable artifact', async () => {
  const endpoint = Deno.env.get('S3_ENDPOINT_URL');
  const bucket = Deno.env.get('S3_BUCKET_NAME');
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Configure S3_ENDPOINT_URL, S3_BUCKET_NAME and AWS credentials',
    );
  }
  const env = {
    NX_CACHE_ACCESS_TOKEN: 'atomic-test-token',
    AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    S3_BUCKET_NAME: bucket,
    S3_ENDPOINT_URL: endpoint,
  };
  const key = `atomic-${crypto.randomUUID()}`;
  const url = `http://localhost/v1/cache/${key}`;
  const storage = new S3Client({
    region: env.AWS_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const gate = Promise.withResolvers<void>();
  let readers = 0;
  // Bound failures before both requests reach body consumption.
  const timeout = setTimeout(() => gate.resolve(), 5_000);
  try {
    const payloads = ['first artifact', 'second artifact'];
    const upload = (body: string) =>
      app.fetch(
        new Request(url, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer atomic-test-token',
            'Content-Length': String(new TextEncoder().encode(body).byteLength),
          },
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              readers++;
              if (readers === 2) gate.resolve();
              await gate.promise;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }, { highWaterMark: 0 }),
        }),
        env,
      );
    const responses = await Promise.all(payloads.map(upload));
    const statuses = responses.map((response) => response.status);
    await Promise.all(responses.map((response) => response.body?.cancel()));
    assertEquals(readers, 2, 'both uploads must pass HEAD before either PUT');
    assertEquals([...statuses].sort(), [200, 409]);

    const winner = payloads[statuses.indexOf(200)];
    const stored = await app.fetch(
      new Request(url, {
        headers: { Authorization: 'Bearer atomic-test-token' },
      }),
      env,
    );
    assertEquals(stored.status, 200);
    assertEquals(await stored.text(), winner);

    const overwrite = await upload('replacement');
    assertEquals(overwrite.status, 409);
    await overwrite.body?.cancel();
    const after = await app.fetch(
      new Request(url, {
        headers: { Authorization: 'Bearer atomic-test-token' },
      }),
      env,
    );
    assertEquals(after.status, 200);
    assertEquals(await after.text(), winner);
  } finally {
    clearTimeout(timeout);
    gate.resolve();
    try {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } finally {
      storage.destroy();
    }
  }
});
