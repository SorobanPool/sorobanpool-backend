/**
 * Local development and E2E server: PGlite (in-process Postgres) + the real testnet chain, with the indexer and
 * keeper embedded on short intervals. NEVER for production: it refuses to start with NODE_ENV=production.
 *
 *   SPONSOR_SECRET=S... pnpm build && node dist/dev/dev-server.js
 */
import 'reflect-metadata';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { rpc } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../app/app.module.js';
import { buildServices } from '../app/services.js';
import { loadDeployments } from '../chain/deployments.js';
import { loadEnv } from '../config/env.js';
import { LocalObjectStore } from '../evidence/store.js';
import { createPrisma } from '../persistence/prisma-stores.js';
import { startIndexer, startKeeper, startTtlKeeper } from '../workers/runners.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('the dev server must not run in production');
  if (!process.env.SPONSOR_SECRET) throw new Error('set SPONSOR_SECRET (a funded testnet key; it sponsors fees and acts as attestor/faucet)');

  const db = new PGlite();
  const migrations = join(process.cwd(), 'prisma/migrations');
  for (const d of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await db.exec(readFileSync(join(migrations, d, 'migration.sql'), 'utf8'));
  }
  const dbPort = await freePort();
  await new PGLiteSocketServer({ db, port: dbPort, host: '127.0.0.1' }).start();

  const rand = () => randomBytes(24).toString('hex');
  const env = loadEnv({
    NODE_ENV: 'development', PORT: process.env.PORT ?? '3100', DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
    REDIS_URL: 'redis://unused', S3_ENDPOINT: 'http://unused', S3_BUCKET_PUBLIC: 'p', S3_BUCKET_EVIDENCE: 'e', S3_ACCESS_KEY_REF: 'x', S3_SECRET_KEY_REF: 'x',
    JWT_SECRET: rand(), JWT_REFRESH_SECRET: rand(), OTP_HMAC_SECRET: rand(), ENCRYPTION_KEY_ID: 'dev',
    RPC_URL: process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org', HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015', DEPLOYMENTS_FILE: process.env.DEPLOYMENTS_FILE ?? '../sorobanpool-contracts/deployments/testnet.json',
    SPONSOR_SECRET_REF: 'env:SPONSOR_SECRET', ATTESTOR_SECRET_REF: 'env:SPONSOR_SECRET', WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: process.env.PUBLIC_APP_URL ?? 'http://localhost:3101', PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? 'http://localhost:3101',
    STELLAR_NETWORK: 'testnet', OTP_DEV_ECHO: 'true', BOOTSTRAP_ADMIN_PHONES: process.env.BOOTSTRAP_ADMIN_PHONES ?? '+2348000000001',
    BOOTSTRAP_ARBITER_PHONES: process.env.BOOTSTRAP_ARBITER_PHONES ?? '+2348000000002', FX_STATIC: '1500,1505', INDEXER_START_LEDGER: process.env.INDEXER_START_LEDGER ?? '1',
    EVIDENCE_DIR: mkdtempSync(join(tmpdir(), 'sp-dev-evidence-')),
  } as NodeJS.ProcessEnv);

  const prisma = createPrisma(env.DATABASE_URL);
  const deployments = loadDeployments(env.DEPLOYMENTS_FILE);
  const services = buildServices(env, prisma, deployments, { store: new LocalObjectStore(env.EVIDENCE_DIR) });
  const server = new rpc.Server(env.RPC_URL);
  // Start from "now": a fresh in-memory database has no history to replay.
  if (!process.env.INDEXER_START_LEDGER) env.INDEXER_START_LEDGER = (await server.getLatestLedger()).sequence;
  startIndexer(services, server, 3000);
  startKeeper(services, 6000);
  startTtlKeeper(services);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(services), { logger: ['error', 'warn'] });
  app.setGlobalPrefix('v1');
  app.enableCors({ origin: true, credentials: true });
  app.useBodyParser('raw', { type: ['image/*', 'video/mp4', 'application/pdf'], limit: '16mb' });
  await app.listen(env.PORT);
  console.log(`dev api listening on :${env.PORT} (indexer from ledger ${env.INDEXER_START_LEDGER})`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
