import { Keypair } from '@stellar/stellar-sdk';
import { startHarness, type Harness } from '../../test/harness.js';
import { mask, PiiCipher } from '../common/pii.js';
import { createVerificationProvider, SandboxVerificationProvider } from './provider.js';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = Buffer.alloc(32, 9).toString('base64');
const person = { firstName: 'Bisi', lastName: 'Adewale', dateOfBirth: '1988-04-12' };
const goodKyc = { idType: 'BVN', idNumber: '22211133344', ...person, selfieSha256: 'a'.repeat(64) };

describe('PII encryption', () => {
  it('round-trips, and any tampering fails decryption', () => {
    const c = new PiiCipher(key);
    const sealed = c.seal({ bvn: '22211133344' });
    expect(JSON.stringify(sealed)).not.toContain('22211133344');
    expect(c.open(sealed)).toEqual({ bvn: '22211133344' });
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0] = ct[0]! ^ 1;
    expect(() => c.open({ ...sealed, ct: ct.toString('base64') })).toThrow();
    expect(() => new PiiCipher(key).open({ ...sealed, tag: Buffer.alloc(16).toString('base64') })).toThrow();
    expect(() => new PiiCipher(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
  it('masks identifiers', () => {
    expect(mask('22211133344')).toBe('*******3344');
    expect(mask('12')).toBe('****');
  });
});

describe('sandbox verification provider', () => {
  const p = new SandboxVerificationProvider();
  it('drives every branch with documented magic values', async () => {
    expect((await p.verifyBvn('22211133344', person)).ok).toBe(true);
    expect((await p.verifyBvn('22211133340', person)).reason).toBe('NOT_FOUND');
    expect((await p.verifyNin('22211133349', person)).reason).toBe('NAME_MISMATCH');
    expect((await p.verifyNin('123', person)).reason).toBe('INVALID_FORMAT');
    expect((await p.liveness('LIVENESS_FAIL-x')).ok).toBe(false);
    expect((await p.faceMatch('NOMATCH-x', 'r')).ok).toBe(false);
    expect((await p.verifyCac('RC123456', 'Tunde Foods')).ok).toBe(true);
    expect((await p.verifyCac('BN123', 'Tunde Foods')).ok).toBe(false);
    expect((await p.verifyBankAccountName('058', '0123456789', ['Tunde Foods Ltd'])).ok).toBe(true);
    expect((await p.verifyBankAccountName('058', '0123456780', ['Tunde Foods Ltd'])).reason).toBe('NAME_MISMATCH');
  });
  it('is refused in production, and unknown providers fail closed', () => {
    expect(() => createVerificationProvider('sandbox', 'production')).toThrow(/refused in production/);
    expect(() => createVerificationProvider('smileid', 'development')).toThrow(/no adapter/);
  });
});

describe('POST /v1/kyc/start', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ ATTESTOR_DAILY_CAP: '3' }); });
  afterAll(async () => { await h.close(); });

  async function trader(phone: string) {
    const me = await h.login(phone);
    await h.s.prisma.user.update({ where: { id: me.userId }, data: { walletAddress: Keypair.random().publicKey() } });
    return me;
  }
  const attests = () => h.chain.calls.filter((c) => c.kind === 'server' && c.fn === 'attest');

  it('verifies, attests level 1 on-chain with only a salted hash, and stores the result encrypted', async () => {
    const me = await trader('+2348033000001');
    const before = attests().length;
    const r = await h.http().post('/v1/kyc/start').set(auth(me.token)).send(goodKyc);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ status: 'VERIFIED', level: 1, idType: 'BVN', idNumber: '*******3344' });

    const call = attests().at(-1)!;
    expect(attests()).toHaveLength(before + 1);
    expect(call.args![2]).toEqual(['Trader']); // role
    expect(call.args![4]).toBe(1); // level
    expect(JSON.stringify(call.args)).not.toMatch(/22211133344|Bisi|Adewale|1988/);

    const rec = await h.s.prisma.verificationRecord.findFirstOrThrow({ where: { userId: me.userId, kind: 'KYC' } });
    expect(rec.status).toBe('VERIFIED');
    expect(JSON.stringify(rec.result)).not.toMatch(/22211133344|Bisi|Adewale/);
    const opened = h.s.pii.open<{ idNumber: string; salt: string; verHash: string }>(rec.result as never);
    expect(opened.idNumber).toBe('22211133344');
    expect(opened.verHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.s.prisma.userRole.findUniqueOrThrow({ where: { userId_role: { userId: me.userId, role: 'TRADER' } } })).level).toBe(1);

    expect((await h.http().get('/v1/kyc/status').set(auth(me.token))).body).toEqual({ status: 'VERIFIED', level: 1, idType: 'BVN', idNumber: '*******3344' });
    // Idempotent: a verified user is not re-checked or re-attested.
    await h.http().post('/v1/kyc/start').set(auth(me.token)).send(goodKyc).expect(200);
    expect(attests()).toHaveLength(before + 1);
  });

  it.each([
    ['not found', { idNumber: '22211133340' }, 'NOT_FOUND'],
    ['name mismatch', { idType: 'NIN', idNumber: '22211133349' }, 'NAME_MISMATCH'],
    ['not live', { selfieSha256: 'LIVENESS_FAIL-1' }, 'NOT_LIVE'],
    ['face mismatch', { selfieSha256: 'NOMATCH-1' }, 'FACE_MISMATCH'],
  ])('a failed check (%s) attests nothing', async (_label, patch, reason) => {
    const me = await trader(`+23480330001${Math.floor(Math.random() * 90 + 10)}`);
    const before = attests().length;
    const r = await h.http().post('/v1/kyc/start').set(auth(me.token)).send({ ...goodKyc, ...patch });
    expect(r.body).toMatchObject({ status: 'FAILED', level: 0, reason });
    expect(attests()).toHaveLength(before);
  });

  it('needs a wallet and well-formed input', async () => {
    const me = await h.login('+2348033000099');
    expect((await h.http().post('/v1/kyc/start').set(auth(me.token)).send(goodKyc)).body.error).toBe('NO_WALLET');
    const w = await trader('+2348033000098');
    expect((await h.http().post('/v1/kyc/start').set(auth(w.token)).send({ ...goodKyc, idNumber: '12' })).status).toBe(400);
    expect((await h.http().get('/v1/kyc/status').set(auth(w.token))).body).toEqual({ status: 'NONE', level: 0 });
  });

  it('stops at the attestor daily cap instead of attesting without limit', async () => {
    // Cap is 3 for this harness; earlier tests used one. Fill the rest, then the next one is refused.
    for (let i = 0; i < 2; i++) {
      const me = await trader(`+234803300020${i}`);
      await h.http().post('/v1/kyc/start').set(auth(me.token)).send(goodKyc).expect(200);
    }
    const late = await trader('+2348033000210');
    const r = await h.http().post('/v1/kyc/start').set(auth(late.token)).send(goodKyc);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('VERIFICATION_BUSY');
  });
});

