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
import { join } from '@std/path/join';

interface StorageBackend {
  exists(key: string): Promise<boolean>;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Response>;
}

class S3Backend implements StorageBackend {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
    );
  }

  async get(key: string): Promise<Response> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, { expiresIn: 18000 });
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
  }
}

class FilesystemBackend implements StorageBackend {
  constructor(private readonly cacheDir: string) {}

  private filePath(key: string): string {
    return join(this.cacheDir, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await Deno.stat(this.filePath(key));
      return true;
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await Deno.mkdir(this.cacheDir, { recursive: true });
    await Deno.writeFile(this.filePath(key), data);
  }

  async get(key: string): Promise<Response> {
    try {
      const data = await Deno.readFile(this.filePath(key));
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response('The record was not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw error;
    }
  }
}

export const app = new Hono<{
  Bindings: {
    NX_CACHE_ACCESS_TOKEN: string;
    NX_CACHE_BACKEND: string;
    NX_LOCAL_CACHE_DIR: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    S3_BUCKET_NAME: string;
    S3_ENDPOINT_URL: string;
  };
  Variables: {
    storage: StorageBackend;
  };
}>();

app.use(async (c, next) => {
  const backend = c.env.NX_CACHE_BACKEND || 's3';
  let storage: StorageBackend;

  if (backend === 'filesystem') {
    const cacheDir = c.env.NX_LOCAL_CACHE_DIR || '/tmp/nx-cache';
    storage = new FilesystemBackend(cacheDir);
  } else {
    const client = new S3Client({
      region: c.env.AWS_REGION,
      endpoint: c.env.S3_ENDPOINT_URL,
      credentials: {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
    storage = new S3Backend(client, c.env.S3_BUCKET_NAME);
  }

  c.set('storage', storage);
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
    const storage = c.get('storage');

    try {
      const exists = await storage.exists(hash);
      if (exists) {
        return new Response('Cannot override an existing record', {
          status: 409,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } catch (error: unknown) {
      console.error('Upload error:', error);
      return new Response('Internal server error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const body = await c.req.arrayBuffer();
    await storage.put(hash, new Uint8Array(body));

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

app.get('/v1/cache/:hash', auth(), async (c) => {
  try {
    const hash = c.req.param('hash');
    return await c.get('storage').get(hash);
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
      NX_CACHE_BACKEND: Deno.env.get('NX_CACHE_BACKEND') || 's3',
      NX_LOCAL_CACHE_DIR: Deno.env.get('NX_LOCAL_CACHE_DIR') || '/tmp/nx-cache',
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
      S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL'),
    }));
}
