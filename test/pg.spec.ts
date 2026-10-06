import { startTestDb } from './pg.js';

describe('test database', () => {
  it('is the real PostgreSQL 16 server when TEST_DATABASE_URL is set (so the CI job cannot silently fall back to PGlite)', async () => {
    const t = await startTestDb();
    try {
      const rows = await t.prisma.$queryRaw<{ v: string }[]>`select version() as v`;
      if (process.env.TEST_DATABASE_URL) expect(rows[0]!.v).toMatch(/^PostgreSQL 16\./);
      else expect(rows[0]!.v).toMatch(/PostgreSQL/);
      const tables = await t.prisma.$queryRaw<{ n: bigint }[]>`select count(*) as n from information_schema.tables where table_schema = 'public' and table_name in ('Pool', 'PasskeyChallenge', 'Notification')`;
      expect(Number(tables[0]!.n)).toBe(3); // every migration through 0006 applied
    } finally { await t.close(); }
  });
});
