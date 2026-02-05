/**
 * Reconciliation Service
 *
 * Compares expected positions (based on executed trades) with actual positions
 * from the Polymarket API to detect and report discrepancies.
 */

import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;

interface PositionDiscrepancy {
    asset: string;
    conditionId: string;
    slug?: string;
    expectedSize: number;
    actualSize: number;
    difference: number;
    differencePercent: number;
    severity: 'info' | 'warning' | 'critical';
}

interface ReconciliationResult {
    timestamp: number;
    discrepancies: PositionDiscrepancy[];
    summary: {
        totalPositions: number;
        matchingPositions: number;
        discrepancyCount: number;
        criticalCount: number;
    };
}

/**
 * Calculate expected position from executed trades
 */
const calculateExpectedPositions = async (): Promise<
    Map<string, { size: number; slug?: string; conditionId: string }>
> => {
    const expectedPositions = new Map<
        string,
        { size: number; slug?: string; conditionId: string }
    >();

    for (const address of USER_ADDRESSES) {
        const UserActivity = getUserActivityModel(address);

        // Get all executed BUY trades with tracked tokens
        const executedBuys = await UserActivity.find({
            $or: [
                { lifecycleState: 'executed', side: 'BUY' },
                { bot: true, side: 'BUY', myBoughtSize: { $gt: 0 } },
            ],
        }).exec();

        for (const buy of executedBuys) {
            const asset = buy.asset;
            if (!asset) continue;

            const tokens = buy.actualTokens || buy.myBoughtSize || 0;
            const existing = expectedPositions.get(asset);

            if (existing) {
                existing.size += tokens;
            } else {
                expectedPositions.set(asset, {
                    size: tokens,
                    slug: buy.slug || undefined,
                    conditionId: buy.conditionId || '',
                });
            }
        }

        // Subtract sold tokens
        const executedSells = await UserActivity.find({
            $or: [
                { lifecycleState: 'executed', side: 'SELL' },
                { bot: true, side: 'SELL' },
            ],
        }).exec();

        for (const sell of executedSells) {
            const asset = sell.asset;
            if (!asset) continue;

            const tokens = sell.actualTokens || sell.myBoughtSize || sell.size || 0;
            const existing = expectedPositions.get(asset);

            if (existing) {
                existing.size -= tokens;
                // Remove if position is effectively zero
                if (existing.size < 0.001) {
                    expectedPositions.delete(asset);
                }
            }
        }
    }

    return expectedPositions;
};

/**
 * Get actual positions from Polymarket API
 */
const getActualPositions = async (): Promise<
    Map<string, { size: number; slug?: string; conditionId: string }>
> => {
    const actualPositions = new Map<string, { size: number; slug?: string; conditionId: string }>();

    try {
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
        const positions = await fetchData(positionsUrl);

        if (Array.isArray(positions)) {
            for (const pos of positions) {
                if (pos.asset && pos.size > 0) {
                    actualPositions.set(pos.asset, {
                        size: pos.size,
                        slug: pos.slug || undefined,
                        conditionId: pos.conditionId || '',
                    });
                }
            }
        }
    } catch (error) {
        Logger.error(`Failed to fetch actual positions: ${error}`);
    }

    return actualPositions;
};

/**
 * Run reconciliation check
 */
export const runReconciliation = async (): Promise<ReconciliationResult> => {
    Logger.info('🔄 Running position reconciliation...');

    const expectedPositions = await calculateExpectedPositions();
    const actualPositions = await getActualPositions();

    const discrepancies: PositionDiscrepancy[] = [];
    let matchingPositions = 0;

    // Check expected positions against actual
    for (const [asset, expected] of expectedPositions) {
        const actual = actualPositions.get(asset);
        const actualSize = actual?.size || 0;
        const difference = actualSize - expected.size;
        const differencePercent = expected.size > 0 ? (difference / expected.size) * 100 : 0;

        // Tolerance: 1% or 0.1 tokens, whichever is larger
        const toleranceTokens = Math.max(expected.size * 0.01, 0.1);

        if (Math.abs(difference) <= toleranceTokens) {
            matchingPositions++;
        } else {
            // Determine severity
            let severity: 'info' | 'warning' | 'critical' = 'info';
            if (Math.abs(differencePercent) > 20) {
                severity = 'critical';
            } else if (Math.abs(differencePercent) > 5) {
                severity = 'warning';
            }

            discrepancies.push({
                asset,
                conditionId: expected.conditionId,
                slug: expected.slug || actual?.slug,
                expectedSize: expected.size,
                actualSize,
                difference,
                differencePercent,
                severity,
            });
        }
    }

    // Check for unexpected positions (positions we don't have records for)
    for (const [asset, actual] of actualPositions) {
        if (!expectedPositions.has(asset)) {
            discrepancies.push({
                asset,
                conditionId: actual.conditionId,
                slug: actual.slug,
                expectedSize: 0,
                actualSize: actual.size,
                difference: actual.size,
                differencePercent: 100,
                severity: 'warning',
            });
        }
    }

    const result: ReconciliationResult = {
        timestamp: Date.now(),
        discrepancies,
        summary: {
            totalPositions:
                expectedPositions.size + discrepancies.filter((d) => d.expectedSize === 0).length,
            matchingPositions,
            discrepancyCount: discrepancies.length,
            criticalCount: discrepancies.filter((d) => d.severity === 'critical').length,
        },
    };

    // Log results
    if (discrepancies.length === 0) {
        Logger.info('✅ Reconciliation complete: All positions match expected');
    } else {
        Logger.warning(`⚠️  Reconciliation found ${discrepancies.length} discrepancies:`);
        for (const d of discrepancies) {
            const icon = d.severity === 'critical' ? '🚨' : d.severity === 'warning' ? '⚠️' : 'ℹ️';
            Logger.warning(`   ${icon} ${d.slug || d.asset.substring(0, 10)}...`);
            Logger.warning(
                `      Expected: ${d.expectedSize.toFixed(4)} | Actual: ${d.actualSize.toFixed(4)} | Diff: ${d.difference.toFixed(4)} (${d.differencePercent.toFixed(1)}%)`
            );
        }
    }

    return result;
};

/**
 * Mark executed trades as reconciled after successful reconciliation
 */
export const markTradesReconciled = async (assets: string[]): Promise<void> => {
    for (const address of USER_ADDRESSES) {
        const UserActivity = getUserActivityModel(address);

        await UserActivity.updateMany(
            {
                asset: { $in: assets },
                lifecycleState: 'executed',
            },
            {
                $set: { lifecycleState: 'reconciled' },
            }
        );
    }
};

export default { runReconciliation, markTradesReconciled };
