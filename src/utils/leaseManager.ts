/**
 * Lease Manager - Worker coordination for copy trading
 *
 * Provides atomic lease acquisition to prevent duplicate trade execution
 * when multiple workers are processing the same trade queue.
 *
 * Uses MongoDB findOneAndUpdate for atomic operations.
 */

import mongoose from 'mongoose';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';

// Default lease timeout (30 seconds)
const DEFAULT_LEASE_TIMEOUT_MS = 30000;

// Generate unique worker ID
let workerId: string | null = null;
export function getWorkerId(): string {
    if (!workerId) {
        workerId = `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    return workerId;
}

/**
 * Attempt to acquire a lease on a trade for exclusive processing
 *
 * Uses atomic findOneAndUpdate to ensure only one worker can claim a trade.
 *
 * @param userAddress - The user's wallet address (for collection name)
 * @param tradeId - The trade's MongoDB _id
 * @param leaseTimeoutMs - How long the lease should be held (default 30s)
 * @returns true if lease acquired, false if already claimed by another worker
 */
export async function acquireLease(
    userAddress: string,
    tradeId: mongoose.Types.ObjectId,
    leaseTimeoutMs: number = DEFAULT_LEASE_TIMEOUT_MS
): Promise<boolean> {
    const UserActivity = getUserActivityModel(userAddress);
    const now = Date.now();
    const leaseExpiresAt = now + leaseTimeoutMs;
    const currentWorkerId = getWorkerId();

    try {
        // Atomic operation: claim trade only if:
        // 1. Not already claimed (claimedBy is null), OR
        // 2. Previous lease has expired (leaseExpiresAt < now)
        const result = await UserActivity.findOneAndUpdate(
            {
                _id: tradeId,
                $or: [
                    { claimedBy: { $exists: false } },
                    { claimedBy: null },
                    { leaseExpiresAt: { $lt: now } },
                ],
            },
            {
                $set: {
                    claimedBy: currentWorkerId,
                    leaseExpiresAt: leaseExpiresAt,
                    claimedAt: now,
                    lifecycleState: 'claimed',
                },
            },
            {
                new: true,
                upsert: false,
            }
        );

        if (result) {
            Logger.info(`Lease acquired for trade ${tradeId} by ${currentWorkerId}`);
            return true;
        }

        // Check if we already own the lease
        const existing = await UserActivity.findById(tradeId);
        if (existing?.claimedBy === currentWorkerId) {
            Logger.info(`Already own lease for trade ${tradeId}`);
            return true;
        }

        Logger.info(
            `Failed to acquire lease for trade ${tradeId} - already claimed by ${existing?.claimedBy}`
        );
        return false;
    } catch (error) {
        Logger.error(`Error acquiring lease for trade ${tradeId}: ${error}`);
        return false;
    }
}

/**
 * Release a lease after processing is complete
 *
 * @param userAddress - The user's wallet address (for collection name)
 * @param tradeId - The trade's MongoDB _id
 */
export async function releaseLease(
    userAddress: string,
    tradeId: mongoose.Types.ObjectId
): Promise<void> {
    const UserActivity = getUserActivityModel(userAddress);
    const currentWorkerId = getWorkerId();

    try {
        // Only release if we own the lease
        await UserActivity.updateOne(
            {
                _id: tradeId,
                claimedBy: currentWorkerId,
            },
            {
                $set: {
                    claimedBy: null,
                    leaseExpiresAt: null,
                },
            }
        );
        Logger.info(`Lease released for trade ${tradeId}`);
    } catch (error) {
        Logger.error(`Error releasing lease for trade ${tradeId}: ${error}`);
    }
}

/**
 * Extend lease timeout while processing is in progress
 *
 * Call this periodically during long-running operations to prevent
 * the lease from expiring while still processing.
 *
 * @param userAddress - The user's wallet address (for collection name)
 * @param tradeId - The trade's MongoDB _id
 * @param extensionMs - How much to extend the lease (default 30s)
 */
export async function extendLease(
    userAddress: string,
    tradeId: mongoose.Types.ObjectId,
    extensionMs: number = DEFAULT_LEASE_TIMEOUT_MS
): Promise<boolean> {
    const UserActivity = getUserActivityModel(userAddress);
    const currentWorkerId = getWorkerId();
    const newExpiry = Date.now() + extensionMs;

    try {
        const result = await UserActivity.updateOne(
            {
                _id: tradeId,
                claimedBy: currentWorkerId,
            },
            {
                $set: {
                    leaseExpiresAt: newExpiry,
                },
            }
        );

        return result.modifiedCount > 0;
    } catch (error) {
        Logger.error(`Error extending lease for trade ${tradeId}: ${error}`);
        return false;
    }
}

/**
 * Check if a trade has an active (non-expired) lease
 *
 * @param userAddress - The user's wallet address (for collection name)
 * @param tradeId - The trade's MongoDB _id
 */
export async function checkLeaseStatus(
    userAddress: string,
    tradeId: mongoose.Types.ObjectId
): Promise<{
    held: boolean;
    heldBy: string | null;
    expiresAt: number | null;
    expired: boolean;
    isOurs: boolean;
}> {
    const UserActivity = getUserActivityModel(userAddress);
    const currentWorkerId = getWorkerId();
    const now = Date.now();

    try {
        const trade = await UserActivity.findById(tradeId);

        if (!trade || !trade.claimedBy) {
            return {
                held: false,
                heldBy: null,
                expiresAt: null,
                expired: false,
                isOurs: false,
            };
        }

        const expired = trade.leaseExpiresAt ? trade.leaseExpiresAt < now : false;

        return {
            held: !expired,
            heldBy: trade.claimedBy || null,
            expiresAt: trade.leaseExpiresAt || null,
            expired,
            isOurs: trade.claimedBy === currentWorkerId,
        };
    } catch (error) {
        Logger.error(`Error checking lease status for trade ${tradeId}: ${error}`);
        return {
            held: false,
            heldBy: null,
            expiresAt: null,
            expired: false,
            isOurs: false,
        };
    }
}

/**
 * Clear all expired leases for a user's trades
 *
 * This is a maintenance function that can be run periodically to
 * clean up any stuck trades due to worker crashes.
 *
 * @param userAddress - The user's wallet address (for collection name)
 */
export async function clearExpiredLeases(userAddress: string): Promise<number> {
    const UserActivity = getUserActivityModel(userAddress);
    const now = Date.now();

    try {
        const result = await UserActivity.updateMany(
            {
                claimedBy: { $ne: null },
                leaseExpiresAt: { $lt: now },
                lifecycleState: 'claimed',
            },
            {
                $set: {
                    claimedBy: null,
                    leaseExpiresAt: null,
                    lifecycleState: 'detected', // Reset to detected for re-processing
                },
            }
        );

        if (result.modifiedCount > 0) {
            Logger.info(`Cleared ${result.modifiedCount} expired leases for user ${userAddress}`);
        }

        return result.modifiedCount;
    } catch (error) {
        Logger.error(`Error clearing expired leases: ${error}`);
        return 0;
    }
}

/**
 * Find trades that are stuck in 'executing' state with expired leases
 *
 * These may need manual review as they could be in an inconsistent state.
 *
 * @param userAddress - The user's wallet address (for collection name)
 */
export async function findStuckTrades(
    userAddress: string
): Promise<mongoose.Types.ObjectId[]> {
    const UserActivity = getUserActivityModel(userAddress);
    const now = Date.now();

    try {
        const stuckTrades = await UserActivity.find({
            lifecycleState: 'executing',
            leaseExpiresAt: { $lt: now },
        }).select('_id');

        return stuckTrades.map((t) => t._id as mongoose.Types.ObjectId);
    } catch (error) {
        Logger.error(`Error finding stuck trades: ${error}`);
        return [];
    }
}
