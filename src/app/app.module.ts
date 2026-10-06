import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminController } from './admin.controller.js';
import { AnchorController } from './anchor.controller.js';
import { AuthController, UsersController } from './auth.controller.js';
import { CatalogController } from './catalog.controller.js';
import { DevController } from './dev.controller.js';
import { DisputesController } from './disputes.controller.js';
import { ApiExceptionFilter, AuthGuard } from './http.js';
import { buildOpenApi, OPENAPI_DOC, OpenApiController } from './openapi.js';
import { RateLimitGuard } from './rate-limit.js';
import { PoolsController } from './pools.controller.js';
import { ReportsController } from './reports.controller.js';
import { SERVICES, type Services } from './services.js';
import { TxController } from './tx.controller.js';
import { UploadsController } from './uploads.controller.js';
import { METRICS, Metrics, MetricsController, MetricsInterceptor } from '../observability/metrics.js';
import { HealthController } from '../health/health.controller.js';

export function appControllers(services: Services) {
  return [
    HealthController, MetricsController, AuthController, UsersController, CatalogController, PoolsController, TxController, UploadsController, DisputesController, AdminController, ReportsController, AnchorController,
    // The test-money faucet exists only off mainnet and outside production.
    ...(services.env.NODE_ENV !== 'production' && services.env.STELLAR_NETWORK !== 'mainnet' ? [DevController] : []),
  ];
}

@Module({})
export class AppModule {
  static forRoot(services: Services): DynamicModule {
    return {
      module: AppModule,
      controllers: [...appControllers(services), OpenApiController],
      providers: [
        { provide: SERVICES, useValue: services },
        { provide: OPENAPI_DOC, useValue: buildOpenApi([...appControllers(services), OpenApiController]) },
        { provide: METRICS, useValue: new Metrics() },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}
