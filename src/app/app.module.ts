import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin.controller.js';
import { AuthController, UsersController } from './auth.controller.js';
import { CatalogController } from './catalog.controller.js';
import { DevController } from './dev.controller.js';
import { DisputesController } from './disputes.controller.js';
import { ApiExceptionFilter, AuthGuard } from './http.js';
import { PoolsController } from './pools.controller.js';
import { SERVICES, type Services } from './services.js';
import { TxController } from './tx.controller.js';
import { UploadsController } from './uploads.controller.js';
import { HealthController } from '../health/health.controller.js';

@Module({})
export class AppModule {
  static forRoot(services: Services): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController, AuthController, UsersController, CatalogController, PoolsController, TxController, UploadsController, DisputesController, AdminController,
        // The test-money faucet exists only off mainnet and outside production.
        ...(services.env.NODE_ENV !== 'production' && services.env.STELLAR_NETWORK !== 'mainnet' ? [DevController] : []),
      ],
      providers: [
        { provide: SERVICES, useValue: services },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
