import sharp from 'sharp';

export interface ShareCardInput {
  product: string;
  supplier: string;
  currentPriceNaira: string;
  nextBreak?: { unitsToGo: number; priceNaira: string };
  unitsToMoq: number;
  progressPct: number;
  deadlineLabel: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 1200x630 Open Graph card for WhatsApp link previews. All text is escaped; nothing user-supplied is trusted. */
export function shareCardSvg(i: ShareCardInput): string {
  const pct = Math.max(0, Math.min(100, Math.round(i.progressPct)));
  const next = i.nextBreak
    ? `${i.nextBreak.unitsToGo} more units → N${esc(i.nextBreak.priceNaira)}/unit`
    : 'Best price reached';
  const goal = i.unitsToMoq > 0 ? `${i.unitsToMoq} units to go` : 'Minimum reached';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#ffffff"/>
<rect width="1200" height="14" fill="#0b6b3a"/>
<text x="60" y="110" font-family="sans-serif" font-size="30" fill="#0b6b3a" font-weight="700">Buy together. Pay on delivery.</text>
<text x="60" y="210" font-family="sans-serif" font-size="64" fill="#111" font-weight="700">${esc(clip(i.product, 34))}</text>
<text x="60" y="262" font-family="sans-serif" font-size="30" fill="#555">${esc(clip(i.supplier, 48))}</text>
<text x="60" y="380" font-family="sans-serif" font-size="96" fill="#0b6b3a" font-weight="700">N${esc(i.currentPriceNaira)}<tspan font-size="36" fill="#555"> / unit now</tspan></text>
<text x="60" y="440" font-family="sans-serif" font-size="34" fill="#111">${esc(next)}</text>
<rect x="60" y="480" width="1080" height="28" rx="14" fill="#e5e7eb"/>
<rect x="60" y="480" width="${Math.round(1080 * pct / 100)}" height="28" rx="14" fill="#0b6b3a"/>
<text x="60" y="560" font-family="sans-serif" font-size="30" fill="#111">${esc(goal)} · ${esc(i.deadlineLabel)}</text>
<text x="1140" y="590" font-family="sans-serif" font-size="24" fill="#777" text-anchor="end">Built on Stellar</text>
</svg>`;
}

export const renderShareCard = (i: ShareCardInput): Promise<Buffer> => sharp(Buffer.from(shareCardSvg(i))).png().toBuffer();
