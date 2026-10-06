import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Account, Address, Contract, Keypair, Networks, Operation, StrKey, TransactionBuilder, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app/app.module.js';
import { buildServices, devInbox, type ChainPort, type Services } from '../src/app/services.js';
import { CONTRACT_NAMES, type ContractName, type Deployments } from '../src/chain/deployments.js';
import { loadEnv } from '../src/config/env.js';
import { startTestDb, type TestDb } from './pg.js';
import { LocalObjectStore } from '../src/evidence/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

export const PHONE_ADMIN = '+2348000000001';
export const PHONE_ARBITER = '+2348000000002';

const sponsor = Keypair.random();

const contractIds = Object.fromEntries(CONTRACT_NAMES.map((n, i) => [n, StrKey.encodeContract(Buffer.alloc(32, i + 1))])) as Record<ContractName, string>;
export const deployments: Deployments = {
  network: 'test', usdc: StrKey.encodeContract(Buffer.alloc(32, 99)), admin: Keypair.random().publicKey(),
  contracts: Object.fromEntries(CONTRACT_NAMES.map((n) => [n, { id: contractIds[n], wasmHash: '00' }])) as Deployments['contracts'],
};

export interface Call { kind: 'prepare' | 'submit' | 'server'; contract?: ContractName; fn?: string; args?: unknown[]; signers?: string[]; wallet?: string }

/** Chain double: builds structurally real transactions (so inspection and policy run for real) without a network. */
export class FakeChain implements ChainPort {
  calls: Call[] = [];
  failNextSubmit: Error | null = null;
  sponsorAddress = sponsor.publicKey();
  id(n: ContractName): string { return contractIds[n]; }
  async latestLedger(): Promise<number> { return 1000; }
  paid: { wallet: string; stroops: bigint }[] = [];
  async payUsdc(wallet: string, stroops: bigint) { this.paid.push({ wallet, stroops }); }
  sponsorBalanceStroops = 5_000n * 10_000_000n;
  async sponsorBalance() { return this.sponsorBalanceStroops; }
  async keepAlive() { return { extended: [] as string[], missing: [] as string[] }; }
  async view<T>(_n: ContractName, fn: string): Promise<T> {
    if (fn === 'get_params') return { accept_window_secs: 86400n, delivery_grace_secs: 172800n, confirm_window_secs: 172800n, perishable_confirm_window_secs: 259200n, early_release_weight_bp: 6000, arbitration_sla_secs: 432000n } as T;
    return undefined as T;
  }
  async prepareUser(name: ContractName, fn: string, args: xdr.ScVal[]) {
    this.calls.push({ kind: 'prepare', contract: name, fn, args: args.map((a) => scValToNative(a)) });
    const wallet = scValToNative(args[0]!) as string;
    const hostFn = (new Contract(this.id(name)).call(fn, ...args).body as unknown as { invokeHostFunctionOp: { hostFunction: xdr.HostFunction } }).invokeHostFunctionOp.hostFunction;
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(new xdr.SorobanAddressCredentials({ address: new Address(wallet).toScAddress(), nonce: 1n, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(this.id(name)).toScAddress(), functionName: fn, args })),
        subInvocations: [],
      }),
    });
    const tx: Transaction = new TransactionBuilder(new Account(this.sponsorAddress, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: [entry] })).setTimeout(60).build();
    return { txXdr: tx.toXDR(), authEntries: [entry.toXDR('base64')], validUntilLedger: 1060 };
  }
  async submitUser(_txXdr: string, _signed: string[], wallet: string) {
    this.calls.push({ kind: 'submit', wallet });
    if (this.failNextSubmit) { const e = this.failNextSubmit; this.failNextSubmit = null; throw e; }
    return { hash: 'ab'.repeat(32), returnValue: 7n as unknown };
  }
  async invokeServer(name: ContractName, fn: string, args: xdr.ScVal[], signers: Keypair[] = []) {
    this.calls.push({ kind: 'server', contract: name, fn, args: args.map((a) => scValToNative(a)), signers: signers.map((s) => s.publicKey()) });
    return { hash: 'cd'.repeat(32), returnValue: undefined as unknown };
  }
}

