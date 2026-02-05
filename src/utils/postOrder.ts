/**
 * Post Order - High-level order orchestration for copy trading
 *
 * This module handles the business logic for copying trades (BUY/SELL/MERGE).
 * All actual order placement is delegated to the guarded executor.
 */

import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import {
    UserActivityInterface,
    UserPositionInterface,
    TradeLifecycleState,
} from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import {
    executeOrderGuarded,
    ExecutionContext,
    OrderRequest,
    OrderResult,
} from '../execution/guardedExecutor';
import mongoose from 'mongoose';
import {
    acquireLease,
    releaseLease,
    checkLeaseStatus,
} from './leaseManager';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_TOKENS = 1.0;

/**
 * Helper to update trade lifecycle state with proper fields
 */
interface TradeStateUpdate {
    state: TradeLifecycleState;
    reason?: string;
    tokens?: number;
    expectedTokens?: number;
    isRetryable?: boolean;
    filledSize?: number;
    avgFillPrice?: number;
    orderId?: string;
    idempotencyKey?: string;
    intendedSize?: number;
    needsManualReview?: boolean;
}

// Threshold for flagging partial fills (20% difference)
const PARTIAL_FILL_THRESHOLD = 0.20;

/**
 * Check if a fill is significantly partial and needs manual review
 */
const checkNeedsManualReview = (
    intendedSize: number | undefined,
    filledSize: number | undefined
): boolean => {
    if (!intendedSize || !filledSize || intendedSize === 0) {
        return false;
    }
    
    const fillRatio = filledSize / intendedSize;
    // Flag if we filled less than 80% or more than 120% of intended
    return fillRatio < (1 - PARTIAL_FILL_THRESHOLD) || fillRatio > (1 + PARTIAL_FILL_THRESHOLD);
};

const updateTradeState = async (
    UserActivity: ReturnType<typeof getUserActivityModel>,
    tradeId: mongoose.Types.ObjectId,
    update: TradeStateUpdate,
    currentRetryCount: number = 0
) => {
    const updateFields: Record<string, unknown> = {
        lifecycleState: update.state,
        // Legacy fields for backward compatibility
        bot:
            update.state === 'executed' ||
            update.state === 'skipped' ||
            (update.state === 'failed' && !update.isRetryable),
    };

    switch (update.state) {
        case 'skipped':
            updateFields.skipReason = update.reason || 'unknown';
            if (update.intendedSize !== undefined) {
                updateFields.intendedSize = update.intendedSize;
            }
            break;
        case 'failed':
            if (update.isRetryable) {
                updateFields.failureReason = update.reason || 'unknown';
                updateFields.retryCount = currentRetryCount + 1;
                updateFields.lastRetryAt = Date.now();
                updateFields.bot = false; // Allow retry
            } else {
                updateFields.failureReason = update.reason || 'unknown';
                updateFields.botExcutedTime = RETRY_LIMIT;
            }
            if (update.intendedSize !== undefined) {
                updateFields.intendedSize = update.intendedSize;
            }
            break;
        case 'executed':
            updateFields.executedAt = Date.now();
            if (update.tokens !== undefined) {
                updateFields.myBoughtSize = update.tokens;
                updateFields.actualTokens = update.tokens;
            }
            if (update.expectedTokens !== undefined) {
                updateFields.expectedTokens = update.expectedTokens;
            }
            if (update.filledSize !== undefined) {
                updateFields.filledSize = update.filledSize;
            }
            if (update.avgFillPrice !== undefined) {
                updateFields.avgFillPrice = update.avgFillPrice;
            }
            if (update.orderId !== undefined) {
                updateFields.clobOrderId = update.orderId;
            }
            if (update.idempotencyKey !== undefined) {
                updateFields.idempotencyKey = update.idempotencyKey;
            }
            if (update.intendedSize !== undefined) {
                updateFields.intendedSize = update.intendedSize;
            }
            // Flag for manual review if fill is significantly partial
            if (update.needsManualReview !== undefined) {
                updateFields.needsManualReview = update.needsManualReview;
            }
            break;
        case 'executing':
            // Transition state, no extra fields
            break;
    }

    await UserActivity.updateOne({ _id: tradeId }, { $set: updateFields });
};

/**
 * Handle the result from guarded executor and update DB state
 */
