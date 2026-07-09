import { Keypair } from '@stellar/stellar-sdk';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import { resolveSecret } from '../config/secrets.js';
import type { Deployments } from '../chain/deployments.js';
import { contractNameMap } from '../chain/deployments.js';
import { ChainService } from '../chain/chain.service.js';
import { OtpService, type SmsSender } from '../auth/otp.service.js';
import { TokenService } from '../auth/token.service.js';
import { SponsorshipPolicy } from '../relayer/allowlist.js';
import type { FxSourceQuote } from '../fx/fx.js';
import { MockAnchor, type AnchorProvider } from '../anchor/anchor.js';
import { LocalObjectStore, type ObjectStore } from '../evidence/store.js';
import { PrismaOtpStore, PrismaSessionStore, PrismaUsageStore } from '../persistence/prisma-stores.js';

export const SERVICES = Symbol('SERVICES');

/** The subset of ChainService the API uses; tests substitute a fake. */
export type ChainPort = Pick<ChainService, 'sponsorAddress' | 'id' | 'view' | 'prepareUser' | 'submitUser' | 'invokeServer' | 'latestLedger' | 'keepAlive' | 'payUsdc' | 'sponsorBalance'>;

export interface FxProvider {
  quotes(): Promise<FxSourceQuote[]>;
}

/** Dev/testnet FX: fixed rates from FX_STATIC. A real provider must query at least two independent sources. */
export class StaticFxProvider implements FxProvider {
  constructor(private readonly rates: number[]) {}
  async quotes(): Promise<FxSourceQuote[]> {
    return this.rates.map((ngnPerUsd, i) => ({ source: `static-${i + 1}`, ngnPerUsd }));
  }
}

/** Last OTP per phone, kept in memory for OTP_DEV_ECHO only. Never populated in production. */
export const devInbox = new Map<string, string>();

export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly echo = false) {}
  async send(phone: string, text: string): Promise<void> {
    if (this.echo) devInbox.set(phone, /\b(\d{6})\b/.exec(text)?.[1] ?? '');
    else console.log(`[sms:${phone}] ${text.replace(/\d{6}/, '******')}`);
  }
}

export interface Services {
  env: Env;
  prisma: PrismaClient;
  deployments: Deployments;
  chain: ChainPort;
  otp: OtpService;
  sms: SmsSender;
  tokens: TokenService;
  policy: SponsorshipPolicy;
  fx: FxProvider;
  /** Server-held attestor key: may only call registry.attest. */
  attestor: Keypair;
  store: ObjectStore;
  /** Undefined on mainnet/production: naira rails need a licensed anchor (brief section 17) and there is none yet. */
  anchor?: AnchorProvider & { confirmDeposit?(id: string): Promise<unknown> };
  now: () => Date;
}

export interface BuildOverrides {
  chain?: ChainPort;
  sms?: SmsSender;
  fx?: FxProvider;
  now?: () => Date;
  attestor?: Keypair;
  otpRandom?: () => number;
  store?: ObjectStore;
}

export function buildServices(env: Env, prisma: PrismaClient, deployments: Deployments, o: BuildOverrides = {}): Services {
  const now = o.now ?? (() => new Date());
  const sponsor = o.chain ? undefined : Keypair.fromSecret(resolveSecret(env.SPONSOR_SECRET_REF, env.NODE_ENV));
  const chain =
    o.chain ?? new ChainService({ rpcUrl: env.RPC_URL, horizonUrl: env.HORIZON_URL, passphrase: env.NETWORK_PASSPHRASE, sponsor: sponsor!, deployments });
  const attestor = o.attestor ?? Keypair.fromSecret(resolveSecret(env.ATTESTOR_SECRET_REF, env.NODE_ENV));
  const offMainnet = env.NODE_ENV !== 'production' && env.STELLAR_NETWORK !== 'mainnet';
  const fx = o.fx ?? new StaticFxProvider(env.FX_STATIC.split(',').map(Number).filter((n) => n > 0));
  const sms = o.sms ?? new ConsoleSmsSender(env.OTP_DEV_ECHO);
  const services: Services = {
    sms,
    env, prisma, deployments, chain, attestor, now,
    store: o.store ?? new LocalObjectStore(env.EVIDENCE_DIR),
    otp: new OtpService(new PrismaOtpStore(prisma), sms, env.OTP_HMAC_SECRET, now, o.otpRandom),
    tokens: new TokenService(env.JWT_SECRET, new PrismaSessionStore(prisma), now),
    policy: new SponsorshipPolicy(contractNameMap(deployments), new PrismaUsageStore(prisma), undefined, now),
    fx,
  };
  // The anchor reads services.fx at call time, so a replaced provider (tests, a future live source) is honoured.
  if (offMainnet) services.anchor = new MockAnchor(prisma, { quotes: () => services.fx.quotes() }, { pay: (w, s) => chain.payUsdc(w, s) }, now);
  return services;
}
