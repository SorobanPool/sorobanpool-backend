import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { Asset, Keypair, Operation, rpc, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { resolveSecret } from '../config/secrets.js';
import { type AuthedUser, CurrentUser, parse } from './http.js';
import { walletOf } from './prepare.js';
import { SERVICES, type Services } from './services.js';

/**
 * TESTNET ONLY. Classic Stellar accounts need XLM and a USDC trustline before they can hold the test dollar; smart
 * wallets will not. This stands in for that setup so the app can be tried end to end. It is registered only when
 * NODE_ENV is not production and the network is not mainnet (see AppModule).
 */
@Controller('dev/faucet')
export class DevController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  private get usdc(): Asset {
    return new Asset('USDC', this.s.deployments.admin);
  }
  private get server(): rpc.Server {
    return new rpc.Server(this.s.env.RPC_URL);
  }

  /** Funds the wallet with test XLM and returns an unsigned trustline transaction for the device to sign. */
  @Post('start') @HttpCode(200)
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

  /** Submits the device-signed trustline, then pays 100 test dollars from the admin account. */
  @Post('finish') @HttpCode(200)
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
    const admin = Keypair.fromSecret(resolveSecret(this.s.env.SPONSOR_SECRET_REF, this.s.env.NODE_ENV));
    const acct = await server.getAccount(admin.publicKey());
    const pay = new TransactionBuilder(acct, { fee: '10000', networkPassphrase: this.s.env.NETWORK_PASSPHRASE })
      .addOperation(Operation.payment({ destination: wallet, asset: this.usdc, amount: '100' })).setTimeout(120).build();
    pay.sign(admin);
    const paid = await server.sendTransaction(pay);
    const ok = await server.pollTransaction(paid.hash, { attempts: 30 });
    if (ok.status !== 'SUCCESS') throw new BadRequestException({ error: 'PAYMENT_FAILED', message: 'Could not add test money' });
    return { added: '100' };
  }
}
