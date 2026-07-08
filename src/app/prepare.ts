import { BadRequestException } from '@nestjs/common';
import type { xdr } from '@stellar/stellar-sdk';
import type { ContractName } from '../chain/deployments.js';
import type { PreparedTx } from '../chain/chain.service.js';
import type { Services } from './services.js';

export async function walletOf(s: Services, userId: string): Promise<string> {
  const u = await s.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.walletAddress) throw new BadRequestException({ error: 'NO_WALLET', message: 'Bind a wallet first' });
  return u.walletAddress;
}

export interface PreparedAction extends PreparedTx {
  contract: ContractName;
  fn: string;
}

/** Builds the transaction for one user action; the client signs only the returned auth entries. */
export async function prepareAction(s: Services, contract: ContractName, fn: string, args: xdr.ScVal[]): Promise<PreparedAction> {
  const p = await s.chain.prepareUser(contract, fn, args);
  return { ...p, contract, fn };
}
