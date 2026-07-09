import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3ObjectStore } from './store.js';

describe('S3ObjectStore against a local S3-style endpoint', () => {
  const objects = new Map<string, Buffer>();
  const seen: { method: string; url: string; auth: string }[] = [];
  let server: Server;
  let store: S3ObjectStore;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? '') });
        const key = req.url!.split('?')[0]!;
        if (key.startsWith('/broken/')) { res.writeHead(500, { 'content-type': 'application/xml' }).end('<Error><Code>InternalError</Code></Error>'); return; }
        if (req.method === 'PUT') {
          // aws-chunked bodies carry framing; strip it so the test stores the payload.
          const body = Buffer.concat(chunks);
          const text = body.toString('latin1');
          objects.set(key, req.headers['content-encoding']?.includes('aws-chunked') ? Buffer.from(text.replace(/^[0-9a-f]+;chunk-signature=\w+\r\n/gm, '').replace(/\r\n0;chunk-signature=\w+\r\n[\s\S]*$/, '').replace(/\r\n$/, ''), 'latin1') : body);
          res.writeHead(200, { etag: '"x"' }).end();
        } else if (objects.has(key)) {
          res.writeHead(200).end(objects.get(key));
        } else {
          res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    store = new S3ObjectStore({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', buckets: { public: 'pub', evidence: 'broken' } });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('puts and gets bytes with a SigV4-signed, path-style request to the right bucket', async () => {
    const bytes = Buffer.from('hello pool');
    await store.put('public', 'offers/a.png', bytes);
    expect((await store.get('public', 'offers/a.png'))?.toString()).toBe('hello pool');
    expect(seen[0]).toMatchObject({ method: 'PUT', url: expect.stringMatching(/^\/pub\/offers\/a\.png/) as unknown as string });
    expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
  });

  it('rejects traversal keys before any request', async () => {
    const before = seen.length;
    await expect(store.put('public', '../x', Buffer.from('a'))).rejects.toThrow('invalid object key');
    expect(seen.length).toBe(before);
  });

  it('returns null for a missing key but throws on other failures', async () => {
    expect(await store.get('public', 'nope.png')).toBeNull();
    await expect(store.get('evidence', 'x')).rejects.toThrow();
  });
});
