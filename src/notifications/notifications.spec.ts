import { inQuietHours, nextAllowedTime, render, shouldSendNow, templateNames, SMS_MAX } from './templates.js';

const vars = {
  product: 'Mama Gold Rice 50kg', units: 100, naira: '1,250,000', toGo: 250, hours: 24, refund: '125,000',
  days: 5, hub: 'Wuse Market Gate B', date: 'Mon 12 Oct', status: 'Resolved in your favour',
};

describe('templates', () => {
  it.each(templateNames.flatMap((n) => (['EN', 'PCM'] as const).map((l) => [n, l] as const)))(
    '%s/%s fits in one SMS with realistic values',
    (name, lang) => {
      const text = render(name, lang, vars);
      expect(text.length).toBeLessThanOrEqual(SMS_MAX);
      expect(text).not.toMatch(/\{\w+\}/);
    },
  );
  it('reports missing variables', () => {
    expect(() => render('joined', 'EN', { product: 'x' })).toThrow(/missing variables: units, naira/);
  });
});

describe('quiet hours (21:00-07:00 WAT)', () => {
  const at = (h: number) => new Date(`2026-10-05T${String(h).padStart(2, '0')}:30:00Z`); // UTC
  it('maps UTC to WAT correctly', () => {
    expect(inQuietHours(at(19))).toBe(false); // 20:30 WAT
    expect(inQuietHours(at(20))).toBe(true); // 21:30 WAT
    expect(inQuietHours(at(5))).toBe(true); // 06:30 WAT
    expect(inQuietHours(at(6))).toBe(false); // 07:30 WAT
  });
  it('lets delivery-day messages through and defers the rest', () => {
    expect(shouldSendNow('ready_for_pickup', at(22))).toBe(true);
    expect(shouldSendNow('joined', at(22))).toBe(false);
    expect(shouldSendNow('joined', at(12))).toBe(true);
  });
  it('defers to 07:00 WAT', () => {
    expect(nextAllowedTime(at(20)).toISOString()).toBe('2026-10-06T06:00:00.000Z');
    expect(nextAllowedTime(at(5)).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(nextAllowedTime(at(12)).toISOString()).toBe(at(12).toISOString());
  });
});
