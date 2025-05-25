import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from 'hono/logger';

import {
  GetObjectCommand,
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
    }),
  );

  await next();
});

const auth = () =>
  createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const token = authHeader.split(' ')[1];

    if (token !== c.env.NX_CACHE_ACCESS_TOKEN) {
      return new Response('Access forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    await next();
  });

app.use(auth());
app.use(logger());

app.get('/health', () => {
  return new Response('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

app.put('/v1/cache/:hash', async (c) => {
  try {
    const hash = c.req.param('hash');

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
      if (error instanceof Error && error.name === 'NotFound') {
        // Do nothing
      } else {
        console.error('Upload error:', error);
        return new Response('Internal server error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    const body = await c.req.arrayBuffer();

    await c.get('s3').send(
      new PutObjectCommand({
        Bucket: c.env.S3_BUCKET_NAME,
        Key: hash,
        Body: new Uint8Array(body),
      }),
    );

    return new Response('Successfully uploaded', {
      status: 202,
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

app.get('/v1/cache/:hash', async (c) => {
  try {
    const hash = c.req.param('hash');

    const command = new GetObjectCommand({
      Bucket: c.env.S3_BUCKET_NAME,
      Key: hash,
    });

    const url = await getSignedUrl(c.get('s3'), command, {
      expiresIn: 18000,
    });

    const response = await fetch(url);

    if (!response.ok) {
      console.error('Download error:', response.statusText);

      await response.body?.cancel();

      if (response.status === 404) {
        return new Response('The record was not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      return new Response('Access forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      return new Response('The record was not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    console.error('Download error:', error);
    return new Response('Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

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
    }));
}
