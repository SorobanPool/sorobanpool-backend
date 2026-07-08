import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { A, type Role } from '../chain/args.js';
import { sha256Hex } from '../common/canonical-json.js';
import { type AuthedUser, CurrentUser, parse, Roles } from './http.js';
import { prepareAction, walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

const roleSchema = z.enum(['Trader', 'Organizer', 'Supplier']);

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

  @Roles('ADMIN') @Get('admin/suppliers')
  async suppliers(@Query('status') status = 'PENDING') {
    return this.s.prisma.supplierProfile.findMany({ where: { kybStatus: status }, orderBy: { userId: 'asc' }, take: 100 });
  }

  /** Approves or rejects a supplier. Approval writes a verification hash on-chain with the attestor key. */
  @Roles('ADMIN') @Post('admin/suppliers/:userId/decision') @HttpCode(200)
  async decide(@CurrentUser() admin: AuthedUser, @Param('userId') userId: string, @Body() body: unknown) {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), body);
    const profile = await this.s.prisma.supplierProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('supplier application not found');
    if (!b.approve) {
      await this.s.prisma.supplierProfile.update({ where: { userId }, data: { kybStatus: 'REJECTED' } });
      await this.audit(admin.id, 'supplier.reject', userId, { note: b.note });
      return { kybStatus: 'REJECTED' };
    }
    const tx = await this.attest(userId, 'Supplier', 1);
    await this.s.prisma.supplierProfile.update({ where: { userId }, data: { kybStatus: 'APPROVED' } });
    await this.s.prisma.userRole.upsert({ where: { userId_role: { userId, role: 'SUPPLIER' } }, create: { userId, role: 'SUPPLIER', level: 1, verHash: tx.verHash }, update: { level: 1, verHash: tx.verHash } });
    await this.audit(admin.id, 'supplier.approve', userId, { note: b.note, tx: tx.hash });
    return { kybStatus: 'APPROVED', txHash: tx.hash };
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

  @Roles('ADMIN') @Post('admin/offers/:id/takedown') @HttpCode(200)
  async takedown(@CurrentUser() admin: AuthedUser, @Param('id') id: string) {
    await this.s.prisma.offer.update({ where: { id }, data: { status: 'TAKEN_DOWN' } });
    await this.audit(admin.id, 'offer.takedown', id, {}); // affects new pools only; existing pools keep their snapshot
    return { status: 'TAKEN_DOWN' };
  }

  @Roles('ADMIN') @Get('admin/audit')
  async auditLog(@Query('limit') limit = '50') {
    return this.s.prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: Math.min(Number(limit) || 50, 200) });
  }

  private async attest(userId: string, role: Role, level: number): Promise<{ hash: string; verHash: string }> {
    const user = await this.s.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'The user has not bound a wallet' });
    // ver_hash = sha256(userId || providerRef || level || salt): no personal data on-chain.
    const verHash = sha256Hex(`${userId}|admin-review|${level}|${randomBytes(16).toString('hex')}`);
    const r = await this.s.chain.invokeServer('registry', 'attest', A.attest(this.s.attestor.publicKey(), user.walletAddress, role, verHash, level), [this.s.attestor]);
    return { hash: r.hash, verHash };
  }
}
