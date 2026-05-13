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

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      { 'Content-Type': 'application/octet-stream' },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 202);
    const body = await response.text();
    assertEquals(body, 'Successfully uploaded');
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

    assertEquals(response.status, 403);
    const body = await response.text();
    assertEquals(body, 'Access forbidden');
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

    assertEquals(response.status, 403);
    const body = await response.text();
    assertEquals(body, 'Access forbidden');
  });

  it('GET /v1/cache/{hash} - Not Found', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest('GET', `/v1/cache/${hash}`);

    assertEquals(response.status, 404);
    const body = await response.text();
    assertEquals(body, 'The record was not found');
  });
});
