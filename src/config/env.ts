import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Default for the indexer lag alert and the degraded /health signal (#85). */
export const DEFAULT_INDEXER_LAG_ALERT_LEDGERS = 20;

/** Bounds for one indexer poll and its RPC retries (#87). */
export const DEFAULT_INDEXER_BATCH_LEDGERS = 1000;
export const DEFAULT_INDEXER_EVENT_PAGE_SIZE = 200;
export const DEFAULT_INDEXER_EVENT_MAX_PAGES = 50;
export const DEFAULT_INDEXER_RETRIES = 3;
export const DEFAULT_INDEXER_RETRY_BASE_MS = 200;
export const DEFAULT_INDEXER_RETRY_MAX_MS = 10_000;
export const DEFAULT_INDEXER_RETRY_JITTER = 0.2;
export const DEFAULT_INDEXER_PROGRESS_LOG_LEDGERS = 1000;
/** Raw ChainEvents for final pools are dropped after this many days (#90). */
export const DEFAULT_CHAIN_EVENT_RETENTION_DAYS = 180;

export const envSchema = z.object({
  ROLE: z.enum(['api', 'worker', 'indexer']).default('api'),
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET_PUBLIC: z.string().min(1),
  S3_BUCKET_EVIDENCE: z.string().min(1),
  S3_ACCESS_KEY_REF: z.string().min(1),
  S3_SECRET_KEY_REF: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_SECRET_PREVIOUS: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().min(32),
  OTP_HMAC_SECRET: z.string().min(32),
  ENCRYPTION_KEY_ID: z.string().min(1),
  STELLAR_NETWORK: z.enum(['local', 'testnet', 'mainnet']).default('testnet'),
  RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),
  DEPLOYMENTS_FILE: z.string().default('deployments/testnet.json'),
  SPONSOR_SECRET_REF: z.string().min(1),
  ATTESTOR_SECRET_REF: z.string().min(1),
  KYC_PROVIDER: z.string().default('sandbox'),
  KYC_API_KEY_REF: z.string().default(''),
  SMS_PROVIDER: z.string().default('console'),
  SMS_API_KEY_REF: z.string().default(''),
  WHATSAPP_API_KEY_REF: z.string().default(''),
  ANCHOR_DOMAIN: z.string().default(''),
  FX_SOURCES: z.string().default(''),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGIN: z.string().url(),
  PUBLIC_APP_URL: z.string().url(),
  SENTRY_DSN: z.string().default(''),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  MAINNET_ENABLED: bool.default(false),
  /** Dev only: return the OTP in the API response. Refused in production. */
  OTP_DEV_ECHO: bool.default(false),
  /** Dev only: phones that receive ADMIN / ARBITER on first login. Refused in production. */
  BOOTSTRAP_ADMIN_PHONES: z.string().default(''),
  BOOTSTRAP_ARBITER_PHONES: z.string().default(''),
  INDEXER_EMBEDDED: bool.default(false),
  METRICS_TOKEN: z.string().min(16).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  SPONSOR_MIN_XLM: z.coerce.number().positive().default(100),
  SPONSOR_MIN_RUNWAY_DAYS: z.coerce.number().positive().default(7),
  KEEPER_EMBEDDED: bool.default(false),
  OBJECT_STORE: z.enum(['local', 's3']).default('local'),
  S3_REGION: z.string().default('auto'),
  EVIDENCE_DIR: z.string().default('.evidence'),
  /** Comma separated NGN-per-USD rates used by the static FX provider (testnet/dev). */
  FX_STATIC: z.string().default('1500,1505'),
  /** First ledger for a fresh indexer. Unset = the oldest ledger the RPC still retains (see Indexer StartLedger). */
  /** registry.attest calls allowed per UTC day (brief 7.8 attestor daily cap); alerts at 80%. */
  ATTESTOR_DAILY_CAP: z.coerce.number().int().positive().default(500),
  /** Spike alert when today's attestations exceed this multiple of the trailing 7-day daily average (#130). */
  ATTESTOR_SPIKE_MULTIPLE: z.coerce.number().min(1).max(100).default(3),
  INDEXER_START_LEDGER: z.coerce.number().int().positive().optional(),
  /** Ledgers behind the RPC tip at which the indexer alert fires and /health reports `indexer: degraded` (#85). */
  INDEXER_LAG_ALERT_LEDGERS: z.coerce.number().int().positive().default(DEFAULT_INDEXER_LAG_ALERT_LEDGERS),
  /** Maximum ledgers scanned by one indexer tick (#87). */
  INDEXER_BATCH_LEDGERS: z.coerce.number().int().positive().default(DEFAULT_INDEXER_BATCH_LEDGERS),
  /** Events requested per RPC getEvents page; the RPC caps this at 200 (#87). */
  INDEXER_EVENT_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(DEFAULT_INDEXER_EVENT_PAGE_SIZE),
  /** Hard cap on RPC pages per getEvents call, so a hot ledger range cannot exhaust memory (#87). */
  INDEXER_EVENT_MAX_PAGES: z.coerce.number().int().positive().default(DEFAULT_INDEXER_EVENT_MAX_PAGES),
  /** Extra attempts after a failed RPC call; backoff doubles between them (#87). */
  INDEXER_RETRIES: z.coerce.number().int().nonnegative().default(DEFAULT_INDEXER_RETRIES),
  /** First retry delay in ms; doubles up to INDEXER_RETRY_MAX_MS (#87). */
  INDEXER_RETRY_BASE_MS: z.coerce.number().int().positive().default(DEFAULT_INDEXER_RETRY_BASE_MS),
  /** Upper bound for a single backoff delay in ms (#87). */
  INDEXER_RETRY_MAX_MS: z.coerce.number().int().positive().default(DEFAULT_INDEXER_RETRY_MAX_MS),
  /** Symmetric jitter fraction (0..1) applied to each backoff delay (#87). */
  INDEXER_RETRY_JITTER: z.coerce.number().min(0).max(1).default(DEFAULT_INDEXER_RETRY_JITTER),
  /** Emit a progress log each time the cursor crosses a multiple of this many ledgers (#87). */
  INDEXER_PROGRESS_LOG_LEDGERS: z.coerce.number().int().positive().default(DEFAULT_INDEXER_PROGRESS_LOG_LEDGERS),
  /** Max JSON request body (body-parser syntax, e.g. "100kb"); larger bodies get a 413 (#171). */
  JSON_BODY_LIMIT: z.string().min(1).default('100kb'),
  /** Max raw upload body for media and evidence (image/*, video/mp4, application/pdf) (#171). */
  UPLOAD_BODY_LIMIT: z.string().min(1).default('16mb'),
  /** Seconds a cached public pool preview stays fresh before it is rebuilt (#75). */
  POOL_PREVIEW_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(5),
  /** Maximum number of cached public pool previews per API process (#75). */
  POOL_PREVIEW_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(1000),
  /** Max member share of a pool in basis points, used by the commit pre-check (#78). */
  COMMIT_MAX_MEMBER_SHARE_BP: z.coerce.number().int().min(1).max(10_000).default(5000),
  /** Max listed members per pool, used by the commit pre-check (#78). */
  COMMIT_MAX_MEMBERS_PER_POOL: z.coerce.number().int().positive().default(200),
  /** Comma-separated stroops caps for trader tiers 0, 1 and 2, used by the commit pre-check (#78). */
  COMMIT_TRADER_TIER_CAPS_STROOPS: z.string().regex(/^\d+(,\d+){2}$/).default('500000000,5000000000,25000000000'),
  /** JSON GET responses at or above this size are compressed (brotli, else gzip) (#174). */
  COMPRESSION_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1024),
  /** Idempotency keys older than this are deleted by the maintenance job (#173). */
  IDEMPOTENCY_RETENTION_DAYS: z.coerce.number().positive().default(7),
  /** Raw ChainEvents for final pools older than this are pruned in bounded batches (#90). */
  CHAIN_EVENT_RETENTION_DAYS: z.coerce.number().positive().default(DEFAULT_CHAIN_EVENT_RETENTION_DAYS),
  /** Minutes before a pending two-person admin action expires. */
  ADMIN_ACTION_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(10_080).default(30),
  /** Minutes before a pending anchor transfer is marked as expired. */
  ANCHOR_TRANSFER_EXPIRY_MINUTES: z.coerce.number().int().min(1).default(1440), // 24 hours default
  /** Minimum seconds between OTP requests for the same phone number. */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),
  /** Maximum OTP requests allowed per phone per hour. */
  OTP_HOURLY_LIMIT: z.coerce.number().int().positive().default(5),
  /** Maximum wrong OTP attempts before invalidating the challenge. */
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof envSchema>;

/** Fails fast with every problem listed; mainnet needs an explicit opt-in (testnet only until the audit). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const d = parsed.data;
  if (d.NODE_ENV === 'production' && (d.OTP_DEV_ECHO || d.BOOTSTRAP_ADMIN_PHONES || d.BOOTSTRAP_ARBITER_PHONES)) {
    throw new Error('OTP_DEV_ECHO and BOOTSTRAP_*_PHONES are development-only and are refused when NODE_ENV=production');
  }
  if (parsed.data.STELLAR_NETWORK === 'mainnet' && !parsed.data.MAINNET_ENABLED) {
    throw new Error('STELLAR_NETWORK=mainnet requires MAINNET_ENABLED=true (testnet only until the audit is complete)');
  }
  return parsed.data;
}
