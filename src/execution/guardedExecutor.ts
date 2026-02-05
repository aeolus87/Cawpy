/**
 * Guarded Executor - THE ONLY place where CLOB orders are placed
 *
 * This module enforces all safety gates before any order placement:
 * - Market viability gate (BUY: hard-block; SELL/MERGE: warn-only but require slippage+depth)
 * - Edge filters
 * - Position required for sell check
 * - Min/max order sizing
 * - Slippage guard
 * - Idempotency check
 * - Lease management
 *
 * NO OTHER MODULE should call clobClient.createMarketOrder or clobClient.postOrder directly.
 */

import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import {
    checkMarketViability,
    logViabilityResult,
    getViabilityConfig,
} from '../utils/marketViability';
import { checkEdgeFilters, logEdgeFilterResult } from '../utils/edgeFilters';
import mongoose from 'mongoose';
import { getUserActivityModel } from '../models/userHistory';
import { getWorkerId } from '../utils/leaseManager';

// ============================================================================
// Constants
// ============================================================================

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const MAX_SLIPPAGE_BPS = ENV.MAX_SLIPPAGE_BPS;
const HARD_CAP_MAX_SLIPPAGE_BPS = 1000;
const EFFECTIVE_MAX_SLIPPAGE_BPS = Math.min(MAX_SLIPPAGE_BPS, HARD_CAP_MAX_SLIPPAGE_BPS);

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;

// Lease timeout for stuck claims (30 seconds)
const LEASE_TIMEOUT_MS = 30000;

// ============================================================================
// Types
// ============================================================================

export type OrderSide = 'BUY' | 'SELL' | 'MERGE';

export interface OrderRequest {
    // Core order info
    side: OrderSide;
    tokenId: string;
    amount: number; // USD for BUY, tokens for SELL/MERGE
    
    // Context for gates
    traderPrice?: number; // For slippage calculation
    endDate?: string; // For viability time check
    marketSlug?: string; // For logging
    
    // Position context
    myPositionSize?: number; // Current position size in tokens
    myPositionValue?: number; // Current position value in USD
    
    // Trade tracking (for copy trades)
    tradeId?: mongoose.Types.ObjectId;
    tradeUsdcSize?: number; // Trader's order size for edge filter
    tradeTimestamp?: number; // Original trade timestamp (seconds or ms)
    
    // For DB operations (idempotency, lease)
    userAddress?: string; // Tracked user's wallet address
}

export interface OrderResult {
    success: boolean;
    executed: boolean;
    skipped: boolean;
    failed: boolean;
    
    // Results
    filledSize?: number;
    filledTokens?: number;
    avgFillPrice?: number;
    
    // Failure/skip info
    reason?: string;
    isRetryable?: boolean;
    
    // Idempotency
    orderId?: string;
    idempotencyKey?: string;
}

export interface ExecutionContext {
    clobClient: ClobClient;
    
    // For idempotency tracking (optional DB model)
    getIdempotencyRecord?: (tradeId: mongoose.Types.ObjectId) => Promise<IdempotencyRecord | null>;
    setIdempotencyRecord?: (tradeId: mongoose.Types.ObjectId, record: IdempotencyRecord) => Promise<void>;
    
    // For lease management
    checkLease?: (tradeId: mongoose.Types.ObjectId) => Promise<LeaseStatus>;
    acquireLease?: (tradeId: mongoose.Types.ObjectId, workerId: string) => Promise<boolean>;
    releaseLease?: (tradeId: mongoose.Types.ObjectId) => Promise<void>;
}

export interface IdempotencyRecord {
    tradeId: string;
    orderId?: string;
    idempotencyKey: string;
    status: 'pending' | 'completed' | 'failed';
    createdAt: number;
    completedAt?: number;
}

export interface LeaseStatus {
    held: boolean;
    heldBy?: string;
    expiresAt?: number;
    expired: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;
        const directError = data.error;
        
