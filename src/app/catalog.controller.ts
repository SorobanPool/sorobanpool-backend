import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { type Prisma } from '../generated/prisma/client.js';
import { offerHash } from '../catalog/offer.js';
import { validateOffer } from '../catalog/offer-validation.js';
import { combineQuotes, convertTiers, FxDivergenceError } from '../fx/fx.js';
import type { Tier } from '../pools/pricing.js';
import { type AuthedUser, CurrentUser, parse, Public, Roles } from './http.js';
import { SERVICES, type Services } from './services.js';

const tierNgn = z.object({ minUnits: z.number().int().positive(), priceNgn: z.string().regex(/^\d+$/, 'whole naira, digits only') });
const offerBody = z.object({
  title: z.string().min(3).max(120), brand: z.string().max(80).optional(), branded: z.boolean().default(false),
  description: z.string().min(3).max(2000), unitLabel: z.string().min(1).max(60), category: z.string().min(1).max(20),
  perishable: z.boolean().default(false), images: z.array(z.string().min(1)).max(10),
  tiersNgn: z.array(tierNgn).min(1).max(5), moq: z.number().int().positive(), maxUnits: z.number().int().positive(),
  maxPerMember: z.number().int().positive(), leadTimeHours: z.number().int().positive(),
  deliveryAreas: z.array(z.object({ state: z.string(), lga: z.string().optional() })).min(1), validUntil: z.coerce.date(),
});
type OfferBody = z.infer<typeof offerBody>;

export const tiersUsdcToJson = (t: Tier[]) => t.map((x) => ({ minUnits: x.minUnits, unitPrice: x.unitPrice.toString() }));
export const tiersUsdcFromJson = (j: unknown): Tier[] =>
  (j as { minUnits: number; unitPrice: string }[]).map((t) => ({ minUnits: t.minUnits, unitPrice: BigInt(t.unitPrice) }));

function check(b: OfferBody, now: Date) {
  const tiers: Tier[] = b.tiersNgn.map((t) => ({ minUnits: t.minUnits, unitPrice: BigInt(t.priceNgn) }));
  const r = validateOffer({ ...b, tiers }, now);
  if (r.errors.length) throw new BadRequestException({ error: 'OFFER_INVALID', issues: r.errors });
  return r.flags;
}

