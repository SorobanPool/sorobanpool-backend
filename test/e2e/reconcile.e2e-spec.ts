import { Keypair } from '@stellar/stellar-sdk';
import { ChainService } from '../../src/chain/chain.service.js';
import { loadDeployments } from '../../src/chain/deployments.js';
import { A } from '../../src/chain/args.js';
import { chainState } from '../../src/workers/maintenance.js';

/** Live testnet: the on-chain pool shape that the reconcile job relies on. E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm test:e2e */
describe.skipIf(!process.env.E2E_TESTNET)('reconcile read shape on testnet', () => {
  const chain = new ChainService({
    rpcUrl: process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    sponsor: Keypair.fromSecret(process.env.SPONSOR_SECRET!),
    deployments: loadDeployments(process.env.DEPLOYMENTS_FILE ?? '../sorobanpool-contracts/deployments/testnet.json'),
  });

  it('decodes state, total_units and escrow_balance as reconcile expects', async (ctx) => {
    // Any existing pool will do; a freshly deployed network has none until another suite creates one.
    let p: Record<string, unknown> | undefined;
    for (let id = 1n; id <= 10n && !p; id++) {
      p = await chain.view<Record<string, unknown>>('group_buy', 'pool', A.poolOnly(id)).catch(() => undefined);
    }
    if (!p) return ctx.skip('no pool on this deployment yet (run m2-flow first)');
    expect(typeof chainState(p.state)).toBe('string');
    expect(chainState(p.state)).toMatch(/^(Open|Filled|Accepted|Dispatched|Delivered|Settled|Expired|Failed|Cancelled)$/);
    expect(typeof p.total_units).toBe('number');
    expect(typeof p.escrow_balance).toBe('bigint');
  });
});
