import { readFileSync } from 'node:fs';
import { cumulativeAlloc, ceilingPrice, finalUnitPrice, refundFor, tierIndex, type Tier } from './pricing.js';

interface Vector {
  tiers: [number, number][];
  moq: number;
  units: number[];
  paid: string[];
  total: number;
  tier: number;
  filled: boolean;
  finalPrice: string;
  received: number;
  alloc: number[];
  refunds: string[];
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../../test/fixtures/pricing-vectors.json', import.meta.url), 'utf8'),
).vectors;

describe('pricing parity with the contracts', () => {
  it('has at least 500 vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(500);
  });

  it('reproduces every vector exactly', () => {
    for (const v of vectors) {
      const tiers: Tier[] = v.tiers.map(([minUnits, price]) => ({ minUnits, unitPrice: BigInt(price) }));
      let total = 0;
      v.units.forEach((u, i) => {
        expect(ceilingPrice(tiers, total) * BigInt(u)).toBe(BigInt(v.paid[i]!));
        total += u;
      });
      expect(total).toBe(v.total);
      expect(tierIndex(tiers, total) ?? -1).toBe(v.tier);
      if (!v.filled) {
        expect(v.refunds).toEqual(v.paid);
        continue;
      }
      const finalPrice = finalUnitPrice(tiers, total);
      expect(finalPrice).toBe(BigInt(v.finalPrice));
      let cum = 0;
      v.units.forEach((u, i) => {
        const a = cumulativeAlloc(cum, u, v.received, total);
        expect(a).toBe(v.alloc[i]);
        expect(refundFor(BigInt(v.paid[i]!), a, finalPrice).toString()).toBe(v.refunds[i]);
        cum += u;
      });
      expect(v.alloc.reduce((x, y) => x + y, 0)).toBe(v.received);
    }
  });
});