@Controller()
export class CatalogController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private async supplierWallet(userId: string): Promise<string> {
    const u = await this.s.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!u.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'Bind a wallet first' });
    return u.walletAddress;
  }

  private async mine(id: string, userId: string) {
    const o = await this.s.prisma.offer.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('offer not found');
    if (o.supplierId !== userId) throw new ForbiddenException('not your offer');
    return o;
  }

  @Roles('SUPPLIER') @Post('offers')
  async create(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(offerBody, body);
    const flags = check(b, this.s.now());
    const { branded: _branded, ...rest } = b;
    const offer = await this.s.prisma.offer.create({
      data: { ...rest, supplierId: u.id, tiersNgn: b.tiersNgn, tiersUsdc: [], fxQuoteId: '', offerHash: '', deliveryAreas: b.deliveryAreas, status: 'DRAFT' },
    });
    return { id: offer.id, status: offer.status, flags };
  }

  @Roles('SUPPLIER') @Patch('offers/:id')
  async update(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.mine(id, u.id);
    if (o.status !== 'DRAFT') throw new BadRequestException({ error: 'NOT_DRAFT', message: 'Only drafts can be edited; publish a new offer instead' });
    const b = parse(offerBody, body);
    check(b, this.s.now());
    const { branded: _branded, ...rest } = b;
    await this.s.prisma.offer.update({ where: { id }, data: { ...rest, tiersNgn: b.tiersNgn, deliveryAreas: b.deliveryAreas } });
    return { id };
  }

  /** Converts naira tiers to USDC at the current FX quote and fixes the offer hash. Blocked on FX divergence. */
  private async price(o: { id: string; supplierId: string; title: string; brand: string | null; unitLabel: string; category: string; perishable: boolean; tiersNgn: unknown; moq: number; maxUnits: number; maxPerMember: number; leadTimeHours: number }, validUntil: Date) {
    const supplier = await this.s.prisma.supplierProfile.findUnique({ where: { userId: o.supplierId } });
    if (supplier?.kybStatus !== 'APPROVED') throw new ForbiddenException({ error: 'KYB_REQUIRED', message: 'Only verified suppliers can publish offers' });
    const supplierAddress = await this.supplierWallet(o.supplierId);
    let quote;
    try {
      quote = combineQuotes(await this.s.fx.quotes(), this.s.now());
    } catch (e) {
      if (e instanceof FxDivergenceError) throw new BadRequestException({ error: 'FX_DIVERGENCE', message: e.message });
      throw e;
    }
    const tiers = convertTiers((o.tiersNgn as { minUnits: number; priceNgn: string }[]).map((t) => ({ minUnits: t.minUnits, priceNgn: BigInt(t.priceNgn) })), quote.rate);
    const fx = await this.s.prisma.fxQuote.create({ data: { pair: 'NGN/USD', rate: quote.rate.toString(), sources: quote.sources as unknown as Prisma.InputJsonValue } });
    const hash = offerHash({
      supplierAddress, title: o.title, brand: o.brand ?? undefined, unitLabel: o.unitLabel, category: o.category, perishable: o.perishable,
      tiers, moq: o.moq, maxUnits: o.maxUnits, maxPerMember: o.maxPerMember, leadTimeHours: o.leadTimeHours, validUntil,
    });
    return { tiersUsdc: tiersUsdcToJson(tiers), fxQuoteId: fx.id, offerHash: hash, rate: quote.rate };
  }

  @Roles('SUPPLIER') @Post('offers/:id/publish') @HttpCode(200)
  async publish(@CurrentUser() u: AuthedUser, @Param('id') id: string) {
    const o = await this.mine(id, u.id);
    if (o.status !== 'DRAFT') throw new BadRequestException({ error: 'NOT_DRAFT', message: 'Already published' });
    if (o.validUntil <= this.s.now()) throw new BadRequestException({ error: 'EXPIRED', message: 'validUntil is in the past' });
    const p = await this.price(o, o.validUntil);
    await this.s.prisma.offer.update({ where: { id }, data: { tiersUsdc: p.tiersUsdc, fxQuoteId: p.fxQuoteId, offerHash: p.offerHash, status: 'LIVE' } });
    return { id, status: 'LIVE', offerHash: p.offerHash, ngnPerUsd: p.rate, tiersUsdc: p.tiersUsdc };
  }

  /** Re-quotes FX (and extends validity, max 14 days) for a live or expired offer. */
  @Roles('SUPPLIER') @Post('offers/:id/refresh-fx') @HttpCode(200)
  async refresh(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.mine(id, u.id);
    if (o.status === 'TAKEN_DOWN' || o.status === 'DRAFT') throw new BadRequestException({ error: 'BAD_STATE', message: 'Publish the draft or contact support' });
    const { validUntil } = parse(z.object({ validUntil: z.coerce.date() }), body);
    const days = (validUntil.getTime() - this.s.now().getTime()) / 86_400_000;
    if (days <= 0 || days > 14) throw new BadRequestException({ error: 'BAD_VALIDITY', message: 'validUntil must be within 14 days' });
    const p = await this.price(o, validUntil);
    await this.s.prisma.offer.update({ where: { id }, data: { tiersUsdc: p.tiersUsdc, fxQuoteId: p.fxQuoteId, offerHash: p.offerHash, validUntil, status: 'LIVE' } });
    return { id, status: 'LIVE', offerHash: p.offerHash, ngnPerUsd: p.rate };
  }

  @Public() @Get('offers')
  async list(@Query() q: Record<string, string | undefined>) {
    const now = this.s.now();
    const where: Prisma.OfferWhereInput = { status: 'LIVE', validUntil: { gt: now } };
    if (q.category) where.category = q.category;
    if (q.q) where.title = { contains: q.q, mode: 'insensitive' };
    const rows = await this.s.prisma.offer.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    const inArea = (areas: unknown) => {
      const a = areas as { state: string; lga?: string }[];
      return (!q.state || a.some((x) => x.state.toLowerCase() === q.state!.toLowerCase())) && (!q.lga || a.some((x) => !x.lga || x.lga.toLowerCase() === q.lga!.toLowerCase()));
    };
    return rows.filter((r) => inArea(r.deliveryAreas)).map(publicOffer);
  }

  @Public() @Get('offers/:id')
  async one(@Param('id') id: string) {
    const o = await this.s.prisma.offer.findUnique({ where: { id } });
    if (!o || o.status === 'DRAFT') throw new NotFoundException('offer not found');
    return publicOffer(o);
  }
}

export function publicOffer(o: Prisma.OfferGetPayload<object>) {
  return {
    id: o.id, supplierId: o.supplierId, title: o.title, brand: o.brand, description: o.description, unitLabel: o.unitLabel,
    category: o.category, perishable: o.perishable, images: o.images, tiersNgn: o.tiersNgn, tiersUsdc: o.tiersUsdc, moq: o.moq,
    maxUnits: o.maxUnits, maxPerMember: o.maxPerMember, leadTimeHours: o.leadTimeHours, deliveryAreas: o.deliveryAreas,
    validUntil: o.validUntil, offerHash: o.offerHash, status: o.status,
  };
}
