import mongoose from 'mongoose';
import { ENV } from '../config/env';
import Logger from '../utils/logger';

interface RuntimePrerequisites {
    hasWallet: boolean;
    hasPrivateKey: boolean;
    hasTraderAddresses: boolean;
    traderAddressCount: number;
    isDatabaseConnected: boolean;
}

interface RuntimeState {
    isRunning: boolean;
    startedAt: Date | null;
    stoppedAt: Date | null;
    startedBy: string | null;
    error: string | null;
}

interface TradingStatus {
    isRunning: boolean;
    startedAt: string | null;
    stoppedAt: string | null;
    startedBy: string | null;
    uptime: number | null;
    error: string | null;
    prerequisites: RuntimePrerequisites;
}

type StopFn = () => void;

const runtimeState: RuntimeState = {
    isRunning: false,
    startedAt: null,
    stoppedAt: null,
    startedBy: null,
    error: null,
};

let stopTradeMonitorRef: StopFn | null = null;
let stopTradeExecutorRef: StopFn | null = null;
let currentRunId = 0;

const errorToMessage = (error: unknown): string => {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
};

const getPrerequisites = (): RuntimePrerequisites => {
    const traderAddresses = Array.isArray(ENV.USER_ADDRESSES) ? ENV.USER_ADDRESSES : [];
    const hasWallet = typeof ENV.PROXY_WALLET === 'string' && ENV.PROXY_WALLET.trim().length > 0;
    const hasPrivateKey = typeof ENV.PRIVATE_KEY === 'string' && ENV.PRIVATE_KEY.trim().length > 0;

    return {
        hasWallet,
        hasPrivateKey,
        hasTraderAddresses: traderAddresses.length > 0,
        traderAddressCount: traderAddresses.length,
        isDatabaseConnected: mongoose.connection.readyState === 1,
    };
};

const markRuntimeFailure = async (runId: number, source: string, error: unknown): Promise<void> => {
    if (runId !== currentRunId) {
        return;
    }

    const message = `${source} failed: ${errorToMessage(error)}`;
    runtimeState.isRunning = false;
    runtimeState.error = message;
    runtimeState.stoppedAt = new Date();
    Logger.error(`Trading runtime failure: ${message}`);

    try {
        stopTradeMonitorRef?.();
        stopTradeExecutorRef?.();
    } catch (stopError) {
        Logger.error(`Failed to stop trading services after runtime error: ${errorToMessage(stopError)}`);
    }
};

export async function startTrading(
    startedBy: string
): Promise<{ success: boolean; error?: string }> {
    if (runtimeState.isRunning) {
        return { success: false, error: 'Already running' };
    }

    const prerequisites = getPrerequisites();
    if (!prerequisites.hasWallet) {
        return { success: false, error: 'Proxy wallet is not configured' };
    }
    if (!prerequisites.hasPrivateKey) {
        return { success: false, error: 'Private key is not configured' };
    }
    if (!prerequisites.hasTraderAddresses) {
        return { success: false, error: 'No trader addresses configured' };
    }
    if (!prerequisites.isDatabaseConnected) {
        return { success: false, error: 'Database is not connected' };
    }

    try {
        const { default: createClobClient } = await import('../utils/createClobClient');
        const clobClient = await createClobClient();

        const [{ default: tradeMonitor, stopTradeMonitor }, { default: tradeExecutor, stopTradeExecutor }] =
            await Promise.all([import('../services/tradeMonitor'), import('../services/tradeExecutor')]);

        stopTradeMonitorRef = stopTradeMonitor;
        stopTradeExecutorRef = stopTradeExecutor;

        runtimeState.isRunning = true;
        runtimeState.startedAt = new Date();
        runtimeState.stoppedAt = null;
        runtimeState.startedBy = startedBy;
        runtimeState.error = null;

        currentRunId += 1;
        const runId = currentRunId;

        void tradeMonitor().catch((error) => {
            void markRuntimeFailure(runId, 'tradeMonitor', error);
        });

        void tradeExecutor(clobClient).catch((error) => {
            void markRuntimeFailure(runId, 'tradeExecutor', error);
        });

        Logger.info(`Trading runtime started by ${startedBy}`);
        return { success: true };
    } catch (error) {
        const message = errorToMessage(error);
        runtimeState.isRunning = false;
        runtimeState.error = message;
        runtimeState.stoppedAt = new Date();
        Logger.error(`Failed to start trading runtime: ${message}`);
        return { success: false, error: message };
    }
}

export function stopTrading(): { success: boolean; error?: string } {
    if (!runtimeState.isRunning) {
        return { success: false, error: 'Not running' };
    }

    try {
        const { stopTradeMonitor } = require('./tradeMonitor') as typeof import('./tradeMonitor');
        const { stopTradeExecutor } = require('./tradeExecutor') as typeof import('./tradeExecutor');

        stopTradeMonitorRef = stopTradeMonitor;
        stopTradeExecutorRef = stopTradeExecutor;

        stopTradeMonitorRef();
        stopTradeExecutorRef();

        runtimeState.isRunning = false;
        runtimeState.stoppedAt = new Date();
        runtimeState.error = null;
        currentRunId += 1;

        Logger.info('Trading runtime stop requested');
        return { success: true };
    } catch (error) {
        const message = errorToMessage(error);
        runtimeState.error = message;
        Logger.error(`Failed to stop trading runtime: ${message}`);
        return { success: false, error: message };
    }
}

export function getTradingStatus(): TradingStatus {
    const prerequisites = getPrerequisites();
    const uptime =
        runtimeState.isRunning && runtimeState.startedAt
            ? Math.floor((Date.now() - runtimeState.startedAt.getTime()) / 1000)
            : null;

    return {
        isRunning: runtimeState.isRunning,
        startedAt: runtimeState.startedAt ? runtimeState.startedAt.toISOString() : null,
        stoppedAt: runtimeState.stoppedAt ? runtimeState.stoppedAt.toISOString() : null,
        startedBy: runtimeState.startedBy,
        uptime,
        error: runtimeState.error,
        prerequisites,
    };
}
