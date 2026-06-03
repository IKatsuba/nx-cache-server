# Nx Custom Self-Hosted Remote Cache Server

A Deno-based server implementation of the Nx Custom Self-Hosted Remote Cache
specification. This server provides a caching layer for Nx build outputs using
Amazon S3 as the storage backend.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/-bmO7p?referralCode=73cYCO)

## Overview

This server implements the
[Nx Custom Remote Cache OpenAPI specification](https://nx.dev/recipes/running-tasks/self-hosted-caching#build-your-own-caching-server)
and provides a production-ready solution for self-hosting your Nx remote cache.

## Features

- Implements the Nx custom remote cache specification
- Uses Amazon S3 for storage
- Secure authentication using Bearer tokens
- Efficient file streaming
- Production-ready implementation
- Available as a Docker image

## Prerequisites

- [Deno](https://deno.land/) installed on your system
- S3 compatible storage

## Environment Variables

The following environment variables are required:

```env
AWS_REGION=your-aws-region
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=your-bucket-name
S3_ENDPOINT_URL=your-s3-endpoint-url
NX_CACHE_ACCESS_TOKEN=your-secure-token
PORT=3000  # Optional, defaults to 3000
TLS_CERT_PATH=/path/to/tls.crt  # Optional, enables HTTPS (must be set with TLS_KEY_PATH)
TLS_KEY_PATH=/path/to/tls.key   # Optional, enables HTTPS (must be set with TLS_CERT_PATH)
```

See [`.env.example`](.env.example) for a ready-to-copy template.

### HTTPS / TLS

By default the server listens over plain HTTP. To serve over HTTPS directly —
without putting a reverse proxy in front of it — set both `TLS_CERT_PATH` and
`TLS_KEY_PATH` to the PEM cert and key files (they must be set together; setting
only one exits with a configuration error). The files are read once at startup,
so rotating the certificate requires a restart. In Kubernetes, terminating TLS
at the Ingress is usually preferable; this option is for direct exposure or
mutual-TLS setups.

## Installation

### Using Docker

The easiest way to run the server is using the official Docker image:

```bash
docker pull ghcr.io/ikatsuba/nx-cache-server:latest
docker run -p 3000:3000 \
  -e AWS_REGION=your-aws-region \
  -e AWS_ACCESS_KEY_ID=your-access-key \
  -e AWS_SECRET_ACCESS_KEY=your-secret-key \
  -e S3_BUCKET_NAME=your-bucket-name \
  -e S3_ENDPOINT_URL=your-s3-endpoint-url \
  -e NX_CACHE_ACCESS_TOKEN=your-secure-token \
  ghcr.io/ikatsuba/nx-cache-server:latest
```

To serve over HTTPS, mount your PEM cert/key and point the TLS env vars at them:

```bash
docker run -p 3000:3000 \
  -v /host/certs:/certs:ro \
  -e TLS_CERT_PATH=/certs/tls.crt \
  -e TLS_KEY_PATH=/certs/tls.key \
  -e AWS_REGION=your-aws-region \
  -e AWS_ACCESS_KEY_ID=your-access-key \
  -e AWS_SECRET_ACCESS_KEY=your-secret-key \
  -e S3_BUCKET_NAME=your-bucket-name \
  -e S3_ENDPOINT_URL=your-s3-endpoint-url \
  -e NX_CACHE_ACCESS_TOKEN=your-secure-token \
  ghcr.io/ikatsuba/nx-cache-server:latest
```

### Using Helm (Kubernetes)

The chart is published as an OCI artifact to GHCR alongside the Docker image:

```bash
helm install nx-cache oci://ghcr.io/ikatsuba/charts/nx-cache-server \
  --version <X.Y.Z> \
  --namespace nx-cache --create-namespace \
  --set secrets.nxCacheAccessToken=your-secure-token \
  --set secrets.awsAccessKeyId=your-access-key \
  --set secrets.awsSecretAccessKey=your-secret-key \
  --set config.s3.bucketName=your-bucket-name \
  --set config.s3.endpointUrl=https://s3.amazonaws.com
```

See [`charts/nx-cache-server/README.md`](charts/nx-cache-server/README.md) for
the full values reference, externally managed Secret usage, and IRSA / Workload
Identity setup.

### Manual Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd nx-cache-server
```

2. Copy the environment template and fill in your values (the `start` task reads
   `.env`):

```bash
cp .env.example .env
```

3. Start a local S3 emulator (no Docker required — uses
   [emulate.dev](https://emulate.dev)):

```bash
deno task emulate
```

This boots an in-memory AWS emulator on `http://localhost:4566` and seeds the
`nx-cloud` bucket. Leave it running in its own terminal.

## Running the Server

Start the server with:

```bash
deno task start
```

For local development against the emulator above, use:

```bash
deno task dev
```

## Testing

```bash
deno task test
deno task e2e
```

Both suites boot their own emulator and (for e2e) cache server — no separate
setup is required.

## Usage with Nx

To use this cache server with your Nx workspace, set the following environment
variables:

```bash
NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://your-server:3000
NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=your-secure-token
```

## Author

- [Igor Katsuba](https://x.com/katsuba_igor)

## License

MIT
