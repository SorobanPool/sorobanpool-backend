export type Lang = 'EN' | 'PCM';

export type TemplateName =
  | 'joined'
  | 'price_break'
  | 'deadline_soon'
  | 'pool_filled'
  | 'pool_expired'
  | 'supplier_accepted'
  | 'dispatched'
  | 'ready_for_pickup'
  | 'confirm_pickup'
  | 'settled'
  | 'dispute_update';

/** SMS is the primary channel: every rendered message must fit in 160 characters. */
export const SMS_MAX = 160;

const T: Record<TemplateName, Record<Lang, string>> = {
  joined: {
    EN: 'You joined {product}: {units} units, N{naira} held safely. Paid out only after delivery.',
    PCM: 'You don join {product}: {units} units, N{naira} dey safe. Dem go pay supplier after goods reach.',
  },
  price_break: {
    EN: '{product}: price dropped to N{naira}/unit! {toGo} more units for the next break. Share the link.',
    PCM: '{product}: price don drop to N{naira}/unit! {toGo} more units reach next break. Share the link.',
  },
  deadline_soon: {
    EN: '{product} closes in {hours}h. {toGo} units to reach the minimum. Invite traders now.',
    PCM: '{product} go close in {hours}h. {toGo} units remain to reach minimum. Call traders now.',
  },
  pool_filled: {
    EN: '{product} is full! Final price N{naira}/unit. Your refund of N{refund} comes after delivery.',
    PCM: '{product} don full! Final price na N{naira}/unit. Your N{refund} refund go come after delivery.',
  },
  pool_expired: {
    EN: '{product} did not reach the minimum. Your N{naira} is being refunded in full.',
    PCM: '{product} no reach minimum. We dey return your N{naira} full.',
  },
  supplier_accepted: {
    EN: 'Good news: the supplier accepted {product}. Delivery is expected within {days} days.',
    PCM: 'Good news: supplier don accept {product}. Goods go reach within {days} days.',
  },
  dispatched: {
    EN: '{product} is on the way. Expected at {hub} by {date}.',
    PCM: '{product} dey road. E go reach {hub} by {date}.',
  },
  ready_for_pickup: {
    EN: 'Your goods are ready: collect {units} units of {product} at {hub} on {date}.',
    PCM: 'Your goods ready: come collect {units} units of {product} for {hub} on {date}.',
  },
  confirm_pickup: {
    EN: 'Collected your {product}? Tap I have collected in the app so the supplier can be paid.',
    PCM: 'You don collect your {product}? Press I have collected for the app so supplier fit collect pay.',
  },
  settled: {
    EN: '{product} is complete. Refund of N{refund} is ready in the app. Thank you!',
    PCM: '{product} don finish. Your N{refund} refund don ready for the app. Thank you!',
  },
  dispute_update: {
    EN: 'Update on your report for {product}: {status}. Open the app for details.',
    PCM: 'Update on your complain for {product}: {status}. Open the app for details.',
  },
};

export function render(name: TemplateName, lang: Lang, vars: Record<string, string | number>): string {
  const missing: string[] = [];
  const out = T[name][lang].replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!(k in vars)) missing.push(k);
    return String(vars[k] ?? '');
  });
  if (missing.length) throw new Error(`template ${name}/${lang} missing variables: ${missing.join(', ')}`);
  return out;
}

export const templateNames = Object.keys(T) as TemplateName[];
export const templateText = (name: TemplateName, lang: Lang): string => T[name][lang];

/** Templates that are allowed through quiet hours (delivery-day messages). */
export const QUIET_HOURS_EXEMPT: ReadonlySet<TemplateName> = new Set(['dispatched', 'ready_for_pickup']);

/** Quiet hours are 21:00-07:00 West Africa Time (UTC+1, no DST). */
export function inQuietHours(at: Date): boolean {
  const wat = (at.getUTCHours() + 1) % 24;
  return wat >= 21 || wat < 7;
}

export function shouldSendNow(name: TemplateName, at: Date): boolean {
  return QUIET_HOURS_EXEMPT.has(name) || !inQuietHours(at);
}

/** Next 07:00 WAT at or after `at`, used to defer quiet-hour messages. */
export function nextAllowedTime(at: Date): Date {
  if (!inQuietHours(at)) return at;
  const d = new Date(at);
  const wat = (at.getUTCHours() + 1) % 24;
  if (wat >= 21) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(6, 0, 0, 0); // 07:00 WAT = 06:00 UTC
  return d;
}
