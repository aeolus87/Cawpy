import { ENV } from './env';
import Logger from '../utils/logger';

export type RuntimeConfig = {
    PROXY_WALLET: string;
    PRIVATE_KEY: string;
    USER_ADDRESSES: string[];
    TRADE_MULTIPLIER: number;
    MAX_ORDER_SIZE_USD: number;
    MIN_ORDER_SIZE_USD: number;
    FETCH_INTERVAL: number;
    RETRY_LIMIT: number;
    MAX_SLIPPAGE_BPS: number;
    TOO_OLD_TIMESTAMP_HOURS: number;
    TRADE_AGGREGATION_ENABLED: boolean;
    TRADE_AGGREGATION_WINDOW_SECONDS: number;
    ENABLE_TRADING: boolean;
    COPY_STRATEGY: string;
    MONGO_URI: string;
    RPC_URL: string;
    CLOB_HTTP_URL: string;
    CLOB_API_KEY: string;
    CLOB_SECRET: string;
    CLOB_PASS_PHRASE: string;
};

const runtimeConfig: RuntimeConfig = {
    PROXY_WALLET: ENV.PROXY_WALLET,
    PRIVATE_KEY: ENV.PRIVATE_KEY,
    USER_ADDRESSES: [...ENV.USER_ADDRESSES],
    TRADE_MULTIPLIER: ENV.TRADE_MULTIPLIER,
    MAX_ORDER_SIZE_USD: ENV.MAX_ORDER_SIZE_USD,
    MIN_ORDER_SIZE_USD: ENV.MIN_ORDER_SIZE_USD,
    FETCH_INTERVAL: ENV.FETCH_INTERVAL,
    RETRY_LIMIT: ENV.RETRY_LIMIT,
    MAX_SLIPPAGE_BPS: ENV.MAX_SLIPPAGE_BPS,
    TOO_OLD_TIMESTAMP_HOURS: ENV.TOO_OLD_TIMESTAMP_HOURS,
    TRADE_AGGREGATION_ENABLED: ENV.TRADE_AGGREGATION_ENABLED,
    TRADE_AGGREGATION_WINDOW_SECONDS: ENV.TRADE_AGGREGATION_WINDOW_SECONDS,
    ENABLE_TRADING: ENV.ENABLE_TRADING,
    COPY_STRATEGY: ENV.COPY_STRATEGY,
    MONGO_URI: ENV.MONGO_URI,
    RPC_URL: ENV.RPC_URL,
    CLOB_HTTP_URL: ENV.CLOB_HTTP_URL,
    CLOB_API_KEY: ENV.CLOB_API_KEY,
    CLOB_SECRET: ENV.CLOB_SECRET,
    CLOB_PASS_PHRASE: ENV.CLOB_PASS_PHRASE,
};

const areAddressesEqual = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
};

const applyProcessEnv = (key: keyof RuntimeConfig, value: RuntimeConfig[keyof RuntimeConfig]): void => {
    if (key === 'USER_ADDRESSES') {
        process.env.USER_ADDRESSES = (value as string[]).join(',');
        return;
    }

    if (typeof value === 'boolean') {
        process.env[key] = value ? 'true' : 'false';
        return;
    }

    process.env[key] = String(value);
};

const resetAddressBasedCaches = (): void => {
    try {
        const { resetUserModels } = require('../services/tradeMonitor') as typeof import('../services/tradeMonitor');
        if (typeof resetUserModels === 'function') {
            resetUserModels();
        }
    } catch (error) {
        Logger.warning(`Unable to reset trade monitor cache after USER_ADDRESSES update: ${error}`);
    }

    try {
        const { resetUserActivityModels } = require('../services/tradeExecutor') as typeof import('../services/tradeExecutor');
        if (typeof resetUserActivityModels === 'function') {
            resetUserActivityModels();
        }
    } catch (error) {
        Logger.warning(`Unable to reset trade executor cache after USER_ADDRESSES update: ${error}`);
    }
};

export const getConfig = (): RuntimeConfig => runtimeConfig;

export const updateConfig = (updates: Partial<RuntimeConfig>): RuntimeConfig => {
    const changedKeys: Array<keyof RuntimeConfig> = [];
    const previousAddresses = [...runtimeConfig.USER_ADDRESSES];

    (Object.keys(updates) as Array<keyof RuntimeConfig>).forEach((key) => {
        const value = updates[key];
        if (value === undefined) return;

        if (key === 'USER_ADDRESSES') {
            runtimeConfig.USER_ADDRESSES = [...(value as string[])];
        } else {
            (runtimeConfig as Record<string, unknown>)[key] = value;
        }

        applyProcessEnv(key, runtimeConfig[key]);
        changedKeys.push(key);
    });

    if (
        changedKeys.includes('USER_ADDRESSES') &&
        !areAddressesEqual(previousAddresses, runtimeConfig.USER_ADDRESSES)
    ) {
        resetAddressBasedCaches();
    }

    if (changedKeys.length > 0) {
        Logger.info(`Runtime config updated: ${changedKeys.join(', ')}`);
    }

    return runtimeConfig;
};