        if (typeof directError === 'string') return directError;
        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') return nested.error;
            if (typeof nested.message === 'string') return nested.message;
        }
        if (typeof data.errorMsg === 'string') return data.errorMsg;
        if (typeof data.message === 'string') return data.message;
    }
    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) return false;
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const generateIdempotencyKey = (
    tradeId: mongoose.Types.ObjectId | undefined,
    side: OrderSide,
    tokenId: string
): string => {
    const timestamp = Date.now();
    const tradeIdStr = tradeId?.toString() || 'manual';
    return `${tradeIdStr}-${side}-${tokenId}-${timestamp}`;
};

// ============================================================================
// Gate Functions
// ============================================================================

interface GateCheckResult {
    passed: boolean;
    reason?: string;
    shouldWarnOnly?: boolean;
}

/**
 * Gate 0: Trade timestamp freshness (fail closed)
 */
function checkTimestampGate(request: OrderRequest): GateCheckResult {
    if (!request.tradeId) {
        return { passed: true };
    }

    if (request.tradeTimestamp === undefined) {
        return { passed: false, reason: 'missing_trade_timestamp' };
    }

    const timestampMs =
        request.tradeTimestamp < 1e12 ? request.tradeTimestamp * 1000 : request.tradeTimestamp;
    const maxAgeMs = ENV.TOO_OLD_TIMESTAMP_HOURS * 60 * 60 * 1000;
    const isFresh = Date.now() - timestampMs <= maxAgeMs;

    return isFresh
        ? { passed: true }
        : { passed: false, reason: 'trade_timestamp_too_old' };
}

/**
 * Gate 1: Market Viability
 * - BUY: Hard block if not viable
 * - SELL/MERGE: Warn only, but still check slippage+depth
 */
async function checkViabilityGate(
    ctx: ExecutionContext,
    request: OrderRequest
): Promise<GateCheckResult> {
    const isBuy = request.side === 'BUY';
    const isExit = request.side === 'SELL' || request.side === 'MERGE';

    if (isBuy && !request.endDate) {
        return { passed: false, reason: 'missing_market_end_date' };
    }
    
    const viability = await checkMarketViability(
        ctx.clobClient,
        request.tokenId,
        request.endDate,
        isExit // Pass true for exit paths (SELL/MERGE)
    );
    
    logViabilityResult(viability, request.marketSlug);
    
    if (!viability.viable) {
        if (isBuy) {
            // Hard block for BUY
            return {
                passed: false,
                reason: viability.reason,
            };
        } else {
            // For SELL/MERGE: check if it's a slippage/depth failure
            // These should still block even for exits
            const config = getViabilityConfig();
            const isSlippageOrDepthFailure =
                !viability.checks.spread.passed || !viability.checks.depth.passed;
            
            if (isSlippageOrDepthFailure) {
                return {
                    passed: false,
                    reason: viability.reason,
                };
            }
            
            // Price/time failures are warn-only for exits
            Logger.warning(`⚠️  Viability warning (proceeding with ${request.side}): ${viability.reason}`);
            return {
                passed: true,
                shouldWarnOnly: true,
                reason: viability.reason,
            };
        }
    }
    
    return { passed: true };
}

/**
 * Gate 2: Edge Filters (only for copy trades with trade context)
 */
function checkEdgeGate(
    request: OrderRequest,
    myPosition: { size: number } | undefined,
    traderPosition: { size: number } | undefined
): GateCheckResult {
    const tradeUsdSize =
        request.tradeUsdcSize ??
        (request.side === 'BUY'
            ? request.amount
            : request.traderPrice
            ? request.amount * request.traderPrice
            : undefined);

    if (tradeUsdSize === undefined) {
        return { passed: false, reason: 'edge_filter_missing_trade_usdc' };
    }
    
    // Build minimal trade-like object for edge filter check
    const tradeForFilter = {
        usdcSize: tradeUsdSize,
        size: request.amount,
        side: request.side,
    };
    
    const myPosForFilter = myPosition ? { size: myPosition.size } : undefined;
    const traderPosForFilter = traderPosition ? { size: traderPosition.size } : undefined;
    
    const result = checkEdgeFilters(
        tradeForFilter as any,
        myPosForFilter as any,
        traderPosForFilter as any
    );
    
    logEdgeFilterResult(result, request.marketSlug);
    
    if (!result.shouldCopy) {
        return {
            passed: false,
            reason: `edge_filter: ${result.reason}`,
        };
    }
    
    return { passed: true };
}

