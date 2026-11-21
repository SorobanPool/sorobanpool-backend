import { z } from 'zod';
import { TransactionBuilder, Networks, Transaction, FeeBumpTransaction, Keypair, BaseTransaction } from '@stellar/stellar-sdk';

const challengeResponseSchema = z.object({
  transaction: z.string(),
  network_passphrase: z.string(),
});

const tokenResponseSchema = z.object({
  token: z.string(),
});

export interface Sep10Config {
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface Sep10Challenge {
  transaction: string;
  networkPassphrase: string;
}

export interface Sep10Token {
  token: string;
  expiresAt: number;
}

export class Sep10Client {
  private tokenCache: Map<string, Sep10Token> = new Map();

  constructor(
    private readonly authServerUrl: string,
    private readonly clientKeypair: Keypair,
    private readonly config: Sep10Config = {},
  ) {}

  private getCacheKey(wallet: string): string {
    return `sep10:${wallet}`;
  }

  private isTokenValid(token: Sep10Token): boolean {
    return Date.now() < token.expiresAt;
  }

  async requestChallenge(wallet: string): Promise<Sep10Challenge> {
    const url = new URL('/auth', this.authServerUrl);
    url.searchParams.set('account', wallet);
    url.searchParams.set('client_domain', this.clientKeypair.publicKey());

    const timeoutMs = this.config.timeoutMs || 10_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Sep10Error('FETCH_FAILED', `Failed to request challenge: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const parsed = challengeResponseSchema.parse(data);

      this.validateChallenge(parsed.transaction, parsed.networkPassphrase, wallet);

      return {
        transaction: parsed.transaction,
        networkPassphrase: parsed.networkPassphrase,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private validateChallenge(transactionXdr: string, networkPassphrase: string, expectedWallet: string): void {
    try {
      const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
      const baseTx = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;

      // Verify source account
      if (baseTx.source !== this.clientKeypair.publicKey()) {
        throw new Sep10Error('VALIDATION_FAILED', 'Challenge source account does not match client');
      }

      // Verify manage_data operation exists for the wallet
      const manageDataOps = baseTx.operations.filter((op) => op.type === 'manageData');
      if (manageDataOps.length === 0) {
        throw new Sep10Error('VALIDATION_FAILED', 'Challenge does not contain manage_data operation');
      }

      const hasWalletOp = manageDataOps.some(
        (op) => 'name' in op && op.name === `${expectedWallet}`,
      );
      if (!hasWalletOp) {
        throw new Sep10Error('VALIDATION_FAILED', `Challenge does not contain manage_data for wallet ${expectedWallet}`);
      }

      // Verify timebounds
      if (!baseTx.timebounds) {
        throw new Sep10Error('VALIDATION_FAILED', 'Challenge does not have timebounds');
      }

      const now = Math.floor(Date.now() / 1000);
      if (baseTx.timebounds.minTime && now < baseTx.timebounds.minTime) {
        throw new Sep10Error('VALIDATION_FAILED', 'Challenge is not yet valid');
      }

      if (baseTx.timebounds.maxTime && now > baseTx.timebounds.maxTime) {
        throw new Sep10Error('VALIDATION_FAILED', 'Challenge has expired');
      }
    } catch (e) {
      if (e instanceof Sep10Error) throw e;
      throw new Sep10Error('VALIDATION_FAILED', `Failed to validate challenge: ${(e as Error).message}`);
    }
  }

  async submitChallenge(signedTx: string, wallet: string): Promise<Sep10Token> {
    const cacheKey = this.getCacheKey(wallet);
    const cached = this.tokenCache.get(cacheKey);

    if (cached && this.isTokenValid(cached)) {
      return cached;
    }

    const url = new URL('/auth', this.authServerUrl);

    const timeoutMs = this.config.timeoutMs || 10_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ transaction: signedTx }),
      });

      if (!response.ok) {
        throw new Sep10Error('FETCH_FAILED', `Failed to submit challenge: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const parsed = tokenResponseSchema.parse(data);

      // Decode JWT to get expiration (iat + standard expiry, typically 24 hours)
      const jwtParts = parsed.token.split('.');
      if (jwtParts.length !== 3) {
        throw new Sep10Error('VALIDATION_FAILED', 'Invalid JWT token format');
      }

      let payload: { exp?: number; iat?: number };
      try {
        const decoded = JSON.parse(Buffer.from(jwtParts[1]!, 'base64').toString());
        payload = decoded;
      } catch {
        throw new Sep10Error('VALIDATION_FAILED', 'Failed to decode JWT payload');
      }

      const expiresAt = (payload.exp || payload.iat || Math.floor(Date.now() / 1000)) * 1000;
      const token: Sep10Token = {
        token: parsed.token,
        expiresAt,
      };

      this.tokenCache.set(cacheKey, token);
      return token;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getToken(wallet: string): Sep10Token | null {
    const cacheKey = this.getCacheKey(wallet);
    const cached = this.tokenCache.get(cacheKey);

    if (cached && this.isTokenValid(cached)) {
      return cached;
    }

    if (cached) {
      this.tokenCache.delete(cacheKey);
    }

    return null;
  }

  clearCache(): void {
    this.tokenCache.clear();
  }

  clearCacheFor(wallet: string): void {
    this.tokenCache.delete(this.getCacheKey(wallet));
  }
}

export class Sep10Error extends Error {
  constructor(
    public readonly code:
      | 'FETCH_FAILED'
      | 'VALIDATION_FAILED'
      | 'TIMEOUT'
      | 'SIGNATURE_FAILED'
      | 'BAD_STATE',
    message: string,
  ) {
    super(message);
  }
}
