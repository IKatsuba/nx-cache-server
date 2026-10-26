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
    NX_CACHE_READ_ONLY_TOKEN?: string;
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

function validateCacheTokens(
  accessToken: unknown,
  readOnlyToken: unknown,
): void {
  if (typeof accessToken !== 'string' || !/^\S+$/.test(accessToken)) {
    throw new Error(
      'NX_CACHE_ACCESS_TOKEN must be a nonempty token without whitespace',
    );
  }
  if (readOnlyToken !== undefined) {
    if (typeof readOnlyToken !== 'string' || !/^\S+$/.test(readOnlyToken)) {
      throw new Error(
        'NX_CACHE_READ_ONLY_TOKEN must be a nonempty token without whitespace',
      );
    }
    if (readOnlyToken === accessToken) {
      throw new Error('Read-only and trusted cache tokens must be different');
    }
  }
}

const auth = (permission: 'read' | 'write') =>
  createMiddleware(async (c, next) => {
    try {
      validateCacheTokens(
        c.env.NX_CACHE_ACCESS_TOKEN,
        c.env.NX_CACHE_READ_ONLY_TOKEN,
      );
    } catch {
      return c.text('Invalid server authentication configuration', 500);
    }
    const token = c.req.header('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (
      !token ||
      (token !== c.env.NX_CACHE_ACCESS_TOKEN &&
        token !== c.env.NX_CACHE_READ_ONLY_TOKEN)
    ) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (permission === 'write' && token !== c.env.NX_CACHE_ACCESS_TOKEN) {
      return c.text('Read-only credentials cannot upload artifacts', 403);
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

app.put('/v1/cache/:hash', auth('write'), async (c) => {
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

app.get('/v1/cache/:hash', auth('read'), async (c) => {
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
  const accessToken = Deno.env.get('NX_CACHE_ACCESS_TOKEN');
  const readOnlyToken = Deno.env.get('NX_CACHE_READ_ONLY_TOKEN');
  try {
    validateCacheTokens(accessToken, readOnlyToken);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }

  const port = parseInt(Deno.env.get('PORT') || '3000');

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
      NX_CACHE_ACCESS_TOKEN: accessToken,
      NX_CACHE_READ_ONLY_TOKEN: readOnlyToken,
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
      S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL'),
    }));
}