describe('supplier KYB checks', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });
  const application = { businessName: 'Tunde Foods Ltd', cacNumber: 'RC1234567', address: '12 Market Rd', state: 'FCT', lga: 'Abuja Municipal', categories: ['rice'], deliveryAreas: [{ state: 'FCT' }] };

  it('runs CAC and bank-name checks for the reviewer without exposing the account number', async () => {
    const sup = await h.login('+2348034000001');
    const r = await h.http().post('/v1/suppliers/apply').set(auth(sup.token)).send({ ...application, bankCode: '058', bankAccountNumber: '0123456789', directors: ['Tunde Bello'] });
    expect(r.body).toEqual({ kybStatus: 'PENDING', checks: { cac: 'PASSED', bank: 'PASSED' } });
    const profile = await h.s.prisma.supplierProfile.findUniqueOrThrow({ where: { userId: sup.userId } });
    expect(profile.bankAccountMasked).toBe('******6789');

    const bad = await h.login('+2348034000002');
    const r2 = await h.http().post('/v1/suppliers/apply').set(auth(bad.token)).send({ ...application, cacNumber: 'BN99999', bankCode: '058', bankAccountNumber: '0123456780' });
    expect(r2.body.checks).toEqual({ cac: 'NOT_FOUND', bank: 'NAME_MISMATCH' });

    const admin = await h.login('+2348000000001');
    const list = await h.http().get('/v1/admin/suppliers').set(auth(admin.token)).expect(200);
    const row = (list.body as { userId: string; kybChecks: unknown }[]).find((x) => x.userId === sup.userId)!;
    expect(row.kybChecks).toEqual({ cac: 'PASSED', bank: 'PASSED' });
    expect(JSON.stringify(list.body)).not.toContain('0123456789');
  });
});
