import type { S3Client } from '@aws-sdk/client-s3';
import { S3Client as S3ClientImpl } from '@aws-sdk/client-s3';
import type { MiddlewareHandler } from 'hono';

export const s3Middleware = (): MiddlewareHandler => {
  return async (c, next) => {
    c.set(
      's3',
      new S3ClientImpl({
        region: c.env.AWS_REGION,
        endpoint: c.env.S3_ENDPOINT_URL,
        credentials: {
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      }) as S3Client,
    );

    await next();
  };
};
