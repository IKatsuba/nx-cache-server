# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

Deno-based HTTP server implementing the
[Nx Custom Self-Hosted Remote Cache specification](https://nx.dev/recipes/running-tasks/self-hosted-caching#build-your-own-caching-server).
Uses Hono as the HTTP framework and S3-compatible storage (real AWS S3 in
production; [emulate.dev](https://emulate.dev) for local dev/tests) as the cache
backend. Published as a multi-platform Docker image to
`ghcr.io/ikatsuba/nx-cache-server`.

## Commands

```bash
# Start the local S3 emulator (emulate.dev AWS service on :4566, seeds nx-cloud bucket)
deno task emulate

# Development (watch mode, uses .env.local; expects `deno task emulate` running in another terminal)
deno task dev

# Production start (uses .env)
deno task start

# Unit tests (self-host the emulator, no external deps)
deno task test

# E2E tests (creates a real Nx workspace; self-hosts emulator + cache server)
deno task e2e

# Lint and format
deno lint
deno fmt --check
deno fmt
```

## Architecture

Modular application built on Hono with typed bindings (`AppEnv` in
`src/types.ts`) for env vars and an S3Client context variable.

**Structure:**

- `src/index.ts` — app setup, middleware registration, route registration
- `src/types.ts` — shared `AppEnv` type definition
- `src/middleware/auth.ts` — Bearer token authentication
- `src/middleware/s3.ts` — S3 client initialization
- `src/routes/cache.ts` — cache PUT/GET endpoints
- `src/routes/metrics.ts` — metrics endpoints
- `src/metrics/cacheHitRate.ts` — in-memory metrics tracking

**Request flow:** S3Client init middleware -> Logger middleware -> Auth
middleware (Bearer token) -> Route handler

**Routes:**

- `GET /health` — health check (no auth)
- `PUT /v1/cache/:hash` — upload artifact to S3 (requires Content-Length header,
  checks for duplicates with HeadObject, returns 409 on conflict)
- `GET /v1/cache/:hash` — download artifact via S3 presigned URL
- `GET /v1/metrics/json` — JSON time series of cache hit/miss data
- `GET /v1/metrics/chart` — HTML page with inline SVG chart

**Key pattern:** The Hono `app` is exported separately from server startup
(`if (import.meta.main)`), allowing unit tests to call `app.fetch()` directly
with mock env bindings without starting a real server.

## Testing

- **Unit tests** (`src/index.test.ts`): Call `app.fetch()` directly. `beforeAll`
  boots an `emulate.dev` AWS service via `scripts/start-emulator.ts`; `afterAll`
  shuts it down.
- **E2E tests** (`e2e/e2e.test.ts`): Scaffold a full Nx React workspace via
  `create-nx-workspace`. `beforeAll` boots the emulator AND serves the cache
  server in-process on `:3000` (`Deno.serve` + the exported `app`). Then runs
  builds and verifies cache miss then cache hit. Uses `@david/dax` for shell
  commands.

Both suites are self-contained — no Docker, no separate `deno task dev`.

## Environment Variables

Required at runtime: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`S3_BUCKET_NAME`, `S3_ENDPOINT_URL`, `NX_CACHE_ACCESS_TOKEN`. Optional: `PORT`
(default 3000), `METRICS_AUTH` (default `true` — set to `false` to disable auth
on metrics endpoints).

Local dev values are in `.env.local` (emulate.dev's seeded IAM defaults:
`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, bucket
`nx-cloud`, endpoint `http://localhost:4566`).

## CI/CD

GitHub Actions (`.github/workflows/main.yml`) runs on push/PR to main and
releases:

1. **checks**: `deno lint` + `deno fmt --check`
2. **e2e**: runs `deno task test` + `deno task e2e` directly (each suite
   self-hosts its dependencies)
3. **publish** (after checks + e2e pass): builds multi-platform Docker image
   (amd64/arm64) and pushes to GHCR

## Conventions

- Deno runtime (not Node.js) — use `deno.json` for deps, tasks, and config
- Single quotes enforced via `"fmt": { "singleQuote": true }` in `deno.json`
- Dependencies use `npm:` and `jsr:` specifiers in the `imports` map
- Deno permissions are explicit per task (no `--allow-all`)
