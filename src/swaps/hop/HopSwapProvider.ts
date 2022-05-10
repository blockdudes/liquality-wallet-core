import BN from 'bignumber.js'
import { Hop } from '@hop-protocol/sdk'
import { chains, currencyToUnit, unitToCurrency } from '@liquality/cryptoassets'
import { v4 as uuidv4 } from 'uuid'
import { createClient } from 'urql'
import { Wallet } from 'ethers'
import { SwapProvider } from '../SwapProvider'
import cryptoassets from '../../utils/cryptoassets'
import { prettyBalance } from '../../utils/coinFormatter'
import { withInterval, withLock } from '../../store/actions/performNextAction/utils'
import { isERC20 } from '../../utils/asset'
import {
  // BaseSwapProviderConfig,
  EstimateFeeRequest,
  EstimateFeeResponse,
  // GetQuoteResult,
  NextSwapActionRequest,
  QuoteRequest,
  // SwapQuote,
  SwapRequest,
  SwapStatus,
} from '../types';
import { ActionContext } from '../../store'
// import { Network, PairData, SwapHistoryItem, WalletId } from '../../store/types'
import { Network} from '../../store/types'

class HopSwapProvider extends SwapProvider {
  protected _getStatuses(): Record<string, SwapStatus> {
    return {
      WAITING_FOR_APPROVE_CONFIRMATIONS: {
        step: 0,
        label: 'Approving {from}',
        filterStatus: 'PENDING',
        notification(swap : any) {
          return {
            message: `Approving ${swap.from}`
          }
        }
      },
      APPROVE_CONFIRMED: {
        step: 1,
        label: 'Swapping {from}',
        filterStatus: 'PENDING'
      },
      WAITING_FOR_SEND_SWAP_CONFIRMATIONS: {
        step: 1,
        label: 'Swapping {from}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Engaging the hop.exchange'
          }
        }
      },
      WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS: {
        step: 2,
        label: 'Swapping {to}',
        filterStatus: 'PENDING',
        notification() {
          return {
            message: 'Engaging the hop.exchange'
          }
        }
      },
      SUCCESS: {
        step: 3,
        label: 'Completed',
        filterStatus: 'COMPLETED',
        notification(swap: any) {
          return {
            message: `Swap completed, ${prettyBalance(swap.toAmount, swap.to)} ${swap.to
              } ready to use`
          }
        }
      },
      FAILED: {
        step: 3,
        label: 'Swap Failed',
        filterStatus: 'REFUNDED',
        notification() {
          return {
            message: 'Swap failed'
          }
        }
      }
    }
  }

  protected _txTypes(): Record<string, string | null> {
    return {
      SWAP: 'SWAP',
    };
  }
  protected _fromTxType(): string | null {
   return this._txTypes().SWAP;
  }
  protected _toTxType(): string | null {
    return null;
  }
  protected _totalSteps(): number {
    return 4;
  }
  protected _timelineDiagramSteps(): string[] {
    return ['APPROVE', 'INITIATION', 'RECEIVE']
  }

  config: any;
  _apiCache: any;
  graphqlURLs: { [key: string]: string };

  constructor(config: any) {
    super(config)
    this._apiCache = {}
    this.graphqlURLs = {
      url: 'https://api.thegraph.com/subgraphs/name/hop-protocol',
      ethereum: 'hop-mainnet',
      xdai: 'hop-xdai',
      arbitrum: 'hop-arbitrum',
      polygon: 'hop-polygon',
      optimism: 'hop-optimism'
    }
  }
  /**
   * Get the supported pairs of this provider for this network
   * @param {{ network }} network
   */
  // eslint-disable-next-line no-unused-vars
  async getSupportedPairs() {
    return [];
  }

  confirmationsSendCount(networkName: string) {
      const networkToConfirmations: { [key: string]: number } =    
      {
        ethereum: 1,
        arbitrum: 20,
        polygon: 256
      }
      return networkToConfirmations[networkName]
  }

  gasLimit(networkName: string){
    const networkToGasLimit : { [key: string]: any } = {
      arbitrum: {
        send: 900000,
        approve: 1000000
      },
      polygon: {
        send: 300000,
        approve: 300000
      },
      ethereum: {
        send: 150000,
        approve: 100000
      }
    }
    return networkToGasLimit[networkName]
  }

  getChain(chainName: string){
    const slugToChain : { [key: string]: any } = {
      [Hop.Chain.Ethereum.slug]: Hop.Chain.Ethereum,
      [Hop.Chain.Arbitrum.slug]: Hop.Chain.Arbitrum,
      [Hop.Chain.Gnosis.slug]: Hop.Chain.Gnosis,
      [Hop.Chain.Optimism.slug]: Hop.Chain.Optimism,
      [Hop.Chain.Polygon.slug]: Hop.Chain.Polygon
    }
    return slugToChain[chainName]
  }
  // L2->L1 or L2->L2
  GQL_getDestinationTxHashFromL2Source(transferId: any) {
    return `query {
        withdrawalBondeds(
          where: {
            transferId: "${transferId}"
          }
        ) {
          timestamp
          amount
          transactionHash
          token
          timestamp
        }
      }
    `
  }
  // L1->L2
  GQL_getDestinationTxHashFromL1Source(recipient : any) {
    return `query {
        transferFromL1Completeds(
          where: {
            recipient: "${recipient}"
          },
          orderBy: timestamp,
          orderDirection: desc
        ) {
          timestamp
          amount
          transactionHash
          token
          timestamp
        }
      }
    `
  }

  GQL_getTransferIdByTxHash(txHash: any) {
    return `query {
        transferSents(
          where: {
            transactionHash: "${txHash}"
          }
        ) {
          timestamp
          transferId
          amount
          bonderFee
          transactionHash
          token
          timestamp
        }
      }
    `
  }

  _getDestinationTxGQL(transferId: string, recipient: string, isFromL1Source: boolean) {
    return isFromL1Source
      ? this.GQL_getDestinationTxHashFromL1Source(recipient)
      : this.GQL_getDestinationTxHashFromL2Source(transferId)
  }

  _getHop(network: Network, signer = undefined) {
    if (!network) return null
    return new Hop(network === 'mainnet' ? 'mainnet' : 'kovan', signer)
  }

  _getAllTokens(hop:any) {
    const bridge = hop.bridge('ETH')
    const token = bridge.getCanonicalToken(hop.Chain.Ethereum)
    return token.addresses
  }

  _getClient(network: Network, walletId: string, from: string, fromAccountId: string) {
    return this.getClient(network, walletId, from, fromAccountId)
  }

  async _getSigner(network: Network, walletId: string, from: string, fromAccountId: string, provider: any) {
    const client = this._getClient(network, walletId, from, fromAccountId)
    const privKey = await client.wallet.exportPrivateKey()
    return new Wallet(privKey, provider)
  }

  async _getBridgeWithSigner(hopAsset: any, hopChainFrom: any, network: Network, walletId: string, from: string, fromAccountId: string) {
    const chainFrom = this.getChain(hopChainFrom.slug)
    const client = this._getClient(network, walletId, from, fromAccountId)
    const privKey = await client.wallet.exportPrivateKey()
    const hop = this._getHop(network)
    const signer = new Wallet(privKey, hop?.getChainProvider(chainFrom))
    const bridge = hop?.connect(signer).bridge(hopAsset)
    return bridge
  }

  _findAsset(asset: any, chain: any, tokens: any, tokenName: string) {
    if (asset.type === 'native') {
      // native asset
      if (
        // this.getToken[asset.code] === tokenName ||
        // this.getToken[asset.matchingAsset] === tokenName
        asset.code === tokenName ||
        asset.matchingAsset === tokenName
      ) {
        return tokenName
      }
    } else {
      // erc20 asset
      if (
        tokens[chain]?.l1CanonicalToken?.toLowerCase() === asset?.contractAddress.toLowerCase() ||
        tokens[chain]?.l2CanonicalToken?.toLowerCase() === asset?.contractAddress.toLowerCase()
      ) {
        return tokenName
      }
    }
  }

  _getSendInfo(assetFrom: any, assetTo: any, hop: any) {
    if (!assetFrom || !assetTo) return null
    const _chainFrom = this.getChain(assetFrom.chain)
    const _chainTo = this.getChain(assetTo.chain)
    if (!_chainFrom || !_chainTo) return null
    const availableToken = this._getAllTokens(hop)
    let _from, _to
    for (const token in availableToken) {
      if (!_from) _from = this._findAsset(assetFrom, _chainFrom.slug, availableToken[token], token)
      if (!_to) _to = this._findAsset(assetTo, _chainTo.slug, availableToken[token], token)
    }
    if (!_from || !_to || _from !== _to) return null
    const supportedAssetsFrom = hop.getSupportedAssetsForChain(_chainFrom.slug)
    const supportedAssetsTo = hop.getSupportedAssetsForChain(_chainTo.slug)
    if (!supportedAssetsFrom[_from] || !supportedAssetsTo[_to]) return null
    return { bridgeAsset: _from, chainFrom: _chainFrom, chainTo: _chainTo }
  }

  // eslint-disable-next-line no-unused-vars
  public async getQuote({ network, from, to, amount } : QuoteRequest) {
    if (amount <= new BN(0)) return null
    const assetFrom = cryptoassets[from]
    const assetTo = cryptoassets[to]
    const fromAmountInUnit = currencyToUnit(cryptoassets[from], new BN(amount))
    const hop = this._getHop(network)
    if (!hop || !hop.isValidChain(assetFrom.chain) || !hop.isValidChain(assetTo.chain)) return null
    const info = this._getSendInfo(assetFrom, assetTo, hop)
    if (!info?.bridgeAsset || !info?.chainFrom || !info?.chainTo) return null
    const { bridgeAsset, chainFrom, chainTo } = info
    const bridge = hop.bridge(bridgeAsset)
    const sendData = await bridge.getSendData(fromAmountInUnit.toString(), chainFrom, chainTo)
    if (!sendData) return null
    return {
      from,
      to,
      // Amounts should be in BigNumber to prevent loss of precision
      fromAmount: fromAmountInUnit.toFixed(),
      toAmount: new BN(sendData.amountOut.toString()).toFixed(),
      hopAsset: bridgeAsset,
      hopChainFrom: chainFrom,
      hopChainTo: chainTo,
      receiveFee: new BN(sendData.adjustedBonderFee.toString())
        .plus(new BN(sendData.adjustedDestinationTxFee.toString()))
        .toString()
    }
  }

  async _approveToken(bridge: any, chainFrom: any, fromAmount: any, signer: any, fee: any) {
    const txData = await bridge.populateSendApprovalTx(fromAmount, chainFrom)
    const approveTx = await signer.sendTransaction({
      ...txData,
      gasPrice:
        '0x' +
        new BN(fee)
          .times(1e9)
          .toString(16)
    })
    approveTx.hash = approveTx?.hash?.substring(2)
    return {
      status: 'WAITING_FOR_APPROVE_CONFIRMATIONS',
      approveTx,
      approveTxHash: approveTx?.hash
    }
  }

  async sendSwap({ network, walletId, quote }: SwapRequest) {
    const { hopAsset, hopChainFrom, hopChainTo, from, fromAccountId, fromAmount } = quote
    const chainFrom = this.getChain(hopChainFrom.slug)
    const chainTo = this.getChain(hopChainTo.slug)
    const bridge = await this._getBridgeWithSigner(
      hopAsset,
      hopChainFrom,
      network,
      walletId,
      from,
      fromAccountId
    )
    const hop = this._getHop(network)
    const signer = await this._getSigner(
      network,
      walletId,
      from,
      fromAccountId,
      hop?.getChainProvider(chainFrom)
    )
    const txData = await bridge?.populateSendTx(fromAmount, chainFrom, chainTo)
    const fromFundTx = await signer.sendTransaction({
      ...txData,
      gasPrice:
        '0x' +
        new BN(quote.fee)
          .times(1e9)
          .toString(16)
    })
    fromFundTx.hash = fromFundTx?.hash?.substring(2)
    return {
      status: 'WAITING_FOR_SEND_SWAP_CONFIRMATIONS',
      fromFundTx,
      fromFundHash: fromFundTx.hash
    }
  }

  /**
   * Create a new swap for the given quote
   * @param {{ network, walletId, quote }} options
   */
  // eslint-disable-next-line no-unused-vars
  async newSwap({  network, walletId, quote}: SwapRequest) {
    const { hopAsset, hopChainFrom, hopChainTo, from, fromAccountId, fromAmount } = quote
    const chainFrom = this.getChain(hopChainFrom.slug)
    const chainTo = this.getChain(hopChainTo.slug)
    const bridge = await this._getBridgeWithSigner(
      hopAsset,
      hopChainFrom,
      network,
      walletId,
      from,
      fromAccountId
    )
    const hop = this._getHop(network)
    const signer = await this._getSigner(
      network,
      walletId,
      from,
      fromAccountId,
      hop?.getChainProvider(chainFrom)
    )
    let updates
    if (isERC20(quote.from)) {
      updates = await this._approveToken(bridge, chainFrom, fromAmount, signer, quote.fee)
    } else {
      updates = {
        endTime: Date.now(),
        status: 'APPROVE_CONFIRMED'
      }
    }
    return {
      id: uuidv4(),
      fee: quote.fee,
      slippage: 50,
      hopAsset: hopAsset,
      hopChainFrom: chainFrom,
      hopChainTo: chainTo,
      ...updates
    }
  }

  /**
   * Estimate the fees for the given parameters
   * @param {{ network, walletId, asset, fromAccountId, toAccountId, txType, amount, feePrices[], max }} options
   * @return Object of key feePrice and value fee
   */
  // eslint-disable-next-line no-unused-vars
  async estimateFees({ asset, txType, quote, feePrices }: EstimateFeeRequest) {
    if (txType !== this.fromTxType) {
      throw new Error(`Invalid tx type ${txType}`);
    }

    const nativeAsset = chains[cryptoassets[asset].chain].nativeAsset;
    const quoteFromStr: string = quote.hopChainFrom.slug || ""
    let gasLimit : any = this.gasLimit(quoteFromStr).send
    if (isERC20(quote.from)) {
      gasLimit += this.gasLimit(quoteFromStr).approve
    }

    const fees: EstimateFeeResponse = {}
    for (const feePrice of feePrices) {
      const gasPrice = new BN(feePrice).times(1e9) // ETH fee price is in gwei
      const fee = new BN(gasLimit).times(1.1).times(gasPrice)
      fees[feePrice] = unitToCurrency(cryptoassets[nativeAsset], fee)
    }
    return fees
  }

  async waitForApproveConfirmations({ swap, network, walletId }: any) {
    const client = this._getClient(network, walletId, swap.from, swap.fromAccountId)
    try {
      const tx = await client.chain.getTransactionByHash(swap.approveTxHash)
      if (tx && tx.confirmations && tx.confirmations >= 1) {
        return {
          endTime: Date.now(),
          status: 'APPROVE_CONFIRMED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  async waitForSendSwapConfirmations({ swap, network, walletId } : any) {
    const client = this._getClient(network, walletId, swap.from, swap.fromAccountId)
    try {
      const tx = await client.chain.getTransactionByHash(swap.fromFundHash)
      const hopChainFromName: string = swap?.hopChainFrom?.slug.toString()
      if (tx && tx.confirmations  && tx.confirmations >= this.confirmationsSendCount(hopChainFromName)) {
        this.updateBalances(network, walletId, [swap.from])
        return {
          endTime: Date.now(),
          status:
            tx.status === 'SUCCESS' || Number(tx.status) === 1
              ? 'WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS'
              : 'FAILED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  async waitForRecieveSwapConfirmations({ swap, network, walletId }: any) {
    const { hopChainFrom, hopChainTo, fromFundHash, from, to, fromAccountId } = swap
    const client = this._getClient(network, walletId, from, fromAccountId)
    const privKey = await client.wallet.exportPrivateKey()
    const signer = new Wallet(privKey)
    const chainFrom = this.getChain(hopChainFrom.slug)
    const chainTo = this.getChain(hopChainTo.slug)
    const isFromL1Source = chainFrom.isL1 && !chainTo.isL1
    try {
      let clientGQL
      let transferId = ''
      if (!isFromL1Source) {
        clientGQL = createClient({
          url: `${this.graphqlURLs.url}/${this.graphqlURLs[chainFrom.slug]}`
        })
        const { data } = await clientGQL
          .query(this.GQL_getTransferIdByTxHash('0x' + fromFundHash))
          .toPromise()
        transferId = data.transferSents?.[0]?.transferId
        if (!transferId) return
      }
      clientGQL = createClient({
        url: `${this.graphqlURLs.url}/${this.graphqlURLs[chainTo.slug]}`
      })
      const { data } = await clientGQL
        .query(this._getDestinationTxGQL(transferId, signer.address.toLowerCase(), isFromL1Source))
        .toPromise()
      const methodName = !isFromL1Source ? 'withdrawalBondeds' : 'transferFromL1Completeds'
      const destinationTxHash = data[methodName]?.[0]?.transactionHash

      if (!destinationTxHash) return
      const client = this._getClient(network, walletId, to, fromAccountId)
      const tx = await client.chain.getTransactionByHash(data[methodName]?.[0]?.transactionHash)
      if (tx && tx.confirmations && tx.confirmations >= 1) {
        return {
          receiveTxHash: tx.hash,
          receiveTx: tx,
          endTime: Date.now(),
          status: tx.status === 'SUCCESS' || Number(tx.status) === 1 ? 'SUCCESS' : 'FAILED'
        }
      }
    } catch (e) {
      if (e.name === 'TxNotFoundError') console.warn(e)
      else throw e
    }
  }

  /**
   * This hook is called when state updates are required
   * @param {object} store
   * @param {{ network, walletId, swap }}
   * @return updates An object representing updates to the current swap in the history
   */
  // eslint-disable-next-line no-unused-vars
  async performNextSwapAction(store: ActionContext, { network, walletId, swap } : NextSwapActionRequest<any> ) {
    let updates

    switch (swap.status) {
      case 'WAITING_FOR_APPROVE_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForApproveConfirmations({ swap, network, walletId })
        )
        break
      case 'APPROVE_CONFIRMED':
        updates = await withLock(
          store,
          { item: swap, network, walletId, asset: swap.from },
          async () => this.sendSwap({ quote: swap, network, walletId })
        )
        break
      case 'WAITING_FOR_SEND_SWAP_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForSendSwapConfirmations({ swap, network, walletId })
        )
        break
      case 'WAITING_FOR_RECIEVE_SWAP_CONFIRMATIONS':
        updates = await withInterval(async () =>
          this.waitForRecieveSwapConfirmations({ swap, network, walletId })
        )
        break
    }
    return updates
  }
}

export { HopSwapProvider }
