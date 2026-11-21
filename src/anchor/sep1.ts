import { z } from 'zod';

const sep1Schema = z.object({
  ACCOUNTS: z.array(z.string()).optional(),
  AUTH_SERVER: z.string().url().optional(),
  TRANSFER_SERVER: z.string().url().optional(),
  TRANSFER_SERVER_SEP0024: z.string().url().optional(),
  DIRECT_PAYMENT_SERVER: z.string().url().optional(),
  SIGNING_KEY: z.string().optional(),
  HORIZON_URL: z.string().url().optional(),
  FEDERATION_SERVER: z.string().url().optional(),
  WEB_AUTH_ENDPOINT: z.string().url().optional(),
});

export type Sep1TomlData = z.infer<typeof sep1Schema>;

export interface Sep1Config {
  anchorDomain: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxSizeBytes?: number;
}

/** Parses TOML-like key=value pairs (simplified parser for Stellar TOML format). */
function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (!key) continue;

    const k = key.trim();
    const v = valueParts.join('=').trim();

    // Handle quoted strings
    let value: string | string[] = v.replace(/^["']|["']$/g, '');

    // Handle arrays (comma-separated)
    if (value.includes(',')) {
      value = value.split(',').map((s) => s.trim());
    }

    result[k] = value;
  }

  return result;
}

export class Sep1Discovery {
  private cache: Map<string, { data: Sep1TomlData; expiresAt: number }> = new Map();

  constructor(private readonly config: Sep1Config) {}

  private getCacheKey(domain: string): string {
    return `sep1:${domain}`;
  }

  private isCacheValid(expiresAt: number): boolean {
    return Date.now() < expiresAt;
  }

  async fetch(domain?: string): Promise<Sep1TomlData> {
    const targetDomain = domain || this.config.anchorDomain;

    if (!targetDomain) {
      throw new Error('No anchor domain configured or provided');
    }

    const cacheKey = this.getCacheKey(targetDomain);
    const cached = this.cache.get(cacheKey);

    if (cached && this.isCacheValid(cached.expiresAt)) {
      return cached.data;
    }

    const toml = await this.fetchToml(targetDomain);
    const data = this.parseAndValidate(toml);

    const cacheTtlMs = this.config.cacheTtlMs || 3_600_000; // 1 hour default
    this.cache.set(cacheKey, {
      data,
      expiresAt: Date.now() + cacheTtlMs,
    });

    return data;
  }

  private async fetchToml(domain: string): Promise<string> {
    const url = new URL('/.well-known/stellar.toml', `https://${domain}`);
    const timeoutMs = this.config.timeoutMs || 10_000; // 10 seconds default
    const maxSizeBytes = this.config.maxSizeBytes || 50_000; // 50 KB default

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: 'text/plain' },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch stellar.toml: ${response.status} ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
        throw new Error(`stellar.toml exceeds size limit: ${contentLength} > ${maxSizeBytes}`);
      }

      const text = await response.text();
      if (text.length > maxSizeBytes) {
        throw new Error(`stellar.toml exceeds size limit: ${text.length} > ${maxSizeBytes}`);
      }

      return text;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseAndValidate(content: string): Sep1TomlData {
    const parsed = parseToml(content);
    const validated = sep1Schema.parse(parsed);
    return validated;
  }

  clearCache(): void {
    this.cache.clear();
  }

  clearCacheFor(domain: string): void {
    this.cache.delete(this.getCacheKey(domain));
  }
}

export class Sep1Error extends Error {
  constructor(
    public readonly code: 'FETCH_FAILED' | 'PARSE_FAILED' | 'VALIDATION_FAILED' | 'TIMEOUT' | 'SIZE_EXCEEDED',
    message: string,
  ) {
    super(message);
  }
}
