import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { DoneCallback, Job, Queue } from 'bull';
import { HttpService, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TxService } from './tx.service';
import { StellarService } from '../stellar.service';
import { StrKey } from 'stellar-sdk';
import { BigNumber } from 'bignumber.js';

@Processor('txs')
export class TxsProcessor {
  private readonly logger = new Logger(TxsProcessor.name);

  constructor(
    private readonly config: ConfigService,
    private readonly txService: TxService,
    private readonly stellarService: StellarService,
    private readonly httpService: HttpService,
  ) {}

  @Process()
  async process(job: Job<number>, done: DoneCallback) {
    this.logger.log(job.data);

    try {
      let tx = await this.txService.find(job.data);
      this.logger.log(tx);
      if (!tx.channel || !tx.sequence) {
        const rand = Math.random() * this.config.get('channelAccounts').length;
        tx.channel = this.config.get('channelAccounts')[Math.floor(rand)];
        const source = await this.stellarService.loadAccount(tx.channel);
        tx.sequence = source.sequence;
        tx = await this.txService.save(tx);
      }
      this.logger.log(tx);

      let addressOut;
      let memo = null;

      const fed = await this.stellarService.resolveFederatedAddress(tx.swap.addressOut);
      if (fed.account_id) {
        addressOut = fed.account_id;
        memo = fed.memo;
      } else {
        const response = await this.httpService.post(this.config.get('apayBaseUrl')
          + '/withdraw', {
          type: 'crypto',
          dest: tx.swap.addressOut,
          asset_code: tx.currencyOut,
          account: tx.swap.account,
        }).toPromise();
        this.logger.log(response.data);
        addressOut = response.data.account_id;
        memo = response.data.memo;
      }

      let path;
      let result;
      if (tx.swap.userInput === 'out' && tx.swap.amountIn && tx.swap.amountIn.minus(tx.amountIn).lte(0.0001)) {
        path = await this.stellarService.calculateSell(tx.currencyIn, tx.currencyOut, tx.swap.amountOut.toString());
        this.logger.log(path);
        result = await this.stellarService.pathPaymentStrictReceive({
          currencyIn: tx.currencyIn,
          currencyOut: tx.currencyOut,
          amountIn: tx.amountIn.toFixed(7),
          amountOut: path.destination_amount,
          addressOut,
          path: path.path,
          memo,
          channel: tx.channel,
          sequence: tx.sequence,
        });

        tx.amountOut = tx.swap.amountOut;
      } else {
        path = await this.stellarService.calculateBuy(tx.currencyIn, tx.amountIn.dividedBy(1.005).toFixed(7), tx.currencyOut);
        const destAmount = new BigNumber(path.destination_amount).dividedBy(1.005);
        this.logger.log(path);
        result = await this.stellarService.pathPaymentStrictSend({
          currencyIn: tx.currencyIn,
          currencyOut: tx.currencyOut,
          amountIn: path.source_amount,
          amountOut: destAmount.toFixed(7),
          addressOut,
          path: path.path,
          memo,
          channel: tx.channel,
          sequence: tx.sequence,
        });
        this.logger.log(result);

        tx.amountOut = destAmount;
      }
      tx.txOut = result.hash;
      await this.txService.save(tx);

      done(null, result);
    } catch (err) {
      this.logger.error(err);
      // throw err;
      done(err);
    }
  }
}
