import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

// Minimal CBOR (just what WebAuthn attestation needs) and a software ES256 authenticator, so passkey flows run without a browser.
const head = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
};
const cbor = {
  int: (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n)),
  bytes: (b: Buffer) => Buffer.concat([head(2, b.length), b]),
  text: (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]),
  map: (entries: [Buffer, Buffer][]) => Buffer.concat([head(5, entries.length), ...entries.flat()]),
};
const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly priv: KeyObject;
  private readonly cose: Buffer;
  counter = 0;

  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor.map([
      [cbor.int(1), cbor.int(2)], [cbor.int(3), cbor.int(-7)], [cbor.int(-1), cbor.int(1)],
      [cbor.int(-2), cbor.bytes(Buffer.from(jwk.x!, 'base64url'))], [cbor.int(-3), cbor.bytes(Buffer.from(jwk.y!, 'base64url'))],
    ]);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  register(challenge: string) {
    const counter = Buffer.alloc(4);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), counter, Buffer.alloc(16), credLen, this.credentialId, this.cose]);
    const attestationObject = cbor.map([[cbor.text('fmt'), cbor.text('none')], [cbor.text('attStmt'), cbor.map([])], [cbor.text('authData'), cbor.bytes(authData)]]);
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { attestationObject: b64u(attestationObject), clientDataJSON: b64u(this.clientData('webauthn.create', challenge)), transports: ['internal'] },
    };
  }

  assert(challenge: string, opts: { origin?: string } = {}) {
    this.counter++;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), c]);
    const cd = opts.origin ? Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin, crossOrigin: false })) : this.clientData('webauthn.get', challenge);
    const signature = createSign('sha256').update(Buffer.concat([authData, sha256(cd)])).sign(this.priv);
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(cd), signature: b64u(signature) },
    };
  }
}
