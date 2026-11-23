import { envSchema } from './env.js';

/** How a variable's value must be handled. `ref` values name a secret (`env:NAME`); they are not the secret. */
export type Sensitivity = 'public' | 'secret' | 'ref';

export interface EnvDoc {
  /** Which process roles read it: `all`, or a subset of api / worker / indexer. `reserved` = parsed but not read yet. */
  usedBy: string;
  sensitivity: Sensitivity;
  description: string;
}

/**
 * One entry per key of `envSchema`. `env-docs.spec.ts` fails when a key is missing here or in
 * `docs/configuration.md`, so a new variable cannot ship undocumented. Regenerate the table with `pnpm docs:config`.
 */
export const ENV_DOCS: Record<keyof typeof envSchema.shape, EnvDoc> = {
  ROLE: { usedBy: 'all', sensitivity: 'public', description: 'Process role: api, worker or indexer (one codebase, three roles).' },
  PORT: { usedBy: 'api', sensitivity: 'public', description: 'HTTP port the API listens on.' },
  NODE_ENV: { usedBy: 'all', sensitivity: 'public', description: 'development, test or production. Production refuses literal secrets and dev-only flags.' },
  DATABASE_URL: { usedBy: 'all', sensitivity: 'secret', description: 'PostgreSQL connection string; contains the database password.' },
  REDIS_URL: { usedBy: 'reserved', sensitivity: 'secret', description: 'Redis connection string. Required by the schema, not read yet (rate limits and SSE fan-out are in-process today).' },
  S3_ENDPOINT: { usedBy: 'all', sensitivity: 'public', description: 'S3-compatible endpoint (AWS S3, R2, MinIO) when OBJECT_STORE=s3.' },
  S3_BUCKET_PUBLIC: { usedBy: 'all', sensitivity: 'public', description: 'Bucket for public product photos (re-encoded WebP, metadata stripped).' },
  S3_BUCKET_EVIDENCE: { usedBy: 'all', sensitivity: 'public', description: 'Private bucket for delivery, dispute and waybill evidence.' },
  S3_ACCESS_KEY_REF: { usedBy: 'all', sensitivity: 'ref', description: 'Secret reference for the S3 access key id.' },
  S3_SECRET_KEY_REF: { usedBy: 'all', sensitivity: 'ref', description: 'Secret reference for the S3 secret access key.' },
  JWT_SECRET: { usedBy: 'all', sensitivity: 'secret', description: 'Signs access tokens and upload/evidence URLs. At least 32 characters.' },
  JWT_REFRESH_SECRET: { usedBy: 'reserved', sensitivity: 'secret', description: 'Refresh-token secret. At least 32 characters; refresh tokens are opaque session rows today.' },
  OTP_HMAC_SECRET: { usedBy: 'all', sensitivity: 'secret', description: 'HMAC key for stored OTP codes. At least 32 characters.' },
  ENCRYPTION_KEY_ID: { usedBy: 'all', sensitivity: 'ref', description: 'Secret reference for the AES-256-GCM key (base64 of 32 bytes) that seals PII at rest.' },
  STELLAR_NETWORK: { usedBy: 'all', sensitivity: 'public', description: 'local, testnet or mainnet. mainnet also needs MAINNET_ENABLED=true.' },
  RPC_URL: { usedBy: 'all', sensitivity: 'public', description: 'Soroban RPC endpoint.' },
  HORIZON_URL: { usedBy: 'all', sensitivity: 'public', description: 'Horizon endpoint (sponsor balance, account lookups).' },
  NETWORK_PASSPHRASE: { usedBy: 'all', sensitivity: 'public', description: 'Network passphrase transactions are signed for.' },
  DEPLOYMENTS_FILE: { usedBy: 'all', sensitivity: 'public', description: 'Contract ids and wasm hashes, vendored by scripts/sync-contract-artifacts.sh.' },
  SPONSOR_SECRET_REF: { usedBy: 'all', sensitivity: 'ref', description: 'Secret reference for the fee sponsor key; the sponsor is the source of every transaction (ADR 0001).' },
  ATTESTOR_SECRET_REF: { usedBy: 'all', sensitivity: 'ref', description: 'Secret reference for the attestor key; may only call registry.attest.' },
  KYC_PROVIDER: { usedBy: 'all', sensitivity: 'public', description: 'Verification provider adapter (sandbox today; ADR 0006).' },
  KYC_API_KEY_REF: { usedBy: 'reserved', sensitivity: 'ref', description: 'Secret reference for the KYC provider API key (no live adapter yet).' },
  SMS_PROVIDER: { usedBy: 'reserved', sensitivity: 'public', description: 'SMS adapter name (console locally).' },
  SMS_API_KEY_REF: { usedBy: 'reserved', sensitivity: 'ref', description: 'Secret reference for the SMS provider API key.' },
  WHATSAPP_API_KEY_REF: { usedBy: 'reserved', sensitivity: 'ref', description: 'Secret reference for the WhatsApp provider API key.' },
  ANCHOR_DOMAIN: { usedBy: 'reserved', sensitivity: 'public', description: 'SEP anchor domain for Naira rails (mock anchor today; ADR 0005).' },
  FX_SOURCES: { usedBy: 'all', sensitivity: 'public', description: 'Comma-separated live FX sources (er-api, coingecko). Empty uses FX_STATIC; required in production.' },
  WEBAUTHN_RP_ID: { usedBy: 'api', sensitivity: 'public', description: 'WebAuthn relying-party id (the app domain).' },
  WEBAUTHN_ORIGIN: { usedBy: 'api', sensitivity: 'public', description: 'Origin passkey assertions must come from.' },
  PUBLIC_APP_URL: { usedBy: 'api', sensitivity: 'public', description: 'Frontend URL; the only allowed CORS origin.' },
  SENTRY_DSN: { usedBy: 'all', sensitivity: 'secret', description: 'Sentry DSN; empty disables error reporting.' },
  OTEL_EXPORTER_OTLP_ENDPOINT: { usedBy: 'all', sensitivity: 'public', description: 'OTLP HTTP traces endpoint; empty disables OpenTelemetry tracing.' },
  MAINNET_ENABLED: { usedBy: 'all', sensitivity: 'public', description: 'Explicit opt-in required for STELLAR_NETWORK=mainnet (testnet only until the audit).' },
  OTP_DEV_ECHO: { usedBy: 'api', sensitivity: 'public', description: 'Dev only: return the OTP in the API response. Refused in production.' },
  OTP_RESEND_COOLDOWN_SECONDS: { usedBy: 'api', sensitivity: 'public', description: 'Minimum seconds between OTP requests for the same phone number (default 30).' },
  OTP_HOURLY_LIMIT: { usedBy: 'api', sensitivity: 'public', description: 'Maximum OTP requests per phone per hour (default 5).' },
  OTP_MAX_ATTEMPTS: { usedBy: 'api', sensitivity: 'public', description: 'Maximum wrong OTP verification attempts before the challenge is invalidated (default 5).' },
  BOOTSTRAP_ADMIN_PHONES: { usedBy: 'api', sensitivity: 'public', description: 'Dev only: comma-separated phones that get ADMIN on first login. Refused in production.' },
  BOOTSTRAP_ARBITER_PHONES: { usedBy: 'api', sensitivity: 'public', description: 'Dev only: comma-separated phones that get ARBITER on first login. Refused in production.' },
  INDEXER_EMBEDDED: { usedBy: 'api', sensitivity: 'public', description: 'Run the indexer inside the api process (single-process dev setups).' },
  METRICS_TOKEN: { usedBy: 'api', sensitivity: 'secret', description: 'Bearer token for /v1/metrics; at least 16 characters. Required to scrape in production.' },
  RATE_LIMIT_PER_MIN: { usedBy: 'api', sensitivity: 'public', description: 'Requests per minute per client.' },
  SPONSOR_MIN_XLM: { usedBy: 'worker', sensitivity: 'public', description: 'Fallback alert floor: used when there are no sponsored transactions to measure a spend rate from.' },
  SPONSOR_MIN_RUNWAY_DAYS: { usedBy: 'worker', sensitivity: 'public', description: 'The maintenance job alerts when the sponsor balance covers fewer days than this at the recent average spend.' },
  KEEPER_EMBEDDED: { usedBy: 'api', sensitivity: 'public', description: 'Run the keeper and maintenance jobs inside the api process (single-process dev setups).' },
  OBJECT_STORE: { usedBy: 'all', sensitivity: 'public', description: 'local (EVIDENCE_DIR) or s3 (ADR 0008).' },
  S3_REGION: { usedBy: 'all', sensitivity: 'public', description: 'S3 region; auto suits R2 and MinIO.' },
  EVIDENCE_DIR: { usedBy: 'all', sensitivity: 'public', description: 'Root directory for the local object store.' },
  FX_STATIC: { usedBy: 'all', sensitivity: 'public', description: 'Comma-separated NGN-per-USD rates for the static FX provider (testnet/dev).' },
  ATTESTOR_DAILY_CAP: { usedBy: 'all', sensitivity: 'public', description: 'registry.attest calls allowed per UTC day; alerts at 80%.' },
  ATTESTOR_SPIKE_MULTIPLE: { usedBy: 'all', sensitivity: 'public', description: "Spike alert when today's registry.attest count exceeds this multiple of the trailing 7-day daily average (and at least 10)." },
  INDEXER_START_LEDGER: { usedBy: 'indexer', sensitivity: 'public', description: 'First ledger for a fresh indexer; unset starts near the oldest retained ledger (runbook: indexer-backfill).' },
  INDEXER_LAG_ALERT_LEDGERS: { usedBy: 'api,indexer', sensitivity: 'public', description: 'Ledgers behind the RPC tip at which indexer_lag_ledgers is degraded in /health and the alert fires (default 20).' },
  INDEXER_BATCH_LEDGERS: { usedBy: 'indexer', sensitivity: 'public', description: 'Maximum ledgers scanned by one poll; bounds RPC and memory use per tick (default 1000).' },
  INDEXER_EVENT_PAGE_SIZE: { usedBy: 'indexer', sensitivity: 'public', description: 'Events fetched per getEvents page, at most 200 (the RPC limit).' },
  INDEXER_EVENT_MAX_PAGES: { usedBy: 'indexer', sensitivity: 'public', description: 'Hard cap on pages per getEvents call; a full page set stops the poll rather than growing without bound.' },
  INDEXER_RETRIES: { usedBy: 'indexer', sensitivity: 'public', description: 'Extra attempts after a failed RPC call, with exponential backoff.' },
  INDEXER_RETRY_BASE_MS: { usedBy: 'indexer', sensitivity: 'public', description: 'Delay before the first retry; doubles on each further failure.' },
  INDEXER_RETRY_MAX_MS: { usedBy: 'indexer', sensitivity: 'public', description: 'Upper bound on any single retry delay.' },
  INDEXER_RETRY_JITTER: { usedBy: 'indexer', sensitivity: 'public', description: 'Symmetric jitter fraction applied to each backoff delay to avoid thundering herds.' },
  INDEXER_PROGRESS_LOG_LEDGERS: { usedBy: 'indexer', sensitivity: 'public', description: 'Log a progress line each time the cursor crosses a multiple of this many ledgers.' },
  JSON_BODY_LIMIT: { usedBy: 'api', sensitivity: 'public', description: 'Max JSON request body (body-parser syntax, e.g. 100kb); larger bodies get a 413.' },
  UPLOAD_BODY_LIMIT: { usedBy: 'api', sensitivity: 'public', description: 'Max raw upload body for media and evidence (image/*, video/mp4, application/pdf); larger bodies get a 413.' },
  POOL_PREVIEW_CACHE_TTL_SECONDS: { usedBy: 'api', sensitivity: 'public', description: 'Seconds a cached public pool preview stays fresh; indexer events evict earlier (#75).' },
  POOL_PREVIEW_CACHE_MAX_ENTRIES: { usedBy: 'api', sensitivity: 'public', description: 'Maximum cached public pool previews per API process; least recently used entries are dropped when full (#75).' },
  COMMIT_MAX_MEMBER_SHARE_BP: { usedBy: 'api', sensitivity: 'public', description: 'Member share cap in basis points for the pre-sign commit check; mirrors the contract default (5000 = 50%).' },
  COMMIT_MAX_MEMBERS_PER_POOL: { usedBy: 'api', sensitivity: 'public', description: 'Listed-member cap for the pre-sign commit check; mirrors the contract default.' },
  COMMIT_TRADER_TIER_CAPS_STROOPS: { usedBy: 'api', sensitivity: 'public', description: 'Comma-separated stroops caps for trader tiers 0, 1 and 2 in the pre-sign commit check.' },
  COMPRESSION_THRESHOLD_BYTES: { usedBy: 'api', sensitivity: 'public', description: 'JSON GET responses at or above this size are compressed (brotli, else gzip).' },
  IDEMPOTENCY_RETENTION_DAYS: { usedBy: 'worker', sensitivity: 'public', description: 'The maintenance job deletes idempotency keys older than this many days.' },
  CHAIN_EVENT_RETENTION_DAYS: { usedBy: 'worker', sensitivity: 'public', description: 'Raw ChainEvents for final pools older than this are pruned; events for non-final pools are always kept (#90).' },
  ADMIN_ACTION_EXPIRY_MINUTES: { usedBy: 'api', sensitivity: 'public', description: 'Minutes before a pending sensitive admin action expires (1–10,080; default 30).' },
  ANCHOR_TRANSFER_EXPIRY_MINUTES: { usedBy: 'worker', sensitivity: 'public', description: 'Minutes before a pending anchor transfer is marked as expired (default 1,440).' },
};

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  public: 'no',
  secret: '**secret**',
  ref: '**secret ref**',
};

