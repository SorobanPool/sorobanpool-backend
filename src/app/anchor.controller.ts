import { BadRequestException, Body, Controller, Get, HttpException, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AnchorError, transferJson } from '../anchor/anchor.js';
import { formatUsdc } from '../common/money.js';
import { type AuthedUser, CurrentUser, parse } from './http.js';
import { SERVICES, type Services } from './services.js';

/** Naira deposits. Only the mock anchor exists; on mainnet/production these answer 501 until a licensed anchor is integrated. */
@Controller('anchor')
export class AnchorController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private get anchor() {
    if (!this.s.anchor) throw new HttpException({ error: 'NOT_AVAILABLE', message: 'Naira payments are not available yet' }, 501);
    return this.s.anchor;
  }

  @Post('deposit/start')
  async start(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { amountNgn } = parse(z.object({ amountNgn: z.string().regex(/^\d{1,9}$/, 'whole naira') }), body);
    try {
      const d = await this.anchor.startDeposit(u.id, BigInt(amountNgn));
      return {
        transferId: d.transferId, anchor: d.anchor, instructions: d.instructions, amountNgn: d.amountNgn.toString(), ngnPerUsd: d.ngnPerUsd,
        estimatedUsdc: formatUsdc(d.estimatedUsdcStroops),
        note: 'Indicative. The rate when your bank transfer is confirmed is final.',
      };
    } catch (e) {
      if (e instanceof AnchorError) throw new BadRequestException({ error: e.code, message: e.message });
      throw e;
    }
  }

  @Get('transfers/:id')
  async transfer(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const t = await this.anchor.transfer(id, u.id);
    if (!t) throw new NotFoundException('transfer not found');
    return transferJson(t);
  }
}
