import type { SmsSender } from '../auth/otp.service.js';
import type { DecodedEvent } from '../indexer/decode.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { nextAllowedTime, render, shouldSendNow, type Lang, type TemplateName } from './templates.js';

type Db = Pick<PrismaClient, 'notification' | 'user' | 'pool' | 'offer' | 'commitment'>;

export const MAX_ATTEMPTS = 5;

/** Queues an SMS. Quiet-hour deferral happens here so a restart never loses or early-sends a message. */
export async function enqueue(db: Pick<PrismaClient, 'notification'>, userId: string, template: TemplateName, vars: Record<string, string | number>, now: Date): Promise<void> {
  await db.notification.create({ data: { userId, channel: 'sms', template, payload: vars, status: 'PENDING', runAfter: shouldSendNow(template, now) ? now : nextAllowedTime(now) } });
}

/** Sends due messages. Failures back off exponentially (2^attempts minutes) and end as FAILED after MAX_ATTEMPTS. */
export async function dispatchDue(db: Db, sms: SmsSender, now: Date, batch = 50): Promise<{ sent: number; retried: number; failed: number }> {
  const due = await db.notification.findMany({ where: { status: 'PENDING', runAfter: { lte: now } }, orderBy: { runAfter: 'asc' }, take: batch });
  const r = { sent: 0, retried: 0, failed: 0 };
  for (const n of due) {
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: n.userId } });
      const text = render(n.template as TemplateName, user.language as Lang, n.payload as Record<string, string | number>);
      await sms.send(user.phone, text);
      await db.notification.update({ where: { id: n.id }, data: { status: 'SENT', sentAt: now, attempts: n.attempts + 1, lastError: null } });
      r.sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await db.notification.update({
        where: { id: n.id },
        data: { attempts, lastError: (e as Error).message.slice(0, 300), status: dead ? 'FAILED' : 'PENDING', runAfter: new Date(now.getTime() + 2 ** attempts * 60_000) },
      });
      if (dead) r.failed++;
      else r.retried++;
    }
  }
  return r;
}

const fmtNaira = (usdc: { toString(): string } | number, rate: number): string => Math.round(Number(usdc.toString()) * rate).toLocaleString('en-US');

const POOL_END: Record<string, true> = { expired: true, cancelled: true, rejected: true, failed: true };

/**
 * Turns committed pool events into member notifications. Called by the indexer only for events that were newly applied,
 * so replays never duplicate messages. `price_break` and `deadline_soon` need extra state and are not produced here.
 */
export class NotificationProducer {
  constructor(private readonly db: Db, private readonly rate: () => Promise<number>, private readonly now: () => Date) {}

  async onEvent(ev: DecodedEvent): Promise<number> {
    if (ev.contract !== 'group_buy') return 0;
    const template = this.templateFor(ev.event);
    if (!template) return 0;
    const poolId = BigInt(ev.key as bigint | number | string);
    const pool = await this.db.pool.findUnique({ where: { id: poolId } });
    if (!pool) return 0;
    const offer = await this.db.offer.findUnique({ where: { id: pool.offerId } });
    const members = await this.db.commitment.findMany({ where: { poolId } });
    if (!members.length) return 0;
    const rate = await this.rate();
    const tier = template === 'price_break' ? this.tierVars(ev.data, offer?.tiersNgn) : undefined;
    if (template === 'price_break' && !tier) return 0; // already in the last tier, or tiers unknown: nothing useful to say
    const users = await this.db.user.findMany({ where: { walletAddress: { in: members.map((m) => m.memberAddress) } } });
    const byWallet = new Map(users.map((u) => [u.walletAddress, u]));
    const window = pool.pickupWindow as { from?: string } | null;
    let n = 0;
    for (const m of members) {
      const u = byWallet.get(m.memberAddress);
      if (!u) continue;
      const finalPrice = Number((pool.finalUnitPrice ?? 0).toString());
      const refundUsdc = Math.max(0, Number(m.paid.toString()) - m.units * finalPrice);
      const vars: Record<string, string | number> = {
        product: offer?.title ?? 'your pool', units: m.units, naira: fmtNaira(template === 'pool_filled' ? finalPrice : m.paid, rate),
        ...tier, refund: fmtNaira(refundUsdc, rate), days: Math.max(1, Math.ceil((offer?.leadTimeHours ?? 24) / 24)), hub: pool.hubAddress, date: window?.from?.slice(0, 10) ?? 'the agreed date',
      };
      await enqueue(this.db, u.id, template, vars, this.now());
      n++;
    }
    return n;
  }

  /** `tier_up` data is (new tier index, total units). The message needs that tier's price and the gap to the next break. */
  private tierVars(data: unknown, tiersJson: unknown): { naira: string; toGo: number } | undefined {
    const [idx, total] = (data as unknown[]).map(Number) as [number, number];
    const tiers = (Array.isArray(tiersJson) ? tiersJson : []) as { minUnits: number; priceNgn: string | number }[];
    const here = tiers[idx];
    const next = tiers[idx + 1];
    if (!here || !next) return undefined;
    return { naira: Number(here.priceNgn).toLocaleString('en-US'), toGo: Math.max(1, next.minUnits - total) };
  }

  private templateFor(event: string): TemplateName | undefined {
    if (POOL_END[event]) return 'pool_expired';
    switch (event) {
      case 'filled': return 'pool_filled';
      case 'tier_up': return 'price_break';
      case 'accepted': return 'supplier_accepted';
      case 'dispatch': return 'dispatched';
      case 'delivered': return 'ready_for_pickup';
      case 'settled': return 'settled';
      default: return undefined;
    }
  }
}

export const REMINDER_WINDOW_MS = 24 * 3_600_000;

/**
 * Open pools within 24h of their deadline that still lack the minimum get one reminder per member.
 * The pool is marked first (compare-and-set), so concurrent or repeated runs cannot double-send.
 */
export async function queueDeadlineReminders(db: Db, now: Date): Promise<number> {
  const pools = await db.pool.findMany({ where: { state: 'Open', deadlineRemindedAt: null, fillDeadline: { gt: now, lte: new Date(now.getTime() + REMINDER_WINDOW_MS) } } });
  let queued = 0;
  for (const pool of pools) {
    const claimed = await db.pool.updateMany({ where: { id: pool.id, deadlineRemindedAt: null }, data: { deadlineRemindedAt: now } });
    if (claimed.count === 0) continue;
    const offer = await db.offer.findUnique({ where: { id: pool.offerId } });
    const toGo = (offer?.moq ?? 0) - pool.totalUnits;
    if (!offer || toGo <= 0) continue;
    const members = await db.commitment.findMany({ where: { poolId: pool.id } });
    const users = await db.user.findMany({ where: { walletAddress: { in: members.map((m) => m.memberAddress) } } });
    const hours = Math.max(1, Math.ceil((pool.fillDeadline.getTime() - now.getTime()) / 3_600_000));
    for (const u of users) {
      await enqueue(db, u.id, 'deadline_soon', { product: offer.title, hours, toGo }, now);
      queued++;
    }
  }
  return queued;
}
