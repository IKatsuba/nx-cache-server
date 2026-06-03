import $ from '@david/dax';
import { assertEquals } from '@std/assert';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { join } from '@std/path/join';
import { startEmulator } from '../scripts/start-emulator.ts';

const CACHE_TOKEN = 'test-token';
const BUCKET = 'nx-cloud';
// Distinct from the Nx e2e emulator (4566) so the two suites never collide.
const EMULATE_PORT = 4567;
const CA = join(Deno.cwd(), 'src', 'fixtures', 'tls', 'ca.pem');
const CERT = join(Deno.cwd(), 'src', 'fixtures', 'tls', 'cert.pem');
const KEY = join(Deno.cwd(), 'src', 'fixtures', 'tls', 'key.pem');
const AUTH = `Authorization: Bearer ${CACHE_TOKEN}`;

function getFreePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForHealth(
  url: string,
  client: Deno.HttpClient,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { client });
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Cache server did not become ready at ${url}`);
}

// Drives the real `src/index.ts` process over HTTPS with an external client
// (curl), exercising the TLS startup wiring and a full PUT -> GET round-trip
// through the S3 emulator — the path Nx's native client cannot take with a
// self-signed cert.
describe('Remote Cache over HTTPS (curl)', () => {
  let emulator: { url: string; close(): Promise<void> };
  let server: Deno.ChildProcess;
  let url: string;
  let client: Deno.HttpClient;

  beforeAll(async () => {
    emulator = await startEmulator({ port: EMULATE_PORT, bucket: BUCKET });

    const port = getFreePort();
    url = `https://localhost:${port}`;
    server = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-env',
        '--allow-net',
        '--allow-sys',
        '--allow-read',
        'src/index.ts',
      ],
      env: {
        PORT: String(port),
        TLS_CERT_PATH: CERT,
        TLS_KEY_PATH: KEY,
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

    client = Deno.createHttpClient({ caCerts: [Deno.readTextFileSync(CA)] });
    await waitForHealth(url, client);
  });

  afterAll(async () => {
    try {
      server.kill('SIGTERM');
      await server.status;
    } catch {
      // already exited
    }
    client?.close();
    await emulator.close();
  });

  it('uploads and downloads an artifact over HTTPS', async () => {
    const hash = crypto.randomUUID();
    const payload = `tls-artifact-${hash}`;
    const tmp = await Deno.makeTempFile();
    Deno.writeTextFileSync(tmp, payload);

    try {
      const putCode = await $`curl -sS -o /dev/null -w ${'%{http_code}'} \
        -X PUT --cacert ${CA} -H ${AUTH} --data-binary ${`@${tmp}`} \
        ${`${url}/v1/cache/${hash}`}`.text();
      assertEquals(putCode, '200');

      const body = await $`curl -sS --cacert ${CA} -H ${AUTH} \
        ${`${url}/v1/cache/${hash}`}`.text();
      assertEquals(body, payload);
    } finally {
      await Deno.remove(tmp);
    }
  });

  it('rejects unauthenticated requests over HTTPS', async () => {
    const hash = crypto.randomUUID();
    const code = await $`curl -sS -o /dev/null -w ${'%{http_code}'} \
      --cacert ${CA} ${`${url}/v1/cache/${hash}`}`.text();
    assertEquals(code, '401');
  });
});
