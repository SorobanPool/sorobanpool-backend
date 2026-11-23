import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, GoneException, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { A, type Role } from '../chain/args.js';
import { sha256Hex } from '../common/canonical-json.js';
import { mask } from '../common/pii.js';
import { KYB_DOCUMENT_KINDS, signUrl } from '../evidence/evidence.js';
import { storedSources } from '../fx/fx.js';
import { verHashMatches } from '../verification/attestor.js';
import { KYC_LEVEL } from './kyc.controller.js';
import { type AuthedUser, CurrentUser, parse, Roles } from './http.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

const roleSchema = z.enum(['Trader', 'Organizer', 'Supplier']);

/** Reason codes for revoking a verification (#129). Written to the audit log, and on-chain with the revocation. */
export const REVOCATION_REASONS = ['FRAUD', 'DUPLICATE_IDENTITY', 'DOCUMENT_INVALID', 'ADMIN_ERROR'] as const;
const revokeSchema = z.object({ role: roleSchema, reason: z.enum(REVOCATION_REASONS) });

/** Verification record kind for an admin attestation of one role (the KYC flow keeps its own `KYC` kind). */
const attestationKind = (dbRole: string) => `ATTESTATION:${dbRole}`;
/** The record kinds that hold a verification of this role, which a revocation marks REVOKED. */
const verificationKinds = (dbRole: string): string[] => (dbRole === 'TRADER' ? ['KYC', attestationKind(dbRole)] : [attestationKind(dbRole)]);

