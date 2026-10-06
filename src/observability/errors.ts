import * as Sentry from '@sentry/node';

/** Where unexpected failures go. Expected ones (validation, auth, contract refusals) are never reported. */
export interface ErrorReporter {
  capture(e: unknown, where: string): void;
}

export class NoopReporter implements ErrorReporter {
  capture(): void {}
}

/** Sentry via the official SDK. Request bodies, headers and cookies can carry tokens and phone numbers, so none are sent. */
export class SentryReporter implements ErrorReporter {
  constructor(dsn: string, environment: string) {
    Sentry.init({
      dsn, environment, tracesSampleRate: 0,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      beforeSend(event) {
        if (event.request) { delete event.request.data; delete event.request.cookies; delete event.request.headers; }
        delete event.user;
        return event;
      },
    });
  }
  capture(e: unknown, where: string): void {
    Sentry.withScope((scope) => { scope.setTag('where', where); Sentry.captureException(e); });
  }
}

export const createReporter = (dsn: string, environment: string): ErrorReporter => (dsn ? new SentryReporter(dsn, environment) : new NoopReporter());
