import mongoose from 'mongoose';

/**
 * Trade lifecycle states:
 * - detected: Trade found in API, not yet processed
 * - claimed: Trade claimed for processing (atomic lock)
 * - executing: Order being placed on CLOB
 * - executed: Order successfully filled
 * - skipped: Intentionally skipped (viability, slippage, etc.)
 * - failed: Failed after retries (infra error, retryable)
 * - reconciled: Position verified against expected
 */
export type TradeLifecycleState =
    | 'detected'
    | 'claimed'
    | 'executing'
    | 'executed'
    | 'skipped'
    | 'failed'
    | 'reconciled';

export interface UserActivityInterface {
    _id: mongoose.Types.ObjectId;
    proxyWallet: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: string;
    outcomeIndex: number;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    name: string;
    pseudonym: string;
    bio: string;
    profileImage: string;
    profileImageOptimized: string;
    // Legacy fields (kept for backward compatibility)
    bot: boolean;
    botExcutedTime: number;
    myBoughtSize?: number; // Tracks actual tokens we bought
    // New lifecycle state fields
    lifecycleState?: TradeLifecycleState;
    skipReason?: string;
    failureReason?: string;
    retryCount?: number;
    lastRetryAt?: number;
    claimedAt?: number;
    executedAt?: number;
    expectedTokens?: number;
    actualTokens?: number;
    // Idempotency and lease fields
    idempotencyKey?: string;
    clobOrderId?: string;
    claimedBy?: string;
    leaseExpiresAt?: number;
    // Fill tracking fields
    intendedSize?: number;
    filledSize?: number;
    avgFillPrice?: number;
    needsManualReview?: boolean;
}

export interface UserPositionInterface {
    _id: mongoose.Types.ObjectId;
    proxyWallet: string;
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    redeemable: boolean;
    mergeable: boolean;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    oppositeOutcome: string;
    oppositeAsset: string;
    endDate: string;
    negativeRisk: boolean;
}
