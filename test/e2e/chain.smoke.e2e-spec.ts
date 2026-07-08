import { Keypair } from '@stellar/stellar-sdk';
import { ChainService, signAuthEntries } from '../../src/chain/chain.service.js';
import { loadDeployments } from '../../src/chain/deployments.js';
import { A } from '../../src/chain/args.js';

/** Live testnet smoke test. Run with: E2E_TESTNET=1 SPONSOR_SECRET=S... pnpm test:e2e */
const enabled = !!process.env.E2E_TESTNET;
const PASSPHRASE = 'Test SDF Network ; September 2015';

describe.skipIf(!enabled)('chain service on testnet', () => {
  const deployments = loadDeployments(process.env.DEPLOYMENTS_FILE ?? '../sorobanpool-contracts/deployments/testnet.json');
  const chain = new ChainService({
    rpcUrl: process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org',
    passphrase: PASSPHRASE,
    sponsor: Keypair.fromSecret(process.env.SPONSOR_SECRET!),
    deployments,
  });

  it('reads contract state', async () => {
    const params = await chain.view<{ platform_fee_bp: number; advance_enabled: boolean }>('config', 'get_params');
    expect(params.platform_fee_bp).toBe(150);
    expect(params.advance_enabled).toBe(false);
  });

  it('registers a user who signs only an auth entry while the sponsor pays', async () => {
    const user = Keypair.random();
    const fb = await fetch(`https://friendbot.stellar.org?addr=${user.publicKey()}`);
    expect(fb.ok).toBe(true);
    const prepared = await chain.prepareUser('registry', 'register', A.register(user.publicKey(), 'Trader', '01'.repeat(32), 'wuse'));
    expect(prepared.authEntries.length).toBe(1);
    const signed = await signAuthEntries(prepared.authEntries, user, prepared.validUntilLedger, PASSPHRASE);
    const res = await chain.submitUser(prepared.txXdr, signed, user.publicKey());
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    const status = await chain.view<string[]>('registry', 'status', [...A.poolOnly(0n).slice(0, 0), ...A.register(user.publicKey(), 'Trader', '01'.repeat(32)).slice(0, 2)]);
    expect(status).toEqual(['Registered']);
  }, 120_000);

  it('refuses a transaction signed for a different wallet', async () => {
    const user = Keypair.random();
    const imposter = Keypair.random();
    const prepared = await chain.prepareUser('registry', 'register', A.register(user.publicKey(), 'Trader', '02'.repeat(32)));
    const signed = await signAuthEntries(prepared.authEntries, user, prepared.validUntilLedger, PASSPHRASE);
    await expect(chain.submitUser(prepared.txXdr, signed, imposter.publicKey())).rejects.toMatchObject({ code: 'WRONG_SIGNER' });
  }, 60_000);
});
