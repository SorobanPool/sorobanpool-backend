import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { Asset, Operation, rpc, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { transferJson, type TransferView } from '../anchor/anchor.js';
import { type AuthedUser, CurrentUser, parse } from './http.js';
import { walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

/**
 * TESTNET ONLY. Classic Stellar accounts need XLM and a USDC trustline before they can hold the test dollar; smart
 * wallets will not. This stands in for that setup so the app can be tried end to end. It is registered only when
 * NODE_ENV is not production and the network is not mainnet (see AppModule).
 */
@Controller('dev')
export class DevController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private get usdc(): Asset {
    return new Asset('USDC', this.s.deployments.admin);
  }
  private get server(): rpc.Server {
    return new rpc.Server(this.s.env.RPC_URL);
  }

  /** Funds the wallet with test XLM and returns an unsigned trustline transaction for the device to sign. */
  @Post('faucet/start') @HttpCode(200)
  async start(@CurrentUser() u: AuthedUser) {
    const wallet = await walletOf(this.s, u.id);
    let funded = false;
    for (let i = 0; i < 4 && !funded; i++) {
      try {
        funded = (await fetch(`https://friendbot.stellar.org?addr=${wallet}`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    if (!funded) throw new BadRequestException({ error: 'FAUCET_UNAVAILABLE', message: 'Test money is not available right now' });
    const acct = await this.server.getAccount(wallet);
    const tx = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: this.s.env.NETWORK_PASSPHRASE })
      .addOperation(Operation.changeTrust({ asset: this.usdc })).setTimeout(120).build();
    return { trustlineXdr: tx.toXDR() };
  }

  /** Simulates the bank confirming a mock naira deposit: fixes the final rate and credits USDC. Dev only. */
  @Post('anchor/confirm') @HttpCode(200)
  async confirmAnchor(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { transferId } = parse(z.object({ transferId: z.string() }), body);
    if (!this.s.anchor?.confirmDeposit) throw new BadRequestException({ error: 'NO_ANCHOR', message: 'No mock anchor configured' });
    const t = await this.s.prisma.anchorTransfer.findFirst({ where: { id: transferId, userId: u.id } });
    if (!t) throw new BadRequestException({ error: 'NOT_FOUND', message: 'Unknown transfer' });
    return transferJson((await this.s.anchor.confirmDeposit(transferId)) as TransferView);
  }

  /** Submits the device-signed trustline, then pays 100 test dollars from the admin account. */
  @Post('faucet/finish') @HttpCode(200)
  async finish(@CurrentUser() u: AuthedUser, @Body() body: unknown) {
    const { signedXdr } = parse(z.object({ signedXdr: z.string().min(10) }), body);
    const wallet = await walletOf(this.s, u.id);
    const tx = TransactionBuilder.fromXDR(signedXdr, this.s.env.NETWORK_PASSPHRASE);
    if (!(tx instanceof Transaction) || tx.source !== wallet || tx.operations.length !== 1 || tx.operations[0]!.type !== 'changeTrust') {
      throw new BadRequestException({ error: 'BAD_TX', message: 'Unexpected transaction' });
    }
    const server = this.server;
    const sent = await server.sendTransaction(tx);
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== 'SUCCESS') throw new BadRequestException({ error: 'TRUSTLINE_FAILED', message: 'Could not set up the dollar balance' });
    await this.s.chain.payUsdc(wallet, 100n * 10_000_000n); // through the chain lock: same account as the fee sponsor
    return { added: '100' };
  }
}
