import { readFileSync, writeFileSync } from 'node:fs';
import { appControllers } from './app.module.js';
import { buildOpenApi, OpenApiController } from './openapi.js';
import { startHarness } from '../../test/harness.js';

const file = new URL('../../docs/openapi.json', import.meta.url);
// The committed document describes the production surface: no dev faucet.
const prod = () => buildOpenApi([...appControllers({ env: { NODE_ENV: 'production', STELLAR_NETWORK: 'mainnet' } } as never), OpenApiController]);
const doc = prod() as { paths: Record<string, Record<string, { security: unknown[]; 'x-roles'?: string[]; parameters?: { name: string }[] }>> };

describe('openapi', () => {
  it('docs/openapi.json is up to date (run `pnpm openapi` after changing routes)', () => {
    const text = JSON.stringify(prod(), null, 2) + '\n';
    if (process.env.UPDATE_OPENAPI) writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
  it('captures public routes, bearer routes, roles and path params', () => {
    expect(doc.paths['/v1/health']!.get!.security).toEqual([]);
    expect(doc.paths['/v1/offers/{id}']!.get!.parameters![0]!.name).toBe('id');
    const admin = Object.entries(doc.paths).filter(([p]) => p.startsWith('/v1/admin'));
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.every(([, m]) => Object.values(m).every((o) => o.security.length === 1 && o['x-roles']?.includes('ADMIN')))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('/v1/dev');
  });
  it('is served at /v1/openapi.json without auth', async () => {
    const h = await startHarness();
    try {
      const r = await h.http().get('/v1/openapi.json');
      expect(r.status).toBe(200);
      expect(r.body.openapi).toBe('3.1.0');
      expect(Object.keys(r.body.paths).length).toBeGreaterThan(30);
    } finally { await h.close(); }
  });
});
