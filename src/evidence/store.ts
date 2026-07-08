import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export interface ObjectStore {
  put(bucket: 'public' | 'evidence', key: string, bytes: Uint8Array): Promise<void>;
  get(bucket: 'public' | 'evidence', key: string): Promise<Buffer | null>;
}

/** Filesystem store for development and tests. Production uses an S3-compatible adapter (not implemented yet). */
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
