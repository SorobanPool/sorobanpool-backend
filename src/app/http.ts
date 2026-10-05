import {
  type ArgumentsHost, BadRequestException, type CanActivate, Catch, type ExceptionFilter, type ExecutionContext,
  ForbiddenException, HttpException, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ZodError, type ZodType } from 'zod';
import { AuthError } from '../auth/otp.service.js';
import { SponsorshipError } from '../relayer/allowlist.js';
import { TxRejected } from '../chain/inspect.js';
import { SERVICES, type Services } from './services.js';

export interface AuthedUser {
  id: string;
  roles: string[];
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
export const PUBLIC_KEY = 'public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthedUser => {
  return ctx.switchToHttp().getRequest<{ user: AuthedUser }>().user;
});

/** Every route needs a valid access token unless marked @Public(); @Roles() narrows further. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(SERVICES) private readonly s: Services, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: AuthedUser }>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');
    const claims = await this.s.tokens.verifyAccess(header.slice(7));
    req.user = { id: claims.sub, roles: claims.roles };
    const needed = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (needed?.length) {
      // Roles come from the database, not the token: a grant takes effect at once and a revocation cannot be
      // outlived by a token that was issued before it (access tokens last 15 minutes).
      const current = (await this.s.prisma.userRole.findMany({ where: { userId: claims.sub } })).map((r) => r.role);
      req.user.roles = current;
      if (!needed.some((r) => current.includes(r))) throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}

/** Parses untrusted input with zod; a failure is a 400 listing every problem. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequestException({ error: 'VALIDATION', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

/** Extracts `Error(Contract, #n)` from a Soroban failure so clients can map it to plain language. */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(b: unknown): void } }>();
    const send = (status: number, body: Record<string, unknown>) => res.status(status).json(body);
    if (e instanceof AuthError) {
      const status = e.code === 'OTP_RATE_LIMITED' ? 429 : e.code === 'INVALID_PHONE' ? 400 : 401;
      return send(status, { error: e.code, message: e.message });
    }
    if (e instanceof SponsorshipError) return send(e.code === 'CAP_REACHED' ? 429 : 403, { error: e.code, message: e.message });
    if (e instanceof TxRejected) return send(e.code === 'WRONG_SIGNER' || e.code === 'SPONSOR_AUTH' ? 403 : 400, { error: e.code, message: e.message });
    if (e instanceof ZodError) return send(400, { error: 'VALIDATION', message: e.message });
    if (e instanceof HttpException) {
      const body = e.getResponse();
      return send(e.getStatus(), typeof body === 'string' ? { error: 'HTTP', message: body } : (body as Record<string, unknown>));
    }
    const message = e instanceof Error ? e.message : String(e);
    const code = contractErrorCode(message);
    if (code !== undefined) return send(422, { error: 'CONTRACT_ERROR', contractCode: code, message: 'The transaction was refused by the contract' });
    console.error(e);
    return send(500, { error: 'INTERNAL', message: 'Something went wrong' });
  }
}
