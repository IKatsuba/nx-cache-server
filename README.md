# Nx Custom Self-Hosted Remote Cache Server

A Deno-based server implementation of the Nx Custom Self-Hosted Remote Cache
specification. This server provides a caching layer for Nx build outputs using
either Amazon S3 or the local filesystem as the storage backend.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/-bmO7p?referralCode=73cYCO)

## Overview

This server implements the
[Nx Custom Remote Cache OpenAPI specification](https://nx.dev/recipes/running-tasks/self-hosted-caching#build-your-own-caching-server)
and provides a production-ready solution for self-hosting your Nx remote cache.

## Features

- Implements the Nx custom remote cache specification
- Pluggable storage backends: Amazon S3 (default) or local filesystem
- Secure authentication using Bearer tokens
- Efficient file streaming
- Production-ready implementation
- Available as a Docker image

## Prerequisites

- [Deno](https://deno.land/) installed on your system
- S3-compatible storage (when using the S3 backend)

## Environment Variables

### Common

| Variable | Required | Default | Description |
|---|---|---|---|
| `NX_CACHE_ACCESS_TOKEN` | Yes | — | Bearer token used to authenticate cache requests |
| `NX_CACHE_BACKEND` | No | `s3` | Storage backend to use: `s3` or `filesystem` |
| `PORT` | No | `3000` | Port the server listens on |

### S3 backend (default)

Required when `NX_CACHE_BACKEND=s3` (or unset):

| Variable | Required | Default | Description |
|---|---|---|---|
| `AWS_REGION` | Yes | — | AWS region (e.g. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Yes | — | AWS / MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | — | AWS / MinIO secret key |
| `S3_BUCKET_NAME` | Yes | `nx-cloud` | S3 bucket to store cache artifacts in |
| `S3_ENDPOINT_URL` | No | — | Custom S3-compatible endpoint (e.g. MinIO) |

### Filesystem backend

Used when `NX_CACHE_BACKEND=filesystem`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `NX_LOCAL_CACHE_DIR` | No | `/tmp/nx-cache` | Directory where cache artifacts are stored |

## Installation

### Using Docker

The easiest way to run the server is using the official Docker image.

**S3 backend:**

```bash
docker pull ghcr.io/ikatsuba/nx-cache-server:latest
docker run -p 3000:3000 \
  -e NX_CACHE_ACCESS_TOKEN=your-secure-token \
  -e AWS_REGION=your-aws-region \
  -e AWS_ACCESS_KEY_ID=your-access-key \
  -e AWS_SECRET_ACCESS_KEY=your-secret-key \
  -e S3_BUCKET_NAME=your-bucket-name \
  -e S3_ENDPOINT_URL=your-s3-endpoint-url \
  ghcr.io/ikatsuba/nx-cache-server:latest
```

**Filesystem backend:**

```bash
docker pull ghcr.io/ikatsuba/nx-cache-server:latest
docker run -p 3000:3000 \
  -e NX_CACHE_ACCESS_TOKEN=your-secure-token \
  -e NX_CACHE_BACKEND=filesystem \
  -e NX_LOCAL_CACHE_DIR=/cache \
  -v /path/on/host:/cache \
  ghcr.io/ikatsuba/nx-cache-server:latest
```

### Manual Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd nx-cloud
```

2. Run docker compose to start the MinIO server:

```bash
docker compose up -d
```

## Running the Server

Start the server with:

```bash
deno task start
```

## Testing

Run the tests with:

```bash
deno task test
deno task e2e
```

> **Note:** The tests assume that the MinIO server is running and that the
> `nx-cloud` bucket exists. Be sure to run
> `docker compose -f docker-compose.yml up s3 create_bucket_and_user -d` before
> running the tests.

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
