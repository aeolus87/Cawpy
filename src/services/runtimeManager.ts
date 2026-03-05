import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getConfig, updateConfig, type RuntimeConfig } from '../config/configProvider';
import { loadPersistedConfig, type PersistentConfig } from '../models/botConfig';
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
    activeTenantId: string | null;
    error: string | null;
}

interface TradingStatus {
    isRunning: boolean;
    startedAt: string | null;
    stoppedAt: string | null;
    startedBy: string | null;
    activeTenantId: string | null;
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
    activeTenantId: null,
    error: null,
};

let stopTradeMonitorRef: StopFn | null = null;
let stopTradeExecutorRef: StopFn | null = null;
let currentRunId = 0;

const normalizeTenantId = (tenantId: string): string => tenantId.trim();

const normalizeUserAddresses = (addresses: string[] | undefined): string[] => {
    if (!Array.isArray(addresses)) {
        return [];
    }

    return addresses
        .map((address) => (typeof address === 'string' ? address.trim().toLowerCase() : ''))
        .filter((address) => address.length > 0);
};

const errorToMessage = (error: unknown): string => {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
};

const buildRuntimeConfigFromTenant = (tenantConfig: Partial<PersistentConfig>): RuntimeConfig => {
    return {
        PROXY_WALLET: tenantConfig.proxyWallet || '',
        PRIVATE_KEY: tenantConfig.privateKey || '',
        USER_ADDRESSES: normalizeUserAddresses(tenantConfig.userAddresses),
        TRADE_MULTIPLIER: tenantConfig.tradeMultiplier ?? ENV.TRADE_MULTIPLIER,
        MAX_ORDER_SIZE_USD: tenantConfig.maxOrderSizeUsd ?? ENV.MAX_ORDER_SIZE_USD,
        MIN_ORDER_SIZE_USD: tenantConfig.minOrderSizeUsd ?? ENV.MIN_ORDER_SIZE_USD,
        FETCH_INTERVAL: tenantConfig.fetchInterval ?? ENV.FETCH_INTERVAL,
        RETRY_LIMIT: tenantConfig.retryLimit ?? ENV.RETRY_LIMIT,
        MAX_SLIPPAGE_BPS: tenantConfig.maxSlippageBps ?? ENV.MAX_SLIPPAGE_BPS,
        TOO_OLD_TIMESTAMP_HOURS: tenantConfig.tooOldTimestampHours ?? ENV.TOO_OLD_TIMESTAMP_HOURS,
        TRADE_AGGREGATION_ENABLED:
            tenantConfig.tradeAggregationEnabled ?? ENV.TRADE_AGGREGATION_ENABLED,
        TRADE_AGGREGATION_WINDOW_SECONDS:
            tenantConfig.tradeAggregationWindowSeconds ?? ENV.TRADE_AGGREGATION_WINDOW_SECONDS,
        ENABLE_TRADING: tenantConfig.enableTrading ?? ENV.ENABLE_TRADING,
        COPY_STRATEGY: tenantConfig.copyStrategy || ENV.COPY_STRATEGY,
        MONGO_URI: tenantConfig.mongoUri || ENV.MONGO_URI,
        RPC_URL: tenantConfig.rpcUrl || ENV.RPC_URL,
        CLOB_HTTP_URL: tenantConfig.clobHttpUrl || ENV.CLOB_HTTP_URL,
        CLOB_API_KEY: tenantConfig.clobApiKey || '',
        CLOB_SECRET: tenantConfig.clobSecret || '',
        CLOB_PASS_PHRASE: tenantConfig.clobPassPhrase || '',
    };
};

const loadTenantConfigIntoRuntime = async (tenantId: string): Promise<void> => {
    const tenantConfig = await loadPersistedConfig(tenantId);
    const runtimeConfig = buildRuntimeConfigFromTenant(tenantConfig);
    updateConfig(runtimeConfig);
};

const getPrerequisites = (): RuntimePrerequisites => {
    const config = getConfig();
    const traderAddresses = Array.isArray(config.USER_ADDRESSES) ? config.USER_ADDRESSES : [];
    const hasWallet = typeof config.PROXY_WALLET === 'string' && config.PROXY_WALLET.trim().length > 0;
    const hasPrivateKey = typeof config.PRIVATE_KEY === 'string' && config.PRIVATE_KEY.trim().length > 0;

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
    runtimeState.activeTenantId = null;
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
    startedBy: string,
    tenantId: string
): Promise<{ success: boolean; error?: string }> {
    const normalizedTenantId = normalizeTenantId(tenantId || '');
    if (!normalizedTenantId) {
        return { success: false, error: 'Tenant ID is required' };
    }

    if (runtimeState.isRunning) {
        if (runtimeState.activeTenantId && runtimeState.activeTenantId !== normalizedTenantId) {
            return { success: false, error: 'Trading bot is currently running for another user' };
        }
        return { success: false, error: 'Already running' };
    }

    try {
        await loadTenantConfigIntoRuntime(normalizedTenantId);
    } catch (error) {
        const message = errorToMessage(error);
        runtimeState.error = message;
        return { success: false, error: `Failed to load tenant config: ${message}` };
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
        runtimeState.activeTenantId = normalizedTenantId;
        runtimeState.error = null;

        currentRunId += 1;
        const runId = currentRunId;

        void tradeMonitor().catch((error) => {
            void markRuntimeFailure(runId, 'tradeMonitor', error);
        });

        void tradeExecutor(clobClient).catch((error) => {
            void markRuntimeFailure(runId, 'tradeExecutor', error);
        });

        Logger.info(`Trading runtime started by ${startedBy} for tenant ${normalizedTenantId}`);
        return { success: true };
    } catch (error) {
        const message = errorToMessage(error);
        runtimeState.isRunning = false;
        runtimeState.activeTenantId = null;
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
        runtimeState.activeTenantId = null;
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

export function getActiveTenantId(): string | null {
    return runtimeState.activeTenantId;
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
        activeTenantId: runtimeState.activeTenantId,
        uptime,
        error: runtimeState.error,
        prerequisites,
    };
}
