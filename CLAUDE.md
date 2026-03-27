# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Deno-based HTTP server implementing the [Nx Custom Self-Hosted Remote Cache specification](https://nx.dev/recipes/running-tasks/self-hosted-caching#build-your-own-caching-server). Uses Hono as the HTTP framework and S3-compatible storage (AWS S3 or MinIO) as the cache backend. Published as a multi-platform Docker image to `ghcr.io/ikatsuba/nx-cache-server`.

## Commands

```bash
# Development (watch mode, uses .env.local)
deno task dev

# Production start (uses .env)
deno task start

# Unit tests (requires MinIO running on localhost:9000)
deno task test

# E2E tests (creates a real Nx workspace, requires MinIO + cache server running)
deno task e2e

# Lint and format
deno lint
deno fmt --check
deno fmt

# Start local infrastructure (MinIO + cache server)
docker compose up -d

# Start only MinIO (for running tests against local dev server)
docker compose up s3 create_bucket_and_user -d
```

## Architecture

Single-file application (`src/index.ts`) built on Hono with typed bindings for env vars and an S3Client context variable.

**Request flow:** S3Client init middleware -> Logger middleware -> Auth middleware (Bearer token) -> Route handler

**Routes:**
- `GET /health` — health check (no auth)
- `PUT /v1/cache/:hash` — upload artifact to S3 (checks for duplicates with HeadObject, returns 409 on conflict)
- `GET /v1/cache/:hash` — download artifact via S3 presigned URL

**Key pattern:** The Hono `app` is exported separately from server startup (`if (import.meta.main)`), allowing unit tests to call `app.fetch()` directly with mock env bindings without starting a real server.

## Testing

- **Unit tests** (`src/index.test.ts`): Call `app.fetch()` directly with hardcoded MinIO credentials. Need MinIO running on `localhost:9000`.
- **E2E tests** (`e2e/e2e.test.ts`): Scaffold a full Nx React workspace via `create-nx-workspace`, run builds against the cache server on `localhost:3000`, verify cache miss then cache hit. Uses `@david/dax` for shell commands.

Both test suites require local infrastructure via `docker compose`.

## Environment Variables

Required at runtime: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_ENDPOINT_URL`, `NX_CACHE_ACCESS_TOKEN`. Optional: `PORT` (default 3000).

Local dev values are in `.env.local` (MinIO defaults: `minio`/`minio123`, bucket `nx-cloud`, endpoint `http://localhost:9000`).

## CI/CD

GitHub Actions (`.github/workflows/main.yml`) runs on push/PR to main and releases:
1. **checks**: `deno lint` + `deno fmt --check`
2. **e2e**: starts full docker-compose stack, waits for `/health`, runs `deno task test` + `deno task e2e`
3. **publish** (after checks + e2e pass): builds multi-platform Docker image (amd64/arm64) and pushes to GHCR

## Conventions

- Deno runtime (not Node.js) — use `deno.json` for deps, tasks, and config
- Single quotes enforced via `"fmt": { "singleQuote": true }` in `deno.json`
- Dependencies use `npm:` and `jsr:` specifiers in the `imports` map
- Deno permissions are explicit per task (no `--allow-all`)
