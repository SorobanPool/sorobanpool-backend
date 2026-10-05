# sorobanpool-backend

NestJS backend for SorobanPool (API, workers, indexer, keeper, relayer). **Buy together. Pay on delivery.** Built on Stellar.

```
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install && pnpm start:dev     # GET /health
pnpm lint && pnpm build && pnpm test && pnpm test:e2e
```
One codebase, role chosen by `ROLE=api|worker|indexer`. Status: M0 (foundations).
