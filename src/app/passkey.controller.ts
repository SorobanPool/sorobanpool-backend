import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, UnauthorizedException, ConflictException } from '@nestjs/common';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { rolesOf } from './auth.controller.js';
import { type AuthedUser, CurrentUser, parse, Public, FreshAuth } from './http.js';
import { SERVICES, type Services } from './services.js';
import { StrictRateLimit } from './rate-limit.js';

const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * Passkeys: registered while signed in (after phone OTP). A registered passkey both signs the user in without an SMS
 * and, through `POST /wallets/passkey`, controls their smart wallet (contracts ADR 0006). The wallet contract only
 * accepts user-verified assertions (fingerprint, face or PIN), so registration and sign-in require verification.
 */
@Controller('auth/passkey')
export class PasskeyController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async issueChallenge(kind: 'register' | 'login', challenge: string, userId?: string): Promise<string> {
    const row = await this.s.prisma.passkeyChallenge.create({ data: { kind, challenge, userId, expiresAt: new Date(this.s.now().getTime() + CHALLENGE_TTL_MS) } });
    return row.id;
  }

  /** Single use: the row is deleted whether or not verification then succeeds, so a challenge can never be replayed. */
  private async consumeChallenge(id: string, kind: 'register' | 'login'): Promise<{ challenge: string; userId: string | null }> {
    const row = await this.s.prisma.passkeyChallenge.findUnique({ where: { id } });
    if (row) await this.s.prisma.passkeyChallenge.deleteMany({ where: { id } });
    if (!row || row.kind !== kind || row.expiresAt < this.s.now()) throw new UnauthorizedException({ error: 'PASSKEY_CHALLENGE_INVALID', message: 'Challenge expired or already used' });
    return { challenge: row.challenge, userId: row.userId };
  }

  @Get('')
  async list(@CurrentUser() me: AuthedUser) {
    const rows = await this.s.prisma.passkey.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'asc' } });
    return rows.map((p) => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  }

  /** The person must keep at least one sign-in method; phone OTP always remains, so a passkey can always be removed. */
  @FreshAuth() @Delete(':id') @HttpCode(200)
  async remove(@CurrentUser() me: AuthedUser, @Param('id') id: string) {
    const row = await this.s.prisma.passkey.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No such passkey' });
    if (row.userId !== me.id) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Not your passkey' });
    
    // Block deletion of the last passkey (issue #62)
    const count = await this.s.prisma.passkey.count({ where: { userId: me.id } });
    if (count === 1) {
      throw new ConflictException({ error: 'LAST_PASSKEY', message: 'Cannot delete your only passkey. Add another passkey first or use phone OTP to sign in.' });
    }
    
    await this.s.prisma.passkey.delete({ where: { id } });
    return { removed: true };
  }

  /** Rename a passkey (issue #61). */
  @Patch(':id') @HttpCode(200)
  async rename(@CurrentUser() me: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { label } = parse(z.object({ label: z.string().max(40).transform(s => s.trim()).optional() }), body);
    const row = await this.s.prisma.passkey.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No such passkey' });
    if (row.userId !== me.id) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Not your passkey' });
    await this.s.prisma.passkey.update({ where: { id }, data: { label: label ?? null } });
    return { updated: true, label };
  }

  @FreshAuth() @Post('register/options') @HttpCode(200)
  async registerOptions(@CurrentUser() me: AuthedUser) {
    const user = await this.s.prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { passkeys: true } });
    const options = await generateRegistrationOptions({
      rpName: 'SorobanPool', rpID: this.s.env.WEBAUTHN_RP_ID, userName: user.phone, userID: new TextEncoder().encode(user.id), attestationType: 'none',
      excludeCredentials: user.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      // ES256 first: only P-256 keys can control the on-chain wallet (secp256r1_verify).
      supportedAlgorithmIDs: [-7],
    });
    return { challengeId: await this.issueChallenge('register', options.challenge, user.id), options };
  }

  @Post('register/verify') @HttpCode(200)
  async registerVerify(@CurrentUser() me: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({ 
      challengeId: z.string(), 
      response: z.record(z.string(), z.unknown()),
      label: z.string().max(40).transform(s => s.trim()).optional(),
    }), body);
    const c = await this.consumeChallenge(b.challengeId, 'register');
    if (c.userId !== me.id) throw new UnauthorizedException({ error: 'PASSKEY_CHALLENGE_INVALID', message: 'Challenge belongs to another user' });
    const v = await verifyRegistrationResponse({
      response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: c.challenge, expectedOrigin: this.s.env.WEBAUTHN_ORIGIN, expectedRPID: this.s.env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    }).catch((e: Error) => { throw new UnauthorizedException({ error: 'PASSKEY_INVALID', message: e.message }); });
    if (!v.verified) throw new UnauthorizedException({ error: 'PASSKEY_INVALID', message: 'Registration not verified' });
    const { credential } = v.registrationInfo;
    await this.s.prisma.passkey.create({
      data: { 
        id: credential.id, 
        userId: me.id, 
        credentialId: credential.id, 
        publicKey: Buffer.from(credential.publicKey), 
        counter: credential.counter, 
        transports: credential.transports ?? [],
        label: b.label ?? null,
      },
    });
    return { registered: true, passkeyId: credential.id };
  }

  @StrictRateLimit() @Public() @Post('login/options') @HttpCode(200)
  async loginOptions() {
    // Usernameless: the authenticator picks a discoverable credential, so this reveals nothing about any phone number.
    const options = await generateAuthenticationOptions({ rpID: this.s.env.WEBAUTHN_RP_ID, userVerification: 'required' });
    return { challengeId: await this.issueChallenge('login', options.challenge), options };
  }

  @StrictRateLimit() @Public() @Post('login/verify') @HttpCode(200)
  async loginVerify(@Body() body: unknown) {
    const b = parse(z.object({ challengeId: z.string(), response: z.object({ id: z.string() }).passthrough() }), body);
    const c = await this.consumeChallenge(b.challengeId, 'login');
    const pk = await this.s.prisma.passkey.findUnique({ where: { credentialId: b.response.id }, include: { user: true } });
    if (!pk) throw new UnauthorizedException({ error: 'PASSKEY_INVALID', message: 'Unknown passkey' });
    const v = await verifyAuthenticationResponse({
      response: b.response as unknown as AuthenticationResponseJSON, expectedChallenge: c.challenge, expectedOrigin: this.s.env.WEBAUTHN_ORIGIN, expectedRPID: this.s.env.WEBAUTHN_RP_ID,
      credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: pk.transports as never },
      requireUserVerification: true,
    }).catch((e: Error) => { throw new UnauthorizedException({ error: 'PASSKEY_INVALID', message: e.message }); });
    if (!v.verified) throw new UnauthorizedException({ error: 'PASSKEY_INVALID', message: 'Authentication not verified' });
    await this.s.prisma.passkey.update({ where: { id: pk.id }, data: { counter: v.authenticationInfo.newCounter, lastUsedAt: this.s.now() } });
    if (pk.user.status !== 'ACTIVE') throw new UnauthorizedException({ error: 'ACCOUNT_DISABLED', message: 'Account is not active' });
    const roles = await rolesOf(this.s, pk.userId);
    return { user: { id: pk.user.id, phone: pk.user.phone, walletAddress: pk.user.walletAddress }, roles, ...(await this.s.tokens.issue(pk.userId, roles)) };
  }
}
