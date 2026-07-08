import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { inspectUserTx } from '../chain/inspect.js';
import { MAX_FEE_STROOPS } from '../chain/chain.service.js';
import { type AuthedUser, CurrentUser, parse } from './http.js';
import { walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';
import type { Prisma } from '../generated/prisma/client.js';

@Controller('tx')
export class TxController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /**
   * Submits a prepared transaction with the user's signed auth entries. The relayer checks the allow-list and
   * the user's daily cap before spending the sponsor's fee, and replays the stored result for a repeated key.
   */
  @Post('submit') @HttpCode(200)
  async submit(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({ txXdr: z.string().min(10), signedAuthEntries: z.array(z.string()).min(1), idempotencyKey: z.string().min(8).max(100) }), body);
    const existing = await this.s.prisma.idempotencyKey.findUnique({ where: { key: b.idempotencyKey } });
    if (existing) {
      if (existing.userId !== u.id) throw new BadRequestException({ error: 'KEY_IN_USE', message: 'Idempotency key belongs to another user' });
      if (existing.response) return existing.response;
      throw new BadRequestException({ error: 'IN_PROGRESS', message: 'This request is still being processed' });
    }
    const wallet = await walletOf(this.s, u.id);
    const seen = inspectUserTx(b.txXdr, { sponsor: this.s.chain.sponsorAddress, passphrase: this.s.env.NETWORK_PASSPHRASE, userWallet: wallet, maxFeeStroops: MAX_FEE_STROOPS });
    await this.s.policy.authorize(u.id, seen.contractId, seen.fn);
    await this.s.prisma.idempotencyKey.create({ data: { key: b.idempotencyKey, userId: u.id } });
    try {
      const r = await this.s.chain.submitUser(b.txXdr, b.signedAuthEntries, wallet);
      const response = { hash: r.hash, contractId: seen.contractId, fn: seen.fn, returnValue: r.returnValue === undefined ? null : JSON.parse(JSON.stringify(r.returnValue, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) } as Prisma.InputJsonObject;
      await this.s.prisma.idempotencyKey.update({ where: { key: b.idempotencyKey }, data: { response } });
      return response;
    } catch (e) {
      await this.s.prisma.idempotencyKey.delete({ where: { key: b.idempotencyKey } }).catch(() => undefined);
      throw e;
    }
  }
}
