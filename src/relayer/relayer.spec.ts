import { Account, Keypair, Networks, Operation, TransactionBuilder, Asset } from '@stellar/stellar-sdk';
import { MemoryUsageStore, SponsorshipError, SponsorshipPolicy } from './allowlist.js';
import { feeBump, runwayDays } from './fee-bump.js';

const contracts = new Map([['CGROUP', 'group_buy'], ['CCONFIG', 'config'], ['CREG', 'registry']]);

describe('SponsorshipPolicy', () => {
  const policy = (cap = 3) => new SponsorshipPolicy(contracts, new MemoryUsageStore(), cap, () => new Date('2026-10-05T10:00:00Z'));

  it('sponsors allow-listed user actions only', async () => {
    const p = policy();
    await expect(p.authorize('u1', 'CGROUP', 'commit')).resolves.toBeUndefined();
    await expect(p.authorize('u1', 'CREG', 'register')).resolves.toBeUndefined();
    for (const [c, f] of [['CGROUP', 'freeze'], ['CGROUP', 'apply_outcome'], ['CCONFIG', 'set_params'], ['CREG', 'attest'], ['CCONFIG', 'upgrade']]) {
      await expect(p.authorize('u1', c!, f!)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    }
    await expect(p.authorize('u1', 'CUNKNOWN', 'commit')).rejects.toMatchObject({ code: 'UNKNOWN_CONTRACT' });
  });

  it('enforces a per-user daily cap and does not count refused calls', async () => {
    const p = policy(3);
    await expect(p.authorize('u1', 'CCONFIG', 'set_params')).rejects.toBeInstanceOf(SponsorshipError);
    for (let i = 0; i < 3; i++) await p.authorize('u1', 'CGROUP', 'commit');
    await expect(p.authorize('u1', 'CGROUP', 'commit')).rejects.toMatchObject({ code: 'CAP_REACHED' });
    await expect(p.authorize('u2', 'CGROUP', 'commit')).resolves.toBeUndefined(); // other users unaffected
  });
});

describe('feeBump', () => {
  const user = Keypair.random();
  const sponsor = Keypair.random();
  const inner = new TransactionBuilder(new Account(user.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build();
  inner.sign(user);

  it('is paid by the sponsor, signed by it, and wraps the user-signed transaction', () => {
    const bumped = feeBump(sponsor, inner, Networks.TESTNET, '200');
    expect(bumped.feeSource).toBe(sponsor.publicKey());
    expect(bumped.innerTransaction.source).toBe(user.publicKey());
    expect(bumped.innerTransaction.signatures).toHaveLength(1);
    expect(bumped.signatures).toHaveLength(1);
  });

  it('refuses a base fee below the inner fee rate', () => {
    expect(() => feeBump(sponsor, inner, Networks.TESTNET, '50')).toThrow(/lower than the inner/);
  });

  it('computes sponsor runway', () => {
    expect(runwayDays(70_000_000n, 10_000_000n)).toBe(7);
    expect(runwayDays(1n, 0n)).toBe(Infinity);
  });
});
