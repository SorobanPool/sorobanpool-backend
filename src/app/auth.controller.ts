import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthError } from '../auth/otp.service.js';
import { normalizeNgPhone } from '../auth/phone.js';
import { type AuthedUser, CurrentUser, parse, Public } from './http.js';
import { devInbox, SERVICES, type Services } from './services.js';

export async function rolesOf(s: Services, userId: string): Promise<string[]> {
  return (await s.prisma.userRole.findMany({ where: { userId } })).map((r) => r.role);
}

const phoneList = (csv: string) => new Set(csv.split(',').map((p) => normalizeNgPhone(p.trim())).filter((p): p is string => !!p));

@Controller('auth')
export class AuthController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Public() @Post('otp/request') @HttpCode(200)
  async request(@Body() body: unknown) {
    const { phone } = parse(z.object({ phone: z.string() }), body);
    const r = await this.s.otp.request(phone);
    // Dev only (the env loader refuses OTP_DEV_ECHO in production): echo the code so scripts can log in.
    const devCode = this.s.env.OTP_DEV_ECHO ? devInbox.get(r.phone) : undefined;
    return { phone: r.phone, ...(devCode ? { devCode } : {}) };
  }

  @Public() @Post('otp/verify') @HttpCode(200)
  async verify(@Body() body: unknown) {
    const { phone, code } = parse(z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/) }), body);
    const normalised = await this.s.otp.verify(phone, code);
    let user = await this.s.prisma.user.findUnique({ where: { phone: normalised } });
    if (!user) {
      user = await this.s.prisma.user.create({ data: { phone: normalised, roles: { create: [{ role: 'TRADER' }] } } });
    }
    // Development bootstrap only; the env loader refuses these lists in production.
    for (const [role, list] of [['ADMIN', this.s.env.BOOTSTRAP_ADMIN_PHONES], ['ARBITER', this.s.env.BOOTSTRAP_ARBITER_PHONES]] as const) {
      if (phoneList(list).has(normalised)) {
        await this.s.prisma.userRole.upsert({ where: { userId_role: { userId: user.id, role } }, create: { userId: user.id, role }, update: {} });
      }
    }
    const roles = await rolesOf(this.s, user.id);
    return { user: { id: user.id, phone: user.phone, walletAddress: user.walletAddress }, roles, ...(await this.s.tokens.issue(user.id, roles)) };
  }

  @Public() @Post('refresh') @HttpCode(200)
  async refresh(@Body() body: unknown) {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), body);
    return this.s.tokens.refresh(refreshToken, (id) => rolesOf(this.s, id));
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() body: unknown) {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), body);
    await this.s.tokens.logout(refreshToken);
  }
}

const challenges = new Map<string, { nonce: string; expires: number }>();

@Controller()
export class UsersController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Get('me')
  async me(@CurrentUser() u: AuthedUser) {
    const user = await this.s.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    return { id: user.id, phone: user.phone, displayName: user.displayName, language: user.language, walletAddress: user.walletAddress, roles: await rolesOf(this.s, u.id) };
  }

  @Patch('me')
  async update(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({ displayName: z.string().min(1).max(80).optional(), language: z.enum(['EN', 'PCM', 'HA', 'YO', 'IG']).optional() }), body);
    await this.s.prisma.user.update({ where: { id: u.id }, data: b });
    return this.me(u);
  }

  /** Step 1 of wallet binding: a random challenge the wallet must sign. */
  @Get('wallets/challenge')
  challenge(@CurrentUser() u: AuthedUser) {
    const nonce = randomBytes(32).toString('base64url');
    const expires = this.s.now().getTime() + 5 * 60_000;
    challenges.set(u.id, { nonce, expires });
    return { challenge: nonce, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Step 2: binds a Stellar account to the user after proof of possession (ed25519 signature over the
   * challenge). Smart (passkey) wallets are not supported yet: that needs the wallet-implementation ADR.
   */
  @Post('wallets') @HttpCode(200)
  async bind(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { address, signature } = parse(z.object({ address: z.string(), signature: z.string() }), body);
    if (StrKey.isValidContract(address)) throw new AuthError('SMART_WALLET_UNSUPPORTED', 'Smart wallets are not supported yet');
    if (!StrKey.isValidEd25519PublicKey(address)) throw new AuthError('INVALID_ADDRESS', 'Invalid Stellar address');
    const ch = challenges.get(u.id);
    if (!ch || ch.expires < this.s.now().getTime()) throw new AuthError('CHALLENGE_EXPIRED', 'Request a new wallet challenge');
    if (!Keypair.fromPublicKey(address).verify(Buffer.from(ch.nonce), Buffer.from(signature, 'base64'))) {
      throw new AuthError('BAD_SIGNATURE', 'Signature does not match the challenge');
    }
    challenges.delete(u.id);
    const taken = await this.s.prisma.user.findUnique({ where: { walletAddress: address } });
    if (taken && taken.id !== u.id) throw new AuthError('WALLET_TAKEN', 'This wallet belongs to another account');
    await this.s.prisma.user.update({ where: { id: u.id }, data: { walletAddress: address } });
    return { walletAddress: address };
  }

  @Post('suppliers/apply') @HttpCode(200)
  async apply(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({
      businessName: z.string().min(2), cacNumber: z.string().min(5), address: z.string().min(5),
      state: z.string(), lga: z.string(), categories: z.array(z.string()).min(1),
      deliveryAreas: z.array(z.object({ state: z.string(), lga: z.string().optional() })).min(1),
      bankName: z.string().optional(), bankAccountMasked: z.string().optional(),
    }), body);
    await this.s.prisma.supplierProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, ...b }, update: b });
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId: u.id, role: 'SUPPLIER' } }, create: { userId: u.id, role: 'SUPPLIER' }, update: {} });
    return { kybStatus: 'PENDING' };
  }

  @Get('suppliers/me')
  async mySupplier(@CurrentUser() u: AuthedUser) {
    return this.s.prisma.supplierProfile.findUnique({ where: { userId: u.id } });
  }
}
