# API (v1)

Auth is a bearer access token (15 min) from OTP login; refresh tokens rotate and a replayed token revokes the family. Access tokens are tied to individual sessions and stop working as soon as their session is revoked (including logout-all). Routes marked *public* need no token; a valid bearer on a public route is still honoured (an invalid one is treated as anonymous). Errors: `{error, message}`; contract failures are `422 {error:"CONTRACT_ERROR", contractCode}` (map the code with `src/chain/artifacts/errors.json`).

**Auth/users**: `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout` (public), `POST /auth/logout-all` (requires bearer token; revokes every device session and logs `auth.logout_all`) · passkeys: `GET /auth/passkey` (lists passkeys with id, label, createdAt, lastUsedAt), `POST /auth/passkey/register/{options,verify}` (signed in; verify accepts optional `label` up to 40 characters), `PATCH /auth/passkey/:id` (rename with `{label}`), `DELETE /auth/passkey/:id` (returns `409 {error:"LAST_PASSKEY"}` when deleting the only passkey), `POST /auth/passkey/login/{options,verify}` (public, usernameless; challenges are single use and expire in 5 minutes; login updates lastUsedAt) · `GET|PATCH /me` (includes local account `status`) · `POST /wallets/passkey {passkeyId}` creates the user's passkey smart wallet from a passkey they registered (sponsor-deployed, idempotent; contracts ADR 0006) · `GET /wallets/challenge`, `POST /wallets` bind a classic device-key account instead (testnet fallback for browsers without passkeys) · `POST /suppliers/apply` (runs CAC and bank-account-name checks; an admin still decides), `GET /suppliers/me` · `POST /kyc/start` (BVN or NIN + selfie: identity, liveness, face match; on success the attestor writes level 1 on-chain), `GET /kyc/status` (identifier masked) · `POST /registry/register/prepare`

Fresh authentication requirement: Passkey registration (`POST /auth/passkey/register/options`), passkey deletion (`DELETE /auth/passkey/:id`), and wallet binding (`POST /wallets` and `POST /wallets/passkey`) require the access token to be no more than 10 minutes old. Requests with older tokens return `403 {error:"FRESH_AUTH_REQUIRED", message, ageMinutes}`. The user must sign in again to perform these actions.
**Catalog**: `GET /offers`, `GET /offers/:id` (public) · `POST /offers`, `PATCH /offers/:id`, `POST /offers/:id/publish`, `/offers/:id/refresh-fx` (SUPPLIER)

