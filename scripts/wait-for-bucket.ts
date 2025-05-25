import { HeadBucketCommand, S3Client } from 'npm:@aws-sdk/client-s3';

const BUCKET = Deno.env.get('S3_BUCKET_NAME')!;

const s3 = new S3Client({
  region: Deno.env.get('AWS_REGION')!,
  endpoint: Deno.env.get('S3_ENDPOINT_URL')!,
  credentials: {
    accessKeyId: Deno.env.get('AWS_ACCESS_KEY_ID')!,
    secretAccessKey: Deno.env.get('AWS_SECRET_ACCESS_KEY')!,
  },
  forcePathStyle: true,
});

let found = false;
for (let i = 0; i < 30; i++) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    found = true;
    break;
  } catch (error) {
    console.error('Error waiting for bucket', error);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (!found) {
  console.error('Bucket not found after waiting');
  Deno.exit(1);
}
console.log('Bucket is ready!');
