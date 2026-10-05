# sorobanpool-backend

NestJS backend for SorobanPool (API, workers, indexer, keeper, relayer). **Buy together. Pay on delivery.** Built on Stellar.

```
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install && pnpm start:dev     # GET /health
pnpm lint && pnpm build && pnpm test && pnpm test:e2e
```
One codebase, role chosen by `ROLE=api|worker|indexer`. Status: M2 (backend core) — verified end to end on Stellar testnet (`test/e2e/m2-flow.e2e-spec.ts`).

The product and architecture brief (source of truth): [sorobanpool-contracts/docs/brief.md](https://github.com/SorobanPool/sorobanpool-contracts/blob/main/docs/brief.md). Sibling repos: [contracts](https://github.com/SorobanPool/sorobanpool-contracts), [backend](https://github.com/SorobanPool/sorobanpool-backend), [frontend](https://github.com/SorobanPool/sorobanpool-frontend).

## Verify
```
pnpm lint && pnpm exec tsc --noEmit && pnpm build && pnpm test          # 126+ tests, real Postgres semantics via PGlite
E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm test:e2e                          # live testnet: full group-buy lifecycle through the API
```
Docs: `docs/api.md`, `docs/decisions/`, `docs/runbooks/`.

## Not done yet (M2 scope gaps)
BullMQ scheduling (ADR 0002), S3-compatible object storage (local filesystem store only), passkey smart wallets and passkey endpoints (ADR 0003), real KYC/KYB and SMS/WhatsApp providers, notification dispatch and reminder jobs, `offer-expiry`, `fx-refresh` and `reconcile` jobs, WebSocket realtime, rate limiting, OpenAPI generation, real anchor integration (only a mock exists, ADR 0005; no withdrawals), Testcontainers CI.
