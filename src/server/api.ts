/**
 * PolyCopy API Server
 *
 * REST API for frontend integration with copy trading bot functionality.
 * Includes authentication, rate limiting, and comprehensive endpoints.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerJsdoc from 'swagger-jsdoc';
import * as swaggerUi from 'swagger-ui-express';
import * as jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { getConfig, updateConfig as updateRuntimeConfig, type RuntimeConfig } from '../config/configProvider';
import connectDB from '../config/db';
import Logger from '../utils/logger';
import { getActiveTenantId, getTradingStatus, startTrading, stopTrading } from '../services/runtimeManager';
import {
    loadPersistedConfig,
    savePersistedConfig,
    type PersistentConfig,
} from '../models/botConfig';

// NOTE: Trading services (tradeExecutor, tradeMonitor, reconciliation) are
// loaded dynamically via await import() inside their endpoints to prevent
// their top-level code from executing in API-only mode.

// Import utilities
import fetchData from '../utils/fetchData';
import { authenticateToken, requireAdmin, AuthRequest } from '../utils/auth.middleware';
import { resolveTenantId } from '../utils/tenantResolver';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Configuration Persistence
// ============================================================================

const LOGS_DIR_PATH = path.join(process.cwd(), 'logs');
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

let dbConnectionAttempt: Promise<boolean> | null = null;

const toRuntimeConfigUpdates = (config: Partial<PersistentConfig>): Partial<RuntimeConfig> => {
    const updates: Partial<RuntimeConfig> = {};

    if (config.userAddresses) updates.USER_ADDRESSES = config.userAddresses;
    if (config.proxyWallet) updates.PROXY_WALLET = config.proxyWallet;
    if (config.privateKey) updates.PRIVATE_KEY = config.privateKey;
    if (config.tradeMultiplier !== undefined) updates.TRADE_MULTIPLIER = config.tradeMultiplier;
    if (config.maxOrderSizeUsd !== undefined) updates.MAX_ORDER_SIZE_USD = config.maxOrderSizeUsd;
    if (config.minOrderSizeUsd !== undefined) updates.MIN_ORDER_SIZE_USD = config.minOrderSizeUsd;
    if (config.fetchInterval !== undefined) updates.FETCH_INTERVAL = config.fetchInterval;
    if (config.retryLimit !== undefined) updates.RETRY_LIMIT = config.retryLimit;
    if (config.maxSlippageBps !== undefined) updates.MAX_SLIPPAGE_BPS = config.maxSlippageBps;
    if (config.tooOldTimestampHours !== undefined) {
        updates.TOO_OLD_TIMESTAMP_HOURS = config.tooOldTimestampHours;
    }
    if (config.tradeAggregationEnabled !== undefined) {
        updates.TRADE_AGGREGATION_ENABLED = config.tradeAggregationEnabled;
    }
    if (config.tradeAggregationWindowSeconds !== undefined) {
        updates.TRADE_AGGREGATION_WINDOW_SECONDS = config.tradeAggregationWindowSeconds;
    }
    if (config.enableTrading !== undefined) updates.ENABLE_TRADING = config.enableTrading;
    if (config.copyStrategy) updates.COPY_STRATEGY = config.copyStrategy;
    if (config.mongoUri) updates.MONGO_URI = config.mongoUri;
    if (config.rpcUrl) updates.RPC_URL = config.rpcUrl;
    if (config.clobHttpUrl) updates.CLOB_HTTP_URL = config.clobHttpUrl;
    if (config.clobApiKey) updates.CLOB_API_KEY = config.clobApiKey;
    if (config.clobSecret) updates.CLOB_SECRET = config.clobSecret;
    if (config.clobPassPhrase) updates.CLOB_PASS_PHRASE = config.clobPassPhrase;

    return updates;
};

const updateProcessEnvFromConfig = (config: Partial<PersistentConfig>): void => {
    if (config.userAddresses) process.env.USER_ADDRESSES = config.userAddresses.join(',');
    if (config.proxyWallet) process.env.PROXY_WALLET = config.proxyWallet;
    if (config.privateKey) process.env.PRIVATE_KEY = config.privateKey;
    if (config.clobApiKey) process.env.CLOB_API_KEY = config.clobApiKey;
    if (config.clobSecret) process.env.CLOB_SECRET = config.clobSecret;
    if (config.clobPassPhrase) process.env.CLOB_PASS_PHRASE = config.clobPassPhrase;
    if (config.tradeMultiplier !== undefined) process.env.TRADE_MULTIPLIER = config.tradeMultiplier.toString();
    if (config.maxOrderSizeUsd !== undefined) process.env.MAX_ORDER_SIZE_USD = config.maxOrderSizeUsd.toString();
    if (config.minOrderSizeUsd !== undefined) process.env.MIN_ORDER_SIZE_USD = config.minOrderSizeUsd.toString();
    if (config.fetchInterval !== undefined) process.env.FETCH_INTERVAL = config.fetchInterval.toString();
    if (config.retryLimit !== undefined) process.env.RETRY_LIMIT = config.retryLimit.toString();
    if (config.maxSlippageBps !== undefined) process.env.MAX_SLIPPAGE_BPS = config.maxSlippageBps.toString();
    if (config.tooOldTimestampHours !== undefined) {
        process.env.TOO_OLD_TIMESTAMP_HOURS = config.tooOldTimestampHours.toString();
    }
    if (config.tradeAggregationEnabled !== undefined) {
        process.env.TRADE_AGGREGATION_ENABLED = config.tradeAggregationEnabled.toString();
    }
    if (config.tradeAggregationWindowSeconds !== undefined) {
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS = config.tradeAggregationWindowSeconds.toString();
    }
    if (config.mongoUri) process.env.MONGO_URI = config.mongoUri;
    if (config.rpcUrl) process.env.RPC_URL = config.rpcUrl;
    if (config.clobHttpUrl) process.env.CLOB_HTTP_URL = config.clobHttpUrl;
    if (config.clobWsUrl) process.env.CLOB_WS_URL = config.clobWsUrl;
    if (config.usdcContractAddress) process.env.USDC_CONTRACT_ADDRESS = config.usdcContractAddress;
    if (config.enableApi !== undefined) process.env.ENABLE_API = config.enableApi.toString();
    if (config.apiPort !== undefined) process.env.API_PORT = config.apiPort.toString();
    if (config.apiHost) process.env.API_HOST = config.apiHost;
    if (config.jwtSecret) process.env.JWT_SECRET = config.jwtSecret;
    if (config.corsOrigin) process.env.CORS_ORIGIN = config.corsOrigin;
    if (config.enableTrading !== undefined) process.env.ENABLE_TRADING = config.enableTrading.toString();
    if (config.copyStrategy) process.env.COPY_STRATEGY = config.copyStrategy;
};

const updateEnvironmentFromConfig = async (
    tenantId: string,
    overrides: Partial<PersistentConfig> = {}
): Promise<Partial<PersistentConfig>> => {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
        return {};
    }

    const persistedConfig = await loadPersistedConfig(normalizedTenantId);
    const mergedConfig = { ...persistedConfig, ...overrides };

    if (getActiveTenantId() === normalizedTenantId) {
        updateProcessEnvFromConfig(mergedConfig);

        const runtimeUpdates = toRuntimeConfigUpdates(mergedConfig);
        if (Object.keys(runtimeUpdates).length > 0) {
            updateRuntimeConfig(runtimeUpdates);
        }
    }

    return mergedConfig;
};

// ============================================================================
// Types & Interfaces
// ============================================================================

type LogLevel = 'info' | 'success' | 'warning' | 'error';
type LogCategory = 'configuration' | 'trading' | 'database' | 'authentication' | 'system';

interface ParsedLogEntry {
    timestamp: string;
    level: LogLevel;
    category: LogCategory;
    message: string;
    actor?: string;
    raw: string;
}

interface PolymarketTraderProfile {
    boundAddress: string;
    canonicalProxyWallet: string;
    displayName: string;
    name: string | null;
    pseudonym: string | null;
    bio: string | null;
    verifiedBadge: boolean;
    profileImage: string | null;
    profileUrl: string;
}

interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: number;
}

const normalizeAddress = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ETH_ADDRESS_REGEX.test(trimmed) ? trimmed.toLowerCase() : null;
};

const maskAddress = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;

const getRequesterIdentity = (req: AuthRequest): string => {
    const normalizedAddress = normalizeAddress(req.user?.address);
    if (normalizedAddress) return normalizedAddress;
    if (req.user?.moniqoId) return `moniqo:${req.user.moniqoId}`;
    if (req.user?.email) return `email:${req.user.email}`;
    return 'unknown';
};

const getConfiguredUserAddresses = async (tenantId: string): Promise<string[]> => {
    const persistedConfig = await loadPersistedConfig(tenantId);

    const persistedAddresses = Array.isArray(persistedConfig.userAddresses)
        ? persistedConfig.userAddresses
              .map((address) => normalizeAddress(address))
              .filter((address): address is string => !!address)
        : [];

    if (persistedAddresses.length > 0) {
        return Array.from(new Set(persistedAddresses));
    }

    if (getActiveTenantId() === tenantId) {
        return Array.from(
            new Set(
                (getConfig().USER_ADDRESSES || [])
                    .map((address) => normalizeAddress(address))
                    .filter((address): address is string => !!address)
            )
        );
    }

    return [];
};

const resolveRequestTenantId = (req: AuthRequest, res: Response): string | null => {
    const tenantId = resolveTenantId(req.user);
    if (tenantId) {
        return tenantId;
    }

    res.status(400).json({
        success: false,
        error: 'Unable to resolve user identity',
        timestamp: Date.now(),
    } as ApiResponse);
    return null;
};

const waitForDbConnection = async (timeoutMs = 5000): Promise<boolean> => {
    const start = Date.now();
    while (mongoose.connection.readyState === 2 && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return mongoose.connection.readyState === 1;
};

const ensureDatabaseConnection = async (): Promise<boolean> => {
    if (mongoose.connection.readyState === 1) {
        return true;
    }

    if (mongoose.connection.readyState === 2) {
        return waitForDbConnection();
    }

    if (!dbConnectionAttempt) {
        dbConnectionAttempt = connectDB()
            .then((connected) => connected === true)
            .catch((error) => {
                Logger.error(`Database connection error: ${error}`);
                return false;
            })
            .finally(() => {
                dbConnectionAttempt = null;
            });
    }

    return dbConnectionAttempt;
};

const parseLogLevel = (prefix: string, message: string): LogLevel => {
    const upperPrefix = prefix.toUpperCase();
    if (upperPrefix.includes('ERROR') || upperPrefix.includes('FAILED')) return 'error';
    if (upperPrefix.includes('WARNING')) return 'warning';
    if (upperPrefix.includes('SUCCESS')) return 'success';
    if (message.toLowerCase().includes('error')) return 'error';
    return 'info';
};

const parseLogCategory = (message: string): LogCategory => {
    const lowered = message.toLowerCase();
    if (
        lowered.includes('config') ||
        lowered.includes('wallet credentials') ||
        lowered.includes('api credentials')
    ) {
        return 'configuration';
    }
    if (lowered.includes('trade') || lowered.includes('order') || lowered.includes('trader')) {
        return 'trading';
    }
    if (lowered.includes('mongo') || lowered.includes('database') || lowered.includes('mongoose')) {
        return 'database';
    }
    if (lowered.includes('auth') || lowered.includes('token') || lowered.includes('login')) {
        return 'authentication';
    }
    return 'system';
};

const extractActorFromMessage = (message: string): string | undefined => {
    const byMatch = message.match(/\bby\s+([^\s]+)$/i);
    if (byMatch?.[1]) return byMatch[1];
    const moniqoMatch = message.match(/\bmoniqo[-\w:]+/i);
    if (moniqoMatch?.[0]) return moniqoMatch[0];
    return undefined;
};

const parseLogLine = (line: string): ParsedLogEntry | null => {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const lineMatch = trimmed.match(/^\[([^\]]+)\]\s(.+)$/);
    if (!lineMatch) return null;

    const timestamp = lineMatch[1];
    const payload = lineMatch[2];
    const payloadMatch = payload.match(/^([A-Z ]+):\s(.*)$/);
    const prefix = payloadMatch?.[1]?.trim() || 'INFO';
    const message = payloadMatch?.[2]?.trim() || payload;
    const level = parseLogLevel(prefix, message);

    return {
        timestamp,
        level,
        category: parseLogCategory(message),
        message,
        actor: extractActorFromMessage(message),
        raw: trimmed
    };
};

const readRecentLogEntries = (limit: number): ParsedLogEntry[] => {
    if (!fs.existsSync(LOGS_DIR_PATH)) {
        return [];
    }

    const files = fs
        .readdirSync(LOGS_DIR_PATH)
        .filter((name) => name.startsWith('bot-') && name.endsWith('.log'))
        .sort((a, b) => b.localeCompare(a));

    const collectedLines: string[] = [];

    for (const fileName of files) {
        const filePath = path.join(LOGS_DIR_PATH, fileName);
        const fileLines = fs
            .readFileSync(filePath, 'utf8')
            .split('\n')
            .filter(Boolean);

        for (let index = fileLines.length - 1; index >= 0 && collectedLines.length < limit; index--) {
            collectedLines.push(fileLines[index]);
        }

        if (collectedLines.length >= limit) break;
    }

    return collectedLines
        .reverse()
        .map((line) => parseLogLine(line))
        .filter((entry): entry is ParsedLogEntry => !!entry);
};

const mapPolymarketProfile = (profile: any, boundAddress: string): PolymarketTraderProfile => {
    const proxyWallet =
        normalizeAddress(profile?.proxyWallet) ||
        normalizeAddress(profile?.address) ||
        boundAddress;
    const displayName =
        (typeof profile?.name === 'string' && profile.name.trim()) ||
        (typeof profile?.pseudonym === 'string' && profile.pseudonym.trim()) ||
        maskAddress(proxyWallet);

    return {
        boundAddress,
        canonicalProxyWallet: proxyWallet,
        displayName,
        name: typeof profile?.name === 'string' ? profile.name : null,
        pseudonym: typeof profile?.pseudonym === 'string' ? profile.pseudonym : null,
        bio: typeof profile?.bio === 'string' ? profile.bio : null,
        verifiedBadge: Boolean(profile?.verifiedBadge),
        profileImage:
            (typeof profile?.profileImageOptimized === 'string' && profile.profileImageOptimized) ||
            (typeof profile?.profileImage === 'string' && profile.profileImage) ||
            null,
        profileUrl: `https://polymarket.com/profile/${proxyWallet}`
    };
};

const fetchPolymarketTraderProfile = async (address: string): Promise<PolymarketTraderProfile> => {
    const fallback = mapPolymarketProfile({}, address);
    const endpoints = [
        `https://gamma-api.polymarket.com/public-profile?address=${address}`,
        `https://gamma-api.polymarket.com/public-profile?wallet_address=${address}`
    ];

    for (const endpoint of endpoints) {
        try {
            const profile = await fetchData(endpoint);
            if (profile && typeof profile === 'object') {
                return mapPolymarketProfile(profile, address);
            }
        } catch (error) {
            continue;
        }
    }

    return fallback;
};

// ============================================================================
// Rate Limiting
// ============================================================================

const limiter = rateLimit({
    windowMs: ENV.API_RATE_LIMIT_WINDOW_MS,
    max: ENV.API_RATE_LIMIT_MAX_REQUESTS,
    message: {
        success: false,
        error: 'Too many requests, please try again later',
        timestamp: Date.now()
    } as ApiResponse,
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================================================
// API Server Setup
// ============================================================================

const app = express();

// Trust proxy for Render/reverse proxy deployments (fixes rate limiter X-Forwarded-For error)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors({
    origin: true, // Allow all origins for Moniqo integration
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api/', limiter);

// Attempt DB connection early so analytics endpoints are ready for FE usage.
void ensureDatabaseConnection().then((connected) => {
    if (connected) {
        Logger.info('MongoDB connection ready for API analytics routes');
    } else {
        Logger.warning(
            'MongoDB is not connected. Trade history endpoints will return 503 until MONGO_URI is configured'
        );
    }
});

// ============================================================================
// Swagger Documentation
// ============================================================================

if (ENV.ENABLE_API_DOCS) {
    const swaggerOptions = {
        definition: {
            openapi: '3.0.0',
            info: {
                title: 'PolyCopy API',
                version: '1.0.0',
                description: 'REST API for Polymarket Copy Trading Bot',
            },
            servers: [
                {
                    url: `http://${ENV.API_HOST}:${ENV.API_PORT}/api`,
                    description: 'Development server',
                },
            ],
            components: {
                securitySchemes: {
                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                },
            },
            security: [
                {
                    bearerAuth: [],
                },
            ],
        },
        apis: ['./src/server/routes/*.ts', './src/server/api.ts'],
    };

    const swaggerSpec = swaggerJsdoc(swaggerOptions);
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Service is healthy
 */
