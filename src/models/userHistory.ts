import mongoose, { Schema } from 'mongoose';

const positionSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    proxyWallet: { type: String, required: false },
    asset: { type: String, required: false },
    conditionId: { type: String, required: false },
    size: { type: Number, required: false },
    avgPrice: { type: Number, required: false },
    initialValue: { type: Number, required: false },
    currentValue: { type: Number, required: false },
    cashPnl: { type: Number, required: false },
    percentPnl: { type: Number, required: false },
    totalBought: { type: Number, required: false },
    realizedPnl: { type: Number, required: false },
    percentRealizedPnl: { type: Number, required: false },
    curPrice: { type: Number, required: false },
    redeemable: { type: Boolean, required: false },
    mergeable: { type: Boolean, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    oppositeOutcome: { type: String, required: false },
    oppositeAsset: { type: String, required: false },
    endDate: { type: String, required: false },
    negativeRisk: { type: Boolean, required: false },
});

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

const activitySchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    proxyWallet: { type: String, required: false },
    timestamp: { type: Number, required: false },
    conditionId: { type: String, required: false },
    type: { type: String, required: false },
    size: { type: Number, required: false },
    usdcSize: { type: Number, required: false },
    transactionHash: { type: String, required: false },
    price: { type: Number, required: false },
    asset: { type: String, required: false },
    side: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    name: { type: String, required: false },
    pseudonym: { type: String, required: false },
    bio: { type: String, required: false },
    profileImage: { type: String, required: false },
    profileImageOptimized: { type: String, required: false },
    // Legacy fields (kept for backward compatibility)
    bot: { type: Boolean, required: false },
    botExcutedTime: { type: Number, required: false },
    myBoughtSize: { type: Number, required: false }, // Tracks actual tokens we bought
    // New lifecycle state fields
    lifecycleState: { type: String, required: false, default: 'detected' },
    skipReason: { type: String, required: false }, // Why trade was skipped
    failureReason: { type: String, required: false }, // Why trade failed
    retryCount: { type: Number, required: false, default: 0 },
    lastRetryAt: { type: Number, required: false }, // Timestamp of last retry
    claimedAt: { type: Number, required: false }, // When trade was claimed
    executedAt: { type: Number, required: false }, // When trade was executed
    expectedTokens: { type: Number, required: false }, // Expected tokens from order
    actualTokens: { type: Number, required: false }, // Actual tokens received
    // Idempotency and lease fields
    idempotencyKey: { type: String, required: false }, // Unique key to prevent duplicate execution
    clobOrderId: { type: String, required: false }, // Order ID from CLOB
    claimedBy: { type: String, required: false }, // Worker ID that claimed this trade
    leaseExpiresAt: { type: Number, required: false }, // Lease expiration timestamp
    // Fill tracking fields
    intendedSize: { type: Number, required: false }, // Size we intended to fill
    filledSize: { type: Number, required: false }, // USD amount actually filled
    avgFillPrice: { type: Number, required: false }, // Average fill price
    needsManualReview: { type: Boolean, required: false, default: false }, // Flag for ambiguous fills
});

const getUserPositionModel = (walletAddress: string) => {
    const collectionName = `user_positions_${walletAddress}`;
    return mongoose.model(collectionName, positionSchema, collectionName);
};

const getUserActivityModel = (walletAddress: string) => {
    const collectionName = `user_activities_${walletAddress}`;
    return mongoose.model(collectionName, activitySchema, collectionName);
};

export { getUserActivityModel, getUserPositionModel };
