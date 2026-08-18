import { assertEquals, assertExists } from '@std/assert';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { startEmulator } from '../scripts/start-emulator.ts';
import { app } from './index.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BUCKET = 'nx-cloud';
const TOKEN = 'test-token';

describe('Cache server routes', () => {
  let endpoint: string;
  let emulator: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    emulator = await startEmulator({ port: 4566, bucket: BUCKET });
    endpoint = emulator.url;
  });

  afterAll(async () => {
    await emulator.close();
  });

  async function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
  ) {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        ...headers,
      },
      body: body as BodyInit | undefined,
    });

    return await app.fetch(req, {
      NX_CACHE_ACCESS_TOKEN: TOKEN,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      S3_BUCKET_NAME: BUCKET,
      S3_ENDPOINT_URL: endpoint,
    });
  }

  it('PUT /v1/cache/{hash} - Success', async () => {
    const hash = crypto.randomUUID();
    const payload = Deno.readFileSync('./src/index.ts');

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.byteLength),
      },
      payload,
    );

    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body, 'Successfully uploaded');
  });

  it('PUT /v1/cache/{hash} - Missing Content-Length', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      { 'Content-Type': 'application/octet-stream' },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 411);
    const body = await response.text();
    assertEquals(body, 'Content-Length header is required');
  });

  it('PUT /v1/cache/{hash} - Unauthorized', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      {
        'Authorization': 'Bearer wrong-token',
        'Content-Length': '10',
      },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 401);
    const body = await response.text();
    assertEquals(body, 'Missing or invalid authentication token');
  });

  it('GET /v1/cache/{hash} - Success', async () => {
    const hash = crypto.randomUUID();

    await makeRequest('PUT', `/v1/cache/${hash}`, {
      'Content-Length': '10',
    }, Deno.readFileSync('./src/index.ts'));

    const response = await makeRequest('GET', `/v1/cache/${hash}`);

    assertEquals(response.status, 200);
    assertExists(response.headers.get('content-type'));

    const body = await response.text();
    assertEquals(body, Deno.readTextFileSync('./src/index.ts'));
  });

  it('GET /v1/cache/{hash} - Unauthorized', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'GET',
      `/v1/cache/${hash}`,
      { 'Authorization': 'Bearer wrong-token' },
    );

    assertEquals(response.status, 401);
    const body = await response.text();
    assertEquals(body, 'Missing or invalid authentication token');
  });

  it('GET /v1/cache/{hash} - Not Found', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest('GET', `/v1/cache/${hash}`);

    assertEquals(response.status, 404);
    const body = await response.text();
    assertEquals(body, 'The record was not found');
  });

  // Regression guard for the IRSA bug: the server used to pass an explicit
  // `credentials` object unconditionally, which short-circuits the AWS SDK's
  // default provider chain before it can read AWS_WEB_IDENTITY_TOKEN_FILE.
  //
  // With no keys in the bindings the request can only succeed if the SDK
  // resolved credentials itself. It does not prove *which* provider won - the
  // emulator does not verify signatures - only that the chain was consulted
  // rather than bypassed, which is exactly what the bug prevented.
  it('PUT /v1/cache/{hash} - no static keys, credentials from the SDK chain', async () => {
    const hash = crypto.randomUUID();
    const payload = new TextEncoder().encode('default-credential-chain');

    Deno.env.set('AWS_ACCESS_KEY_ID', ACCESS_KEY_ID);
    Deno.env.set('AWS_SECRET_ACCESS_KEY', SECRET_ACCESS_KEY);

    try {
      const req = new Request(`http://localhost/v1/cache/${hash}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.byteLength),
        },
        body: payload,
      });

      const response = await app.fetch(req, {
        NX_CACHE_ACCESS_TOKEN: TOKEN,
        AWS_REGION: 'us-east-1',
        S3_BUCKET_NAME: BUCKET,
        S3_ENDPOINT_URL: endpoint,
      });

      assertEquals(response.status, 200);
      assertEquals(await response.text(), 'Successfully uploaded');
    } finally {
      Deno.env.delete('AWS_ACCESS_KEY_ID');
      Deno.env.delete('AWS_SECRET_ACCESS_KEY');
    }
  });
});
