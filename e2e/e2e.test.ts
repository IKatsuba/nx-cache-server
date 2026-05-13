import $ from '@david/dax';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { join } from '@std/path/join';
import { startEmulator } from '../scripts/start-emulator.ts';

function generateRandomString(length: number) {
  return Math.random().toString(36).substring(2, 2 + length);
}

function getFreePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Cache server did not become ready at ${url}`);
}

const CACHE_TOKEN = 'test-token';
const BUCKET = 'nx-cloud';
const EMULATE_PORT = 4566;

describe('Remote Cache', () => {
  const workspaceName = generateRandomString(10);
  let emulator: { url: string; close(): Promise<void> };
  let cacheServer: Deno.ChildProcess;
  let cacheServerUrl: string;

  beforeAll(async () => {
    emulator = await startEmulator({ port: EMULATE_PORT, bucket: BUCKET });

    const cachePort = getFreePort();
    cacheServerUrl = `http://localhost:${cachePort}`;

    cacheServer = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-env',
        '--allow-net',
        '--allow-sys',
        '--allow-read',
        'src/index.ts',
      ],
      env: {
        PORT: String(cachePort),
        NX_CACHE_ACCESS_TOKEN: CACHE_TOKEN,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        S3_BUCKET_NAME: BUCKET,
        S3_ENDPOINT_URL: emulator.url,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn();

    await waitForHealth(cacheServerUrl);

    await $`rm -rf tmp`;
    await $`mkdir -p tmp`;

    await $`npx -y create-nx-workspace@20.8 --name=${workspaceName} --preset=react-monorepo --interactive=false --workspaceType=integrated --appName=web --e2eTestRunner=none --unitTestRunner=none --skipGit`
      .cwd(join(Deno.cwd(), 'tmp'));
  });

  afterAll(async () => {
    try {
      cacheServer.kill('SIGTERM');
      await cacheServer.status;
    } catch {
      // already exited
    }
    await emulator.close();
  });

  it('should store and retrieve cache artifacts', async () => {
    const workspacePath = join(Deno.cwd(), 'tmp', workspaceName);

    await $`echo 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER=${cacheServerUrl}' >> .env`
      .cwd(workspacePath);
    await $`echo 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=${CACHE_TOKEN}' >> .env`
      .cwd(workspacePath);

    const firstBuild = await $`npx nx build web --verbose`
      .cwd(workspacePath)
      .env('NX_SELF_HOSTED_REMOTE_CACHE_SERVER', cacheServerUrl)
      .env('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN', CACHE_TOKEN)
      .printCommand().stdout('inheritPiped');

    if (
      !firstBuild.stdout.includes(
        'Successfully ran target build for project web',
      )
    ) {
      console.log(firstBuild.stdout);
      throw new Error('Expected cache miss on first build');
    }

    const secondBuild = await $`npx nx build web`
      .cwd(workspacePath)
      .env('NX_SELF_HOSTED_REMOTE_CACHE_SERVER', cacheServerUrl)
      .env('NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN', CACHE_TOKEN)
      .printCommand().stdout('inheritPiped');

    if (
      !secondBuild.stdout.includes(
        'Nx read the output from the cache instead',
      )
    ) {
      console.log(secondBuild.stdout);
      throw new Error('Expected cache hit on second build');
    }
  });
});