/**
 * Gate 3: Position required for sell
 */
function checkPositionRequiredForSell(
    request: OrderRequest
): GateCheckResult {
    if (request.side === 'SELL' || request.side === 'MERGE') {
        if (!request.myPositionSize || request.myPositionSize <= 0) {
            return {
                passed: false,
                reason: 'no_position_to_sell',
            };
        }
    }
    return { passed: true };
}

/**
 * Gate 4: Min/Max Order Sizing
 */
function checkOrderSizing(request: OrderRequest): GateCheckResult {
    const isBuy = request.side === 'BUY';
    
    if (isBuy) {
        if (request.amount < MIN_ORDER_SIZE_USD) {
            return {
                passed: false,
                reason: `order_size_below_minimum_usd_${request.amount.toFixed(2)}`,
            };
        }
    } else {
        if (request.amount < MIN_ORDER_SIZE_TOKENS) {
            return {
                passed: false,
                reason: `order_size_below_minimum_tokens_${request.amount.toFixed(2)}`,
            };
        }
    }
    
    return { passed: true };
}

/**
 * Gate 5: Slippage Guard (checked in execution loop for BUY)
 */
function checkSlippageGate(
    side: OrderSide,
    currentPrice: number,
    traderPrice: number | undefined
): GateCheckResult {
    if (!traderPrice || traderPrice <= 0) {
        // No trader price context, skip slippage check
        return { passed: true };
    }
    
    const slippageBps =
        side === 'BUY'
            ? ((currentPrice - traderPrice) / traderPrice) * 10000
            : ((traderPrice - currentPrice) / traderPrice) * 10000;
    
    if (slippageBps > EFFECTIVE_MAX_SLIPPAGE_BPS) {
        return {
            passed: false,
            reason: `slippage_${slippageBps.toFixed(0)}bps_exceeds_max_${EFFECTIVE_MAX_SLIPPAGE_BPS}bps`,
        };
    }
    
    return { passed: true };
}

// ============================================================================
// Idempotency & Lease Helpers
// ============================================================================

/**
 * Check if a trade has already been executed (idempotency check)
 *
 * Uses the DB to check if the trade has an idempotencyKey set,
 * which indicates it was already processed.
 */
async function checkIdempotency(
    ctx: ExecutionContext,
    request: OrderRequest
): Promise<{ skip: boolean; existingOrderId?: string; existingKey?: string }> {
    // First check via context function (if provided)
    if (request.tradeId && ctx.getIdempotencyRecord) {
        const record = await ctx.getIdempotencyRecord(request.tradeId);
        if (record && record.status === 'completed') {
            Logger.info(`Idempotency check: trade ${request.tradeId} already executed (orderId: ${record.orderId})`);
            return { skip: true, existingOrderId: record.orderId, existingKey: record.idempotencyKey };
        }
    }
    
    // Direct DB check if userAddress is provided
    if (request.tradeId && request.userAddress) {
        try {
            const UserActivity = getUserActivityModel(request.userAddress);
            const trade = await UserActivity.findById(request.tradeId);
            
            if (trade) {
                // Check if already executed (has idempotencyKey and executed state)
                if (trade.idempotencyKey && trade.lifecycleState === 'executed') {
                    Logger.info(`Idempotency check (DB): trade ${request.tradeId} already executed (key: ${trade.idempotencyKey})`);
                    return {
                        skip: true,
                        existingOrderId: trade.clobOrderId ?? undefined,
                        existingKey: trade.idempotencyKey ?? undefined,
                    };
                }
                
                // If idempotencyKey already exists, do not re-execute
                if (trade.idempotencyKey) {
                    Logger.info(
                        `Idempotency check (DB): trade ${request.tradeId} already has idempotencyKey ${trade.idempotencyKey}`
                    );
                    return {
                        skip: true,
                        existingOrderId: trade.clobOrderId ?? undefined,
                        existingKey: trade.idempotencyKey ?? undefined,
                    };
                }

                // Check if already has CLOB order ID (execution completed even if state didn't update)
                if (trade.clobOrderId) {
                    Logger.info(`Idempotency check (DB): trade ${request.tradeId} has clobOrderId ${trade.clobOrderId}`);
                    return {
                        skip: true,
                        existingOrderId: trade.clobOrderId ?? undefined,
                        existingKey: trade.idempotencyKey ?? undefined,
                    };
                }
            }
        } catch (error) {
            Logger.error(`Idempotency DB check error: ${error}`);
            // Don't skip on error - let it proceed and potentially fail
        }
    }
    
    return { skip: false };
}

