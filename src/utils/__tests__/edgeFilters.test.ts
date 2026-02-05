import { checkEdgeFilters, isFullPositionClose, isSignificantPositionChange } from '../edgeFilters';
import { UserActivityInterface, UserPositionInterface } from '../../interfaces/User';
import mongoose from 'mongoose';

// Mock trade data
const createMockTrade = (
    overrides: Partial<UserActivityInterface> = {}
): UserActivityInterface => ({
    _id: new mongoose.Types.ObjectId(),
    proxyWallet: '0x123',
    timestamp: Date.now(),
    conditionId: 'cond123',
    type: 'TRADE',
    size: 100,
    usdcSize: 50,
    transactionHash: '0xabc',
    price: 0.5,
    asset: 'asset123',
    side: 'BUY',
    outcomeIndex: 0,
    title: 'Test Market',
    slug: 'test-market',
    icon: '',
    eventSlug: 'test-event',
    outcome: 'Yes',
    name: 'Trader',
    pseudonym: '',
    bio: '',
    profileImage: '',
    profileImageOptimized: '',
    bot: false,
    botExcutedTime: 0,
    ...overrides,
});

// Mock position data
const createMockPosition = (
    overrides: Partial<UserPositionInterface> = {}
): UserPositionInterface => ({
    _id: new mongoose.Types.ObjectId(),
    proxyWallet: '0x123',
    asset: 'asset123',
    conditionId: 'cond123',
    size: 100,
    avgPrice: 0.5,
    initialValue: 50,
    currentValue: 55,
    cashPnl: 5,
    percentPnl: 10,
    totalBought: 100,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: 0.55,
    redeemable: false,
    mergeable: false,
    title: 'Test Market',
    slug: 'test-market',
    icon: '',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    oppositeOutcome: 'No',
    oppositeAsset: 'asset456',
    endDate: new Date(Date.now() + 86400000).toISOString(),
    negativeRisk: false,
    ...overrides,
});

describe('Edge Filters', () => {
    describe('checkEdgeFilters', () => {
        it('should pass a valid buy trade', () => {
            const trade = createMockTrade({ side: 'BUY', usdcSize: 50 });
            const myPosition = undefined;
            const traderPosition = createMockPosition();

            const result = checkEdgeFilters(trade, myPosition, traderPosition);

            expect(result.shouldCopy).toBe(true);
            expect(result.filters.positionDelta.passed).toBe(true);
        });

        it('should block trades below minimum position delta', () => {
            const trade = createMockTrade({ side: 'BUY', usdcSize: 0.1 }); // Very small trade
            const myPosition = undefined;
            const traderPosition = createMockPosition();

            const result = checkEdgeFilters(trade, myPosition, traderPosition, {
                minPositionDeltaUsd: 5.0,
            });

            expect(result.shouldCopy).toBe(false);
            expect(result.filters.positionDelta.passed).toBe(false);
            expect(result.reason).toContain('below minimum');
        });

        it('should block sell trades when no position held', () => {
            const trade = createMockTrade({ side: 'SELL', usdcSize: 50 });
            const myPosition = undefined; // No position
            const traderPosition = createMockPosition();

            const result = checkEdgeFilters(trade, myPosition, traderPosition, {
                requirePositionForSell: true,
            });

            expect(result.shouldCopy).toBe(false);
            expect(result.filters.hasPositionForSell.passed).toBe(false);
            expect(result.reason).toContain('no position');
        });

        it('should allow sell trades when position is held', () => {
            const trade = createMockTrade({ side: 'SELL', usdcSize: 50 });
            const myPosition = createMockPosition({ size: 100 });
            const traderPosition = createMockPosition();

            const result = checkEdgeFilters(trade, myPosition, traderPosition, {
                requirePositionForSell: true,
            });

            expect(result.shouldCopy).toBe(true);
            expect(result.filters.hasPositionForSell.passed).toBe(true);
        });

        it('should allow sell trades when requirePositionForSell is disabled', () => {
            const trade = createMockTrade({ side: 'SELL', usdcSize: 50 });
            const myPosition = undefined;
            const traderPosition = createMockPosition();

            const result = checkEdgeFilters(trade, myPosition, traderPosition, {
                requirePositionForSell: false,
            });

            expect(result.shouldCopy).toBe(true);
        });

        it('should block small rebalancing sells', () => {
            const trade = createMockTrade({ side: 'SELL', usdcSize: 50, size: 2 }); // Selling 2 tokens
            const myPosition = createMockPosition({ size: 100 });
            const traderPosition = createMockPosition({ size: 100 }); // Has 100 after the sell

            const result = checkEdgeFilters(trade, myPosition, traderPosition, {
                minTradePercentOfPosition: 10, // Require 10% minimum
            });

            expect(result.shouldCopy).toBe(false);
            expect(result.filters.tradePercentOfPosition.passed).toBe(false);
            expect(result.reason).toContain('rebalance');
        });
    });

    describe('isFullPositionClose', () => {
        it('should return true when trader has no position after', () => {
            const trade = createMockTrade({ side: 'SELL' });
            const traderPositionAfter = undefined;

            expect(isFullPositionClose(trade, traderPositionAfter)).toBe(true);
        });

        it('should return true when trader has near-zero position after', () => {
            const trade = createMockTrade({ side: 'SELL' });
            const traderPositionAfter = createMockPosition({ size: 0.0001 });

            expect(isFullPositionClose(trade, traderPositionAfter)).toBe(true);
        });

        it('should return false when trader still has position', () => {
            const trade = createMockTrade({ side: 'SELL' });
            const traderPositionAfter = createMockPosition({ size: 50 });

            expect(isFullPositionClose(trade, traderPositionAfter)).toBe(false);
        });
    });

    describe('isSignificantPositionChange', () => {
        it('should return true for first buy (no prior position)', () => {
            const trade = createMockTrade({ side: 'BUY', size: 100 });

            expect(isSignificantPositionChange(trade, 0)).toBe(true);
        });

        it('should return true for large position changes', () => {
            const trade = createMockTrade({ side: 'BUY', size: 50 });

            // 50 / 100 = 50% change
            expect(isSignificantPositionChange(trade, 100, 10)).toBe(true);
        });

        it('should return false for small position changes', () => {
            const trade = createMockTrade({ side: 'BUY', size: 5 });

            // 5 / 100 = 5% change
            expect(isSignificantPositionChange(trade, 100, 10)).toBe(false);
        });
    });
});
