import { ActionContext, rootActionContext } from '..';
import buildConfig from '../../build.config';
import { getSwapProvider } from '../../factory/swap';
import { MarketData, Network } from '../types';

Promise.allSettled = Promise.allSettled || ((promises: Promise<any>[]) => Promise.all(
    promises.map(p => p
        .then(value => ({
          status: "fulfilled",
          value
        }))
        .catch(reason => ({
          status: "rejected",
          reason
        }))
    )
));

export const updateMarketData = async (
  context: ActionContext,
  { network }: { network: Network }
): Promise<{ network: Network; marketData: MarketData[] }> => {
  const { commit } = rootActionContext(context);
  const supportedPairResponses = await Promise.allSettled(
    Object.keys(buildConfig.swapProviders[network]).map((provider) => {
      const swapProvider = getSwapProvider(network, provider);
      return swapProvider.getSupportedPairs({ network }).then((pairs) => pairs.map((pair) => ({ ...pair, provider })));
    })
  );

  let supportedPairs: MarketData[] = [];
  supportedPairResponses.forEach((response) => {
    if (response.status === 'fulfilled') {
      supportedPairs = [...supportedPairs, ...response.value];
    } else {
      console.error('Fetching market data failed', response.reason);
    }
  });

  const marketData = supportedPairs;

  commit.UPDATE_MARKET_DATA({ network, marketData });

  return { network, marketData };
};
