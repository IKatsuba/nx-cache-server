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

export type Bindings = {
  NX_CACHE_ACCESS_TOKEN: string;
  AWS_REGION: string;
  // Optional: when both are unset the AWS SDK's default credential chain is
  // used instead (env -> web identity / IRSA -> IMDS). Setting only one, or
  // setting either to an empty string, is a configuration error.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  S3_BUCKET_NAME: string;
  S3_ENDPOINT_URL: string;
};

/**
 * Resolves the static credentials to hand to the S3 client, or `undefined` to
 * let the SDK's default provider chain run.
 *
 * An explicit credentials object short-circuits that chain before it reads
 * AWS_WEB_IDENTITY_TOKEN_FILE, so it must only be passed when the keys are
 * genuinely configured. Empty strings are rejected rather than ignored: they
 * are almost always a leftover placeholder, and silently falling back to an
 * ambient identity (an EC2 node role, say) would sign requests as something
 * the operator never chose.
 */
export function staticCredentials(env: Bindings) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;

  if (accessKeyId === undefined && secretAccessKey === undefined) {
    return undefined;
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be non-empty, or both unset',
    );
  }

  return { accessKeyId, secretAccessKey };
}

// The SDK caches resolved credentials per client instance, so a client built
// per request means a fresh AssumeRoleWithWebIdentity on every cache hit under
// IRSA. One process only ever sees one set of bindings; the tests are what make
// this a map rather than a single value.
const clients = new Map<string, S3Client>();

export function s3Client(env: Bindings): S3Client {
  const credentials = staticCredentials(env);
  const key = [
    env.AWS_REGION,
    env.S3_ENDPOINT_URL,
    credentials?.accessKeyId ?? '',
    credentials?.secretAccessKey ?? '',
  ].join('\u0000');

  let client = clients.get(key);
  if (!client) {
    client = new S3Client({
      region: env.AWS_REGION,
      endpoint: env.S3_ENDPOINT_URL,
      ...(credentials ? { credentials } : {}),
      forcePathStyle: true,
    });
    clients.set(key, client);
  }

  return client;
}

export const app = new Hono<{
  Bindings: Bindings;
  Variables: {
    s3: S3Client;
  };
}>();

app.use(async (c, next) => {
  c.set('s3', s3Client(c.env));

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

app.get('/v1/cache/:hash', auth(), async (c) => {
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
  const port = parseInt(Deno.env.get('PORT') || '3000');

  const env: Bindings = {
    NX_CACHE_ACCESS_TOKEN: Deno.env.get('NX_CACHE_ACCESS_TOKEN')!,
    AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
    AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
    S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
    S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL')!,
  };

  let credentials;
  try {
    credentials = staticCredentials(env);
  } catch (e) {
    console.error(
      `AWS credential misconfiguration: ${e instanceof Error ? e.message : e}`,
    );
    Deno.exit(1);
  }

  // Nothing static configured, so the SDK's chain has to supply them. Resolve
  // once now rather than letting the first cache request discover there is no
  // credential source at all, after waiting out the IMDS timeouts. The client
  // is memoized, so this also warms the cache for that first request.
  if (!credentials) {
    try {
      await s3Client(env).config.credentials();
    } catch (e) {
      console.error(
        `No AWS credentials could be resolved: ${
          e instanceof Error ? e.message : e
        }`,
      );
      Deno.exit(1);
    }
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

  Deno.serve({ port, ...tls }, (req) => app.fetch(req, env));
}
