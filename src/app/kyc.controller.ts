import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { mask } from '../common/pii.js';
import { AttestorCapReached } from '../verification/attestor.js';
import type { CheckResult } from '../verification/provider.js';
import { type AuthedUser, CurrentUser, parse } from './http.js';
import { SERVICES, type Services } from './services.js';

/** Trader KYC level written on-chain on success: T1 lifts the per-pool limit from 50 to 500 USDC (brief 3.8). */
export const KYC_LEVEL = 1;

const startBody = z.object({
  idType: z.enum(['BVN', 'NIN']),
  idNumber: z.string().regex(/^\d{11}$/, 'BVN and NIN are 11 digits'),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** sha256 of a selfie uploaded through /uploads/sign (kind EVIDENCE); the provider fetches it via a signed URL. */
  selfieSha256: z.string().min(8).max(128),
});

/**
 * Trader KYC (brief 5.1 step 4, 7.8): BVN or NIN lookup, selfie liveness and face match through the provider port.
 * The provider's answer is stored encrypted (AES-256-GCM); only a salted hash and the level go on-chain, written by
 * the capped attestor. Personal data is never logged and never returned (identifiers come back masked).
 */
@Controller('kyc')
export class KycController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  @Post('start') @HttpCode(200)
  async start(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(startBody, body);
    const user = await this.s.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'Create your wallet first' });
    const done = await this.s.prisma.verificationRecord.findFirst({ where: { userId: u.id, kind: 'KYC', status: 'VERIFIED' } });
    if (done) return this.view(done.status, b.idType, b.idNumber);

    const claim = { firstName: b.firstName, lastName: b.lastName, dateOfBirth: b.dateOfBirth };
    const id = b.idType === 'BVN' ? await this.s.kyc.verifyBvn(b.idNumber, claim) : await this.s.kyc.verifyNin(b.idNumber, claim);
    const checks: Record<string, CheckResult> = { identity: id };
    if (id.ok) checks.liveness = await this.s.kyc.liveness(b.selfieSha256);
    if (id.ok && checks.liveness?.ok) checks.faceMatch = await this.s.kyc.faceMatch(b.selfieSha256, id.providerRef);
    const passed = Object.values(checks).every((c) => c.ok) && Object.keys(checks).length === 3;
    const reason = Object.values(checks).find((c) => !c.ok)?.reason;

    const record = await this.s.prisma.verificationRecord.create({
      data: {
        userId: u.id, kind: 'KYC', provider: this.s.kyc.name, providerRef: id.providerRef, status: passed ? 'PASSED' : 'FAILED',
        result: this.s.pii.seal({ idType: b.idType, idNumber: b.idNumber, claim, checks }) as never,
      },
    });
    if (!passed) return { ...this.view('FAILED', b.idType, b.idNumber), reason };

    try {
      const a = await this.s.attestations.attest(u.id, user.walletAddress, 'Trader', KYC_LEVEL, id.providerRef);
      await this.s.prisma.verificationRecord.update({
        where: { id: record.id },
        data: { status: 'VERIFIED', result: this.s.pii.seal({ idType: b.idType, idNumber: b.idNumber, claim, checks, salt: a.salt, verHash: a.verHash, tx: a.hash }) as never },
      });
      await this.s.prisma.userRole.upsert({
        where: { userId_role: { userId: u.id, role: 'TRADER' } }, create: { userId: u.id, role: 'TRADER', level: KYC_LEVEL, verHash: a.verHash }, update: { level: KYC_LEVEL, verHash: a.verHash },
      });
      return this.view('VERIFIED', b.idType, b.idNumber);
    } catch (e) {
      if (e instanceof AttestorCapReached) throw new ServiceUnavailableException({ error: 'VERIFICATION_BUSY', message: 'Verification is busy today. Your check passed; we will finish it shortly.' });
      throw e;
    }
  }

  @Get('status')
  async status(@CurrentUser() u: AuthedUser) {
    const r = await this.s.prisma.verificationRecord.findFirst({ where: { userId: u.id, kind: 'KYC' }, orderBy: { createdAt: 'desc' } });
    if (!r) return { status: 'NONE', level: 0 };
    const sealed = this.s.pii.open<{ idType: string; idNumber: string }>(r.result as never);
    return this.view(r.status, sealed.idType, sealed.idNumber);
  }

  private view(status: string, idType: string, idNumber: string) {
    return { status, level: status === 'VERIFIED' ? KYC_LEVEL : 0, idType, idNumber: mask(idNumber) };
  }
}