@Controller()
export class AdminController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private audit(actorId: string, action: string, target: string, data: object) {
    return this.s.prisma.auditLog.create({ data: { actorId, action, target, data } });
  }

  /** The user signs their own on-chain registration; profile_hash carries no personal data. */
  @Post('registry/register/prepare')
  async register(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const b = parse(z.object({ role: roleSchema, cluster: z.string().max(30).optional() }), body);
    const profileHash = sha256Hex(`${u.id}:${b.role}`);
    return prepareAction(this.s, 'registry', 'register', A.register(await walletOf(this.s, u.id), b.role as Role, profileHash, b.cluster));
  }

  /**
   * Review queue, oldest submission first. Filters: `status` (default PENDING), `state`, `from`/`to` (submission date).
   * Cursor pagination: pass the `X-Next-Cursor` response header back as `cursor`; it is absent on the last page.
   */
  @Roles('ADMIN') @Get('admin/suppliers')
  async suppliers(@Res({ passthrough: true }) res: Response, @Query() query: Record<string, string>) {
    const q = parse(z.object({
      status: z.string().default('PENDING'), state: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }), query);
    const where = {
      kybStatus: q.status,
      ...(q.state ? { state: q.state } : {}),
      ...(q.from || q.to ? { submittedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const page = await this.s.prisma.supplierProfile.findMany({
      where, orderBy: [{ submittedAt: 'asc' }, { userId: 'asc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { userId: q.cursor }, skip: 1 } : {}),
    });
    const rows = page.slice(0, q.limit);
    if (page.length > q.limit) res.setHeader('X-Next-Cursor', rows[rows.length - 1]!.userId);
    const records = await this.s.prisma.verificationRecord.findMany({ where: { id: { in: rows.map((r) => r.kybRecordId).filter((x): x is string => !!x) } } });
    // Reviewers see each automated check's outcome; the personal data behind them stays encrypted.
    const checks = new Map(records.map((r) => {
      const c = this.s.pii.open<{ checks: Record<string, { ok: boolean; reason?: string } | null> }>(r.result as never).checks;
      return [r.id, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ? (v.ok ? 'PASSED' : v.reason ?? 'FAILED') : 'NOT_PROVIDED']))];
    }));
    return rows.map((r) => ({ ...r, cacNumber: mask(r.cacNumber), kybChecks: (r.kybRecordId && checks.get(r.kybRecordId)) || null }));
  }

  /** KYB documents a supplier uploaded (#131), each with a short-lived signed read URL. Admins only. */
  @Roles('ADMIN') @Get('admin/suppliers/:userId/documents')
  async supplierDocuments(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string) {
    const docs = await this.s.prisma.evidence.findMany({ where: { ownerId: userId, kind: { in: [...KYB_DOCUMENT_KINDS] }, NOT: { sha256: '' } }, orderBy: { createdAt: 'asc' } });
    return docs.map((d) => ({ id: d.id, kind: d.kind, mime: d.mime, sha256: d.sha256, ...signUrl(this.s.env.JWT_SECRET + ':uploads', 'GET', d.objectKey, admin.id, this.s.now().getTime()) }));
  }

  /** Approves or rejects a supplier. Approval writes a verification hash on-chain with the attestor key. */
  @Roles('ADMIN') @Post('admin/suppliers/:userId/decision') @HttpCode(200)
  async decide(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), body);
    const profile = await this.s.prisma.supplierProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('supplier application not found');
    if (!b.approve) {
      await this.s.prisma.supplierProfile.update({ where: { userId }, data: { kybStatus: 'REJECTED' } });
      await this.audit(admin.id, 'supplier.reject', userId, b.note === undefined ? {} : { note: b.note });
      return { kybStatus: 'REJECTED' };
    }
    return this.requestApproval(admin.id, 'supplier.approve', userId, b.note === undefined ? {} : { note: b.note });
  }

  @Roles('ADMIN') @Get('admin/actions')
  async pendingActions() {
    const rows = await this.s.prisma.pendingAdminAction.findMany({
      where: { status: 'PENDING', expiresAt: { gt: this.s.now() } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, action: true, target: true, actorId: true, createdAt: true, expiresAt: true },
    });
    return rows;
  }

  @Roles('ADMIN') @Post('admin/actions/:id/approve') @HttpCode(200)
  async approveAction(@CurrentUser() admin: AuthedUser, @Param('id') id: string) {
    const pending = await this.s.prisma.pendingAdminAction.findUnique({ where: { id } });
    if (!pending) throw new NotFoundException('pending admin action not found');
    if (pending.actorId === admin.id) throw new ForbiddenException('another admin must approve this action');
    const now = this.s.now();
    if (pending.status === 'PENDING' && pending.expiresAt <= now) {
      await this.s.prisma.pendingAdminAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      await this.audit(admin.id, 'admin.action.expired', id, { requestedBy: pending.actorId, action: pending.action, target: pending.target });
      throw new GoneException('pending admin action has expired');
    }
    const claimed = await this.s.prisma.pendingAdminAction.updateMany({
      where: { id, actorId: { not: admin.id }, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'PROCESSING', approvedBy: admin.id },
    });
    if (claimed.count !== 1) throw new ConflictException('pending admin action is expired or already being processed');

    try {
      let result: Record<string, unknown>;
      let action: string;
      let auditData: Prisma.InputJsonObject;
      if (pending.action === 'supplier.approve') {
        const { note } = parse(z.object({ note: z.string().max(500).optional() }), pending.payload);
        const profile = await this.s.prisma.supplierProfile.findUnique({ where: { userId: pending.target } });
        if (!profile) throw new NotFoundException('supplier application not found');
        const tx = await this.attest(pending.target, 'Supplier', 1);
        action = 'supplier.approve';
        auditData = { requestedBy: pending.actorId, ...(note === undefined ? {} : { note }), tx: tx.hash };
        result = { kybStatus: 'APPROVED', txHash: tx.hash };
        await this.s.prisma.$transaction(async (db) => {
          await db.supplierProfile.update({ where: { userId: pending.target }, data: { kybStatus: 'APPROVED' } });
          await db.userRole.upsert({ where: { userId_role: { userId: pending.target, role: 'SUPPLIER' } }, create: { userId: pending.target, role: 'SUPPLIER', level: 1, verHash: tx.verHash }, update: { level: 1, verHash: tx.verHash } });
          await db.pendingAdminAction.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: now } });
          await db.auditLog.create({ data: { actorId: admin.id, action, target: pending.target, data: auditData } });
          await db.auditLog.create({ data: { actorId: admin.id, action: 'admin.action.approve', target: id, data: { requestedBy: pending.actorId, action: pending.action, target: pending.target } } });
        });
      } else if (pending.action === 'user.suspend') {
        const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), pending.payload);
        const prepared = await this.prepareSuspension(admin, pending.target);
        action = 'user.suspend';
        auditData = { requestedBy: pending.actorId, reason };
        result = { ...prepared, status: 'SUSPENDED' };
        await this.s.prisma.$transaction(async (db) => {
          await db.user.update({ where: { id: pending.target }, data: { status: 'SUSPENDED' } });
          await db.pendingAdminAction.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: now } });
          await db.auditLog.create({ data: { actorId: admin.id, action, target: pending.target, data: auditData } });
          await db.auditLog.create({ data: { actorId: admin.id, action: 'admin.action.approve', target: id, data: { requestedBy: pending.actorId, action: pending.action, target: pending.target } } });
        });
      } else if (pending.action === 'user.revoke') {
        const { role, reason } = parse(revokeSchema, pending.payload);
        const dbRole = role.toUpperCase();
        const user = await this.s.prisma.user.findUnique({ where: { id: pending.target } });
        if (!user) throw new NotFoundException('user not found');
        if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
        const held = await this.s.prisma.userRole.findUnique({ where: { userId_role: { userId: pending.target, role: dbRole } } });
        if (!held || held.level < 1) throw new NotFoundException('no active verification for this role');
        const prepared = await prepareAction(this.s, 'registry', 'revoke', A.revoke(await walletOf(this.s, admin.id), user.walletAddress, role, reason));
        action = 'user.revoke';
        auditData = { requestedBy: pending.actorId, role, reason };
        result = { ...prepared, status: 'REVOKED', level: 0 };
        await this.s.prisma.$transaction(async (db) => {
          await db.userRole.update({ where: { userId_role: { userId: pending.target, role: dbRole } }, data: { level: 0, verHash: null } });
          await db.verificationRecord.updateMany({ where: { userId: pending.target, status: 'VERIFIED', kind: { in: verificationKinds(dbRole) } }, data: { status: 'REVOKED' } });
          await db.pendingAdminAction.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: now } });
          await db.auditLog.create({ data: { actorId: admin.id, action, target: pending.target, data: auditData } });
          await db.auditLog.create({ data: { actorId: admin.id, action: 'admin.action.approve', target: id, data: { requestedBy: pending.actorId, action: pending.action, target: pending.target } } });
        });
      } else {
        throw new ConflictException('unsupported pending admin action');
      }
      return result;
    } catch (error) {
      await this.s.prisma.pendingAdminAction.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PENDING', approvedBy: null } });
      throw error;
    }
  }

  /** Writes a verification (KYC) level for a trader or organizer. */
  @Roles('ADMIN') @Post('admin/users/:userId/attest') @HttpCode(200)
  async attestUser(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ role: roleSchema, level: z.number().int().min(1).max(5) }), body);
    const tx = await this.attest(userId, b.role, b.level);
    const dbRole = b.role.toUpperCase();
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId, role: dbRole } }, create: { userId, role: dbRole, level: b.level, verHash: tx.verHash }, update: { level: b.level, verHash: tx.verHash } });
    await this.audit(admin.id, 'user.attest', userId, { role: b.role, level: b.level, tx: tx.hash });
    return { txHash: tx.hash };
  }

  /** Grants an application role (e.g. ORGANIZER, ARBITER). On-chain standing comes from registration plus attestation. */
  @Roles('ADMIN') @Post('admin/users/:userId/roles') @HttpCode(200)
  async grant(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const { role } = parse(z.object({ role: z.enum(['ORGANIZER', 'ARBITER', 'TRADER']) }), body);
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId, role } }, create: { userId, role }, update: {} });
    await this.audit(admin.id, 'role.grant', userId, { role });
    return { ok: true };
  }

  @Roles('ADMIN') @Post('admin/users/:id/suspend') @HttpCode(200)
  async suspend(@CurrentUser() admin: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), body);
    const user = await this.s.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    return this.requestApproval(admin.id, 'user.suspend', id, { reason });
  }

  @Roles('ADMIN') @Post('admin/users/:id/unsuspend') @HttpCode(200)
  async unsuspend(@CurrentUser() admin: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(500) }), body);
    return this.setSuspension(admin, id, reason);
  }

  @Roles('ADMIN') @Get('admin/offers')
  async adminOffers(@Query() query: Record<string, string>) {
    const q = parse(z.object({
      status: z.enum(['DRAFT', 'LIVE', 'EXPIRED', 'TAKEN_DOWN']).optional(),
      priceOutlier: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), query);
    
    const where: Prisma.OfferWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.priceOutlier === 'true') where.priceOutlierFlag = true;
    
    const offers = await this.s.prisma.offer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      select: {
        id: true,
        title: true,
        category: true,
        supplierId: true,
        status: true,
        priceOutlierFlag: true,
        createdAt: true,
        validUntil: true,
      },
    });
    
    return offers;
  }

  @Roles('ADMIN') @Post('admin/offers/:id/takedown') @HttpCode(200)
  async takedown(@CurrentUser() admin: AuthedUser, @Param('id') id: string) {
    await this.s.prisma.offer.update({ where: { id }, data: { status: 'TAKEN_DOWN' } });
    await this.audit(admin.id, 'offer.takedown', id, {}); // affects new pools only; existing pools keep their snapshot
    return { status: 'TAKEN_DOWN' };
  }

  /**
   * FX quote history, newest first (#125): each NGN/USD rate the fx-refresh job or offer publishing recorded, with its
   * sources and the divergence between them. Read-only. Refreshes blocked by divergence have no rate, so they are in
   * the audit log as `fx.blocked`. Cursor pagination: `limit` 1–100 (default 100), then the `X-Next-Cursor` header.
   */
  @Roles('ADMIN') @Get('admin/fx')
  async fxHistory(@Res({ passthrough: true }) res: Response, @Query() query: Record<string, string>) {
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }), query);
    const page = await this.s.prisma.fxQuote.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const rows = page.slice(0, q.limit);
    if (page.length > q.limit) res.setHeader('X-Next-Cursor', rows[rows.length - 1]!.id);
    return rows.map((r) => {
      const { sources, divergence } = storedSources(r.sources);
      return { id: r.id, pair: r.pair, rate: r.rate.toString(), sources, divergence, createdAt: r.createdAt };
    });
  }

  /**
   * Revokes one role's verification after fraud or an error (#129). Dual control, like suspension: a different ADMIN
   * approves it, which prepares `registry.revoke` for that admin to sign and sets the stored level to 0.
   */
  @Roles('ADMIN') @Post('admin/users/:id/revoke') @HttpCode(200)
  async revoke(@CurrentUser() admin: AuthedUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(revokeSchema, body);
    const user = await this.s.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    const held = await this.s.prisma.userRole.findUnique({ where: { userId_role: { userId: id, role: b.role.toUpperCase() } } });
    if (!held || held.level < 1) throw new NotFoundException('no active verification for this role');
    return this.requestApproval(admin.id, 'user.revoke', id, { role: b.role, reason: b.reason });
  }

  /**
   * Checks a verification hash (for example one read from the chain) against the salted record it came from (#128).
   * Only the match is returned: the salt and the personal data stay encrypted on the server. Every check is audited.
   */
  @Roles('ADMIN') @Post('admin/users/:userId/verify-hash') @HttpCode(200)
  async verifyHash(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const { verHash } = parse(z.object({ verHash: z.string().regex(/^[0-9a-fA-F]{64}$/) }), body);
    const records = await this.s.prisma.verificationRecord.findMany({
      where: { userId, OR: [{ kind: 'KYC' }, { kind: { startsWith: 'ATTESTATION:' } }] }, orderBy: { createdAt: 'asc' },
    });
    let match: { recordId: string; kind: string; status: string; role: string; level: number } | undefined;
    for (const r of records) {
      const sealed = this.s.pii.open<{ role?: string; level?: number; salt?: string }>(r.result as never);
      if (!sealed.salt) continue; // failed checks never attested, so they have no salt
      const level = sealed.level ?? KYC_LEVEL; // KYC records written before the level was stored are level 1
      if (verHashMatches(verHash, { userId, providerRef: r.providerRef, level, salt: sealed.salt })) {
        match = { recordId: r.id, kind: r.kind, status: r.status, role: sealed.role ?? 'Trader', level };
        break;
      }
    }
    await this.audit(admin.id, 'user.verify_hash', userId, { verified: match !== undefined, ...(match ? { recordId: match.recordId } : {}) });
    return match ? { verified: true, ...match } : { verified: false };
  }

  @Roles('ADMIN') @Get('admin/audit')
  async auditLog(@Query('limit') limit = '50') {
    return this.s.prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  }

  private async attest(userId: string, role: Role, level: number): Promise<{ hash: string; verHash: string }> {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    // Manual admin review: the reference is the review itself. The capped attestor writes only a salted hash on-chain.
    const a = await this.s.attestations.attest(userId, user.walletAddress, role, level, 'admin-review', 'admin');
    // The salt is kept encrypted with the record, so the on-chain hash can be verified later (#128).
    await this.s.prisma.verificationRecord.create({
      data: {
        userId, kind: attestationKind(role.toUpperCase()), provider: 'admin', providerRef: 'admin-review', status: 'VERIFIED',
        result: this.s.pii.seal({ role, level, salt: a.salt, verHash: a.verHash, tx: a.hash }) as never,
      },
    });
    return { hash: a.hash, verHash: a.verHash };
  }

  private async setSuspension(admin: AuthedUser, userId: string, reason: string) {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    const action = 'unsuspend';
    const prepared = await prepareAction(this.s, 'registry', action, A.unsuspend(await walletOf(this.s, admin.id), user.walletAddress));
    const status = 'ACTIVE';
    await this.s.prisma.user.update({ where: { id: userId }, data: { status } });
    await this.audit(admin.id, `user.${action}`, userId, { reason });
    return { ...prepared, status };
  }

  private async prepareSuspension(admin: AuthedUser, userId: string) {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('user not found');
    if (!user.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    return prepareAction(this.s, 'registry', 'suspend', A.suspend(await walletOf(this.s, admin.id), user.walletAddress));
  }

  private async requestApproval(actorId: string, action: string, target: string, payload: Prisma.InputJsonObject) {
    const expiresAt = new Date(this.s.now().getTime() + this.s.env.ADMIN_ACTION_EXPIRY_MINUTES * 60_000);
    const pending = await this.s.prisma.$transaction(async (db) => {
      const row = await db.pendingAdminAction.create({
        data: { action, target, actorId, payload, expiresAt },
      });
      await db.auditLog.create({ data: { actorId, action: 'admin.action.requested', target, data: { action, actionId: row.id, expiresAt: expiresAt.toISOString() } } });
      return row;
    });
    return { status: 'PENDING_APPROVAL', actionId: pending.id, expiresAt };
  }
}