app.get('/health', (req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        },
        timestamp: Date.now()
    } as ApiResponse);
});

// ============================================================================
// Authentication Routes
// ============================================================================

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate and get JWT token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *                 description: Ethereum wallet address
 *               signature:
 *                 type: string
 *                 description: Signed message for authentication
 *             required:
 *               - address
 *               - signature
 *     responses:
 *       200:
 *         description: Authentication successful
 */
app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
        const { address, signature, moniqoToken, moniqoId, email } = req.body;
        const normalizedAddress = normalizeAddress(address);
        const tenantId = resolveTenantId({
            moniqoId: typeof moniqoId === 'string' ? moniqoId : undefined,
            address: normalizedAddress || (typeof address === 'string' ? address : undefined),
        } as AuthRequest['user']);

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                error: 'Unable to resolve user identity',
                timestamp: Date.now(),
            } as ApiResponse);
        }

        const persistedConfig = await loadPersistedConfig(tenantId);
        const hasTenantConfig = Object.keys(persistedConfig).length > 0;
        const persistedRole =
            typeof persistedConfig.role === 'string' && persistedConfig.role.trim().length > 0
                ? persistedConfig.role.trim()
                : null;
        const resolvedRole = persistedRole || (hasTenantConfig ? 'user' : 'admin');

        let userData: Record<string, unknown> = {};

        // Method 1: Traditional wallet signature (for direct Polycopy users)
        if (address && signature) {
            // TODO: Implement proper wallet signature verification
            // For now, accept any address
            userData = {
                address: normalizedAddress || String(address).toLowerCase(),
                role: resolvedRole,
            };
        }
        // Method 2: Moniqo token exchange (for Moniqo-integrated users)
        else if (moniqoToken || moniqoId) {
            // Accept Moniqo authentication
            userData = {
                moniqoId: moniqoId,
                email: email,
                address: normalizedAddress || address, // Optional wallet address from Moniqo
                role: resolvedRole,
            };
        } else {
            return res.status(400).json({
                success: false,
                error: 'Either wallet signature (address + signature) or Moniqo token required',
                timestamp: Date.now()
            });
        }

        if (!hasTenantConfig) {
            const bootstrapConfig: Partial<PersistentConfig> = {
                role: 'admin',
            };

            const normalizedMoniqoId = typeof moniqoId === 'string' ? moniqoId.trim() : '';
            if (normalizedMoniqoId) {
                bootstrapConfig.moniqoId = normalizedMoniqoId;
            }
            if (typeof email === 'string' && email.trim().length > 0) {
                bootstrapConfig.email = email.trim();
            }

            await savePersistedConfig(tenantId, bootstrapConfig, `auth-bootstrap-${tenantId}`);
            await updateEnvironmentFromConfig(tenantId, bootstrapConfig);
            userData.role = 'admin';
        }

        // Generate Polycopy JWT token
        const token = jwt.sign(userData, ENV.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            success: true,
            data: {
                token,
                user: userData,
                integration: moniqoId ? 'moniqo' : 'direct'
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Auth error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Authentication failed',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Trading Control Routes
// ============================================================================

/**
 * @swagger
 * /api/trading/status:
 *   get:
 *     summary: Get trading bot status
 *     responses:
 *       200:
 *         description: Trading status
 */
app.get('/api/trading/status', authenticateToken, (req: AuthRequest, res: Response) => {
    const status = getTradingStatus();
    res.json({
        success: true,
        data: {
            ...status,
            activeTenantId: status.activeTenantId ?? null,
        },
        timestamp: Date.now()
    } as ApiResponse);
});

/**
 * @swagger
 * /api/trading/start:
 *   post:
 *     summary: Start the trading bot
 *     responses:
 *       200:
 *         description: Bot started successfully
 */
app.post('/api/trading/start', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const result = await startTrading(`api:${getRequesterIdentity(req)}`, tenantId);
        if (!result.success) {
            const mappedError =
                result.error === 'Trading bot is currently running for another user'
                    ? 'Trading bot is currently running for another user. Stop it first.'
                    : result.error || 'Failed to start trading';
            return res.status(400).json({
                success: false,
                error: mappedError,
                timestamp: Date.now()
            } as ApiResponse);
        }

        Logger.info(`Trading bot start requested via API by ${getRequesterIdentity(req)}`);

        res.json({
            success: true,
            data: { status: 'started' },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Start trading error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to start trading',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/trading/stop:
 *   post:
 *     summary: Stop the trading bot
 *     responses:
 *       200:
 *         description: Bot stopped successfully
 */
app.post('/api/trading/stop', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const status = getTradingStatus();
        const isAdmin = req.user?.role === 'admin';
        if (
            status.isRunning &&
            status.activeTenantId &&
            status.activeTenantId !== tenantId &&
            !isAdmin
        ) {
            return res.status(403).json({
                success: false,
                error: 'Only the user who started trading or an admin can stop it.',
                timestamp: Date.now(),
            } as ApiResponse);
        }

        const result = stopTrading();
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Failed to stop trading',
                timestamp: Date.now()
            } as ApiResponse);
        }

        Logger.info(`Trading bot stop requested via API by ${getRequesterIdentity(req)}`);

        res.json({
            success: true,
            data: { status: 'stopped' },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Stop trading error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to stop trading',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Position Management Routes
// ============================================================================

/**
 * @swagger
 * /api/positions:
 *   get:
 *     summary: Get current positions
 *     responses:
 *       200:
 *         description: List of positions
 */
app.get('/api/positions', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const persistedConfig = await loadPersistedConfig(tenantId);
        const wallet =
            persistedConfig.proxyWallet ||
            (getActiveTenantId() === tenantId ? getConfig().PROXY_WALLET : '');

        if (!wallet) {
            return res.json({
                success: true,
                data: [],
                message: 'No wallet configured. Set up your wallet via /api/config/wallet',
                timestamp: Date.now()
            } as ApiResponse);
        }

        const positionsUrl = `https://data-api.polymarket.com/positions?user=${wallet}`;
        const positions = await fetchData(positionsUrl);

        res.json({
            success: true,
            data: positions,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get positions error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch positions',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/positions/close:
 *   post:
 *     summary: Close specific positions
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               assetIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of asset IDs to close
 *             required:
 *               - assetIds
 *     responses:
 *       200:
 *         description: Positions closed successfully
 */
app.post('/api/positions/close', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const { assetIds } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'assetIds array is required',
                timestamp: Date.now()
            } as ApiResponse);
        }

        // TODO: Implement position closing logic
        Logger.info(`Closing positions via API: ${assetIds.join(', ')}`);

        res.json({
            success: true,
            data: {
                message: 'Position closing initiated',
                assetIds
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Close positions error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to close positions',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Analytics Routes
// ============================================================================

/**
 * @swagger
 * /api/analytics/performance:
 *   get:
 *     summary: Get performance analytics
 *     responses:
 *       200:
 *         description: Performance metrics
 */
app.get('/api/analytics/performance', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        // TODO: Implement performance analytics
        res.json({
            success: true,
            data: {
                totalPnL: 0,
                winRate: 0,
                totalTrades: 0,
                activePositions: 0
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Performance analytics error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/analytics/trades:
 *   get:
 *     summary: Get trade history
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of trades to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *     responses:
 *       200:
 *         description: Trade history
 */
app.get('/api/analytics/trades', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const parsedLimit = parseInt(req.query.limit as string, 10);
        const parsedOffset = parseInt(req.query.offset as string, 10);
        const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;
        const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

        // Get trades from all configured users
        const allTrades: any[] = [];
        const addresses = await getConfiguredUserAddresses(tenantId);

        if (addresses.length === 0) {
            return res.json({
                success: true,
                data: { trades: [], count: 0, offset, limit },
                message: 'No trader addresses configured. Add traders via /api/config/user-addresses',
                timestamp: Date.now()
            } as ApiResponse);
        }

        const dbConnected = await ensureDatabaseConnection();
        if (!dbConnected) {
            return res.status(503).json({
                success: false,
                error: 'Trade history is temporarily unavailable because MongoDB is not connected',
                data: {
                    hint: 'Set a valid MONGO_URI and restart API, then retry /api/analytics/trades',
                    mongoReadyState: mongoose.connection.readyState
                },
                timestamp: Date.now()
            } as ApiResponse);
        }

        const { getUserActivityModel } = await import('../models/userHistory');
        const failedAddresses: string[] = [];

        const perAddressTrades = await Promise.all(
            addresses.map(async (address) => {
                try {
                    const UserActivity = getUserActivityModel(address);
                    const trades = await UserActivity.find()
                        .sort({ timestamp: -1 })
                        .limit(limit)
                        .skip(offset)
                        .lean()
                        .exec();

                    return trades.map((trade: any) => {
                        const canonicalProxyWallet = normalizeAddress(trade?.proxyWallet) || address;
                        const displayName =
                            (typeof trade?.name === 'string' && trade.name.trim()) ||
                            (typeof trade?.pseudonym === 'string' && trade.pseudonym.trim()) ||
                            maskAddress(canonicalProxyWallet);

                        return {
                            ...trade,
                            userAddress: address,
                            trader: {
                                boundAddress: address,
                                canonicalProxyWallet,
                                displayName,
                                name: typeof trade?.name === 'string' ? trade.name : null,
                                pseudonym: typeof trade?.pseudonym === 'string' ? trade.pseudonym : null,
                                profileUrl: `https://polymarket.com/profile/${canonicalProxyWallet}`
                            }
                        };
                    });
                } catch (error) {
                    failedAddresses.push(address);
                    Logger.warning(`Trade history query failed for ${address}: ${error}`);
                    return [];
                }
            })
        );

        allTrades.push(...perAddressTrades.flat());

        // Sort by timestamp and limit
        allTrades.sort((a, b) => b.timestamp - a.timestamp);
        const limitedTrades = allTrades.slice(0, limit);

        res.json({
            success: true,
            data: {
                trades: limitedTrades,
                count: limitedTrades.length,
                offset,
                limit,
                failedAddresses
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Trade history error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch trade history',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.get('/api/analytics/traders', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const addresses = await getConfiguredUserAddresses(tenantId);

        if (addresses.length === 0) {
            return res.json({
                success: true,
                data: { traders: [], count: 0 },
                message: 'No trader addresses configured. Add traders via /api/config/user-addresses',
                timestamp: Date.now()
            } as ApiResponse);
        }

        const traders = await Promise.all(
            addresses.map(async (address) => fetchPolymarketTraderProfile(address))
        );

        res.json({
            success: true,
            data: {
                traders,
                count: traders.length
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Trader identity lookup error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to resolve trader identities',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.get('/api/system/logs', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const parsedLimit = parseInt(req.query.limit as string, 10);
        const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 100;
        const levelFilter = typeof req.query.level === 'string' ? req.query.level.toLowerCase() : '';
        const categoryFilter = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : '';
        const rawEntries = readRecentLogEntries(Math.min(limit * 5, 2000));

        const filteredEntries = rawEntries.filter((entry) => {
            const levelMatches = !levelFilter || entry.level === levelFilter;
            const categoryMatches = !categoryFilter || entry.category === categoryFilter;
            return levelMatches && categoryMatches;
        });

        const logs = filteredEntries.slice(-limit);
        const byLevel = {
            info: logs.filter((entry) => entry.level === 'info').length,
            success: logs.filter((entry) => entry.level === 'success').length,
            warning: logs.filter((entry) => entry.level === 'warning').length,
            error: logs.filter((entry) => entry.level === 'error').length
        };
        const byCategory = {
            configuration: logs.filter((entry) => entry.category === 'configuration').length,
            trading: logs.filter((entry) => entry.category === 'trading').length,
            database: logs.filter((entry) => entry.category === 'database').length,
            authentication: logs.filter((entry) => entry.category === 'authentication').length,
            system: logs.filter((entry) => entry.category === 'system').length
        };

        res.json({
            success: true,
            data: {
                logs,
                summary: {
                    total: logs.length,
                    byLevel,
                    byCategory,
                    latestTimestamp: logs.length > 0 ? logs[logs.length - 1].timestamp : null
                }
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`System logs endpoint error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to read system logs',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Reconciliation Routes
// ============================================================================

/**
 * @swagger
 * /api/reconciliation/run:
 *   post:
 *     summary: Run position reconciliation
 *     responses:
 *       200:
 *         description: Reconciliation completed
 */
app.post('/api/reconciliation/run', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const { runReconciliation } = await import('../services/reconciliation');
        const result = await runReconciliation();

        res.json({
            success: true,
            data: result,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Reconciliation error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Reconciliation failed',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Configuration Management (CRUD)
// ============================================================================

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Get current bot configuration (safe fields only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Configuration retrieved successfully
 */
app.get('/api/config', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        // Load current persisted configuration
        const persistedConfig = await loadPersistedConfig(tenantId);
        const isActiveTenant = getActiveTenantId() === tenantId;
        const runtimeConfig = isActiveTenant ? getConfig() : null;
        const configuredAddresses = await getConfiguredUserAddresses(tenantId);

        const walletSource = persistedConfig.proxyWallet || (runtimeConfig?.PROXY_WALLET || '');
        const hasPrivateKey = !!(persistedConfig.privateKey || (runtimeConfig?.PRIVATE_KEY || ''));
        const hasApiKeys = !!(
            persistedConfig.clobApiKey ||
            ((runtimeConfig?.CLOB_API_KEY || '') &&
                (runtimeConfig?.CLOB_SECRET || '') &&
                (runtimeConfig?.CLOB_PASS_PHRASE || ''))
        );

        // Return safe configuration (exclude sensitive data)
        const safeConfig = {
            // User addresses
            userAddresses: configuredAddresses,

            // Trading settings
            tradeMultiplier:
                persistedConfig.tradeMultiplier ?? runtimeConfig?.TRADE_MULTIPLIER ?? ENV.TRADE_MULTIPLIER,
            maxOrderSizeUsd:
                persistedConfig.maxOrderSizeUsd ??
                runtimeConfig?.MAX_ORDER_SIZE_USD ??
                ENV.MAX_ORDER_SIZE_USD,
            minOrderSizeUsd:
                persistedConfig.minOrderSizeUsd ??
                runtimeConfig?.MIN_ORDER_SIZE_USD ??
                ENV.MIN_ORDER_SIZE_USD,
            fetchInterval: persistedConfig.fetchInterval ?? runtimeConfig?.FETCH_INTERVAL ?? ENV.FETCH_INTERVAL,
            retryLimit: persistedConfig.retryLimit ?? runtimeConfig?.RETRY_LIMIT ?? ENV.RETRY_LIMIT,
            tooOldTimestampHours:
                persistedConfig.tooOldTimestampHours ??
                runtimeConfig?.TOO_OLD_TIMESTAMP_HOURS ??
                ENV.TOO_OLD_TIMESTAMP_HOURS,

            // Risk management
            maxSlippageBps:
                persistedConfig.maxSlippageBps ?? runtimeConfig?.MAX_SLIPPAGE_BPS ?? ENV.MAX_SLIPPAGE_BPS,
            tradeAggregationEnabled:
                persistedConfig.tradeAggregationEnabled ??
                runtimeConfig?.TRADE_AGGREGATION_ENABLED ??
                ENV.TRADE_AGGREGATION_ENABLED,
            tradeAggregationWindowSeconds:
                persistedConfig.tradeAggregationWindowSeconds ??
                runtimeConfig?.TRADE_AGGREGATION_WINDOW_SECONDS ??
                ENV.TRADE_AGGREGATION_WINDOW_SECONDS,

            // API settings
            enableApi: persistedConfig.enableApi ?? ENV.ENABLE_API,
            apiPort: persistedConfig.apiPort || ENV.API_PORT,
            apiHost: persistedConfig.apiHost || ENV.API_HOST,
            corsOrigin: persistedConfig.corsOrigin || ENV.CORS_ORIGIN,

            // Bot status
            enabled: persistedConfig.enableTrading ?? runtimeConfig?.ENABLE_TRADING ?? ENV.ENABLE_TRADING,
            copyStrategy: persistedConfig.copyStrategy || runtimeConfig?.COPY_STRATEGY || ENV.COPY_STRATEGY,

            // Network settings
            rpcUrl: persistedConfig.rpcUrl || runtimeConfig?.RPC_URL || ENV.RPC_URL,
            clobHttpUrl: persistedConfig.clobHttpUrl || runtimeConfig?.CLOB_HTTP_URL || ENV.CLOB_HTTP_URL,
            usdcContractAddress: persistedConfig.usdcContractAddress || ENV.USDC_CONTRACT_ADDRESS,

            // Wallet info (mask sensitive data)
            proxyWallet: walletSource ? `${walletSource.slice(0, 6)}...${walletSource.slice(-4)}` : null,
            hasPrivateKey,
            hasApiKeys,

            // Metadata
            lastUpdated: persistedConfig.lastUpdated,
            updatedBy: persistedConfig.updatedBy
        };

        res.json({
            success: true,
            data: safeConfig,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get config error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve configuration',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/config:
 *   put:
 *     summary: Update bot configuration (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tradeMultiplier:
 *                 type: number
 *               maxOrderSizeUsd:
 *                 type: number
 *               minOrderSizeUsd:
 *                 type: number
 *               fetchInterval:
 *                 type: number
 *               retryLimit:
 *                 type: number
 *               maxSlippageBps:
 *                 type: number
 *               tradeAggregationEnabled:
 *                 type: boolean
 *               enableApi:
 *                 type: boolean
 *               corsOrigin:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Configuration updated successfully
 */
app.put('/api/config', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const updates = req.body;

        // Validate input
        if (updates.tradeMultiplier !== undefined && (updates.tradeMultiplier < 0.1 || updates.tradeMultiplier > 10)) {
            return res.status(400).json({
                success: false,
                error: 'Trade multiplier must be between 0.1 and 10',
                timestamp: Date.now()
            });
        }

        if (updates.maxSlippageBps !== undefined && (updates.maxSlippageBps < 1 || updates.maxSlippageBps > 1000)) {
            return res.status(400).json({
                success: false,
                error: 'Max slippage must be between 1 and 1000 BPS',
                timestamp: Date.now()
            });
        }

        if (updates.fetchInterval !== undefined && (updates.fetchInterval < 1 || updates.fetchInterval > 60)) {
            return res.status(400).json({
                success: false,
                error: 'Fetch interval must be between 1 and 60 seconds',
                timestamp: Date.now()
            });
        }

        if (
            updates.tooOldTimestampHours !== undefined &&
            (updates.tooOldTimestampHours < 1 || updates.tooOldTimestampHours > 168)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Too old timestamp hours must be between 1 and 168',
                timestamp: Date.now()
            });
        }

        if (
            updates.tradeAggregationWindowSeconds !== undefined &&
            (updates.tradeAggregationWindowSeconds < 1 || updates.tradeAggregationWindowSeconds > 3600)
        ) {
            return res.status(400).json({
                success: false,
                error: 'Trade aggregation window must be between 1 and 3600 seconds',
                timestamp: Date.now()
            });
        }

        // Persist configuration changes
        const configUpdates: Partial<PersistentConfig> = {};
        if (updates.tradeMultiplier !== undefined) configUpdates.tradeMultiplier = updates.tradeMultiplier;
        if (updates.maxOrderSizeUsd !== undefined) configUpdates.maxOrderSizeUsd = updates.maxOrderSizeUsd;
        if (updates.minOrderSizeUsd !== undefined) configUpdates.minOrderSizeUsd = updates.minOrderSizeUsd;
        if (updates.fetchInterval !== undefined) configUpdates.fetchInterval = updates.fetchInterval;
        if (updates.retryLimit !== undefined) configUpdates.retryLimit = updates.retryLimit;
        if (updates.maxSlippageBps !== undefined) configUpdates.maxSlippageBps = updates.maxSlippageBps;
        if (updates.tooOldTimestampHours !== undefined) {
            configUpdates.tooOldTimestampHours = updates.tooOldTimestampHours;
        }
        if (updates.tradeAggregationEnabled !== undefined) configUpdates.tradeAggregationEnabled = updates.tradeAggregationEnabled;
        if (updates.tradeAggregationWindowSeconds !== undefined) {
            configUpdates.tradeAggregationWindowSeconds = updates.tradeAggregationWindowSeconds;
        }
        if (updates.enableApi !== undefined) configUpdates.enableApi = updates.enableApi;
        if (updates.corsOrigin !== undefined) configUpdates.corsOrigin = updates.corsOrigin;
        if (updates.enabled !== undefined) configUpdates.enableTrading = updates.enabled;

        const actor = getRequesterIdentity(req);
        await savePersistedConfig(tenantId, configUpdates, actor);

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, configUpdates);

        Logger.info(`Configuration updated by ${actor}`);

        res.json({
            success: true,
            data: { message: 'Configuration updated successfully' },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Update config error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update configuration',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/config/user-addresses:
 *   get:
 *     summary: Get list of trader addresses being copied
 *   post:
 *     summary: Add a new trader address to copy
 *   delete:
 *     summary: Remove a trader address
 */
app.get('/api/config/user-addresses', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const addresses = await getConfiguredUserAddresses(tenantId);
        const includeProfiles = String(req.query.includeProfiles || '').toLowerCase() === 'true';

        if (!includeProfiles) {
            return res.json({
                success: true,
                data: addresses,
                timestamp: Date.now()
            } as ApiResponse);
        }

        const traders = await Promise.all(
            addresses.map(async (address) => fetchPolymarketTraderProfile(address))
        );

        res.json({
            success: true,
            data: {
                addresses: traders,
                count: traders.length
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get user addresses error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve user addresses',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.post('/api/config/user-addresses', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const normalizedAddress = normalizeAddress(req.body?.address);

        if (!normalizedAddress) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Ethereum address format',
                timestamp: Date.now()
            });
        }

        const currentAddresses = await getConfiguredUserAddresses(tenantId);

        if (currentAddresses.includes(normalizedAddress)) {
            return res.status(400).json({
                success: false,
                error: 'Address already exists',
                timestamp: Date.now()
            });
        }

        currentAddresses.push(normalizedAddress);
        const actor = getRequesterIdentity(req);

        // Persist the updated addresses
        await savePersistedConfig(tenantId, { userAddresses: currentAddresses }, actor);

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, { userAddresses: currentAddresses });

        Logger.info(`Added trader address ${normalizedAddress} by ${actor}`);

        res.json({
            success: true,
            data: { message: 'Trader address added successfully', addresses: currentAddresses },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Add user address error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to add trader address',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.delete('/api/config/user-addresses/:address', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const normalizedAddress = normalizeAddress(req.params.address);
        if (!normalizedAddress) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Ethereum address format',
                timestamp: Date.now()
            } as ApiResponse);
        }

        const currentAddresses = await getConfiguredUserAddresses(tenantId);

        const filteredAddresses = currentAddresses.filter((addr) => addr.toLowerCase() !== normalizedAddress);

        if (filteredAddresses.length === currentAddresses.length) {
            return res.status(404).json({
                success: false,
                error: 'Address not found',
                timestamp: Date.now()
            });
        }

        const actor = getRequesterIdentity(req);

        // Persist the updated addresses
        await savePersistedConfig(tenantId, { userAddresses: filteredAddresses }, actor);

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, { userAddresses: filteredAddresses });

        Logger.info(`Removed trader address ${normalizedAddress} by ${actor}`);

        res.json({
            success: true,
            data: { message: 'Trader address removed successfully', addresses: filteredAddresses },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Remove user address error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to remove trader address',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/config/wallet:
 *   post:
 *     summary: Set wallet credentials (admin only)
 *   get:
 *     summary: Get wallet status (masked)
 */
app.get('/api/config/wallet', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const persistedConfig = await loadPersistedConfig(tenantId);
        const runtimeConfig = getActiveTenantId() === tenantId ? getConfig() : null;
        const proxyWallet = persistedConfig.proxyWallet || runtimeConfig?.PROXY_WALLET || '';
        const hasPrivateKey = !!(persistedConfig.privateKey || runtimeConfig?.PRIVATE_KEY || '');

        const walletStatus = {
            proxyWallet: proxyWallet ? `${proxyWallet.slice(0, 6)}...${proxyWallet.slice(-4)}` : null,
            hasPrivateKey,
            isConfigured: !!(proxyWallet && hasPrivateKey)
        };

        res.json({
            success: true,
            data: walletStatus,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get wallet status error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to get wallet status',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.post('/api/config/wallet', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const { proxyWallet, privateKey } = req.body;
        const normalizedProxyWallet = proxyWallet ? normalizeAddress(proxyWallet) : null;

        // Validate proxy wallet address
        if (proxyWallet && !normalizedProxyWallet) {
            return res.status(400).json({
                success: false,
                error: 'Invalid proxy wallet address format',
                timestamp: Date.now()
            });
        }

        // Validate private key format (basic check)
        if (privateKey && !privateKey.match(/^0x[a-fA-F0-9]{64}$/)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid private key format (should be 0x followed by 64 hex characters)',
                timestamp: Date.now()
            });
        }

        // Persist wallet credentials
        const walletUpdates: Partial<PersistentConfig> = {};
        if (normalizedProxyWallet) walletUpdates.proxyWallet = normalizedProxyWallet;
        if (privateKey) walletUpdates.privateKey = privateKey;

        const actor = getRequesterIdentity(req);
        await savePersistedConfig(tenantId, walletUpdates, actor);

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, walletUpdates);

        Logger.info(`Wallet credentials updated by ${actor}`);

        res.json({
            success: true,
            data: {
                message: 'Wallet credentials updated successfully',
                proxyWallet: normalizedProxyWallet
                    ? `${normalizedProxyWallet.slice(0, 6)}...${normalizedProxyWallet.slice(-4)}`
                    : null,
                hasPrivateKey: !!privateKey
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Update wallet error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update wallet credentials',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/config/api-keys:
 *   post:
 *     summary: Set Polymarket API credentials (admin only)
 *   get:
 *     summary: Get API keys status (masked)
 */
app.get('/api/config/api-keys', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const persistedConfig = await loadPersistedConfig(tenantId);
        const runtimeConfig = getActiveTenantId() === tenantId ? getConfig() : null;
        const hasApiKey = !!(persistedConfig.clobApiKey || runtimeConfig?.CLOB_API_KEY || '');
        const hasSecret = !!(persistedConfig.clobSecret || runtimeConfig?.CLOB_SECRET || '');
        const hasPassphrase = !!(persistedConfig.clobPassPhrase || runtimeConfig?.CLOB_PASS_PHRASE || '');

        const apiKeysStatus = {
            hasApiKey,
            hasSecret,
            hasPassphrase,
            isConfigured: hasApiKey && hasSecret && hasPassphrase
        };

        res.json({
            success: true,
            data: apiKeysStatus,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get API keys status error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to get API keys status',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.post('/api/config/api-keys', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const { apiKey, secret, passphrase } = req.body;

        if (!apiKey || !secret || !passphrase) {
            return res.status(400).json({
                success: false,
                error: 'API key, secret, and passphrase are all required',
                timestamp: Date.now()
            });
        }

        // Persist API credentials
        const actor = getRequesterIdentity(req);
        await savePersistedConfig(
            tenantId,
            {
                clobApiKey: apiKey,
                clobSecret: secret,
                clobPassPhrase: passphrase
            },
            actor
        );

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, {
            clobApiKey: apiKey,
            clobSecret: secret,
            clobPassPhrase: passphrase
        });

        Logger.info(`Polymarket API credentials updated by ${actor}`);

        res.json({
            success: true,
            data: {
                message: 'API credentials updated successfully',
                hasApiKey: !!apiKey,
                hasSecret: !!secret,
                hasPassphrase: !!passphrase
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Update API keys error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to update API credentials',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/moniqo/user:
 *   post:
 *     summary: Create or link Moniqo user to Polycopy account
 *     description: Used by Moniqo to create Polycopy accounts for their users
 *   get:
 *     summary: Get Polycopy user data for Moniqo user
 */
app.post('/api/moniqo/user', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { moniqoId, email, walletAddress, preferences } = req.body;
        const tenantId = typeof moniqoId === 'string' ? moniqoId.trim() : '';

        // Validate required fields
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                error: 'moniqoId is required',
                timestamp: Date.now()
            });
        }

        // Check if this tenant already exists
        const existingConfig = await loadPersistedConfig(tenantId);
        const hasExistingTenantConfig = Object.keys(existingConfig).length > 0;
        const existingRole =
            typeof existingConfig.role === 'string' && existingConfig.role.trim().length > 0
                ? existingConfig.role.trim()
                : null;
        const resolvedRole = existingRole || (hasExistingTenantConfig ? 'user' : 'admin');

        // Create user configuration
        const userConfig: Partial<PersistentConfig> = {
            moniqoId: tenantId,
            email,
            proxyWallet: walletAddress,
            // Set defaults for new users
            tradeMultiplier: 1.0,
            maxOrderSizeUsd: 1000,
            minOrderSizeUsd: 1,
            fetchInterval: 1,
            maxSlippageBps: 500,
            tradeAggregationEnabled: false,
            enableTrading: false, // Start disabled, user enables later
            copyStrategy: 'proportional'
        };

        userConfig.role = resolvedRole;

        // Save user configuration
        await savePersistedConfig(tenantId, userConfig, `moniqo-integration-${tenantId}`);
        await updateEnvironmentFromConfig(tenantId, userConfig);

        Logger.info(`Moniqo user ${tenantId} linked to Polycopy account`);

        res.json({
            success: true,
            data: {
                message: 'User account created/linked successfully',
                userId: tenantId,
                isAdmin: userConfig.role === 'admin',
                polycopyReady: true
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Moniqo user creation error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to create user account',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

app.get('/api/moniqo/user', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        // Load user configuration
        const config = await loadPersistedConfig(tenantId);
        const userAddresses = await getConfiguredUserAddresses(tenantId);

        // Find user-specific data (you might want to store per-user configs)
        const userData = {
            moniqoId: config.moniqoId || req.user?.moniqoId || null,
            email: config.email,
            walletAddress: config.proxyWallet,
            isConfigured: !!(config.proxyWallet && config.userAddresses?.length),
            tradingEnabled: config.enableTrading || false,
            userAddresses,
            lastUpdated: config.lastUpdated
        };

        res.json({
            success: true,
            data: userData,
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Get Moniqo user error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve user data',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

/**
 * @swagger
 * /api/config/setup:
 *   post:
 *     summary: Complete bot setup wizard (admin only)
 */
app.post('/api/config/setup', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = resolveRequestTenantId(req, res);
        if (!tenantId) return;

        const setupData = req.body;
        const normalizedProxyWallet = normalizeAddress(setupData.proxyWallet);

        // Validate all required fields
        const required = ['proxyWallet', 'privateKey', 'userAddresses', 'mongoUri', 'rpcUrl'];
        for (const field of required) {
            if (!setupData[field]) {
                return res.status(400).json({
                    success: false,
                    error: `Missing required field: ${field}`,
                    timestamp: Date.now()
                });
            }
        }

        // Validate wallet address
        if (!normalizedProxyWallet) {
            return res.status(400).json({
                success: false,
                error: 'Invalid proxy wallet address',
                timestamp: Date.now()
            });
        }

        // Validate user addresses
        if (!Array.isArray(setupData.userAddresses) || setupData.userAddresses.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one trader address is required',
                timestamp: Date.now()
            });
        }

        const normalizedUserAddresses: string[] = [];
        for (const addr of setupData.userAddresses) {
            const normalizedAddress = normalizeAddress(addr);
            if (!normalizedAddress) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid trader address: ${addr}`,
                    timestamp: Date.now()
                });
            }
            normalizedUserAddresses.push(normalizedAddress);
        }

        // Prepare configuration for persistence
        const setupConfig: Partial<PersistentConfig> = {
            proxyWallet: normalizedProxyWallet,
            privateKey: setupData.privateKey,
            userAddresses: normalizedUserAddresses,
            mongoUri: setupData.mongoUri,
            rpcUrl: setupData.rpcUrl,
            clobHttpUrl: setupData.clobHttpUrl || 'https://clob.polymarket.com',
            usdcContractAddress: setupData.usdcContractAddress || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            jwtSecret: setupData.jwtSecret || ENV.JWT_SECRET,
            enableApi: true,
            apiPort: setupData.apiPort || 3001,
            apiHost: setupData.apiHost || 'localhost',
            corsOrigin: setupData.corsOrigin || 'http://localhost:3000'
        };

        // Optional fields
        if (setupData.clobWsUrl) setupConfig.clobWsUrl = setupData.clobWsUrl;
        if (setupData.tradeMultiplier) setupConfig.tradeMultiplier = setupData.tradeMultiplier;
        if (setupData.maxOrderSizeUsd) setupConfig.maxOrderSizeUsd = setupData.maxOrderSizeUsd;
        if (setupData.minOrderSizeUsd) setupConfig.minOrderSizeUsd = setupData.minOrderSizeUsd;
        if (setupData.fetchInterval) setupConfig.fetchInterval = setupData.fetchInterval;
        if (setupData.retryLimit) setupConfig.retryLimit = setupData.retryLimit;
        if (setupData.maxSlippageBps) setupConfig.maxSlippageBps = setupData.maxSlippageBps;
        if (setupData.tooOldTimestampHours) {
            setupConfig.tooOldTimestampHours = setupData.tooOldTimestampHours;
        }
        if (setupData.tradeAggregationEnabled !== undefined) {
            setupConfig.tradeAggregationEnabled = !!setupData.tradeAggregationEnabled;
        }
        if (setupData.tradeAggregationWindowSeconds) {
            setupConfig.tradeAggregationWindowSeconds = setupData.tradeAggregationWindowSeconds;
        }

        // Persist complete setup
        const actor = getRequesterIdentity(req);
        await savePersistedConfig(tenantId, setupConfig, actor);

        // Update runtime environment
        await updateEnvironmentFromConfig(tenantId, setupConfig);

        Logger.info(`Complete bot setup completed by ${actor}`);

        res.json({
            success: true,
            data: {
                message: 'Bot setup completed successfully',
                nextSteps: [
                    'Configure Polymarket API keys',
                    'Test wallet connection',
                    'Enable trading'
                ]
            },
            timestamp: Date.now()
        } as ApiResponse);
    } catch (error) {
        Logger.error(`Setup wizard error: ${error}`);
        res.status(500).json({
            success: false,
            error: 'Setup failed',
            timestamp: Date.now()
        } as ApiResponse);
    }
});

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    Logger.error(`API Error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: Date.now()
    } as ApiResponse);
});

// ============================================================================
// Server Startup
// ============================================================================

// Use Render's PORT environment variable, fallback to config
const PORT = parseInt(process.env.PORT || ENV.API_PORT.toString(), 10);
// For Render/containerized deployments, always use 0.0.0.0
const HOST = process.env.RENDER || process.env.NODE_ENV === 'production' ? '0.0.0.0' : ENV.API_HOST;

console.log(`🔍 Starting server on port ${PORT}, host ${HOST}`);
console.log(`🔍 process.env.PORT: ${process.env.PORT}`);
console.log(`🔍 ENV.API_PORT: ${ENV.API_PORT}`);

app.listen(PORT, HOST, () => {
    console.log(`✅ Server callback executed - listening on ${HOST}:${PORT}`);
    Logger.success(`🚀 PolyCopy API server running on http://${HOST}:${PORT}`);
    Logger.info(`📚 API docs available at http://${HOST}:${PORT}/api-docs (if enabled)`);
    Logger.info(`🔐 JWT Secret: ${ENV.JWT_SECRET.substring(0, 8)}...`);
    Logger.info(`⚡ Rate limit: ${ENV.API_RATE_LIMIT_MAX_REQUESTS} requests per ${ENV.API_RATE_LIMIT_WINDOW_MS / 1000}s`);
    Logger.info(`🌐 Listening on port ${PORT} (Render: ${process.env.PORT ? 'Yes' : 'No'})`);
}).on('error', (err) => {
    console.error(`❌ Server failed to start:`, err);
    process.exit(1);
});

export default app;
