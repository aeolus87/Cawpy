import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from './logger';

const HARD_CAP_PRICE_LIMIT = 0.95;
const HARD_CAP_MIN_TIME_MINUTES = 5;
const HARD_CAP_MAX_SPREAD_BPS = 2000;
const HARD_CAP_MIN_DEPTH_USD = 0.5;

export interface ViabilityConfig {
    priceLimit: number;
    minTimeBeforeEndMinutes: number;
    maxSpreadBps: number;
    minDepthUsd: number;
}

export interface ViabilityResult {
    viable: boolean;
    reason: string;
    checks: {
        priceExtreme: { passed: boolean; value?: number; threshold: number };
        timeToEnd: { passed: boolean; minutesRemaining?: number; threshold: number };
        spread: { passed: boolean; spreadBps?: number; threshold: number };
        depth: { passed: boolean; depthUsd?: number; threshold: number };
    };
}

export function getViabilityConfig(): ViabilityConfig {
    const envPriceLimit = ENV.VIABILITY_PRICE_LIMIT ?? 0.95;
    const envMinTime = ENV.VIABILITY_MIN_TIME_BEFORE_END_MINUTES ?? 60;
    const envMaxSpread = ENV.VIABILITY_MAX_SPREAD_BPS ?? 500;
    const envMinDepth = ENV.VIABILITY_MIN_DEPTH_USD ?? 10;

    return {
        priceLimit: Math.min(envPriceLimit, HARD_CAP_PRICE_LIMIT),
        minTimeBeforeEndMinutes: Math.max(envMinTime, HARD_CAP_MIN_TIME_MINUTES),
        maxSpreadBps: Math.min(envMaxSpread, HARD_CAP_MAX_SPREAD_BPS),
        minDepthUsd: Math.max(envMinDepth, HARD_CAP_MIN_DEPTH_USD),
    };
}

export async function checkMarketViability(
    clobClient: ClobClient,
    tokenId: string,
    endDate: string | undefined,
    isSellReducingExposure: boolean = false
): Promise<ViabilityResult> {
    const config = getViabilityConfig();

    const result: ViabilityResult = {
        viable: true,
        reason: 'All checks passed',
        checks: {
            priceExtreme: { passed: true, threshold: config.priceLimit },
            timeToEnd: { passed: true, threshold: config.minTimeBeforeEndMinutes },
            spread: { passed: true, threshold: config.maxSpreadBps },
            depth: { passed: true, threshold: config.minDepthUsd },
        },
    };

    try {
        const orderBook = await clobClient.getOrderBook(tokenId);

        const bestBid = orderBook.bids?.[0];
        const bestAsk = orderBook.asks?.[0];

        const bestBidPrice = bestBid ? parseFloat(bestBid.price) : 0;
        const bestAskPrice = bestAsk ? parseFloat(bestAsk.price) : 1;

        if (bestBidPrice >= config.priceLimit) {
            result.checks.priceExtreme = {
                passed: false,
                value: bestBidPrice,
                threshold: config.priceLimit,
            };
            result.viable = false;
            result.reason = `Market appears resolved: bid price ${bestBidPrice.toFixed(4)} >= ${config.priceLimit}`;
            return result;
        }

        if (bestAskPrice <= 1 - config.priceLimit) {
            result.checks.priceExtreme = {
                passed: false,
                value: bestAskPrice,
                threshold: 1 - config.priceLimit,
            };
            result.viable = false;
            result.reason = `Market appears resolved: ask price ${bestAskPrice.toFixed(4)} <= ${(1 - config.priceLimit).toFixed(4)}`;
            return result;
        }

        result.checks.priceExtreme.value = Math.max(bestBidPrice, 1 - bestAskPrice);

        if (endDate) {
            const endTime = new Date(endDate).getTime();
            const now = Date.now();
            const minutesRemaining = (endTime - now) / (1000 * 60);

            result.checks.timeToEnd.minutesRemaining = minutesRemaining;

            if (minutesRemaining < config.minTimeBeforeEndMinutes && !isSellReducingExposure) {
                result.checks.timeToEnd.passed = false;
                result.viable = false;
                result.reason = `Too close to market end: ${minutesRemaining.toFixed(0)} minutes remaining < ${config.minTimeBeforeEndMinutes} minimum`;
                return result;
            }
        }

        if (bestBid && bestAsk) {
            const spreadBps = ((bestAskPrice - bestBidPrice) / bestBidPrice) * 10000;
            result.checks.spread.spreadBps = spreadBps;

            if (spreadBps > config.maxSpreadBps) {
                result.checks.spread.passed = false;
                result.viable = false;
                result.reason = `Spread too wide: ${spreadBps.toFixed(0)} bps > ${config.maxSpreadBps} bps max`;
                return result;
            }
        }

        const bidDepth =
            orderBook.bids?.reduce((sum, bid) => {
                return sum + parseFloat(bid.size) * parseFloat(bid.price);
            }, 0) ?? 0;

        const askDepth =
            orderBook.asks?.reduce((sum, ask) => {
                return sum + parseFloat(ask.size) * parseFloat(ask.price);
            }, 0) ?? 0;

        const relevantDepth = Math.min(bidDepth, askDepth);
        result.checks.depth.depthUsd = relevantDepth;

        if (relevantDepth < config.minDepthUsd) {
            result.checks.depth.passed = false;
            result.viable = false;
            result.reason = `Insufficient liquidity: $${relevantDepth.toFixed(2)} < $${config.minDepthUsd} minimum`;
            return result;
        }

        return result;
    } catch (error) {
        Logger.warning(`Viability check failed for ${tokenId}: ${error}`);
        result.viable = false;
        result.reason = `Failed to check viability: ${error instanceof Error ? error.message : String(error)}`;
        return result;
    }
}

export function logViabilityResult(result: ViabilityResult, marketSlug?: string): void {
    if (result.viable) {
        Logger.info(`Market viable: ${marketSlug || 'unknown'}`);
    } else {
        Logger.warning(`Market not viable: ${result.reason}`);
        if (marketSlug) {
            Logger.warning(`   Market: ${marketSlug}`);
        }
    }
}
