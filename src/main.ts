import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { rpc } from '@stellar/stellar-sdk';
import { AppModule } from './app/app.module.js';
import { buildServices } from './app/services.js';
import { loadDeployments } from './chain/deployments.js';
import { loadEnv } from './config/env.js';
import { createPrisma } from './persistence/prisma-stores.js';
import { startIndexer, startKeeper, startTtlKeeper } from './workers/runners.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrisma(env.DATABASE_URL);
  const services = buildServices(env, prisma, loadDeployments(env.DEPLOYMENTS_FILE));

  if (env.ROLE === 'indexer' || env.INDEXER_EMBEDDED) {
    startIndexer(services, new rpc.Server(env.RPC_URL, { allowHttp: env.RPC_URL.startsWith('http://') }));
    console.log('indexer started');
  }
  if (env.ROLE === 'worker' || env.KEEPER_EMBEDDED) {
    startKeeper(services);
    startTtlKeeper(services);
    console.log('keeper started');
  }
  if (env.ROLE !== 'api') return;

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(services));
  app.setGlobalPrefix('v1');
  app.use(helmet());
  app.enableCors({ origin: [env.PUBLIC_APP_URL], credentials: true });
  app.useBodyParser('raw', { type: ['image/*', 'video/mp4', 'application/pdf'], limit: '16mb' });
  await app.listen(env.PORT);
  console.log(`api listening on :${env.PORT}`);
}

void bootstrap();
