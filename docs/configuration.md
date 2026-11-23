# Configuration

<!-- Generated from src/config/env.ts and src/config/env-docs.ts by `pnpm docs:config`. Do not edit by hand. -->

Every variable `loadEnv` accepts, in schema order. All roles parse the full schema at startup, so a **required**
variable must be set for every role even if that role does not read it.

- **Secret**: the value itself is sensitive; keep it in the secret manager and out of logs.
- **Secret ref**: the value is a reference such as `env:NAME`, resolved by `src/config/secrets.ts`; protect what it points to.
  `literal:` references are refused in production.
- **Used by** `reserved`: validated by the schema but not read by any code path yet.

| Variable | Default | Secret | Used by | Description |
| --- | --- | --- | --- | --- |
| `ROLE` | `api` | no | all | Process role: api, worker or indexer (one codebase, three roles). |
| `PORT` | `3000` | no | api | HTTP port the API listens on. |
| `NODE_ENV` | `development` | no | all | development, test or production. Production refuses literal secrets and dev-only flags. |
| `DATABASE_URL` | **required** | **secret** | all | PostgreSQL connection string; contains the database password. |
| `REDIS_URL` | **required** | **secret** | reserved | Redis connection string. Required by the schema, not read yet (rate limits and SSE fan-out are in-process today). |
| `S3_ENDPOINT` | **required** | no | all | S3-compatible endpoint (AWS S3, R2, MinIO) when OBJECT_STORE=s3. |
| `S3_BUCKET_PUBLIC` | **required** | no | all | Bucket for public product photos (re-encoded WebP, metadata stripped). |
| `S3_BUCKET_EVIDENCE` | **required** | no | all | Private bucket for delivery, dispute and waybill evidence. |
| `S3_ACCESS_KEY_REF` | **required** | **secret ref** | all | Secret reference for the S3 access key id. |
| `S3_SECRET_KEY_REF` | **required** | **secret ref** | all | Secret reference for the S3 secret access key. |
| `JWT_SECRET` | **required** | **secret** | all | Signs access tokens and upload/evidence URLs. At least 32 characters. |
| `JWT_REFRESH_SECRET` | **required** | **secret** | reserved | Refresh-token secret. At least 32 characters; refresh tokens are opaque session rows today. |
| `OTP_HMAC_SECRET` | **required** | **secret** | all | HMAC key for stored OTP codes. At least 32 characters. |
| `ENCRYPTION_KEY_ID` | **required** | **secret ref** | all | Secret reference for the AES-256-GCM key (base64 of 32 bytes) that seals PII at rest. |
| `STELLAR_NETWORK` | `testnet` | no | all | local, testnet or mainnet. mainnet also needs MAINNET_ENABLED=true. |
| `RPC_URL` | **required** | no | all | Soroban RPC endpoint. |
| `HORIZON_URL` | **required** | no | all | Horizon endpoint (sponsor balance, account lookups). |
| `NETWORK_PASSPHRASE` | **required** | no | all | Network passphrase transactions are signed for. |
| `DEPLOYMENTS_FILE` | `deployments/testnet.json` | no | all | Contract ids and wasm hashes, vendored by scripts/sync-contract-artifacts.sh. |
| `SPONSOR_SECRET_REF` | **required** | **secret ref** | all | Secret reference for the fee sponsor key; the sponsor is the source of every transaction (ADR 0001). |
| `ATTESTOR_SECRET_REF` | **required** | **secret ref** | all | Secret reference for the attestor key; may only call registry.attest. |
| `KYC_PROVIDER` | `sandbox` | no | all | Verification provider adapter (sandbox today; ADR 0006). |
| `KYC_API_KEY_REF` | `""` | **secret ref** | reserved | Secret reference for the KYC provider API key (no live adapter yet). |
| `SMS_PROVIDER` | `console` | no | reserved | SMS adapter name (console locally). |
| `SMS_API_KEY_REF` | `""` | **secret ref** | reserved | Secret reference for the SMS provider API key. |
| `WHATSAPP_API_KEY_REF` | `""` | **secret ref** | reserved | Secret reference for the WhatsApp provider API key. |
| `ANCHOR_DOMAIN` | `""` | no | reserved | SEP anchor domain for Naira rails (mock anchor today; ADR 0005). |
| `FX_SOURCES` | `""` | no | all | Comma-separated live FX sources (er-api, coingecko). Empty uses FX_STATIC; required in production. |
| `WEBAUTHN_RP_ID` | **required** | no | api | WebAuthn relying-party id (the app domain). |
| `WEBAUTHN_ORIGIN` | **required** | no | api | Origin passkey assertions must come from. |
| `PUBLIC_APP_URL` | **required** | no | api | Frontend URL; the only allowed CORS origin. |
| `SENTRY_DSN` | `""` | **secret** | all | Sentry DSN; empty disables error reporting. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | no | all | OTLP HTTP traces endpoint; empty disables OpenTelemetry tracing. |
| `MAINNET_ENABLED` | `false` | no | all | Explicit opt-in required for STELLAR_NETWORK=mainnet (testnet only until the audit). |
| `OTP_DEV_ECHO` | `false` | no | api | Dev only: return the OTP in the API response. Refused in production. |
| `BOOTSTRAP_ADMIN_PHONES` | `""` | no | api | Dev only: comma-separated phones that get ADMIN on first login. Refused in production. |
| `BOOTSTRAP_ARBITER_PHONES` | `""` | no | api | Dev only: comma-separated phones that get ARBITER on first login. Refused in production. |
| `INDEXER_EMBEDDED` | `false` | no | api | Run the indexer inside the api process (single-process dev setups). |
| `METRICS_TOKEN` | optional | **secret** | api | Bearer token for /v1/metrics; at least 16 characters. Required to scrape in production. |
| `RATE_LIMIT_PER_MIN` | `300` | no | api | Requests per minute per client. |
| `SPONSOR_MIN_XLM` | `100` | no | worker | Fallback alert floor: used when there are no sponsored transactions to measure a spend rate from. |
| `SPONSOR_MIN_RUNWAY_DAYS` | `7` | no | worker | The maintenance job alerts when the sponsor balance covers fewer days than this at the recent average spend. |
| `KEEPER_EMBEDDED` | `false` | no | api | Run the keeper and maintenance jobs inside the api process (single-process dev setups). |
| `OBJECT_STORE` | `local` | no | all | local (EVIDENCE_DIR) or s3 (ADR 0008). |
| `S3_REGION` | `auto` | no | all | S3 region; auto suits R2 and MinIO. |
| `EVIDENCE_DIR` | `.evidence` | no | all | Root directory for the local object store. |
| `FX_STATIC` | `1500,1505` | no | all | Comma-separated NGN-per-USD rates for the static FX provider (testnet/dev). |
| `ATTESTOR_DAILY_CAP` | `500` | no | all | registry.attest calls allowed per UTC day; alerts at 80%. |
| `ATTESTOR_SPIKE_MULTIPLE` | `3` | no | all | Spike alert when today's registry.attest count exceeds this multiple of the trailing 7-day daily average (and at least 10). |
| `INDEXER_START_LEDGER` | optional | no | indexer | First ledger for a fresh indexer; unset starts near the oldest retained ledger (runbook: indexer-backfill). |
| `INDEXER_LAG_ALERT_LEDGERS` | `20` | no | api,indexer | Ledgers behind the RPC tip at which indexer_lag_ledgers is degraded in /health and the alert fires (default 20). |
| `INDEXER_BATCH_LEDGERS` | `1000` | no | indexer | Maximum ledgers scanned by one poll; bounds RPC and memory use per tick (default 1000). |
| `INDEXER_EVENT_PAGE_SIZE` | `200` | no | indexer | Events fetched per getEvents page, at most 200 (the RPC limit). |
| `INDEXER_EVENT_MAX_PAGES` | `50` | no | indexer | Hard cap on pages per getEvents call; a full page set stops the poll rather than growing without bound. |
| `INDEXER_RETRIES` | `3` | no | indexer | Extra attempts after a failed RPC call, with exponential backoff. |
| `INDEXER_RETRY_BASE_MS` | `200` | no | indexer | Delay before the first retry; doubles on each further failure. |
| `INDEXER_RETRY_MAX_MS` | `10000` | no | indexer | Upper bound on any single retry delay. |
| `INDEXER_RETRY_JITTER` | `0.2` | no | indexer | Symmetric jitter fraction applied to each backoff delay to avoid thundering herds. |
| `INDEXER_PROGRESS_LOG_LEDGERS` | `1000` | no | indexer | Log a progress line each time the cursor crosses a multiple of this many ledgers. |
| `JSON_BODY_LIMIT` | `100kb` | no | api | Max JSON request body (body-parser syntax, e.g. 100kb); larger bodies get a 413. |
| `UPLOAD_BODY_LIMIT` | `16mb` | no | api | Max raw upload body for media and evidence (image/*, video/mp4, application/pdf); larger bodies get a 413. |
| `POOL_PREVIEW_CACHE_TTL_SECONDS` | `5` | no | api | Seconds a cached public pool preview stays fresh; indexer events evict earlier (#75). |
| `POOL_PREVIEW_CACHE_MAX_ENTRIES` | `1000` | no | api | Maximum cached public pool previews per API process; least recently used entries are dropped when full (#75). |
| `COMMIT_MAX_MEMBER_SHARE_BP` | `5000` | no | api | Member share cap in basis points for the pre-sign commit check; mirrors the contract default (5000 = 50%). |
| `COMMIT_MAX_MEMBERS_PER_POOL` | `200` | no | api | Listed-member cap for the pre-sign commit check; mirrors the contract default. |
| `COMMIT_TRADER_TIER_CAPS_STROOPS` | `500000000,5000000000,25000000000` | no | api | Comma-separated stroops caps for trader tiers 0, 1 and 2 in the pre-sign commit check. |
| `COMPRESSION_THRESHOLD_BYTES` | `1024` | no | api | JSON GET responses at or above this size are compressed (brotli, else gzip). |
| `IDEMPOTENCY_RETENTION_DAYS` | `7` | no | worker | The maintenance job deletes idempotency keys older than this many days. |
| `CHAIN_EVENT_RETENTION_DAYS` | `180` | no | worker | Raw ChainEvents for final pools older than this are pruned; events for non-final pools are always kept (#90). |
| `ADMIN_ACTION_EXPIRY_MINUTES` | `30` | no | api | Minutes before a pending sensitive admin action expires (1–10,080; default 30). |
| `ANCHOR_TRANSFER_EXPIRY_MINUTES` | `1440` | no | worker | Minutes before a pending anchor transfer is marked as expired (default 1,440). |
| `OTP_RESEND_COOLDOWN_SECONDS` | `30` | no | api | Minimum seconds between OTP requests for the same phone number (default 30). |
| `OTP_HOURLY_LIMIT` | `5` | no | api | Maximum OTP requests per phone per hour (default 5). |
| `OTP_MAX_ATTEMPTS` | `5` | no | api | Maximum wrong OTP verification attempts before the challenge is invalidated (default 5). |