/** Default column, derived by parsing `undefined` through the field's own schema (no zod internals). */
export function defaultCell(key: keyof typeof envSchema.shape): string {
  const r = envSchema.shape[key].safeParse(undefined);
  if (!r.success) return '**required**';
  if (r.data === undefined) return 'optional';
  if (r.data === '') return '`""`';
  return '`' + String(r.data) + '`';
}

/** Renders docs/configuration.md from the schema and ENV_DOCS. */
export function renderConfigurationDoc(): string {
  const rows = (Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[]).map((key) => {
    const d = ENV_DOCS[key];
    return `| \`${key}\` | ${defaultCell(key)} | ${SENSITIVITY_LABEL[d.sensitivity]} | ${d.usedBy} | ${d.description} |`;
  });
  return [
    '# Configuration',
    '',
    '<!-- Generated from src/config/env.ts and src/config/env-docs.ts by `pnpm docs:config`. Do not edit by hand. -->',
    '',
    'Every variable `loadEnv` accepts, in schema order. All roles parse the full schema at startup, so a **required**',
    'variable must be set for every role even if that role does not read it.',
    '',
    '- **Secret**: the value itself is sensitive; keep it in the secret manager and out of logs.',
    '- **Secret ref**: the value is a reference such as `env:NAME`, resolved by `src/config/secrets.ts`; protect what it points to.',
    '  `literal:` references are refused in production.',
    '- **Used by** `reserved`: validated by the schema but not read by any code path yet.',
    '',
    '| Variable | Default | Secret | Used by | Description |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
