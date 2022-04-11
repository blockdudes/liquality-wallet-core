import BigNumber from 'bignumber.js';
import store, { OriginalStore } from '../store';
import { createNotification } from '../store/broker/notification';
import { Asset, MarketData, Network, SwapHistoryItem } from '../store/types';

export type SwapQuote = {
  from: Asset;
  to: Asset;
  fromAmount: BigNumber;
  toAmount: BigNumber;
};

export type QuoteRequest = {
  network: Network;
  from: string;
  to: string;
  amount: BigNumber;
};

abstract class SwapProvider {
  // TODO: types
  config: any;
  constructor(config) {
    if (this.constructor === SwapProvider) {
      throw new TypeError(
        'Abstract class "SwapProvider" cannot be instantiated directly.'
      );
    }
    this.config = config;
  }

  async sendLedgerNotification(accountId, message) {
    const account = store.getters.accountItem(accountId);
    if (account?.type.includes('ledger')) {
      await createNotification({
        title: 'Sign with Ledger',
        message,
      });
    }
  }

  /**
   * Get the supported pairs of this provider for this network
   * @param {{ network }} network
   */
  // eslint-disable-next-line no-unused-vars
  abstract getSupportedPairs({ network }: { network: Network });

  /**
   * Get a quote for the specified parameters
   * @param {{ network, from, to, amount }} options
   */
  // eslint-disable-next-line no-unused-vars
  abstract getQuote({
    network,
    from,
    to,
    amount,
  }: QuoteRequest): Promise<SwapQuote | null>;

  /**
   * Create a new swap for the given quote
   * @param {{ network, walletId, quote }} options
   */
  // eslint-disable-next-line no-unused-vars
  abstract newSwap({
    network,
    walletId,
    quote,
  }: {
    network: Network;
    walletId: string;
    quote: SwapQuote;
  }): Promise<Partial<SwapHistoryItem>>;

  /**
   * Estimate the fees for the given parameters
   * @param {{ network, walletId, asset, fromAccountId, toAccountId, txType, amount, feePrices[], max }} options
   * @return Object of key feePrice and value fee
   */
  // eslint-disable-next-line no-unused-vars
  abstract estimateFees({
    network,
    walletId,
    asset,
    txType,
    quote,
    feePrices,
    max,
  }: {
    network: Network;
    walletId: string;
    asset: Asset;
    txType: string;
    quote: SwapQuote;
    feePrices: number[];
    max: boolean;
  }): Promise<{ [price: number]: BigNumber } | null>;

  /**
   * This hook is called when state updates are required
   * @param {object} store
   * @param {{ network, walletId, swap }}
   * @return updates An object representing updates to the current swap in the history
   */
  // eslint-disable-next-line no-unused-vars
  abstract performNextSwapAction(
    store: OriginalStore,
    {
      network,
      walletId,
      swap,
    }: { network: Network; walletId: string; swap: SwapHistoryItem }
  ): Promise<Partial<SwapHistoryItem>>;

  /**
   * Get market data
   * @param {string} network
   * @return account
   */
  getMarketData(network: Network): MarketData[] {
    return store.state.marketData[network] as MarketData[];
  }

  /**
   * Get blockchain client
   */
  getClient(network, walletId, asset, accountId) {
    return store.getters.client({
      network,
      walletId,
      asset,
      accountId,
    });
  }

  /**
   * Get account by id
   * @param {string} accountId
   * @return account
   */
  getAccount(accountId) {
    return store.getters.accountItem(accountId);
  }

  /**
   * Update balances for given assets
   * @param {string} network
   * @param {string} walletId
   * @param {string[]} assets
   */
  async updateBalances(network, walletId, assets) {
    return store.dispatch.updateBalances({ network, walletId, assets });
  }

  /**
   * Get an address to use for the swap
   * @param {string} network
   * @param {string} walletId
   * @param {string} asset
   * @param {string} accountId
   * @returns string address
   */
  async getSwapAddress(network, walletId, asset, accountId) {
    const [address] = await store.dispatch.getUnusedAddresses({
      network,
      walletId,
      assets: [asset],
      accountId,
    });
    return address;
  }

  get statuses() {
    // @ts-ignore
    const statuses = this.constructor.statuses;
    if (typeof statuses === 'undefined')
      throw new Error(
        '`statuses` is not defined. Shape: { STATUS: { step: number, label: string, filterStatus: string, notification () : ({ message }) } }'
      );
    return statuses;
  }

  get fromTxType() {
    // @ts-ignore
    const fromTxType = this.constructor.fromTxType;
    if (typeof fromTxType === 'undefined')
      throw new Error('`fromTxType` is not defined. e.g. "INITIATE"');
    return fromTxType;
  }

  get toTxType() {
    // @ts-ignore
    const toTxType = this.constructor.toTxType;
    if (typeof toTxType === 'undefined')
      throw new Error('`toTxType` is not defined. e.g. "REDEEM"');
    return toTxType;
  }

  get timelineDiagramSteps() {
    // @ts-ignore
    const timelineDiagramSteps = this.constructor.timelineDiagramSteps;
    if (typeof timelineDiagramSteps === 'undefined')
      throw new Error(
        '`timelineDiagramSteps` is not defined. e.g. ["APPROVE","SWAP"]'
      );
    return timelineDiagramSteps;
  }

  get totalSteps() {
    // @ts-ignore
    const totalSteps = this.constructor.totalSteps;
    if (typeof totalSteps === 'undefined')
      throw new Error('`totalSteps` is not defined. e.g. 2');
    return totalSteps;
  }
}

export { SwapProvider };
