# API (v1)

Auth is a bearer access token (15 min) from OTP login; refresh tokens rotate and a replayed token revokes the family. Routes marked *public* need no token. Errors: `{error, message}`; contract failures are `422 {error:"CONTRACT_ERROR", contractCode}` (map the code with `src/chain/artifacts/errors.json`).

**Auth/users**: `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout` (public) · passkeys: `POST /auth/passkey/register/{options,verify}` (signed in), `POST /auth/passkey/login/{options,verify}` (public, usernameless; challenges are single use and expire in 5 minutes) · `GET|PATCH /me` · `GET /wallets/challenge`, `POST /wallets` · `POST /suppliers/apply`, `GET /suppliers/me` · `POST /registry/register/prepare`
**Catalog**: `GET /offers`, `GET /offers/:id` (public) · `POST /offers`, `PATCH /offers/:id`, `POST /offers/:id/publish`, `/offers/:id/refresh-fx` (SUPPLIER)
**Pools**: `POST /pools/prepare` (ORGANIZER) · `GET /pools`, `GET /pools/:id`, `GET /pools/:id/quote?units=` · `GET /p/:slug`, `GET /pools/:id/sharecard.png` (public) · `POST /pools/:id/{commit|increase|withdraw|close-early|accept|reject|dispatch|delivery|pickup|refund|member-confirm}/prepare`
**Transactions**: `POST /tx/submit {txXdr, signedAuthEntries[], idempotencyKey}`
**Evidence**: `POST /uploads/sign`, `PUT /uploads/put` (signed URL), `GET /evidence/:id/url`, `GET /evidence/file` (signed URL, 5 min)
**Disputes**: `POST /disputes/prepare`, `POST /disputes/:id/evidence/prepare`, `GET /disputes/:id`, `GET /disputes?mine=true` · arbiter (ARBITER): `GET /arbiter/queue`, `GET /arbiter/disputes/:id`, `POST /arbiter/disputes/:id/resolve/prepare`
**Bond**: `POST /bonds/deposit/prepare`, `/bonds/withdraw/prepare`, `GET /bonds/me` (SUPPLIER)
**Admin** (ADMIN): `GET /admin/suppliers`, `POST /admin/suppliers/:userId/decision`, `POST /admin/users/:userId/{attest|roles}`, `POST /admin/offers/:id/takedown`, `GET /admin/audit`

Every `prepare` returns `{txXdr, authEntries[], validUntilLedger, contract, fn}`; the client signs only `authEntries` with its wallet and sends them to `/tx/submit`. Quotes read the indexed pool and are indicative; the contract is authoritative.

**Operational**: `GET /health` · `GET /metrics` (Prometheus text; bearer `METRICS_TOKEN`, required in production) · `GET /openapi.json` · `GET /pools/:id/stream` (public Server-Sent Events: a `pool` event with state, units, tier and ledger now and after each indexed event, `ping` every 25s; at most 500 streams per API process).

Rate limit: `RATE_LIMIT_PER_MIN` requests per client IP per minute (default 300), then `429 {error:"RATE_LIMITED", retryAfterSecs}`; health is exempt. Behind a proxy set Express `trust proxy` so the real client IP is used.

`docs/openapi.json` (also served at `/v1/openapi.json`) lists every route with method, auth requirement, roles (`x-roles`) and path parameters. It is generated from controller metadata (`pnpm openapi` after changing routes; a test fails if it is stale). It does not describe request or response bodies; this file does.
