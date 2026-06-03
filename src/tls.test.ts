import { assertEquals } from '@std/assert';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { app } from './index.ts';

const CERT = Deno.readTextFileSync('./src/fixtures/tls/cert.pem');
const KEY = Deno.readTextFileSync('./src/fixtures/tls/key.pem');
const CA = Deno.readTextFileSync('./src/fixtures/tls/ca.pem');

// /health needs no S3/auth, but the S3 middleware runs on every request, so
// supply harmless bindings to keep the S3Client constructor happy.
const ENV = {
  NX_CACHE_ACCESS_TOKEN: 'test-token',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  S3_BUCKET_NAME: 'nx-cloud',
  S3_ENDPOINT_URL: 'http://localhost:4566',
};

describe('TLS/HTTPS server', () => {
  let server: Deno.HttpServer;
  let client: Deno.HttpClient;
  let baseUrl: string;

  beforeAll(() => {
    server = Deno.serve(
      { port: 0, cert: CERT, key: KEY, onListen: () => {} },
      (req) => app.fetch(req, ENV),
    );
    const { port } = server.addr as Deno.NetAddr;
    baseUrl = `https://localhost:${port}`;
    // Trust the fixture CA so fetch() accepts the server's leaf cert.
    client = Deno.createHttpClient({ caCerts: [CA] });
  });

  afterAll(async () => {
    client.close();
    await server.shutdown();
  });

  it('serves /health over HTTPS', async () => {
    const response = await fetch(`${baseUrl}/health`, { client });

    assertEquals(response.status, 200);
    assertEquals(await response.text(), 'OK');
  });
});
