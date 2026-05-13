import type { Hono } from 'hono';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { recordCacheGetOutcome } from '../metrics/cacheHitRate.ts';
import type { AppEnv } from '../types.ts';

// deno-lint-ignore no-explicit-any
export function registerCacheRoutes(app: Hono<AppEnv>, auth: () => any) {
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

      // record cache hit/miss
      recordCacheGetOutcome(response.status);

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
      const responseContentLength = response.headers.get('Content-Length');
      if (responseContentLength) {
        headers.set('Content-Length', responseContentLength);
      }

      return new Response(response.body, {
        status: 200,
        headers,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NoSuchKey') {
        recordCacheGetOutcome(404);
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
}
