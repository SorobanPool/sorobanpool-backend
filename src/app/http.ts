import {
  type ArgumentsHost, BadRequestException, type CanActivate, Catch, type ExceptionFilter, type ExecutionContext,
  ForbiddenException, HttpException, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ZodError, type ZodType } from 'zod';
import { AnchorError } from '../anchor/anchor.js';
import { AuthError } from '../auth/otp.service.js';
import { SponsorshipError } from '../relayer/allowlist.js';
import { TxRejected } from '../chain/inspect.js';
import { SERVICES, type Services } from './services.js';
import { currentRequestId } from '../observability/request-context.js';

export interface AuthedUser {
  id: string;
  roles: string[];
  iat?: number; // issued at timestamp (Unix epoch seconds), for fresh auth checks
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
export const PUBLIC_KEY = 'public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const FRESH_AUTH_KEY = 'freshAuth';
/** Requires the user to have authenticated within the last 10 minutes (issue #63). */
export const FreshAuth = () => SetMetadata(FRESH_AUTH_KEY, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthedUser => {
  return ctx.switchToHttp().getRequest<{ user: AuthedUser }>().user;
});

/** Every route needs a valid access token unless marked @Public(); @Roles() narrows further. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(SERVICES) private readonly s: Services, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: AuthedUser }>();
    const header = req.headers['authorization'];
    let claims: { sub: string; roles: string[]; iat?: number } | undefined;
    if (header?.startsWith('Bearer ')) {
      claims = await this.s.tokens.verifyAccess(header.slice(7)).catch(() => undefined);
      if (claims) req.user = { id: claims.sub, roles: claims.roles, iat: claims.iat };
    }
    if (isPublic) return true;
    if (!claims) throw new UnauthorizedException('missing or invalid bearer token');
    const needed = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (needed?.length) {
      // Roles come from the database, not the token: a grant takes effect at once and a revocation cannot be
      // outlived by a token that was issued before it (access tokens last 15 minutes).
      const current = (await this.s.prisma.userRole.findMany({ where: { userId: claims.sub } })).map((r) => r.role);
      req.user!.roles = current;
      if (!needed.some((r) => current.includes(r))) throw new ForbiddenException('insufficient role');
    }
    
    // Check fresh auth requirement (issue #63)
    const requiresFresh = this.reflector.getAllAndOverride<boolean>(FRESH_AUTH_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (requiresFresh) {
      const now = Math.floor(this.s.now().getTime() / 1000);
      const iat = claims.iat ?? 0;
      const ageMinutes = (now - iat) / 60;
      if (ageMinutes > 10) {
        throw new ForbiddenException({ 
          error: 'FRESH_AUTH_REQUIRED', 
          message: 'This action requires a recent sign-in. Please sign in again.',
          ageMinutes: Math.floor(ageMinutes),
        });
      }
    }
    
    return true;
  }
}

/** Parses untrusted input with zod; a failure is a 400 listing every problem. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequestException({ error: 'VALIDATION', fields: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })) });
  return r.data;
}

/** Extracts `Error(Contract, #n)` from a Soroban failure so clients can map it to plain language. */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(SERVICES) private readonly s: Services) {}
  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(b: unknown): void; header(name: string, value: string): void } }>();
    const requestId = currentRequestId();
    const send = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => {
      const statusObj = res.status(status);
      if (headers) {
        Object.entries(headers).forEach(([name, value]) => statusObj.header(name, value));
      }
      return statusObj.json(body);
    };
    if (e instanceof AuthError) {
      const status = e.code === 'OTP_RATE_LIMITED' || e.code === 'OTP_COOLDOWN' ? 429 : e.code === 'INVALID_PHONE' ? 400 : 401;
      const body = { error: e.code, message: e.message, requestId, ...(e.retryAfterSecs !== undefined ? { retryAfterSecs: e.retryAfterSecs } : {}) };
      const headers = e.retryAfterSecs !== undefined ? { 'Retry-After': String(e.retryAfterSecs) } : undefined;
      return send(status, body, headers);
    }
    if (e instanceof AnchorError) return send(e.code === 'NOT_FOUND' ? 404 : e.code === 'FX_UNAVAILABLE' ? 503 : 400, { error: e.code, message: e.message, requestId });
    if (e instanceof SponsorshipError) return send(e.code === 'CAP_REACHED' ? 429 : 403, { error: e.code, message: e.message, requestId });
    if (e instanceof TxRejected) return send(e.code === 'WRONG_SIGNER' || e.code === 'SPONSOR_AUTH' ? 403 : 400, { error: e.code, message: e.message, requestId });
    if (e instanceof ZodError) return send(400, { error: 'VALIDATION', message: e.message, requestId });
    if (e instanceof HttpException) {
      const body = e.getResponse();
      const response = typeof body === 'string' ? { error: 'HTTP', message: body } : body as Record<string, unknown>;
      return send(e.getStatus(), { ...response, requestId });
    }
    const message = e instanceof Error ? e.message : String(e);
    const code = contractErrorCode(message);
    if (code !== undefined) return send(422, { error: 'CONTRACT_ERROR', contractCode: code, message: 'The transaction was refused by the contract' });
    console.error(JSON.stringify({ msg: 'http error', requestId, error: e instanceof Error ? e.message : String(e) }));
    this.s.reporter.capture(e, 'http');
    return send(500, { error: 'INTERNAL', message: 'Something went wrong', requestId });
  }
}
