import { createEmulator, type Emulator } from 'emulate';

export interface EmulatorHandle {
  url: string;
  close(): Promise<void>;
}

export async function startEmulator({
  port,
  bucket,
}: {
  port: number;
  bucket: string;
}): Promise<EmulatorHandle> {
  const emulator: Emulator = await createEmulator({
    service: 'aws',
    port,
    seed: {
      aws: {
        region: 'us-east-1',
        s3: { buckets: [{ name: bucket }] },
      },
    },
  });
  return { url: emulator.url, close: () => emulator.close() };
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get('EMULATE_PORT') || '4566');
  const bucket = Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud';
  const handle = await startEmulator({ port, bucket });
  console.log(
    `Emulate AWS service running at ${handle.url} (bucket: ${bucket})`,
  );

  const shutdown = async () => {
    await handle.close();
    Deno.exit(0);
  };
  Deno.addSignalListener('SIGINT', shutdown);
  Deno.addSignalListener('SIGTERM', shutdown);
}