async function reserveIdempotencyKey(
    request: OrderRequest,
    idempotencyKey: string
): Promise<{ reserved: boolean; existingKey?: string; existingOrderId?: string }> {
    if (!request.tradeId || !request.userAddress) {
        return { reserved: true };
    }

    const UserActivity = getUserActivityModel(request.userAddress);
    const now = Date.now();

    const result = await UserActivity.findOneAndUpdate(
        {
            _id: request.tradeId,
            $or: [{ idempotencyKey: { $exists: false } }, { idempotencyKey: null }],
        },
        {
            $set: {
                idempotencyKey,
                lifecycleState: 'executing',
                lastRetryAt: now,
            },
        },
        { new: true }
    );

    if (result) {
        return { reserved: true };
    }

    const existing = await UserActivity.findById(request.tradeId);
    if (existing?.idempotencyKey) {
        return {
            reserved: false,
            existingKey: existing.idempotencyKey ?? undefined,
            existingOrderId: existing.clobOrderId ?? undefined,
        };
    }

    return { reserved: false };
}

async function acquireLeaseIfNeeded(
    ctx: ExecutionContext,
    tradeId: mongoose.Types.ObjectId | undefined,
    workerId: string
): Promise<boolean> {
    if (!tradeId || !ctx.acquireLease) {
        return true; // No lease management, proceed
    }
    
    return await ctx.acquireLease(tradeId, workerId);
}

// ============================================================================
// Main Execution Function
// ============================================================================

/**
 * executeOrderGuarded - THE ONLY function that should place CLOB orders
 *
 * All safety gates are enforced here. No other code should call
 * clobClient.createMarketOrder or clobClient.postOrder directly.
 */
