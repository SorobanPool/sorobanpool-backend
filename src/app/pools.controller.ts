import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { A } from '../chain/args.js';
import { canonicalJson, sha256Hex } from '../common/canonical-json.js';
import { formatUsdc } from '../common/money.js';
import { unitLabelHash } from '../catalog/offer.js';
import { quote as priceQuote, ceilingPrice, tierIndex } from '../pools/pricing.js';
import { renderShareCard } from '../sharecards/sharecard.js';
import { tiersUsdcFromJson, publicOffer } from './catalog.controller.js';
import { type AuthedUser, CurrentUser, parse, Public, Roles } from './http.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';
import type { Prisma } from '../generated/prisma/client.js';

const naira = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

@Controller()
export class PoolsController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async latestRate(): Promise<number | undefined> {
    const q = await this.s.prisma.fxQuote.findFirst({ orderBy: { createdAt: 'desc' } });
    return q ? Number(q.rate.toString()) : undefined;
  }

  /** Builds create_pool for the organizer and records the off-chain hub details under a unique hub hash. */
  @Roles('ORGANIZER') @Post('pools/prepare')
  async prepare(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({
      offerId: z.string(), fillDeadline: z.coerce.date(), hub: z.object({ address: z.string().min(3), contact: z.string().min(5) }),
      pickupWindow: z.object({ from: z.string(), to: z.string() }), organizerFeeBp: z.number().int().min(0).max(200).default(0), clusterOnly: z.boolean().default(false),
    }), body);
    const offer = await this.s.prisma.offer.findUnique({ where: { id: b.offerId } });
    if (!offer || offer.status !== 'LIVE' || offer.validUntil <= this.s.now()) throw new NotFoundException('offer is not available');
    const supplier = await this.s.prisma.user.findUniqueOrThrow({ where: { id: offer.supplierId } });
    if (!supplier.walletAddress) throw new BadRequestException('supplier has no wallet');
    const organizer = await walletOf(this.s, u.id);
    let cluster: string | undefined;
    if (b.clusterOnly) {
      cluster = (await this.s.prisma.traderProfile.findUnique({ where: { userId: u.id } }))?.cluster ?? undefined;
      if (!cluster) throw new BadRequestException({ error: 'NO_CLUSTER', message: 'Set your market first to restrict a pool to it' });
    }
    const hubHash = sha256Hex(canonicalJson({ address: b.hub.address, contact: b.hub.contact, nonce: randomBytes(16).toString('hex') }));
    const shareSlug = randomBytes(5).toString('hex');
    await this.s.prisma.pendingPool.create({
      data: { hubHash, offerId: offer.id, organizerAddress: organizer, hubAddress: b.hub.address, hubContact: b.hub.contact, pickupWindow: b.pickupWindow, fillDeadline: b.fillDeadline, shareSlug },
    });
    try {
      const prepared = await prepareAction(this.s, 'group_buy', 'create_pool', A.createPool(organizer, {
        supplier: supplier.walletAddress, offerHash: offer.offerHash, unitLabelHash: unitLabelHash(offer.unitLabel), category: offer.category,
        tiers: tiersUsdcFromJson(offer.tiersUsdc), moq: offer.moq, maxUnits: offer.maxUnits, maxPerMember: offer.maxPerMember,
        leadTimeSecs: offer.leadTimeHours * 3600, perishable: offer.perishable,
      }, hubHash, b.organizerFeeBp, cluster, Math.floor(b.fillDeadline.getTime() / 1000)));
      return { ...prepared, shareSlug, hubHash };
    } catch (e) {
      await this.s.prisma.pendingPool.delete({ where: { hubHash } }).catch(() => undefined);
      throw e;
    }
  }

  private async poolView(id: bigint) {
    const pool = await this.s.prisma.pool.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('pool not found');
    const offer = await this.s.prisma.offer.findUnique({ where: { id: pool.offerId } });
    const tiers = offer ? tiersUsdcFromJson(offer.tiersUsdc) : [];
    const members = await this.s.prisma.commitment.count({ where: { poolId: id, units: { gt: 0 } } });
    const rate = await this.latestRate();
    const first = tiers[0];
    const price = first ? ceilingPrice(tiers, pool.totalUnits) : 0n;
    const next = tiers[(tierIndex(tiers, pool.totalUnits) ?? -1) + 1];
    return {
      pool, offer, tiers, members, rate,
      view: {
        id: pool.id.toString(), state: pool.state, shareSlug: pool.shareSlug, offerId: pool.offerId, organizer: pool.organizerAddress, supplier: pool.supplierAddress,
        hub: { address: pool.hubAddress, contact: pool.hubContact }, pickupWindow: pool.pickupWindow, fillDeadline: pool.fillDeadline,
        totalUnits: pool.totalUnits, receivedUnits: pool.receivedUnits, moq: offer?.moq ?? null, maxUnits: offer?.maxUnits ?? null, members,
        progressPct: offer && offer.moq > 0 ? Math.min(100, Math.floor((pool.totalUnits * 100) / offer.moq)) : 0,
        currentUnitPriceUsdc: price.toString(), currentUnitPriceNaira: rate ? naira(((price * BigInt(Math.round(rate * 1e6))) / 10_000_000n / 1_000_000n)) : null,
        nextBreak: next ? { unitsToGo: next.minUnits - pool.totalUnits, unitPriceUsdc: next.unitPrice.toString() } : null,
        tiersUsdc: tiers.map((t) => ({ minUnits: t.minUnits, unitPrice: t.unitPrice.toString() })),
        finalUnitPriceUsdc: pool.finalUnitPrice?.toString() ?? null, escrowBalanceUsdc: pool.escrowBalance.toString(),
        offer: offer ? publicOffer(offer) : null,
        trustMessage: 'Your money is held safely. The supplier is paid only after the goods arrive. If the group does not fill, you get everything back automatically.',
      },
    };
  }

  @Get('pools/:id')
  async get(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const { view } = await this.poolView(BigInt(id));
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    const mine = wallet ? await this.s.prisma.commitment.findUnique({ where: { poolId_memberAddress: { poolId: BigInt(id), memberAddress: wallet } } }) : null;
    return { ...view, myCommitment: mine ? { units: mine.units, paid: mine.paid.toString(), pickedUp: mine.pickedUp } : null };
  }

  /** Public preview used by WhatsApp links. */
  @Public() @Get('p/:slug')
  async preview(@Param('slug') slug: string) {
    const pool = await this.s.prisma.pool.findUnique({ where: { shareSlug: slug } });
    if (!pool) throw new NotFoundException('pool not found');
    return (await this.poolView(pool.id)).view;
  }

  @Get('pools')
  async list(@CurrentUser() u: AuthedUser, @Query() q: Record<string, string | undefined>) {
    const wallet = (await this.s.prisma.user.findUnique({ where: { id: u.id } }))?.walletAddress;
    let where: Prisma.PoolWhereInput = { state: q.state ?? 'Open' };
    if (q.mine === 'true') {
      if (!wallet) return [];
      const joined = (await this.s.prisma.commitment.findMany({ where: { memberAddress: wallet, units: { gt: 0 } }, select: { poolId: true } })).map((c) => c.poolId);
      where = { OR: [{ organizerAddress: wallet }, { supplierAddress: wallet }, { id: { in: joined } }] };
    }
    const rows = await this.s.prisma.pool.findMany({ where, orderBy: { id: 'desc' }, take: 100 });
    return rows.map((p) => ({ id: p.id.toString(), state: p.state, shareSlug: p.shareSlug, offerId: p.offerId, totalUnits: p.totalUnits, fillDeadline: p.fillDeadline }));
  }

  @Get('pools/:id/quote')
  async quote(@Param('id') id: string, @Query('units') units: string) {
    const n = Number(units);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('units must be a positive integer');
    const { pool, tiers, rate } = await this.poolView(BigInt(id));
    if (!tiers.length) throw new BadRequestException('pool has no offer terms');
    const q = priceQuote(tiers, pool.totalUnits, n);
    const ngn = (x: bigint) => (rate ? naira((x * BigInt(Math.round(rate * 1e6)) + 9_999_999_999_999n) / 10_000_000_000_000n) : null);
    return {
      units: n, amountNowUsdc: q.amountNow.toString(), amountNowDisplay: formatUsdc(q.amountNow), amountNowNairaEstimate: ngn(q.amountNow),
      currentUnitPriceUsdc: q.currentUnitPrice.toString(), expectedRefundIfClosedNowUsdc: q.expectedRefundIfClosedNow.toString(),
      nextBreak: q.nextBreak ? { unitsToGo: q.nextBreak.unitsToGo, unitPriceUsdc: q.nextBreak.unitPrice.toString() } : null,
      note: 'Naira amounts are indicative. You pay the current tier price now; if the pool reaches a better tier you are refunded the difference automatically.',
    };
  }

  @Public() @Get('pools/:id/sharecard.png') @Header('Content-Type', 'image/png') @Header('Cache-Control', 'public, max-age=60')
  async shareCard(@Param('id') id: string) {
    const { view, offer } = await this.poolView(BigInt(id));
    const unitsToMoq = Math.max(0, (view.moq ?? 0) - view.totalUnits);
    return new StreamableFile(await renderShareCard({
      product: offer?.title ?? 'Group buy', supplier: offer?.brand ?? 'Verified supplier', currentPriceNaira: view.currentUnitPriceNaira ?? '—',
      nextBreak: view.nextBreak ? { unitsToGo: view.nextBreak.unitsToGo, priceNaira: view.currentUnitPriceNaira ?? '—' } : undefined,
      unitsToMoq, progressPct: view.progressPct, deadlineLabel: `closes ${view.fillDeadline.toDateString()}`,
    }));
  }

  /** Thin wrappers that turn one user intent into a contract call; the contract enforces every rule. */
  @Post('pools/:id/:action/prepare')
  async act(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const poolId = BigInt(id);
    const me = await walletOf(this.s, u.id);
    const units = () => parse(z.object({ units: z.number().int().positive() }), body).units;
    switch (action) {
      case 'commit': {
        const b = parse(z.object({ units: z.number().int().positive(), method: z.enum(['USDC', 'NGN']).default('USDC') }), body);
        if (b.method === 'NGN') throw new BadRequestException({ error: 'NOT_IMPLEMENTED', message: 'Naira payments arrive with the anchor integration' });
        return prepareAction(this.s, 'group_buy', 'commit', A.commit(me, poolId, b.units));
      }
      case 'increase': return prepareAction(this.s, 'group_buy', 'increase', A.commit(me, poolId, units()));
      case 'withdraw': return prepareAction(this.s, 'group_buy', 'withdraw_commitment', A.withdraw(me, poolId));
      case 'close-early': return prepareAction(this.s, 'group_buy', 'close_early', A.closeEarly(me, poolId));
      case 'accept': {
        const b = parse(z.object({ advanceBp: z.number().int().min(0).max(4000).default(0) }), body ?? {});
        return prepareAction(this.s, 'group_buy', 'accept', A.accept(me, poolId, b.advanceBp));
      }
      case 'reject': return prepareAction(this.s, 'group_buy', 'reject', A.reject(me, poolId));
      case 'dispatch': {
        const b = parse(z.object({ waybillHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }), body ?? {});
        return prepareAction(this.s, 'group_buy', 'dispatch', A.dispatch(me, poolId, b.waybillHash));
      }
      case 'delivery': {
        const b = parse(z.object({ receivedUnits: z.number().int().min(0), evidenceIds: z.array(z.string()).min(1) }), body);
        const rows = await this.s.prisma.evidence.findMany({ where: { id: { in: b.evidenceIds }, poolId, ownerId: u.id } });
        if (rows.length !== b.evidenceIds.length || rows.some((r) => !r.sha256)) throw new BadRequestException({ error: 'EVIDENCE_INVALID', message: 'Upload your delivery photos first' });
        // One on-chain hash for the whole bundle: sha256 of the sorted file hashes.
        const bundle = createHash('sha256').update(rows.map((r) => r.sha256).sort().join('')).digest('hex');
        return prepareAction(this.s, 'group_buy', 'confirm_delivery', A.confirmDelivery(me, poolId, b.receivedUnits, bundle));
      }
      case 'pickup': return prepareAction(this.s, 'group_buy', 'confirm_pickup', A.pickup(me, poolId));
      case 'refund': return prepareAction(this.s, 'group_buy', 'claim_refund', A.claimRefund(me, poolId));
      case 'member-confirm': return prepareAction(this.s, 'group_buy', 'member_confirm_delivery', A.memberConfirm(me, poolId));
      default: throw new NotFoundException(`unknown action ${action}`);
    }
  }
}