Offers must have at least two product images before publishing (#70); drafts may have fewer. Image keys must reference valid `PRODUCT` evidence owned by the supplier. Each offer's `validUntil` must be within 14 days of the current time on create, update, publish and refresh (#69). The 14-day limit is exported as `MAX_VALIDITY_DAYS` in `src/catalog/offer-validation.ts`.

Public catalog endpoints (`GET /offers` and `GET /offers/:id`) return an `ETag` header and support conditional GET (#68): when the request's `If-None-Match` header matches the ETag, the server returns `304 Not Modified` with no body, saving mobile data.

On publish, the server computes the category median unit price from live offers and flags those more than `PRICE_OUTLIER_FACTOR` (3) times away as outliers (#65). The flag is stored as `priceOutlierFlag` on the offer and returned in the publish response. Flagged offers can still be published but are marked for review in the admin offer list.

**Admin** (ADMIN): `GET /admin/suppliers`, `POST /admin/suppliers/:userId/decision`, `POST /admin/users/:userId/{attest|roles}`, `POST /admin/users/:id/revoke`, `POST /admin/users/:userId/verify-hash`, `GET /admin/offers`, `POST /admin/offers/:id/takedown`, `GET /admin/fx`, `GET /admin/audit`

`GET /admin/offers` lists offers with optional filters: `status` (`DRAFT`, `LIVE`, `EXPIRED`, `TAKEN_DOWN`), `priceOutlier=true` to show only flagged offers, and `limit` (1–100, default 50). Each result includes `priceOutlierFlag` to help admins prioritize reviews.

`POST /admin/users/:id/suspend` and `/unsuspend` take `{reason}` (required, 1–500 characters). Supplier approvals (`POST /admin/suppliers/:userId/decision` with `{approve:true}`) and suspensions create pending actions instead of executing immediately; a different ADMIN approves them with `POST /admin/actions/:id/approve`. Pending actions are listed by `GET /admin/actions`, expire after `ADMIN_ACTION_EXPIRY_MINUTES` (default 30), and every request and approval is written to the audit log. Rejection and unsuspension remain immediate. A successful suspension approval prepares the `registry.suspend` transaction using the approving admin's wallet and updates local status to `SUSPENDED`; submit the returned transaction through `POST /tx/submit`.

`POST /admin/users/:id/revoke` revokes one role's verification after fraud or an error. It takes `{role, reason}`, where `role` is `Trader`, `Organizer` or `Supplier` and `reason` is `FRAUD`, `DUPLICATE_IDENTITY`, `DOCUMENT_INVALID` or `ADMIN_ERROR`. The user must hold that role at level 1 or more (404 otherwise). Like suspension, the request creates a pending action that a different ADMIN approves. Approval prepares `registry.revoke` with the approving admin's wallet, sets the role's level to 0, marks the role's verification records `REVOKED` and writes `user.revoke` to the audit log with the reason. Submit the returned transaction through `POST /tx/submit`. A revoked trader can start KYC again, so suspend the account as well if that is not intended.

Verification hashes (#128): each admin attestation and each KYC check stores its salt, role and level encrypted with its verification record, so the on-chain `ver_hash` can be checked later. `POST /admin/users/:userId/verify-hash` takes `{verHash}` (64 hex characters) and returns `{verified: true, recordId, kind, status, role, level}` when it is the hash of one of that user's records, or `{verified: false}`. The salt never leaves the server, and every check is written to the audit log as `user.verify_hash`.

`GET /admin/fx?limit=&cursor=` lists the NGN/USD quotes that the fx-refresh job and offer publishing recorded, newest first, as `{id, pair, rate, sources, divergence, createdAt}`. `sources` holds each feed's rate, and `divergence` is the relative spread between them (`null` with fewer than two sources). Pages hold up to 100 quotes (`limit`, default 100); the `X-Next-Cursor` header gives the cursor for the next page. The endpoint is read-only. A refresh blocked by divergence has no rate to store, so it is written to the audit log as `fx.blocked` with its sources.

Risk reporting (ADMIN): `GET /admin/risk/rates?slice=supplier|category|state` returns one row per selected slice with pool counts and failure/dispute rates for both 7- and 30-day windows. Failure rate is failed/expired/cancelled pools divided by completed pools; dispute rate is distinct disputed delivered pools divided by delivered pools in the window. A zero denominator produces a rate of `0`. Supplier values are wallet addresses, category values come from the pool's offer, and state values use the organizer's trader-profile state (falling back to the supplier profile, then `Unknown`). The response shape is `{slice, values:[{value, failedPools7d, completedPools7d, failureRate7d, disputedPools7d, deliveredPools7d, disputeRate7d, failedPools30d, completedPools30d, failureRate30d, disputedPools30d, deliveredPools30d, disputeRate30d}]}`; rates are decimal fractions.

`GET /admin/dashboard?windowDays=7` returns GMV (delivered units × final unit price), currently held escrow, active pools, failure rate, and dispute rate for a rolling 1–365 day window (default 7). GMV and escrow are decimal strings in USDC stroops. Active pools are in Open, Filled, Accepted, Dispatched or Delivered states. Failure rate is failed/expired/cancelled pools divided by all settled/failed/expired/cancelled pools ended in the window. Dispute rate is the distinct delivered pools with a dispute opened in the window divided by pools delivered in the window. Rates are fractions and become 0 when their denominator is zero. Results are cached in-process for 60 seconds per window. Dashboard scans use `Pool_endedAt_state_idx`, `Pool_deliveredAt_state_idx`, `Pool_escrowBalance_idx`, the existing `Pool_state_fillDeadline_idx`, and `Dispute_openedAt_idx`; the respective `EXPLAIN` access paths can be confirmed by querying the predicates shown in `src/app/reports.controller.ts`.

`GET /admin/risk/pairs?threshold=0.6` returns organizer-supplier pairs that meet the share threshold (default `0.6`) and the minimum three-pool evidence count. Each result is `{organizer, supplier, pools, volume, shareOfOrganizer}`; `volume` is a USDC stroops string. Threshold must be between 0 and 1 inclusive.

Every `prepare` returns `{txXdr, authEntries[], validUntilLedger, contract, fn}`; the client signs only `authEntries` with its wallet and sends them to `/tx/submit`. Quotes read the indexed pool and are indicative; the contract is authoritative.

`GET /pools` is public and returns open pools newest first. Filters combine with AND: `state` (anonymous callers can only see `Open`), `category`, `deliveryState`, `lga`, `cluster` and `mine=true` (authenticated; pools the caller organizes, supplies or has committed to). Use `limit` (1–100, default 20) and the `X-Next-Cursor` response header for cursor pagination; the body stays a plain array for compatibility. The filter columns are denormalised onto `Pool` by the indexer and covered by composite indexes.

`GET /pools/:id/activity` returns indexed pool events newest first as `{events:[{id,type,message,at,ledger,actor?,units?,tier?}], nextCursor}`; `id` and `nextCursor` are keyset cursors, so new events cannot shift a page in progress. `limit` is 1–100 (default 20); pass `?cursor=<previous nextCursor>` (also sent as `X-Next-Cursor`) for older events. Aggregate events (created, price break, filled, dispatched, …) are visible to everyone; member events (joined, increased, left, picked up, refunded) are only returned to the organizer, supplier, a member with a commitment, or a signed-in trader in the pool's cluster. Actor addresses are always truncated (`GABC…WXYZ`), never returned in full.

`GET /pools/:id/quote?units=` includes `nextBreak: {minUnits, unitPriceUsdc, unitsToGo}` or `null` at the top tier. `minUnits` is the pool size that starts the next price break and `unitsToGo` is how many more units the pool needs to reach it. `GET /p/:slug` uses a bounded in-process cache (TTL `POOL_PREVIEW_CACHE_TTL_SECONDS`, default 5) keyed by slug; indexer events for a pool evict its previews immediately.

`POST /pools/:id/commit/prepare` checks the per-member unit cap, the member share cap, the pool unit cap, the listed-member cap and the verification-tier USDC cap before building a transaction. Failures use the contract's numeric codes (`contractCode` 315–319) with a matching `error` and a `limit` in the body. The caps come from the indexed offer, commitments, roles and reputation tier, with platform defaults overridable by `COMMIT_*` environment variables; the contract remains authoritative, so a passing pre-check is not a guarantee.

**Operational**: `GET /health` · `GET /health/live` · `GET /health/ready` (see below) · `GET /metrics` (Prometheus text; bearer `METRICS_TOKEN`, required in production) · `GET /openapi.json` · `GET /pools/:id/stream` (public Server-Sent Events: a `pool` event with state, units, tier and ledger now and after each indexed event, `ping` every 25s; at most 500 streams per API process).

Every request accepts a well-formed `X-Request-Id` (1–64 ASCII letters, digits, dot, underscore or hyphen) or receives a generated UUID. The value is returned in `X-Request-Id`, included in error bodies and request/error logs, and forwarded to outbound FX and Horizon HTTP providers.

Rate limit: `RATE_LIMIT_PER_MIN` requests per client IP per minute (default 300), then `429 {error:"RATE_LIMITED", retryAfterSecs}`; health is exempt. Authentication endpoints (`POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/passkey/login/options`, `POST /auth/passkey/login/verify`) use a stricter limit (`RATE_LIMIT_AUTH_PER_MIN`, default 20 per minute) to prevent abuse.

OTP resend cooldown: `POST /auth/otp/request` enforces a per-phone cooldown (default 30 seconds, configurable via `OTP_RESEND_COOLDOWN_SECONDS`) and an hourly limit (default 5 requests per hour, configurable via `OTP_HOURLY_LIMIT`). Requests inside the cooldown or exceeding the hourly limit return `429 {error:"OTP_COOLDOWN"|"OTP_RATE_LIMITED", message, retryAfterSecs}` with a `Retry-After` header (seconds). The cooldown never reveals whether the phone is already registered. The existing 15-minute window limit (3 requests per 15 minutes) also remains in place.

OTP verification attempts: `POST /auth/otp/verify` invalidates the challenge after a configurable number of wrong attempts (default 5, `OTP_MAX_ATTEMPTS`). After the limit is reached, verification returns the same generic `OTP_WRONG` error whether the code is correct or not, preventing brute force attacks without revealing that the challenge is locked. Users must request a new code. Behind a proxy set Express `trust proxy` so the real client IP is used.

Body limits: JSON bodies over `JSON_BODY_LIMIT` (default `100kb`) and raw uploads (`image/*`, `video/mp4`, `application/pdf`) over `UPLOAD_BODY_LIMIT` (default `16mb`) are refused with `413 {error:"PAYLOAD_TOO_LARGE"}` before any route runs.

Compression and caching: JSON `GET` responses of at least `COMPRESSION_THRESHOLD_BYTES` (default 1024) are sent with brotli when the client accepts it, otherwise gzip, with `Vary: Accept-Encoding`. Public routes set `Cache-Control` by class (`src/app/http-setup.ts`): `GET /offers` and `GET /offers/:id` use `public, max-age=60, stale-while-revalidate=300`; `GET /p/:slug` (live progress) uses `public, max-age=15, stale-while-revalidate=60`; `GET /pools/:id/sharecard.png` uses `public, max-age=60`, so WhatsApp and CDN previews refresh within a minute of a pool changing. Authenticated routes set no `Cache-Control`.

`docs/openapi.json` (also served at `/v1/openapi.json`) lists every route with method, auth requirement, roles (`x-roles`) and path parameters. It is generated from controller metadata (`pnpm openapi` after changing routes; a test fails if it is stale). It does not describe request or response schemas; this file does. The most used operations (OTP login and refresh, offer list and detail, FX quote, pool list, read and quote, pool prepare and commit) carry request and response examples from `src/app/openapi-examples.ts`, each request example checked against the handler's zod schema by `openapi.spec.ts`.

## Health probes

`GET /health/live` answers `200 {status:"ok"}` whenever the process is serving and never touches a dependency, so a database or RPC outage cannot put the container into a restart loop. `GET /health` also always answers `200`, but adds `indexer: "ok" | "degraded" | "skipped"`: it is `degraded` when the latest network ledger minus the stored cursor exceeds `INDEXER_LAG_ALERT_LEDGERS` (default 20), and `skipped` before the first run or when the tip is unknown.

`GET /health/ready` checks each dependency independently, each bounded at 2s:

| Check | Fails when |
| --- | --- |
| `database` | `SELECT 1` errors or times out |
| `rpc` | the Soroban RPC cannot return the latest ledger |
| `indexer` | the indexer cursor is more than `INDEXER_LAG_ALERT_LEDGERS` (20 by default) ledgers behind the RPC tip; `skipped` before its first run or when the tip is unknown |

It answers `200 {status:"ready", checks}` or `503 {error:"NOT_READY", message, failing:[...], checks}`. Use liveness for restarts and readiness for routing:

```yaml
# docker-compose
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3000/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  interval: 10s
  timeout: 3s
  retries: 3

# Kubernetes
livenessProbe:
  httpGet: { path: /v1/health/live, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /v1/health/ready, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3
```

All three health routes are exempt from the rate limit.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the process stops accepting new connections and lets in-flight requests finish (`app.close()`), stops every scheduler so no new tick starts while a running tick completes, then disconnects Prisma, and exits 0. If that takes longer than 9s (`SHUTDOWN_TIMEOUT_MS` in `src/app/shutdown.ts`) it exits 1; long-lived `/pools/:id/stream` connections are the usual reason. Keep the platform's kill grace period above that (Docker `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`).

## Metrics and alerts

`http_request_duration_seconds` is a histogram labelled `method`, `route` (the route template, such as `/v1/offers/:id`, or `unmatched`; never a raw URL or id) and `status_class` (`2xx`, `4xx`, `5xx`). `http_requests_total` counts requests by `method`, `route` and `status`. `indexer_lag_ledgers` is a gauge of the latest network ledger minus the indexer cursor (0 before the first run); it is 0 when caught up and rises while the indexer is behind. `sp_notifications_pending` and `sp_notifications_failed` are gauges from the notification table. `attestor_spike_alerts_total` counts each attestation that trips the attestor spike alert (#130): today's `registry.attest` count is above `ATTESTOR_SPIKE_MULTIPLE` (default 3) times the trailing 7-day daily average, and above 10. Each one is also logged as `[attestor] SPIKE …`. The daily cap itself is unchanged. Example Prometheus alert rules:

```yaml
groups:
  - name: sorobanpool-api
    rules:
      - alert: ApiErrorRateHigh
        expr: |
          sum(rate(http_request_duration_seconds_count{status_class="5xx"}[5m]))
            / sum(rate(http_request_duration_seconds_count[5m])) > 0.02
        for: 10m
        annotations:
          summary: API 5xx error rate above 2%
      - alert: ApiLatencyP95High
        expr: |
          histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))) > 1
        for: 10m
        annotations:
          summary: "p95 latency above 1s on {{ $labels.route }}"
      - alert: IndexerLagHigh
        expr: indexer_lag_ledgers > 20
        for: 5m
        annotations:
          summary: "indexer is more than 20 ledgers behind the network tip"
```

OpenTelemetry traces are enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. The API records HTTP server spans, Prisma query spans and individual Soroban RPC spans; resources identify `service.name`, `service.version` and `service.role`. The SDK exporter is shut down after HTTP/background work drains.