const handleExecutionResult = async (
    UserActivity: ReturnType<typeof getUserActivityModel>,
    trade: UserActivityInterface,
    result: OrderResult,
    options?: {
        expectedTokens?: number;
        intendedSize?: number;
    }
): Promise<void> => {
    if (result.skipped) {
        await updateTradeState(UserActivity, trade._id, {
            state: 'skipped',
            reason: result.reason,
            intendedSize: options?.intendedSize,
        });
    } else if (result.failed) {
        await updateTradeState(
            UserActivity,
            trade._id,
            {
                state: 'failed',
                reason: result.reason,
                tokens: result.filledTokens,
                isRetryable: result.isRetryable,
                intendedSize: options?.intendedSize,
            },
            trade.retryCount || 0
        );
    } else if (result.executed) {
        // Check if fill is significantly partial and needs manual review
        const needsReview = checkNeedsManualReview(
            options?.intendedSize,
            result.filledSize
        );
        
        if (needsReview) {
            Logger.warning(
                `⚠️  Partial fill detected: intended ${options?.intendedSize?.toFixed(2)}, filled ${result.filledSize?.toFixed(2)} - flagged for manual review`
            );
        }
        
        await updateTradeState(UserActivity, trade._id, {
            state: 'executed',
            tokens: result.filledTokens,
            expectedTokens: options?.expectedTokens,
            filledSize: result.filledSize,
            avgFillPrice: result.avgFillPrice,
            orderId: result.orderId,
            idempotencyKey: result.idempotencyKey,
            intendedSize: options?.intendedSize,
            needsManualReview: needsReview,
        });
    }
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string
) => {
    const UserActivity = getUserActivityModel(userAddress);
    const ctx: ExecutionContext = {
        clobClient,
        acquireLease: (tradeId, workerId) => acquireLease(userAddress, tradeId),
        releaseLease: (tradeId) => releaseLease(userAddress, tradeId),
        checkLease: (tradeId) =>
            checkLeaseStatus(userAddress, tradeId).then((status) => ({
                held: status.held,
                heldBy: status.heldBy ?? undefined,
                expiresAt: status.expiresAt ?? undefined,
                expired: status.expired,
            })),
    };

    // ========================================================================
    // MERGE Strategy
    // ========================================================================
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');
        
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        const remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Build request and execute through guarded executor
        const request: OrderRequest = {
            side: 'MERGE',
            tokenId: my_position.asset,
            amount: remaining,
            endDate: my_position?.endDate || user_position?.endDate,
            marketSlug: trade.slug,
            myPositionSize: my_position.size,
            tradeId: trade._id,
            userAddress,
            tradeTimestamp: trade.timestamp,
            traderPrice: trade.price,
        };

        const result = await executeOrderGuarded(ctx, request);
        await handleExecutionResult(UserActivity, trade, result, {
            intendedSize: remaining,
        });

        if (result.executed && result.filledTokens && result.filledTokens > 0) {
            Logger.info(`📝 Merged ${result.filledTokens.toFixed(2)} tokens`);
        }
    }
    // ========================================================================
    // BUY Strategy
    // ========================================================================
    else if (condition === 'buy') {
        Logger.info('Executing BUY strategy...');

        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue
        );

        // Log the calculation reasoning
        Logger.info(`📊 ${orderCalc.reasoning}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Build request and execute through guarded executor
        const request: OrderRequest = {
            side: 'BUY',
            tokenId: trade.asset,
            amount: orderCalc.finalAmount,
            traderPrice: trade.price,
            endDate: my_position?.endDate || user_position?.endDate,
            marketSlug: trade.slug,
            myPositionSize: my_position?.size,
            myPositionValue: currentPositionValue,
            tradeId: trade._id,
            tradeUsdcSize: trade.usdcSize,
            userAddress,
            tradeTimestamp: trade.timestamp,
        };

        const result = await executeOrderGuarded(ctx, request);
        
        // Handle result
        const expectedTokens = orderCalc.finalAmount > 0 && result.filledTokens
            ? orderCalc.finalAmount / (result.avgFillPrice || trade.price || 1)
            : undefined;
        
        await handleExecutionResult(UserActivity, trade, result, {
            expectedTokens,
            intendedSize: orderCalc.finalAmount,
        });

        // Log the tracked purchase for later sell reference
        if (result.executed && result.filledTokens && result.filledTokens > 0) {
            Logger.info(
                `📝 Tracked purchase: ${result.filledTokens.toFixed(2)} tokens for future sell calculations`
            );
        }
    }
    // ========================================================================
    // SELL Strategy
    // ========================================================================
    else if (condition === 'sell') {
        Logger.info('Executing SELL strategy...');
        
        if (!my_position) {
            Logger.warning('No position to sell - skipping (edge filter: requirePositionForSell)');
            await updateTradeState(UserActivity, trade._id, {
                state: 'skipped',
                reason: 'no_position_to_sell',
            });
            return;
        }

        // Get all previous BUY trades for this asset to calculate total bought
        const previousBuys = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
            );
        }

        let sellAmount: number;

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            sellAmount = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${sellAmount.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `Position comparison: Trader has ${trader_position_before.toFixed(2)} tokens, You have ${my_position.size.toFixed(2)} tokens`
            );
            Logger.info(
                `Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `No tracked purchases found, using current position: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            }

            // Apply tiered or single multiplier based on trader's order size
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            sellAmount = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${sellAmount.toFixed(2)} tokens`
                );
            }
        }

        // Check minimum order size
        if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ Cannot execute: Sell amount ${sellAmount.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
            );
            Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Cap sell amount to available position size
        if (sellAmount > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${sellAmount.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            sellAmount = my_position.size;
        }

        // Build request and execute through guarded executor
        const request: OrderRequest = {
            side: 'SELL',
            tokenId: trade.asset,
            amount: sellAmount,
            endDate: my_position?.endDate || user_position?.endDate,
            marketSlug: trade.slug,
            myPositionSize: my_position.size,
            tradeId: trade._id,
            tradeUsdcSize: trade.usdcSize,
            userAddress,
            tradeTimestamp: trade.timestamp,
            traderPrice: trade.price,
        };

        const result = await executeOrderGuarded(ctx, request);
        await handleExecutionResult(UserActivity, trade, result, {
            intendedSize: sellAmount,
        });

        // Update tracked purchases after successful sell
        if (result.executed && result.filledTokens && result.filledTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = result.filledTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
                await UserActivity.updateMany(
                    {
                        asset: trade.asset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
                );
            } else {
                // Partial sell - reduce tracked purchases proportionally
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
                );
            }
        }
    } else {
        Logger.error(`Unknown condition: ${condition}`);
    }
};

export default postOrder;
