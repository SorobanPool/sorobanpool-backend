import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, HttpStatus, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { type Prisma } from '../generated/prisma/client.js';
import { offerHash } from '../catalog/offer.js';
import { validateOffer, computeCategoryMedians, isPriceOutlier } from '../catalog/offer-validation.js';
import { combineQuotes, convertTiers, FxDivergenceError } from '../fx/fx.js';
import type { Tier } from '../pools/pricing.js';
import { type AuthedUser, CurrentUser, parse, Public, Roles } from './http.js';
import { CACHE_CONTROL } from './http-setup.js';
import { SERVICES, type Services } from './services.js';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';

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

function check(b: OfferBody, now: Date, options?: { isDraft?: boolean }) {
  const tiers: Tier[] = b.tiersNgn.map((t) => ({ minUnits: t.minUnits, unitPrice: BigInt(t.priceNgn) }));
  const r = validateOffer({ ...b, tiers }, now, undefined, options);
  if (r.errors.length) throw new BadRequestException({ error: 'OFFER_INVALID', issues: r.errors });
  return r.flags;
}

/**
 * Generate an ETag from offer data for conditional GET support.
 * Issue #68: ETag generation for caching.
 */
function generateETag(data: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return `"${hash.substring(0, 16)}"`;
}

/**
 * Check if the request's If-None-Match header matches the ETag.
 * Issue #68: Conditional GET support.
 */