export async function executeOrderGuarded(
    ctx: ExecutionContext,
    request: OrderRequest
): Promise<OrderResult> {
    const workerId = getWorkerId();
    
    Logger.info(`Guarded execution: ${request.side} ${request.amount} for ${request.marketSlug || request.tokenId}`);
    
    // ========================================================================
    // Pre-execution checks
    // ========================================================================
    
    // Gate 0: Timestamp freshness
    const timestampResult = checkTimestampGate(request);
    if (!timestampResult.passed) {
        Logger.warning(`Gate BLOCKED (timestamp): ${timestampResult.reason}`);
        return {
            success: false,
            executed: false,
            skipped: true,
            failed: false,
            reason: timestampResult.reason,
        };
    }

    // Check idempotency first
    const idempotencyCheck = await checkIdempotency(ctx, request);
    if (idempotencyCheck.skip) {
        return {
            success: true,
            executed: false,
            skipped: true,
            failed: false,
            reason: 'idempotency_already_executed',
            orderId: idempotencyCheck.existingOrderId,
            idempotencyKey: idempotencyCheck.existingKey,
        };
    }
    
    // Acquire lease if needed
    if (request.tradeId) {
        const leaseAcquired = await acquireLeaseIfNeeded(ctx, request.tradeId, workerId);
        if (!leaseAcquired) {
            return {
                success: false,
                executed: false,
                skipped: false,
                failed: true,
                reason: 'lease_acquisition_failed',
                isRetryable: true,
            };
        }
    }
    
    // ========================================================================
    // Gate 1: Market Viability
    // ========================================================================
    const viabilityResult = await checkViabilityGate(ctx, request);
    if (!viabilityResult.passed) {
        Logger.warning(`Gate BLOCKED (viability): ${viabilityResult.reason}`);
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        return {
            success: false,
            executed: false,
            skipped: true,
            failed: false,
            reason: viabilityResult.reason,
        };
    }
    
    // ========================================================================
    // Gate 2: Edge Filters (for copy trades)
    // ========================================================================
    const myPosition = request.myPositionSize ? { size: request.myPositionSize } : undefined;
    const edgeResult = checkEdgeGate(request, myPosition, undefined);
    if (!edgeResult.passed) {
        Logger.warning(`Gate BLOCKED (edge): ${edgeResult.reason}`);
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        return {
            success: false,
            executed: false,
            skipped: true,
            failed: false,
            reason: edgeResult.reason,
        };
    }
    
    // ========================================================================
    // Gate 3: Position Required for Sell
    // ========================================================================
    const positionResult = checkPositionRequiredForSell(request);
    if (!positionResult.passed) {
        Logger.warning(`Gate BLOCKED (position): ${positionResult.reason}`);
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        return {
            success: false,
            executed: false,
            skipped: true,
            failed: false,
            reason: positionResult.reason,
        };
    }
    
    // ========================================================================
    // Gate 4: Order Sizing
    // ========================================================================
    const sizingResult = checkOrderSizing(request);
    if (!sizingResult.passed) {
        Logger.warning(`Gate BLOCKED (sizing): ${sizingResult.reason}`);
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        return {
            success: false,
            executed: false,
            skipped: true,
            failed: false,
            reason: sizingResult.reason,
        };
    }
    
    // ========================================================================
    // Execute Order
    // ========================================================================
    const idempotencyKey = generateIdempotencyKey(request.tradeId, request.side, request.tokenId);
    const reserveResult = await reserveIdempotencyKey(request, idempotencyKey);
    if (!reserveResult.reserved) {
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        return {
            success: true,
            executed: false,
            skipped: true,
            failed: false,
            reason: 'idempotency_in_progress',
            orderId: reserveResult.existingOrderId,
            idempotencyKey: reserveResult.existingKey,
        };
    }
    
    try {
        const result = await executeOrderLoop(ctx, request, idempotencyKey);
        
        // Record idempotency on success
        if (result.executed && ctx.setIdempotencyRecord && request.tradeId) {
            await ctx.setIdempotencyRecord(request.tradeId, {
                tradeId: request.tradeId.toString(),
                orderId: result.orderId,
                idempotencyKey,
                status: 'completed',
                createdAt: Date.now(),
                completedAt: Date.now(),
            });
        }
        
        // Release lease
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        
        return result;
    } catch (error) {
        Logger.error(`Order execution error: ${error}`);
        
        // Release lease on error
        if (request.tradeId && ctx.releaseLease) {
            await ctx.releaseLease(request.tradeId);
        }
        
        return {
            success: false,
            executed: false,
            skipped: false,
            failed: true,
            reason: `execution_error: ${error instanceof Error ? error.message : String(error)}`,
            isRetryable: true,
        };
    }
}

/**
 * Execute the actual order loop with retries
 */
