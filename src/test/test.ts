import { ClobClient, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import getMyBalance from '../utils/getMyBalance';
import { executeOrderGuarded } from '../execution/guardedExecutor';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

const runManualTest = async (clobClient: ClobClient) => {
    // const markets = await clobClient.getMarket(
    //     '0x834b371fe993e95cd1aa98a29e77794d5ff6dcaddf71115a6ad522b4b64ec165'
    // );
    // console.log(`markets: `);
    // console.log(markets);
    // const orderbook = await clobClient.getOrderBook(
    //     '104411547841791877252227935410049230769909951522603517050502627610163580155198'
    // );
    // console.log(`orderbook: `);
    // console.log(orderbook);
    // const signedOrder = await clobClient.createMarketOrder({
    //     side: Side.BUY,
    //     tokenID: '0x',
    //     amount: 100,
    //     price: 0.5,
    // });
    // const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
    // console.log(resp);
    // const resp = await clobClient.deleteApiKey();
    // console.log(resp);

    const price = (
        await clobClient.getLastTradePrice(
            '7335630785946116680591336507965313288831710468958917901279210617913444658937'
        )
    ).price;
    console.log(price);
    const result = await executeOrderGuarded(
        { clobClient },
        {
            side: 'BUY',
            tokenId: '7335630785946116680591336507965313288831710468958917901279210617913444658937',
            amount: 5,
            traderPrice: price,
            tradeUsdcSize: 5,
            tradeTimestamp: Date.now(),
            endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }
    );
    console.log(result);
};

export default runManualTest;

test('manual trading helper is not executed in Jest', () => {
    expect(true).toBe(true);
});