export interface Harness {
  db: TestDb; s: Services; chain: FakeChain; app: NestExpressApplication; http: () => ReturnType<typeof request>;
  attestor: Keypair; close(): Promise<void>;
  login(phone: string): Promise<{ token: string; userId: string; refreshToken: string; roles: string[] }>;
  bindWallet(token: string, kp: Keypair): Promise<void>;
}

export async function startHarness(over: Record<string, string> = {}): Promise<Harness> {
  const db = await startTestDb();
  const env = loadEnv({
    DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_BUCKET_PUBLIC: 'p', S3_BUCKET_EVIDENCE: 'e', S3_ACCESS_KEY_REF: 'a', S3_SECRET_KEY_REF: 'b',
    JWT_SECRET: 'j'.repeat(32), JWT_REFRESH_SECRET: 'r'.repeat(32), OTP_HMAC_SECRET: 'o'.repeat(32), ENCRYPTION_KEY_ID: 'k', RPC_URL: 'http://rpc', HORIZON_URL: 'http://h',
    NETWORK_PASSPHRASE: Networks.TESTNET, SPONSOR_SECRET_REF: 'literal:x', ATTESTOR_SECRET_REF: 'literal:x', WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost:3001',
    PUBLIC_APP_URL: 'http://localhost:3001', OTP_DEV_ECHO: 'true', BOOTSTRAP_ADMIN_PHONES: PHONE_ADMIN, BOOTSTRAP_ARBITER_PHONES: PHONE_ARBITER, FX_STATIC: '1500,1505', ...over,
  } as NodeJS.ProcessEnv);
  const chain = new FakeChain();
  const attestor = Keypair.random();
  const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), 'sp-evidence-')));
  const s = buildServices(env, db.prisma, deployments, { chain, attestor, store, otpRandom: undefined });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(s), { logger: false });
  app.setGlobalPrefix('v1');
  app.useBodyParser('raw', { type: ['image/*', 'video/mp4', 'application/pdf'], limit: '16mb' });
  await app.init();
  const http = () => request(app.getHttpServer());
  let n = 0;
  const sessions = new Map<string, { token: string; userId: string; refreshToken: string; roles: string[] }>();
  return {
    db, s, chain, app, http, attestor,
    close: async () => { await app.close(); await db.close(); },
    async login(phone) {
      // Admin/arbiter logins are cached: the OTP limiter (3 per 15 minutes per phone) is real and applies in tests too.
      const cached = sessions.get(phone);
      if (cached && (phone === PHONE_ADMIN || phone === PHONE_ARBITER)) return cached;
      const normalized = phone;
      // each login needs its own OTP; the harness is the only caller so there is no rate-limit clash
      const r1 = await http().post('/v1/auth/otp/request').send({ phone: normalized });
      if (r1.status !== 200) throw new Error(`otp request failed: ${r1.status} ${JSON.stringify(r1.body)}`);
      const code = r1.body.devCode as string;
      const r2 = await http().post('/v1/auth/otp/verify').send({ phone: normalized, code });
      if (r2.status !== 200) throw new Error(`otp verify failed: ${r2.status} ${JSON.stringify(r2.body)}`);
      n++;
      const session = { token: r2.body.accessToken, userId: r2.body.user.id, refreshToken: r2.body.refreshToken, roles: r2.body.roles };
      sessions.set(phone, session);
      return session;
    },
    async bindWallet(token, kp) {
      const c = await http().get('/v1/wallets/challenge').set('Authorization', `Bearer ${token}`);
      const sig = Buffer.from(kp.sign(Buffer.from(String(c.body.challenge)))).toString('base64');
      const r = await http().post('/v1/wallets').set('Authorization', `Bearer ${token}`).send({ address: kp.publicKey(), signature: sig });
      if (r.status !== 200) throw new Error(`bind failed: ${r.status} ${JSON.stringify(r.body)}`);
    },
  };
}

export { devInbox };
