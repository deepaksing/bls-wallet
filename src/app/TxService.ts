import { ethers } from "../../deps/index.ts";

import AddTransactionFailure from "./AddTransactionFailure.ts";
import * as env from "./env.ts";
import TxTable, { TransactionData } from "./TxTable.ts";
import WalletService from "./WalletService.ts";

export default class TxService {
  static defaultConfig = {
    txQueryLimit: env.TX_QUERY_LIMIT,
    maxFutureTxs: env.MAX_FUTURE_TXS,
  };

  constructor(
    public readyTxTable: TxTable,
    public futureTxTable: TxTable,
    public walletService: WalletService,
    public config = TxService.defaultConfig,
  ) {}

  async add(txData: TransactionData): Promise<AddTransactionFailure[]> {
    const { failures, nextNonce } = await this.walletService.checkTx(txData);

    if (failures.length > 0) {
      return failures;
    }

    const lowestAcceptableNonce = await this.LowestAcceptableNonce(
      nextNonce,
      txData.pubKey,
    );

    if (lowestAcceptableNonce.gt(txData.nonce)) {
      return this.replaceReadyTx(lowestAcceptableNonce, txData);
    }

    if (lowestAcceptableNonce.eq(txData.nonce)) {
      await this.readyTxTable.add(txData);
      await this.tryMoveFutureTxs(txData.pubKey, lowestAcceptableNonce.add(1));
    } else {
      await this.ensureFutureTxSpace();
      await this.futureTxTable.add(txData);
    }

    return [];
  }

  /**
   * Find the lowest acceptable nonce based on chain and the ready tx table.
   *
   * Here 'acceptable' means able to be accepted into the ready tx table. This
   * means that it comes after the transactions on chain, but also that it comes
   * after the transactions already in the ready tx table.
   */
  async LowestAcceptableNonce(
    nextChainNonce: ethers.BigNumber,
    pubKey: string,
  ): Promise<ethers.BigNumber> {
    const nextLocalNonce = await this.readyTxTable.nextNonceOf(pubKey);

    const lowestAcceptableNonce = nextChainNonce.gt(nextLocalNonce ?? 0)
      ? nextChainNonce
      : ethers.BigNumber.from(nextLocalNonce);

    return lowestAcceptableNonce;
  }

  /**
   * Move any future txs for the given public key that have become ready into
   * ready txs.
   */
  async tryMoveFutureTxs(
    pubKey: string,
    lowestAcceptableNonce: ethers.BigNumber,
  ) {
    let futureTxsToRemove: TransactionData[];

    do {
      futureTxsToRemove = [];
      const txsToAdd: TransactionData[] = [];

      const futureTxs = await this.futureTxTable.pubKeyTxsInNonceOrder(
        pubKey,
        this.config.txQueryLimit,
      );

      for (const tx of futureTxs) {
        if (lowestAcceptableNonce.gt(tx.nonce)) {
          // TODO: Pick tx with highest reward instead
          console.warn(`Nonce from past was in futureTxs`);
          futureTxsToRemove.push(tx);
        } else if (lowestAcceptableNonce.eq(tx.nonce)) {
          futureTxsToRemove.push(tx);
          const txWithoutId = { ...tx };
          delete txWithoutId.txId;
          txsToAdd.push(txWithoutId);
          lowestAcceptableNonce = lowestAcceptableNonce.add(1);
        } else {
          break;
        }
      }

      await this.readyTxTable.add(...txsToAdd);
      await this.futureTxTable.remove(...futureTxsToRemove);
    } while (futureTxsToRemove.length === this.config.txQueryLimit);
  }

  /**
   * Ensures that at least one new transaction can be inserted into the future
   * tx table without exceeding maxFutureTxs. This is achieved by dropping txs
   * that have been stored the longest.
   */
  async ensureFutureTxSpace() {
    const size = await this.futureTxTable.count();

    if (size >= this.config.maxFutureTxs) {
      const first = await this.futureTxTable.First();

      if (first === null) {
        console.warn(
          "Future txs unexpectedly empty when it seemed to need pruning",
        );

        return;
      }

      const newFirstId = (
        first.txId! + (Number(size) - this.config.maxFutureTxs + 1)
      );

      this.futureTxTable.clearBeforeId(newFirstId);
    }
  }

  /**
   * Replace a ready transaction with one of the same nonce.
   *
   * Note: This also means re-inserting any followup ready transactions of the
   * same key so that they will be processed in the correct sequence.
   */
  async replaceReadyTx(
    lowestAcceptableNonce: ethers.BigNumber,
    txData: TransactionData,
  ): Promise<AddTransactionFailure[]> {
    const existingTx = await this.readyTxTable.find(
      txData.pubKey,
      txData.nonce,
    );

    if (existingTx === null) {
      return [{
        type: "duplicate-nonce",
        description: [
          `nonce ${txData.nonce} was a replacement candidate but it appears to`,
          "have been submitted during processing",
        ].join(" "),
      }];

      // Possible enhancement: Track submitted txs and consider also submitting
      // replacements. This would interfere with aggregate txs already in the
      // mempool. Complicated.
    }

    if (!this.isRewardBetter(txData, existingTx)) {
      return [{
        type: "insufficient-reward",
        description: [
          `${ethers.BigNumber.from(txData.tokenRewardAmount)} is an`,
          "insufficient reward because there is already a tx with this nonce",
          "with a reward of",
          ethers.BigNumber.from(existingTx.tokenRewardAmount),
        ].join(" "),
      }];
    }

    const promises: Promise<unknown>[] = [];

    promises.push(
      this.readyTxTable.remove(existingTx),
      this.readyTxTable.add(txData),
    );

    if (lowestAcceptableNonce.sub(1).eq(txData.nonce)) {
      await Promise.all(promises);
      return [];
    }

    let followupTxs;
    let lastNonceReplaced = txData.nonce;

    while (true) {
      followupTxs = await this.readyTxTable.findAfter(
        txData.pubKey,
        lastNonceReplaced,
        this.config.txQueryLimit,
      );

      if (followupTxs.length === 0) {
        break;
      }

      for (const tx of followupTxs) {
        const newTx = { ...tx };
        delete newTx.txId;

        promises.push(
          this.readyTxTable.remove(tx),
          this.readyTxTable.add(newTx),
        );
      }

      lastNonceReplaced = followupTxs[followupTxs.length - 1].nonce;

      if (followupTxs.length < this.config.txQueryLimit) {
        break;
      }
    }

    await Promise.all(promises);
    return [];
  }

  isRewardBetter(left: TransactionData, right: TransactionData) {
    const leftReward = ethers.BigNumber.from(left.tokenRewardAmount);
    const rightReward = ethers.BigNumber.from(right.tokenRewardAmount);

    return leftReward.gt(rightReward);
  }
}
