import { assertEquals, assertExists } from '@std/assert';
import { app } from './index.ts';

async function makeRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Uint8Array,
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Authorization': 'Bearer test-token',
      ...headers,
    },
    body: body as BodyInit | null | undefined,
  });

  return await app.fetch(req, {
    NX_CACHE_ACCESS_TOKEN: 'test-token',
    NX_CACHE_BACKEND: 's3',
    NX_LOCAL_CACHE_DIR: '',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'minio',
    AWS_SECRET_ACCESS_KEY: 'minio123',
    S3_BUCKET_NAME: 'nx-cloud',
    S3_ENDPOINT_URL: 'http://localhost:9000',
  });
}

async function makeFilesystemRequest(
  method: string,
  path: string,
  cacheDir: string,
  headers: Record<string, string> = {},
  body?: Uint8Array,
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Authorization': 'Bearer test-token',
      ...headers,
    },
    body: body as BodyInit | null | undefined,
  });

  return await app.fetch(req, {
    NX_CACHE_ACCESS_TOKEN: 'test-token',
    NX_CACHE_BACKEND: 'filesystem',
    NX_LOCAL_CACHE_DIR: cacheDir,
    AWS_REGION: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    S3_BUCKET_NAME: '',
    S3_ENDPOINT_URL: '',
  });
}

Deno.test('PUT /v1/cache/{hash} - Success', async () => {
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

Deno.test('PUT /v1/cache/{hash} - Unauthorized', async () => {
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

Deno.test('GET /v1/cache/{hash} - Success', async () => {
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

Deno.test('GET /v1/cache/{hash} - Unauthorized', async () => {
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

Deno.test('GET /v1/cache/{hash} - Not Found', async () => {
  const hash = crypto.randomUUID();

  const response = await makeRequest('GET', `/v1/cache/${hash}`);

  assertEquals(response.status, 404);
  const body = await response.text();
  assertEquals(body, 'The record was not found');
});

Deno.test('Filesystem - PUT /v1/cache/{hash} - Success', async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    const hash = crypto.randomUUID();
    const response = await makeFilesystemRequest(
      'PUT',
      `/v1/cache/${hash}`,
      cacheDir,
      { 'Content-Type': 'application/octet-stream' },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 202);
    assertEquals(await response.text(), 'Successfully uploaded');
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test('Filesystem - PUT /v1/cache/{hash} - Conflict', async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    const hash = crypto.randomUUID();
    const data = Deno.readFileSync('./src/index.ts');

    await makeFilesystemRequest('PUT', `/v1/cache/${hash}`, cacheDir, {}, data);
    const response = await makeFilesystemRequest(
      'PUT',
      `/v1/cache/${hash}`,
      cacheDir,
      {},
      data,
    );

    assertEquals(response.status, 409);
    assertEquals(await response.text(), 'Cannot override an existing record');
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test('Filesystem - GET /v1/cache/{hash} - Success', async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    const hash = crypto.randomUUID();
    const data = Deno.readFileSync('./src/index.ts');

    await makeFilesystemRequest('PUT', `/v1/cache/${hash}`, cacheDir, {}, data);
    const response = await makeFilesystemRequest(
      'GET',
      `/v1/cache/${hash}`,
      cacheDir,
    );

    assertEquals(response.status, 200);
    assertExists(response.headers.get('content-type'));
    const body = await response.arrayBuffer();
    assertEquals(new Uint8Array(body), data);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test('Filesystem - GET /v1/cache/{hash} - Not Found', async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    const hash = crypto.randomUUID();
    const response = await makeFilesystemRequest(
      'GET',
      `/v1/cache/${hash}`,
      cacheDir,
    );

    assertEquals(response.status, 404);
    assertEquals(await response.text(), 'The record was not found');
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