async function executeOrderLoop(
    ctx: ExecutionContext,
    request: OrderRequest,
    idempotencyKey: string
): Promise<OrderResult> {
    const isBuy = request.side === 'BUY';
    let remaining = request.amount;
    let retry = 0;
    let abortDueToFunds = false;
    let totalFilledTokens = 0;
    let totalFilledUsd = 0;
    let lastOrderId: string | undefined;
    
    while (remaining > 0 && retry < RETRY_LIMIT) {
        // Fetch orderbook
        const orderBook = await ctx.clobClient.getOrderBook(request.tokenId);
        
        if (isBuy) {
            // BUY logic
            if (!orderBook.asks || orderBook.asks.length === 0) {
                Logger.warning('No asks available in order book');
                break;
            }
            
            const bestAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);
            
            const currentPrice = parseFloat(bestAsk.price);
            
            // Gate 5: Slippage check
            const slippageResult = checkSlippageGate('BUY', currentPrice, request.traderPrice);
            if (!slippageResult.passed) {
                Logger.warning(`Gate BLOCKED (slippage): ${slippageResult.reason}`);
                return {
                    success: false,
                    executed: totalFilledTokens > 0,
                    skipped: true,
                    failed: false,
                    reason: slippageResult.reason,
                    filledTokens: totalFilledTokens,
                    filledSize: totalFilledUsd,
                    idempotencyKey,
                };
            }
            
            // Check minimum remaining
            if (remaining < MIN_ORDER_SIZE_USD) {
                Logger.info(`Remaining $${remaining.toFixed(2)} below minimum - completing`);
                break;
            }
            
            const maxOrderSize = parseFloat(bestAsk.size) * currentPrice;
            const orderSize = Math.min(remaining, maxOrderSize);
            
            const orderArgs = {
                side: Side.BUY,
                tokenID: request.tokenId,
                amount: orderSize,
                price: currentPrice,
            };
            
            Logger.info(`Creating BUY order: $${orderSize.toFixed(2)} @ $${currentPrice.toFixed(4)}`);
            
            // THIS IS THE ONLY PLACE WHERE WE CALL createMarketOrder and postOrder
            const signedOrder = await ctx.clobClient.createMarketOrder(orderArgs);
            const resp = await ctx.clobClient.postOrder(signedOrder, OrderType.FOK);
            
            if (resp.success === true) {
                retry = 0;
                const tokensBought = orderSize / currentPrice;
                totalFilledTokens += tokensBought;
                totalFilledUsd += orderSize;
                remaining -= orderSize;
                lastOrderId = (resp as any).orderID || (resp as any).orderId;
                Logger.orderResult(true, `Bought $${orderSize.toFixed(2)} at $${currentPrice.toFixed(4)} (${tokensBought.toFixed(2)} tokens)`);
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(`Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`);
                    break;
                }
                retry++;
                Logger.warning(`Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`);
            }
        } else {
            // SELL/MERGE logic
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('No bids available in order book');
                break;
            }
            
            const bestBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);
            
            const currentPrice = parseFloat(bestBid.price);
            
            // Check minimum remaining
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(`Remaining ${remaining.toFixed(2)} tokens below minimum - completing`);
                break;
            }
            
            const sellAmount = Math.min(remaining, parseFloat(bestBid.size));
            
            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(`Order amount ${sellAmount.toFixed(2)} tokens below minimum - completing`);
                break;
            }

            // Slippage check for SELL/MERGE
            const slippageResult = checkSlippageGate('SELL', currentPrice, request.traderPrice);
            if (!slippageResult.passed) {
                Logger.warning(`Gate BLOCKED (slippage): ${slippageResult.reason}`);
                return {
                    success: false,
                    executed: totalFilledTokens > 0,
                    skipped: true,
                    failed: false,
                    reason: slippageResult.reason,
                    filledTokens: totalFilledTokens,
                    filledSize: totalFilledUsd,
                    idempotencyKey,
                };
            }
            
            const orderArgs = {
                side: Side.SELL,
                tokenID: request.tokenId,
                amount: sellAmount,
                price: currentPrice,
            };
            
            Logger.info(`Creating SELL order: ${sellAmount.toFixed(2)} tokens @ $${currentPrice.toFixed(4)}`);
            
            // THIS IS THE ONLY PLACE WHERE WE CALL createMarketOrder and postOrder
            const signedOrder = await ctx.clobClient.createMarketOrder(orderArgs);
            const resp = await ctx.clobClient.postOrder(signedOrder, OrderType.FOK);
            
            if (resp.success === true) {
                retry = 0;
                totalFilledTokens += sellAmount;
                totalFilledUsd += sellAmount * currentPrice;
                remaining -= sellAmount;
                lastOrderId = (resp as any).orderID || (resp as any).orderId;
                Logger.orderResult(true, `Sold ${sellAmount.toFixed(2)} tokens at $${currentPrice.toFixed(4)}`);
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(`Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`);
                    break;
                }
                retry++;
                Logger.warning(`Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`);
            }
        }
    }
    
    // Determine result
    if (abortDueToFunds) {
        return {
            success: false,
            executed: totalFilledTokens > 0,
            skipped: false,
            failed: true,
            reason: 'insufficient_funds_or_allowance',
            isRetryable: false,
            filledTokens: totalFilledTokens,
            filledSize: totalFilledUsd,
            avgFillPrice: totalFilledTokens > 0 ? totalFilledUsd / totalFilledTokens : undefined,
            orderId: lastOrderId,
            idempotencyKey,
        };
    }
    
    if (retry >= RETRY_LIMIT) {
        return {
            success: false,
            executed: totalFilledTokens > 0,
            skipped: false,
            failed: true,
            reason: 'max_retries_exceeded',
            isRetryable: true,
            filledTokens: totalFilledTokens,
            filledSize: totalFilledUsd,
            avgFillPrice: totalFilledTokens > 0 ? totalFilledUsd / totalFilledTokens : undefined,
            orderId: lastOrderId,
            idempotencyKey,
        };
    }
    
    return {
        success: true,
        executed: true,
        skipped: false,
        failed: false,
        filledTokens: totalFilledTokens,
        filledSize: totalFilledUsd,
        avgFillPrice: totalFilledTokens > 0 ? totalFilledUsd / totalFilledTokens : undefined,
        orderId: lastOrderId,
        idempotencyKey,
    };
}

