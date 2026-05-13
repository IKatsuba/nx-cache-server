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
- Cache hit rate metrics (JSON and chart endpoints)

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
PORT=3000         # Optional, defaults to 3000
METRICS_AUTH=true # Optional, defaults to true. Set to false to disable auth on metrics endpoints
```

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

2. Start a local S3 emulator (no Docker required — uses
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

## Metrics

The server tracks cache hit/miss statistics and exposes them via two endpoints:

- `GET /v1/metrics/json` — JSON time series data
- `GET /v1/metrics/chart` — HTML page with inline SVG chart

Both endpoints support query parameters:

- `window` — time window (default `6h`). Supports: `30m`, `1h`, `6h`, `1d`, etc.
- `bucket` — aggregation bucket size (default `1m`). Supports: `1m`, `5m`, `1h`,
  etc.

Example: `/v1/metrics/chart?window=1h&bucket=5m`

**Note:** Metrics are currently stored in memory and reset on server restart. S3
persistence is planned for a future version.

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
