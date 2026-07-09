import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

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
  SPONSOR_MIN_XLM: z.coerce.number().positive().default(100),
  KEEPER_EMBEDDED: bool.default(false),
  EVIDENCE_DIR: z.string().default('.evidence'),
  /** Comma separated NGN-per-USD rates used by the static FX provider (testnet/dev). */
  FX_STATIC: z.string().default('1500,1505'),
  INDEXER_START_LEDGER: z.coerce.number().int().default(1),
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
