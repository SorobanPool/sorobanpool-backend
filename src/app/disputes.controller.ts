import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { A, type DisputeReason, type Outcome } from '../chain/args.js';
import { toStroops } from '../common/money.js';
import { sha256Hex } from '../common/canonical-json.js';
import { type AuthedUser, CurrentUser, parse, Roles } from './http.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ReleaseToSupplier') }),
  z.object({ kind: z.literal('RefundMember'), units: z.number().int().min(0) }),
  z.object({ kind: z.literal('Split'), bp: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal('RefundPool') }),
]);

@Controller()
export class DisputesController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async bundleHash(ids: string[], ownerId: string, extra: Record<string, unknown>): Promise<string> {
    const rows = await this.s.prisma.evidence.findMany({ where: { id: { in: ids }, ownerId, ...extra } });
    if (rows.length !== ids.length || rows.some((r) => !r.sha256)) throw new BadRequestException({ error: 'EVIDENCE_INVALID', message: 'Upload your evidence first' });
    return createHash('sha256').update(rows.map((r) => r.sha256).sort().join('')).digest('hex');
  }

  @Post('disputes/prepare')
  async open(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({
      poolId: z.string().regex(/^\d+$/), reason: z.enum(['Short', 'WrongItem', 'Damaged', 'Quality', 'NotDelivered', 'Other']),
      claimedUnits: z.number().int().positive(), evidenceIds: z.array(z.string()).min(1),
    }), body);
    const me = await walletOf(this.s, u.id);
    const evidence = await this.bundleHash(b.evidenceIds, u.id, { poolId: BigInt(b.poolId) });
    return prepareAction(this.s, 'disputes', 'open', A.disputeOpen(me, BigInt(b.poolId), b.reason as DisputeReason, b.claimedUnits, evidence));
  }

  @Post('disputes/:id/evidence/prepare')
  async addEvidence(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { evidenceIds } = parse(z.object({ evidenceIds: z.array(z.string()).min(1) }), body);
    const me = await walletOf(this.s, u.id);
    const evidence = await this.bundleHash(evidenceIds, u.id, {});
    return prepareAction(this.s, 'disputes', 'add_evidence', A.disputeEvidence(me, BigInt(id), evidence));
  }

  @Get('disputes/:id')
  async one(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const d = await this.s.prisma.dispute.findUnique({ where: { id: BigInt(id) } });
    if (!d) throw new NotFoundException('dispute not found');
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    const pool = await this.s.prisma.pool.findUnique({ where: { id: d.poolId } });
    const party = !!wallet && (d.openerAddress === wallet || pool?.organizerAddress === wallet || pool?.supplierAddress === wallet);
    if (!party && !u.roles.includes('ARBITER') && !u.roles.includes('ADMIN')) throw new NotFoundException('dispute not found');
    return view(d);
  }

  @Get('disputes')
  async mine(@CurrentUser() u: AuthedUser, @Query('mine') mine?: string) {
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    if (mine !== 'true' || !wallet) return [];
    return (await this.s.prisma.dispute.findMany({ where: { openerAddress: wallet }, orderBy: { id: 'desc' }, take: 100 })).map(view);
  }

  // ---- arbiter console ----

  @Roles('ARBITER') @Get('arbiter/queue')
  async queue() {
    const rows = await this.s.prisma.dispute.findMany({ where: { state: 'OPEN' }, orderBy: { slaDueAt: 'asc' }, take: 100 });
    return rows.map((d) => ({ ...view(d), msToSla: d.slaDueAt.getTime() - this.s.now().getTime() }));
  }

  @Roles('ARBITER') @Get('arbiter/disputes/:id')
  async arbiterView(@Param('id') id: string) {
    const d = await this.s.prisma.dispute.findUnique({ where: { id: BigInt(id) } });
    if (!d) throw new NotFoundException('dispute not found');
    const pool = await this.s.prisma.pool.findUnique({ where: { id: d.poolId } });
    const evidence = await this.s.prisma.evidence.findMany({ where: { OR: [{ disputeId: d.id }, { poolId: d.poolId }] }, select: { id: true, kind: true, mime: true, createdAt: true } });
    return { dispute: view(d), pool: pool ? { id: pool.id.toString(), state: pool.state, totalUnits: pool.totalUnits, finalUnitPrice: pool.finalUnitPrice?.toString() ?? null } : null, evidence };
  }

  /** The arbiter signs with their own wallet; the server never holds arbiter keys. */
  @Roles('ARBITER') @Post('arbiter/disputes/:id/resolve/prepare')
  async resolve(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ outcome: outcomeSchema, reasoning: z.string().min(10).max(4000) }), body);
    const me = await walletOf(this.s, u.id);
    const hash = sha256Hex(b.reasoning);
    await this.s.prisma.auditLog.create({ data: { actorId: u.id, action: 'dispute.reasoning', target: id, data: { text: b.reasoning, hash, outcome: b.outcome } } });
    return { ...(await prepareAction(this.s, 'disputes', 'resolve', A.disputeResolve(me, BigInt(id), b.outcome as Outcome, hash))), reasoningHash: hash };
  }

  // ---- supplier bond ----

  @Roles('SUPPLIER') @Post('bonds/deposit/prepare')
  async deposit(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { amountUsdc } = parse(z.object({ amountUsdc: z.string() }), body);
    return prepareAction(this.s, 'supplier_bond', 'deposit', A.bondAmount(await walletOf(this.s, u.id), toStroops(amountUsdc)));
  }

  @Roles('SUPPLIER') @Post('bonds/withdraw/prepare')
  async withdraw(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { amountUsdc } = parse(z.object({ amountUsdc: z.string() }), body);
    return prepareAction(this.s, 'supplier_bond', 'withdraw', A.bondAmount(await walletOf(this.s, u.id), toStroops(amountUsdc)));
  }

  @Roles('SUPPLIER') @Get('bonds/me')
  async myBond(@CurrentUser() u: AuthedUser) {
    const wallet = await walletOf(this.s, u.id);
    const b = await this.s.prisma.bond.findUnique({ where: { supplierAddress: wallet } });
    return { total: b?.total.toString() ?? '0', reserved: b?.reserved.toString() ?? '0' };
  }
}

function view(d: { id: bigint; poolId: bigint; openerAddress: string; state: string; claimedAmount: { toString(): string }; openedAt: Date; slaDueAt: Date; arbiterAddress: string | null }) {
  return { id: d.id.toString(), poolId: d.poolId.toString(), opener: d.openerAddress, state: d.state, claimedAmount: d.claimedAmount.toString(), openedAt: d.openedAt, slaDueAt: d.slaDueAt, arbiter: d.arbiterAddress };
}
