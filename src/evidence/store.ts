import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export interface ObjectStore {
  put(bucket: 'public' | 'evidence', key: string, bytes: Uint8Array): Promise<void>;
  get(bucket: 'public' | 'evidence', key: string): Promise<Buffer | null>;
}

/** Filesystem store for development and tests. Production uses S3ObjectStore. */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}
  private path(bucket: string, key: string): string {
    const p = normalize(join(this.root, bucket, key));
    if (!p.startsWith(normalize(join(this.root, bucket)))) throw new Error('invalid object key');
    return p;
  }
  async put(bucket: 'public' | 'evidence', key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(bucket: 'public' | 'evidence', key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(bucket, key));
    } catch {
      return null;
    }
  }
}

export interface S3Options {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: { public: string; evidence: string };
}

/** S3-compatible store (AWS S3, R2, MinIO). Path-style addressing so custom endpoints work. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly o: S3Options, client?: S3Client) {
    this.client = client ?? new S3Client({ endpoint: o.endpoint, region: o.region ?? 'auto', forcePathStyle: true, credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } });
  }
  private checkKey(key: string): void {
    if (!key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('invalid object key');
  }
  async put(bucket: 'public' | 'evidence', key: string, bytes: Uint8Array): Promise<void> {
    this.checkKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.o.buckets[bucket], Key: key, Body: bytes }));
  }
  async get(bucket: 'public' | 'evidence', key: string): Promise<Buffer | null> {
    this.checkKey(key);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.o.buckets[bucket], Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
}
