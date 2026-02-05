/**
 * Edge Awareness Filters
 *
 * Lightweight filters to improve copy trade quality by avoiding
 * trades that are unlikely to have positive expectancy.
 */

import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import Logger from './logger';

export interface EdgeFilterConfig {
    // Minimum position delta (in USD) for a trade to be copied
    // Filters out noise trades that are too small to matter
    minPositionDeltaUsd: number;

    // Don't copy sells unless we hold a position in that market
    // Prevents opening short exposure when trader is just exiting
    requirePositionForSell: boolean;

    // Minimum trader position percentage being traded
    // Filters out small rebalancing trades
    minTradePercentOfPosition: number;
}

export interface EdgeFilterResult {
    shouldCopy: boolean;
    reason: string;
    filters: {
        positionDelta: { passed: boolean; value?: number; threshold: number };
        hasPositionForSell: { passed: boolean; hasPosition?: boolean };
        tradePercentOfPosition: { passed: boolean; percent?: number; threshold: number };
    };
}

// Hard caps (cannot be overridden by env)
const HARD_CAP_MIN_POSITION_DELTA_USD = 0.5; // At least $0.50
const HARD_CAP_MIN_TRADE_PERCENT = 1.0; // At least 1%

// Get configuration from environment with hard caps
const getEdgeConfig = (): EdgeFilterConfig => {
    const envMinDelta = ENV.EDGE_MIN_POSITION_DELTA_USD ?? 5.0;
    const envMinPercent = ENV.EDGE_MIN_TRADE_PERCENT_OF_POSITION ?? 5.0;

    return {
        minPositionDeltaUsd: Math.max(envMinDelta, HARD_CAP_MIN_POSITION_DELTA_USD),
        requirePositionForSell: ENV.EDGE_REQUIRE_POSITION_FOR_SELL ?? true,
        minTradePercentOfPosition: Math.max(envMinPercent, HARD_CAP_MIN_TRADE_PERCENT),
    };
};

// Default configuration from environment
const DEFAULT_CONFIG: EdgeFilterConfig = getEdgeConfig();

/**
 * Check if a trade passes edge filters
 */
export function checkEdgeFilters(
    trade: UserActivityInterface,
    myPosition: UserPositionInterface | undefined,
    traderPosition: UserPositionInterface | undefined,
    config: Partial<EdgeFilterConfig> = {}
): EdgeFilterResult {
    const effectiveConfig = { ...DEFAULT_CONFIG, ...config };

    const result: EdgeFilterResult = {
        shouldCopy: true,
        reason: 'All edge filters passed',
        filters: {
            positionDelta: { passed: true, threshold: effectiveConfig.minPositionDeltaUsd },
            hasPositionForSell: { passed: true },
            tradePercentOfPosition: {
                passed: true,
                threshold: effectiveConfig.minTradePercentOfPosition,
            },
        },
    };

    // Filter 1: Minimum position delta
    const tradeValueUsd = trade.usdcSize || 0;
    result.filters.positionDelta.value = tradeValueUsd;

    if (tradeValueUsd < effectiveConfig.minPositionDeltaUsd) {
        result.filters.positionDelta.passed = false;
        result.shouldCopy = false;
        result.reason = `Trade value ($${tradeValueUsd.toFixed(2)}) below minimum ($${effectiveConfig.minPositionDeltaUsd})`;
        return result;
    }

    // Filter 2: Require position for sells
    const isSell = trade.side === 'SELL';
    result.filters.hasPositionForSell.hasPosition = !!myPosition && myPosition.size > 0;

    if (isSell && effectiveConfig.requirePositionForSell) {
        if (!myPosition || myPosition.size <= 0) {
            result.filters.hasPositionForSell.passed = false;
            result.shouldCopy = false;
            result.reason = 'Cannot copy sell trade - no position held';
            return result;
        }
    }

    // Filter 3: Minimum trade percentage of position
    if (traderPosition && traderPosition.size > 0) {
        // Calculate what percentage of their position this trade represents
        const tradeSize = trade.size || 0;
        const positionBefore = isSell
            ? traderPosition.size + tradeSize // For sells, add back the sold amount
            : traderPosition.size - tradeSize; // For buys, subtract the bought amount

        const tradePercent = positionBefore > 0 ? (tradeSize / positionBefore) * 100 : 100; // If no prior position, treat as 100%

        result.filters.tradePercentOfPosition.percent = tradePercent;

        // Only apply this filter for sells (rebalancing concern)
        // For buys, we want to copy even small additions
        if (isSell && tradePercent < effectiveConfig.minTradePercentOfPosition) {
            result.filters.tradePercentOfPosition.passed = false;
            result.shouldCopy = false;
            result.reason = `Trade is small rebalance (${tradePercent.toFixed(1)}% of position, min ${effectiveConfig.minTradePercentOfPosition}%)`;
            return result;
        }
    }

    return result;
}

/**
 * Log edge filter result
 */
export function logEdgeFilterResult(result: EdgeFilterResult, slug?: string): void {
    if (result.shouldCopy) {
        Logger.info(`✓ Edge filters passed for ${slug || 'trade'}`);
    } else {
        Logger.warning(`⚠️  Edge filter blocked: ${result.reason}`);
        if (slug) {
            Logger.warning(`   Market: ${slug}`);
        }
    }
}

/**
 * Check if trade appears to be a position close (trader fully exiting)
 */
export function isFullPositionClose(
    trade: UserActivityInterface,
    traderPositionAfter: UserPositionInterface | undefined
): boolean {
    // If trader has no position after, they closed everything
    if (!traderPositionAfter || traderPositionAfter.size <= 0.001) {
        return true;
    }
    return false;
}

/**
 * Check if trade is a significant position change
 * (Not just noise or dust trading)
 */
export function isSignificantPositionChange(
    trade: UserActivityInterface,
    traderPositionBefore: number,
    minSignificantPercent: number = 10
): boolean {
    const tradeSize = trade.size || 0;

    // If no prior position, any buy is significant
    if (traderPositionBefore <= 0) {
        return trade.side === 'BUY';
    }

    const changePercent = (tradeSize / traderPositionBefore) * 100;
    return changePercent >= minSignificantPercent;
}

export default {
    checkEdgeFilters,
    logEdgeFilterResult,
    isFullPositionClose,
    isSignificantPositionChange,
};
