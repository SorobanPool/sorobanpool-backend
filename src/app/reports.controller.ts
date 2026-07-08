import { Controller, Get, Inject, Query, StreamableFile } from '@nestjs/common';
import { toStroops } from '../common/money.js';
import { riskOverview, type PoolFact } from '../risk/metrics.js';
import { type AuthedUser, CurrentUser, Roles } from './http.js';
import { walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

const dec = (d: { toString(): string }): bigint => toStroops(d.toString());
const str = (b: bigint): string => b.toString();

@Controller()
export class ReportsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** GMV, escrow held, failure and dispute rates, supplier ranking and the organizer-supplier collusion signal. */
  @Roles('ADMIN') @Get('admin/risk/overview')
  async overview() {
    const [pools, disputes] = await Promise.all([this.s.prisma.pool.findMany(), this.s.prisma.dispute.findMany()]);
    const supplierOf = new Map(pools.map((p) => [p.id, p.supplierAddress]));
    const facts: PoolFact[] = pools.map((p) => ({
      id: p.id.toString(), state: p.state, supplier: p.supplierAddress, organizer: p.organizerAddress, escrow: dec(p.escrowBalance),
      gross: p.receivedUnits !== null && p.finalUnitPrice ? BigInt(p.receivedUnits) * dec(p.finalUnitPrice) : 0n, indexedAt: p.indexedAt, endedAt: p.endedAt,
    }));
    const r = riskOverview(facts, disputes.map((d) => ({ poolId: d.poolId.toString(), supplier: supplierOf.get(d.poolId) ?? '', openedAt: d.openedAt })), this.s.now());
    return { ...r, gmv: str(r.gmv), escrowHeld: str(r.escrowHeld), generatedAt: this.s.now().toISOString() };
  }

  @Roles('ADMIN') @Get('admin/disputes')
  async disputes(@Query('state') state?: string) {
    const rows = await this.s.prisma.dispute.findMany({ where: state ? { state } : {}, orderBy: { slaDueAt: 'asc' }, take: 200 });
    return rows.map((d) => ({ id: d.id.toString(), poolId: d.poolId.toString(), opener: d.openerAddress, state: d.state, claimedAmount: d.claimedAmount.toString(), openedAt: d.openedAt, slaDueAt: d.slaDueAt, arbiter: d.arbiterAddress }));
  }

  @Roles('ADMIN') @Get('admin/offers')
  async offers(@Query('status') status?: string) {
    return this.s.prisma.offer.findMany({ where: status ? { status: status as 'LIVE' } : {}, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, title: true, category: true, status: true, supplierId: true, validUntil: true, offerHash: true } });
  }

  @Roles('ADMIN') @Get('admin/pools')
  async pools(@Query('state') state?: string) {
    const rows = await this.s.prisma.pool.findMany({ where: state ? { state } : {}, orderBy: { id: 'desc' }, take: 200 });
    return rows.map((p) => ({ id: p.id.toString(), state: p.state, organizer: p.organizerAddress, supplier: p.supplierAddress, totalUnits: p.totalUnits, escrowBalance: p.escrowBalance.toString(), frozenAmount: p.frozenAmount.toString() }));
  }

  @Roles('ADMIN') @Get('admin/users')
  async users(@Query('q') q?: string) {
    const rows = await this.s.prisma.user.findMany({ where: q ? { OR: [{ phone: { contains: q } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {}, include: { roles: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((u) => ({ id: u.id, phone: u.phone, displayName: u.displayName, walletAddress: u.walletAddress, roles: u.roles.map((r) => ({ role: r.role, level: r.level })) }));
  }

  /** What a supplier was paid per settled pool: gross, platform and organizer fees, net. JSON, or CSV with ?format=csv. */
  @Roles('SUPPLIER') @Get('suppliers/statement')
  async statement(@CurrentUser() u: AuthedUser, @Query('format') format?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const wallet = await walletOf(this.s, u.id);
    const rows = await this.s.prisma.pool.findMany({
      where: { supplierAddress: wallet, state: 'Settled', ...(from || to ? { endedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) },
      orderBy: { endedAt: 'desc' },
    });
    const offers = new Map((await this.s.prisma.offer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.offerId))] } }, select: { id: true, title: true } })).map((o) => [o.id, o.title]));
    const lines = rows.map((p) => {
      const net = dec(p.supplierNet), plat = dec(p.platformFee), org = dec(p.organizerFee);
      return { poolId: p.id.toString(), product: offers.get(p.offerId) ?? '', settledAt: p.endedAt?.toISOString() ?? '', unitsDelivered: p.receivedUnits ?? 0, gross: str(net + plat + org), platformFee: str(plat), organizerFee: str(org), net: str(net) };
    });
    const total = lines.reduce((a, l) => ({ gross: a.gross + BigInt(l.gross), platformFee: a.platformFee + BigInt(l.platformFee), organizerFee: a.organizerFee + BigInt(l.organizerFee), net: a.net + BigInt(l.net) }), { gross: 0n, platformFee: 0n, organizerFee: 0n, net: 0n });
    if (format === 'csv') {
      const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
      const head = 'pool_id,product,settled_at,units_delivered,gross_stroops,platform_fee_stroops,organizer_fee_stroops,net_stroops';
      return new StreamableFile(Buffer.from([head, ...lines.map((l) => [l.poolId, l.product, l.settledAt, l.unitsDelivered, l.gross, l.platformFee, l.organizerFee, l.net].map(esc).join(','))].join('\n')), { type: 'text/csv', disposition: 'attachment; filename="statement.csv"' });
    }
    return { lines, total: { gross: str(total.gross), platformFee: str(total.platformFee), organizerFee: str(total.organizerFee), net: str(total.net) }, currency: 'USDC stroops' };
  }
}
