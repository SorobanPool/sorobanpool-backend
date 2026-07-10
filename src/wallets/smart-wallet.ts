import { createHash } from 'node:crypto';
import { Address, hash, StrKey, xdr } from '@stellar/stellar-sdk';
import { cose, decodeCredentialPublicKey, isoBase64URL } from '@simplewebauthn/server/helpers';

/**
 * Passkey smart wallets (contracts ADR 0006). Every user's on-chain identity is a `smart_wallet` contract whose
 * signer is the passkey they registered with us. The private key never leaves their phone; there is no secret to
 * back up and they never hold XLM (the sponsor deploys the wallet and pays every fee).
 */

export class WalletKeyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * The 65-byte uncompressed P-256 point (0x04 || x || y) the wallet contract stores, from the COSE key that
 * WebAuthn registration produced. Only ES256 on P-256 can be verified on-chain (secp256r1_verify).
 */
export function p256PublicKeyFromCose(coseKey: Uint8Array): Buffer {
  const key = decodeCredentialPublicKey(new Uint8Array(coseKey)) as cose.COSEPublicKeyEC2;
  const alg = key.get(cose.COSEKEYS.alg);
  const kty = key.get(cose.COSEKEYS.kty);
  const crv = key.get(cose.COSEKEYS.crv);
  if (alg !== cose.COSEALG.ES256 || kty !== cose.COSEKTY.EC2 || crv !== cose.COSECRV.P256) {
    throw new WalletKeyError('PASSKEY_ALGORITHM_UNSUPPORTED', 'This passkey cannot control a wallet: it must use ES256 (P-256)');
  }
  const x = key.get(cose.COSEKEYS.x);
  const y = key.get(cose.COSEKEYS.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new WalletKeyError('PASSKEY_KEY_INVALID', 'Malformed P-256 public key');
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);
}

/** Raw credential id bytes from the base64url id WebAuthn and the Passkey table use. */
export const credentialIdBytes = (credentialId: string): Buffer => Buffer.from(isoBase64URL.toBuffer(credentialId));

/** Deterministic per credential, so a retried deployment lands on (and finds) the same address. */
export const walletSalt = (credentialId: Buffer): Buffer => createHash('sha256').update('sorobanpool:smart_wallet:v1:').update(credentialId).digest();

/** The address `createContractV2(address = deployer, salt)` will produce on this network. */
export function walletAddress(deployer: string, salt: Buffer, networkPassphrase: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export const isSmartWallet = (address: string | null | undefined): boolean => !!address && StrKey.isValidContract(address);
