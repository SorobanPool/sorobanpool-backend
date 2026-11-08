import { randomBytes } from 'node:crypto';
import type { Keypair } from '@stellar/stellar-sdk';
import { A, type Role } from '../chain/args.js';
import { sha256Hex } from '../common/canonical-json.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ChainPort } from '../app/services.js';

export class AttestorCapReached extends Error {
  constructor(public readonly cap: number) {
    super(`attestor daily cap of ${cap} reached; attestations resume tomorrow (UTC) or after an operator raises ATTESTOR_DAILY_CAP`);
  }
}

/** Alert threshold: a spike towards the cap usually means a bug or a compromised flow (brief 7.8, 12.3). */
export const ATTESTOR_SPIKE_RATIO = 0.8;

/**
 * The only path that writes verification to the chain (`registry.attest`). On-chain there is only
 * `ver_hash = sha256(userId || providerRef || level || salt)` and a level: no personal data (brief 3.2, 7.8). The salt
 * stays off-chain, encrypted with the verification record, so the hash can be re-derived for an audit but not
 * guessed. A daily cap bounds the damage of a compromised attestor flow; admin `revoke` undoes a bad attestation.
 */
export class Attestor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chain: Pick<ChainPort, 'invokeServer'>,
    private readonly key: Keypair,
    private readonly dailyCap: number,
    private readonly now: () => Date,
    private readonly alert: (msg: string) => void = (m) => console.error(m),
  ) {}

  async attestedToday(): Promise<number> {
    const t = this.now();
    const since = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    return this.prisma.auditLog.count({ where: { action: 'attest', at: { gte: since } } });
  }

  async attest(userId: string, wallet: string, role: Role, level: number, providerRef: string, actorId = 'attestor'): Promise<{ hash: string; verHash: string; salt: string }> {
    const done = await this.attestedToday();
    if (done >= this.dailyCap) {
      this.alert(`[attestor] ALERT daily cap ${this.dailyCap} reached`);
      throw new AttestorCapReached(this.dailyCap);
    }
    if (done + 1 >= this.dailyCap * ATTESTOR_SPIKE_RATIO) this.alert(`[attestor] ALERT ${done + 1}/${this.dailyCap} attestations today`);
    const salt = randomBytes(16).toString('hex');
    const verHash = sha256Hex(`${userId}|${providerRef}|${level}|${salt}`);
    const r = await this.chain.invokeServer('registry', 'attest', A.attest(this.key.publicKey(), wallet, role, verHash, level), [this.key]);
    await this.prisma.auditLog.create({ data: { actorId, action: 'attest', target: userId, data: { role, level, verHash, tx: r.hash } } });
    return { hash: r.hash, verHash, salt };
  }
}
