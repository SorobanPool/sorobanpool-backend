import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
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

const migrations = (): string[] =>
  readdirSync(new URL('../prisma/migrations', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => readFileSync(new URL(`../prisma/migrations/${d.name}/migration.sql`, import.meta.url), 'utf8'));

/**
 * With TEST_DATABASE_URL set (CI's real-Postgres job) every test DB is a fresh database on that server, migrated with the
 * committed SQL and dropped on close. Without it, PGlite is used (ADR 0004).
 */
async function startRealPostgres(url: string): Promise<TestDb> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  const conn = new pg.Client({ connectionString: u.toString() });
  await conn.connect();
  for (const sql of migrations()) await conn.query(sql);
  await conn.end();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: u.toString(), max: 5 }) });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Real Postgres semantics without Docker: PGlite served over the wire, migrated with the committed SQL. */
export async function startTestDb(): Promise<TestDb> {
  if (process.env.TEST_DATABASE_URL) return startRealPostgres(process.env.TEST_DATABASE_URL);
  const db = new PGlite();
  for (const sql of migrations()) await db.exec(sql);
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