// ============================================================================
// Convenience Wrappers
// ============================================================================

/**
 * Execute a guarded BUY order
 */
export async function executeBuyGuarded(
    clobClient: ClobClient,
    tokenId: string,
    amountUsd: number,
    options: {
        traderPrice?: number;
        endDate?: string;
        marketSlug?: string;
        tradeId?: mongoose.Types.ObjectId;
        tradeUsdcSize?: number;
        myPositionSize?: number;
        myPositionValue?: number;
    } = {}
): Promise<OrderResult> {
    return executeOrderGuarded(
        { clobClient },
        {
            side: 'BUY',
            tokenId,
            amount: amountUsd,
            ...options,
        }
    );
}

/**
 * Execute a guarded SELL order
 */
export async function executeSellGuarded(
    clobClient: ClobClient,
    tokenId: string,
    amountTokens: number,
    options: {
        endDate?: string;
        marketSlug?: string;
        tradeId?: mongoose.Types.ObjectId;
        myPositionSize?: number;
    } = {}
): Promise<OrderResult> {
    return executeOrderGuarded(
        { clobClient },
        {
            side: 'SELL',
            tokenId,
            amount: amountTokens,
            myPositionSize: options.myPositionSize ?? amountTokens, // Assume position exists
            ...options,
        }
    );
}

/**
 * Execute a guarded MERGE order (close entire position)
 */
export async function executeMergeGuarded(
    clobClient: ClobClient,
    tokenId: string,
    amountTokens: number,
    options: {
        endDate?: string;
        marketSlug?: string;
        tradeId?: mongoose.Types.ObjectId;
    } = {}
): Promise<OrderResult> {
    return executeOrderGuarded(
        { clobClient },
        {
            side: 'MERGE',
            tokenId,
            amount: amountTokens,
            myPositionSize: amountTokens,
            ...options,
        }
    );
}
