import type { S3Client } from '@aws-sdk/client-s3';

export type AppEnv = {
  Bindings: {
    NX_CACHE_ACCESS_TOKEN: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    S3_BUCKET_NAME: string;
    S3_ENDPOINT_URL: string;
    METRICS_AUTH: string;
  };
  Variables: {
    s3: S3Client;
  };
};
