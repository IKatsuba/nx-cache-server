import { assertEquals, assertExists, assertThrows } from '@std/assert';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { startEmulator } from '../scripts/start-emulator.ts';
import type { Bindings } from './index.ts';
import { app, s3Client, staticCredentials } from './index.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BUCKET = 'nx-cloud';
const TOKEN = 'test-token';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}

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
    bindings?: Partial<Bindings>,
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
      ...bindings,
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

  // Regression guard for issue #12 (IRSA / Workload Identity could not work).
  //
  // The S3 client used to be constructed with an explicit `credentials` object
  // whether or not the keys were set. An explicit credentials value
  // short-circuits the AWS SDK's provider chain before it reads
  // AWS_WEB_IDENTITY_TOKEN_FILE, so a pod relying on a projected web-identity
  // token could never authenticate: absent keys failed with "Resolved
  // credential object is not valid" and empty keys produced an S3 400.
  // Running this test against that code reproduces the former.
  //
  // With no keys in the bindings the request can only succeed if the SDK
  // resolved credentials itself. It does not prove *which* provider won - the
  // emulator does not verify signatures - only that the chain was consulted
  // rather than bypassed, which is what the bug prevented.
  it('PUT /v1/cache/{hash} - no static keys, credentials from the SDK chain', async () => {
    const hash = crypto.randomUUID();
    const payload = new TextEncoder().encode('default-credential-chain');

    // .env.local already puts these in the process env; set them explicitly so
    // the test does not depend on that, and restore whatever was there before.
    const previous = {
      id: Deno.env.get('AWS_ACCESS_KEY_ID'),
      secret: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
    };
    Deno.env.set('AWS_ACCESS_KEY_ID', ACCESS_KEY_ID);
    Deno.env.set('AWS_SECRET_ACCESS_KEY', SECRET_ACCESS_KEY);

    try {
      const response = await makeRequest(
        'PUT',
        `/v1/cache/${hash}`,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.byteLength),
        },
        payload,
        { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined },
      );

      assertEquals(response.status, 200);
      assertEquals(await response.text(), 'Successfully uploaded');
    } finally {
      restoreEnv('AWS_ACCESS_KEY_ID', previous.id);
      restoreEnv('AWS_SECRET_ACCESS_KEY', previous.secret);
    }
  });
});

describe('staticCredentials', () => {
  const base = {
    NX_CACHE_ACCESS_TOKEN: TOKEN,
    AWS_REGION: 'us-east-1',
    S3_BUCKET_NAME: BUCKET,
    S3_ENDPOINT_URL: 'http://localhost:4566',
  };

  it('returns undefined when both keys are unset, so the SDK chain runs', () => {
    assertEquals(staticCredentials({ ...base }), undefined);
  });

  it('returns the pair when both keys are set', () => {
    assertEquals(
      staticCredentials({
        ...base,
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      }),
      { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    );
  });

  it('throws when only one key is set', () => {
    assertThrows(
      () => staticCredentials({ ...base, AWS_ACCESS_KEY_ID: ACCESS_KEY_ID }),
      Error,
      'must both be non-empty, or both unset',
    );
  });

  // An empty value is a leftover placeholder, not a request to use the chain:
  // falling back silently would sign as whatever ambient identity exists.
  it('throws when a key is an empty string', () => {
    assertThrows(
      () =>
        staticCredentials({
          ...base,
          AWS_ACCESS_KEY_ID: '',
          AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        }),
      Error,
      'must both be non-empty, or both unset',
    );
  });
});

describe('s3Client', () => {
  const base = {
    NX_CACHE_ACCESS_TOKEN: TOKEN,
    AWS_REGION: 'us-east-1',
    S3_BUCKET_NAME: BUCKET,
    S3_ENDPOINT_URL: 'http://localhost:4566',
  };

  // Credentials are cached per client instance, so a client per request means
  // an STS round-trip per request once the default chain is in play.
  it('reuses one client per configuration and separates distinct ones', () => {
    assertEquals(s3Client({ ...base }), s3Client({ ...base }));
    assertEquals(
      s3Client({ ...base, S3_ENDPOINT_URL: 'http://localhost:9000' }) ===
        s3Client({ ...base }),
      false,
    );
  });
});
