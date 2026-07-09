# sorobanpool-backend

NestJS backend for SorobanPool (API, workers, indexer, keeper, relayer). **Buy together. Pay on delivery.** Built on Stellar.

```
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install && pnpm start:dev     # GET /health
pnpm lint && pnpm build && pnpm test && pnpm test:e2e
```
One codebase, role chosen by `ROLE=api|worker|indexer`. Status: feature-complete for the testnet build — verified end to end on Stellar testnet (`test/e2e/`, plus the frontend's Playwright acceptance suites). Not production-ready: see "Not done yet".

The product and architecture brief (source of truth): [sorobanpool-contracts/docs/brief.md](https://github.com/SorobanPool/sorobanpool-contracts/blob/main/docs/brief.md). Sibling repos: [contracts](https://github.com/SorobanPool/sorobanpool-contracts), [backend](https://github.com/SorobanPool/sorobanpool-backend), [frontend](https://github.com/SorobanPool/sorobanpool-frontend).

## Verify
```
pnpm lint && pnpm exec tsc --noEmit && pnpm build && pnpm test          # 175+ tests, real Postgres semantics via PGlite
E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm test:e2e                          # live testnet: full group-buy lifecycle through the API
```
Docs: `docs/api.md`, `docs/decisions/`, `docs/runbooks/`.

## What runs where
- **API** (`ROLE=api`): REST under `/v1` (see `docs/api.md`, `docs/openapi.json`, `GET /v1/openapi.json`), rate limited per client IP (`RATE_LIMIT_PER_MIN`), Prometheus metrics at `GET /v1/metrics` (`METRICS_TOKEN`; required in production), live pool updates over SSE at `GET /v1/pools/:id/stream`.
- **Workers** (`ROLE=worker` or `KEEPER_EMBEDDED`): keeper (close/fail/allocate/settle/push-refunds/dispute-timeout), `ttl-extend`, maintenance (offer expiry, sponsor-balance alert, 24h deadline reminders, read-model reconcile against the chain), notifier (SMS queue with quiet hours and retries).
- **Indexer** (`ROLE=indexer` or `INDEXER_EMBEDDED`): events to read model, atomic and idempotent; newly applied events enqueue member SMS.
- **Sign-in**: phone OTP, plus passkeys (WebAuthn) registered after an OTP login.
- **Storage**: local filesystem by default; `OBJECT_STORE=s3` for any S3-compatible service (AWS S3, R2, MinIO).
- **Errors**: `SENTRY_DSN` enables Sentry for unexpected 500s and job crashes (no request data is sent).
Operations: `docs/runbooks/`.

## Not done yet
- **Needs a decision or an outside party**: real naira anchor and withdrawals (ADR 0005; only a mock exists), a live FX source (static rates only; so no `fx-refresh` job), real SMS/WhatsApp and KYC/KYB providers (a console sender and the `SmsSender` port exist), passkey-controlled smart wallets (ADR 0003; passkeys here are sign-in only), the external audit and mainnet pilot.
- **Engineering left**: BullMQ scheduling (ADR 0002; needs Redis, an in-process interval scheduler runs today, so run one worker replica), OpenTelemetry, WebSocket transport (SSE is used instead), a pager integration (alerts are log lines), multi-replica rate limiting (the limiter is per process).
- **Not exercised against real providers**: the S3 adapter (tested against a local S3-style endpoint), Sentry delivery (tested against a local endpoint), the Horizon sponsor-balance read.
