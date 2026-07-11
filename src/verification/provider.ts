import { createHash } from 'node:crypto';

/**
 * KYC / KYB provider port (brief 7.8). Candidate Nigerian providers are Smile ID, Dojah and Prembly; choosing one is
 * a commercial and legal decision (pricing, data-processing agreement, NDPA), so only the sandbox exists today and
 * any other KYC_PROVIDER fails closed (docs/decisions/0006-verification-provider-port.md).
 */
export interface PersonClaim {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
}

export interface CheckResult {
  ok: boolean;
  /** The provider's reference for this check; the only provider data that feeds the on-chain hash. */
  providerRef: string;
  /** Short machine reason when not ok (NAME_MISMATCH, NOT_FOUND, ...). */
  reason?: string;
  /** Provider payload; stored encrypted, never logged, never on-chain. */
  data: Record<string, unknown>;
}

export interface VerificationProvider {
  readonly name: string;
  verifyBvn(bvn: string, claim: PersonClaim): Promise<CheckResult>;
  verifyNin(nin: string, claim: PersonClaim): Promise<CheckResult>;
  /** Selfie liveness: `selfieSha256` identifies an uploaded image the provider fetches through a signed URL. */
  liveness(selfieSha256: string): Promise<CheckResult>;
  /** Selfie matches the photo the identity record holds. */
  faceMatch(selfieSha256: string, identityRef: string): Promise<CheckResult>;
  verifyCac(rcNumber: string, businessName: string): Promise<CheckResult>;
  /** Account name at the bank must match the business or a director (brief 7.8). */
  verifyBankAccountName(bankCode: string, accountNumber: string, expectedNames: string[]): Promise<CheckResult>;
}

const ref = (kind: string, ...parts: string[]) => `sbx_${kind}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Deterministic sandbox for development, tests and staging demos. Documented magic values let a tester drive every
 * branch: an identifier ending in `0` is not found, ending in `9` is found under a different name; `LIVENESS_FAIL`
 * and `NOMATCH` selfies fail; any CAC number starting `RC` is registered under the given name; the account name is
 * the first expected name unless the account number ends in `0`.
 */
export class SandboxVerificationProvider implements VerificationProvider {
  readonly name = 'sandbox';

  private person(kind: 'bvn' | 'nin', id: string, claim: PersonClaim): CheckResult {
    // BVN and NIN are both 11 digits.
    if (!/^\d{11}$/.test(id)) return { ok: false, providerRef: ref(kind, id), reason: 'INVALID_FORMAT', data: {} };
    if (id.endsWith('0')) return { ok: false, providerRef: ref(kind, id), reason: 'NOT_FOUND', data: {} };
    const record = id.endsWith('9') ? { firstName: 'Someone', lastName: 'Else', dateOfBirth: '1980-01-01' } : claim;
    const matches = norm(record.firstName) === norm(claim.firstName) && norm(record.lastName) === norm(claim.lastName) && record.dateOfBirth === claim.dateOfBirth;
    return { ok: matches, providerRef: ref(kind, id), reason: matches ? undefined : 'NAME_MISMATCH', data: { record } };
  }

  async verifyBvn(bvn: string, claim: PersonClaim) { return this.person('bvn', bvn, claim); }
  async verifyNin(nin: string, claim: PersonClaim) { return this.person('nin', nin, claim); }

  async liveness(selfie: string) {
    const ok = !selfie.startsWith('LIVENESS_FAIL');
    return { ok, providerRef: ref('live', selfie), reason: ok ? undefined : 'NOT_LIVE', data: { score: ok ? 0.97 : 0.12 } };
  }

  async faceMatch(selfie: string, identityRef: string) {
    const ok = !selfie.startsWith('NOMATCH');
    return { ok, providerRef: ref('face', selfie, identityRef), reason: ok ? undefined : 'FACE_MISMATCH', data: { similarity: ok ? 0.93 : 0.21 } };
  }

  async verifyCac(rc: string, businessName: string) {
    const ok = /^RC\d{5,8}$/i.test(rc);
    return { ok, providerRef: ref('cac', rc), reason: ok ? undefined : 'NOT_FOUND', data: ok ? { registeredName: businessName, status: 'ACTIVE' } : {} };
  }

  async verifyBankAccountName(bank: string, account: string, expectedNames: string[]) {
    if (!/^\d{10}$/.test(account)) return { ok: false, providerRef: ref('nuban', bank, account), reason: 'INVALID_FORMAT', data: {} };
    const accountName = account.endsWith('0') ? 'UNRELATED VENTURES' : (expectedNames[0] ?? '').toUpperCase();
    const ok = expectedNames.some((n) => norm(n) === norm(accountName));
    return { ok, providerRef: ref('nuban', bank, account), reason: ok ? undefined : 'NAME_MISMATCH', data: { accountName } };
  }
}

export function createVerificationProvider(name: string, nodeEnv: string): VerificationProvider {
  if (name === 'sandbox') {
    if (nodeEnv === 'production') throw new Error('KYC_PROVIDER=sandbox is refused in production: it verifies nobody');
    return new SandboxVerificationProvider();
  }
  throw new Error(`KYC_PROVIDER "${name}" has no adapter yet; see docs/decisions/0006-verification-provider-port.md`);
}