function checkETag(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers['if-none-match'];
  if (!ifNoneMatch) return false;
  const tags = ifNoneMatch.split(',').map((t) => t.trim());
  return tags.includes(etag) || tags.includes('*');
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
    // Issue #70: Drafts may have fewer than MIN_PHOTOS images
    const flags = check(b, this.s.now(), { isDraft: true });
    const { branded: _branded, ...rest } = b;
    const offer = await this.s.prisma.offer.create({
      data: { ...rest, supplierId: u.id, tiersNgn: b.tiersNgn, tiersUsdc: [], fxQuoteId: '', offerHash: '', deliveryAreas: b.deliveryAreas, status: 'DRAFT', priceOutlierFlag: false },
    });
    return { id: offer.id, status: offer.status, flags };
  }

  @Roles('SUPPLIER') @Patch('offers/:id')
  async update(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.mine(id, u.id);
    if (o.status !== 'DRAFT') throw new BadRequestException({ error: 'NOT_DRAFT', message: 'Only drafts can be edited; publish a new offer instead' });
    const b = parse(offerBody, body);
    // Issue #70: Drafts may have fewer than MIN_PHOTOS images
    check(b, this.s.now(), { isDraft: true });
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
    const fx = await this.s.prisma.fxQuote.create({ data: { pair: 'NGN/USD', rate: quote.rate.toString(), sources: { quotes: quote.sources, divergence: quote.divergence } as unknown as Prisma.InputJsonValue } });
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
    
    // Issue #69: Re-check validUntil against current time on publish
    if (o.validUntil <= this.s.now()) throw new BadRequestException({ error: 'EXPIRED', message: 'validUntil is in the past' });
    
    // Issue #70: Validate that we have at least MIN_PHOTOS images and they belong to the supplier
    if (o.images.length < 2) {
      throw new BadRequestException({ error: 'OFFER_INVALID', issues: ['at least 2 photos are required'] });
    }
    
    // Issue #70: Check that all image keys exist and are owned by the supplier
    for (const imageKey of o.images) {
      const evidence = await this.s.prisma.evidence.findFirst({
        where: { 
          id: imageKey, 
          ownerId: o.supplierId, 
          kind: 'PRODUCT',
          NOT: { sha256: '' },
        },
      });
      if (!evidence) {
        throw new BadRequestException({ 
          error: 'INVALID_IMAGE', 
          message: `Image "${imageKey}" does not exist or is not owned by you` 
        });
      }
    }
    
    // Issue #65: Compute category median and check for price outliers
    const liveOffers = await this.s.prisma.offer.findMany({
      where: { status: 'LIVE', category: o.category, validUntil: { gt: this.s.now() } },
      select: { category: true, tiersNgn: true },
    });
    
    const categoryTiers = liveOffers.map((offer) => ({
      category: offer.category,
      tiers: (offer.tiersNgn as { minUnits: number; priceNgn: string }[]).map((t) => ({
        unitPrice: BigInt(t.priceNgn),
      })),
    }));
    
    const medians = computeCategoryMedians(categoryTiers);
    const categoryMedian = medians.get(o.category);
    const firstTierPrice = (o.tiersNgn as { minUnits: number; priceNgn: string }[])[0];
    const priceOutlierFlag = firstTierPrice 
      ? isPriceOutlier(BigInt(firstTierPrice.priceNgn), categoryMedian)
      : false;
    
    const p = await this.price(o, o.validUntil);
    await this.s.prisma.offer.update({ 
      where: { id }, 
      data: { 
        tiersUsdc: p.tiersUsdc, 
        fxQuoteId: p.fxQuoteId, 
        offerHash: p.offerHash, 
        status: 'LIVE',
        priceOutlierFlag,
      } 
    });
    return { id, status: 'LIVE', offerHash: p.offerHash, ngnPerUsd: p.rate, tiersUsdc: p.tiersUsdc, priceOutlierFlag };
  }

  /** Re-quotes FX (and extends validity, max 14 days) for a live or expired offer. */
  @Roles('SUPPLIER') @Post('offers/:id/refresh-fx') @HttpCode(200)
  async refresh(@CurrentUser() u: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const o = await this.mine(id, u.id);
    if (o.status === 'TAKEN_DOWN' || o.status === 'DRAFT') throw new BadRequestException({ error: 'BAD_STATE', message: 'Publish the draft or contact support' });
    const { validUntil } = parse(z.object({ validUntil: z.coerce.date() }), body);
    // Issue #69: Enforce MAX_VALIDITY_DAYS on refresh
    const days = (validUntil.getTime() - this.s.now().getTime()) / 86_400_000;
    if (days <= 0 || days > 14) throw new BadRequestException({ error: 'BAD_VALIDITY', message: 'validUntil must be within 14 days' });
    const p = await this.price(o, validUntil);
    await this.s.prisma.offer.update({ where: { id }, data: { tiersUsdc: p.tiersUsdc, fxQuoteId: p.fxQuoteId, offerHash: p.offerHash, validUntil, status: 'LIVE' } });
    return { id, status: 'LIVE', offerHash: p.offerHash, ngnPerUsd: p.rate };
  }

  /** Current NGN per USD from the configured sources, so the offer form can preview USDC prices. Blocked on divergence. */
  @Public() @Get('fx/quote')
  async fxQuote() {
    try {
      const q = combineQuotes(await this.s.fx.quotes(), this.s.now());
      return { ngnPerUsd: q.rate, sources: q.sources.length, at: q.at.toISOString(), ttlSeconds: 60 };
    } catch (e) {
      if (e instanceof FxDivergenceError) throw new BadRequestException({ error: 'FX_DIVERGENCE', message: e.message });
      throw e;
    }
  }

  @Public() @Get('offers') @Header('Cache-Control', CACHE_CONTROL.catalog)
  async list(@Query() q: Record<string, string | undefined>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const now = this.s.now();
    const where: Prisma.OfferWhereInput = { status: 'LIVE', validUntil: { gt: now } };
    if (q.category) where.category = q.category;
    if (q.q) where.title = { contains: q.q, mode: 'insensitive' };
    const rows = await this.s.prisma.offer.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    const inArea = (areas: unknown) => {
      const a = areas as { state: string; lga?: string }[];
      return (!q.state || a.some((x) => x.state.toLowerCase() === q.state!.toLowerCase())) && (!q.lga || a.some((x) => !x.lga || x.lga.toLowerCase() === q.lga!.toLowerCase()));
    };
    const result = rows.filter((r) => inArea(r.deliveryAreas)).map(publicOffer);
    
    // Issue #68: ETag support for conditional GET
    const etag = generateETag(result);
    res.setHeader('ETag', etag);
    
    if (checkETag(req, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return;
    }
    
    return result;
  }

  @Public() @Get('offers/:id') @Header('Cache-Control', CACHE_CONTROL.catalog)
  async one(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const o = await this.s.prisma.offer.findUnique({ where: { id } });
    if (!o || o.status === 'DRAFT') throw new NotFoundException('offer not found');
    const result = publicOffer(o);
    
    // Issue #68: ETag support for conditional GET
    const etag = generateETag(result);
    res.setHeader('ETag', etag);
    
    if (checkETag(req, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return;
    }
    
    return result;
  }
}

/** A product photo as offers expose it (#104): the full WebP and a 320px thumbnail for low-bandwidth clients. */
export const imageRef = (id: string) => ({ id, url: `/v1/images/${id}`, thumb: `/v1/images/${id}?w=320` });

export function publicOffer(o: Prisma.OfferGetPayload<object>) {
  return {
    id: o.id, supplierId: o.supplierId, title: o.title, brand: o.brand, description: o.description, unitLabel: o.unitLabel,
    category: o.category, perishable: o.perishable, images: o.images.map(imageRef), tiersNgn: o.tiersNgn, tiersUsdc: o.tiersUsdc, moq: o.moq,
    maxUnits: o.maxUnits, maxPerMember: o.maxPerMember, leadTimeHours: o.leadTimeHours, deliveryAreas: o.deliveryAreas,
    validUntil: o.validUntil, offerHash: o.offerHash, status: o.status,
  };
}
