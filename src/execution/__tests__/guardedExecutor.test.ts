import { executeOrderGuarded } from '../guardedExecutor';
import { checkMarketViability } from '../../utils/marketViability';

jest.mock('../../utils/marketViability', () => ({
    checkMarketViability: jest.fn(),
    logViabilityResult: jest.fn(),
    getViabilityConfig: jest.fn(() => ({
        priceLimit: 0.95,
        minTimeBeforeEndMinutes: 60,
        maxSpreadBps: 500,
        minDepthUsd: 10,
    })),
}));

const mockedCheckMarketViability = checkMarketViability as jest.Mock;

describe('executeOrderGuarded', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('blocks order placement when viability fails', async () => {
        mockedCheckMarketViability.mockResolvedValue({
            viable: false,
            reason: 'not_viable',
            checks: {
                priceExtreme: { passed: false, threshold: 0.95 },
                timeToEnd: { passed: true, threshold: 60 },
                spread: { passed: true, threshold: 500 },
                depth: { passed: true, threshold: 10 },
            },
        });

        const clobClient = {
            getOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '0.5', size: '10' }],
                asks: [{ price: '0.51', size: '10' }],
            }),
            createMarketOrder: jest.fn(),
            postOrder: jest.fn(),
        } as any;

        const result = await executeOrderGuarded(
            { clobClient },
            {
                side: 'BUY',
                tokenId: 'token',
                amount: 10,
                traderPrice: 0.5,
                tradeUsdcSize: 10,
                tradeTimestamp: Date.now(),
                endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }
        );

        expect(result.skipped).toBe(true);
        expect(clobClient.createMarketOrder).not.toHaveBeenCalled();
    });

    it('blocks order placement when trade timestamp is stale', async () => {
        mockedCheckMarketViability.mockResolvedValue({
            viable: true,
            reason: 'ok',
            checks: {
                priceExtreme: { passed: true, threshold: 0.95 },
                timeToEnd: { passed: true, threshold: 60 },
                spread: { passed: true, threshold: 500 },
                depth: { passed: true, threshold: 10 },
            },
        });

        const clobClient = {
            getOrderBook: jest.fn().mockResolvedValue({
                bids: [{ price: '0.5', size: '10' }],
                asks: [{ price: '0.51', size: '10' }],
            }),
            createMarketOrder: jest.fn(),
            postOrder: jest.fn(),
        } as any;

        const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;

        const result = await executeOrderGuarded(
            { clobClient },
            {
                side: 'BUY',
                tokenId: 'token',
                amount: 10,
                traderPrice: 0.5,
                tradeUsdcSize: 10,
                tradeTimestamp: staleTimestamp,
                endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                tradeId: '507f1f77bcf86cd799439011' as any,
            }
        );

        expect(result.skipped).toBe(true);
        expect(clobClient.createMarketOrder).not.toHaveBeenCalled();
    });
});
