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
});

export type Env = z.infer<typeof envSchema>;

/** Fails fast with every problem listed; mainnet needs an explicit opt-in (testnet only until the audit). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  if (parsed.data.STELLAR_NETWORK === 'mainnet' && !parsed.data.MAINNET_ENABLED) {
    throw new Error('STELLAR_NETWORK=mainnet requires MAINNET_ENABLED=true (testnet only until the audit is complete)');
  }
  return parsed.data;
}
