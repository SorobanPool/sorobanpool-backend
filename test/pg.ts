import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

export interface TestDb {
  prisma: PrismaClient;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Real Postgres semantics without Docker: PGlite served over the wire, migrated with the committed SQL. */
export async function startTestDb(): Promise<TestDb> {
  const db = new PGlite();
  const dirs = readdirSync(new URL('../prisma/migrations', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const d of dirs) {
    await db.exec(readFileSync(new URL(`../prisma/migrations/${d}/migration.sql`, import.meta.url), 'utf8'));
  }
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  const adapter = new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  const prisma = new PrismaClient({ adapter });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await server.stop();
      await db.close();
    },
  };
}
