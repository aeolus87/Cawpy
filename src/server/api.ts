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
import { ENV } from '../config/env';
import Logger from '../utils/logger';

// Import services
import tradeExecutor, { stopTradeExecutor } from '../services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from '../services/tradeMonitor';
import { runReconciliation, markTradesReconciled } from '../services/reconciliation';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';

// Import utilities
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import createClobClient from '../utils/createClobClient';
import { authenticateToken, requireAdmin, AuthRequest } from '../utils/auth.middleware';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Configuration Persistence
// ============================================================================

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');

interface PersistentConfig {
    // User identification
    moniqoId?: string;
    email?: string;
    role?: string;

    // User addresses
    userAddresses?: string[];

    // Wallet credentials (encrypted in production)
    proxyWallet?: string;
    privateKey?: string;

    // API credentials
    clobApiKey?: string;
    clobSecret?: string;
    clobPassPhrase?: string;

    // Trading settings
    tradeMultiplier?: number;
    maxOrderSizeUsd?: number;
    minOrderSizeUsd?: number;
    fetchInterval?: number;
    retryLimit?: number;
    maxSlippageBps?: number;
    tradeAggregationEnabled?: boolean;

    // Network settings
    mongoUri?: string;
    rpcUrl?: string;
    clobHttpUrl?: string;
    clobWsUrl?: string;
    usdcContractAddress?: string;

    // API settings
    enableApi?: boolean;
    apiPort?: number;
    apiHost?: string;
    jwtSecret?: string;
    corsOrigin?: string;

    // Bot settings
    enableTrading?: boolean;
    copyStrategy?: string;

    // Metadata
    lastUpdated: string;
    updatedBy: string;
}

function loadPersistentConfig(): Partial<PersistentConfig> {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const configData = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
            return JSON.parse(configData);
        }
    } catch (error) {
        Logger.error(`Failed to load persistent config: ${error}`);
    }
    return {};
}

function savePersistentConfig(config: Partial<PersistentConfig>, updatedBy: string): void {
    try {
        const existingConfig = loadPersistentConfig();

        const fullConfig: PersistentConfig = {
            // User addresses
            userAddresses: config.userAddresses || existingConfig.userAddresses || [],

            // Wallet credentials
            proxyWallet: config.proxyWallet || existingConfig.proxyWallet,
            privateKey: config.privateKey || existingConfig.privateKey,

            // API credentials
            clobApiKey: config.clobApiKey || existingConfig.clobApiKey,
            clobSecret: config.clobSecret || existingConfig.clobSecret,
            clobPassPhrase: config.clobPassPhrase || existingConfig.clobPassPhrase,

            // Trading settings with defaults
            tradeMultiplier: config.tradeMultiplier || existingConfig.tradeMultiplier || 1.0,
            maxOrderSizeUsd: config.maxOrderSizeUsd || existingConfig.maxOrderSizeUsd || 1000,
            minOrderSizeUsd: config.minOrderSizeUsd || existingConfig.minOrderSizeUsd || 1,
            fetchInterval: config.fetchInterval || existingConfig.fetchInterval || 1,
            retryLimit: config.retryLimit || existingConfig.retryLimit || 3,
            maxSlippageBps: config.maxSlippageBps || existingConfig.maxSlippageBps || 500,
            tradeAggregationEnabled: config.tradeAggregationEnabled ?? existingConfig.tradeAggregationEnabled ?? false,

            // Network settings with defaults
            mongoUri: config.mongoUri || existingConfig.mongoUri || '',
            rpcUrl: config.rpcUrl || existingConfig.rpcUrl || '',
            clobHttpUrl: config.clobHttpUrl || existingConfig.clobHttpUrl || 'https://clob.polymarket.com',
            clobWsUrl: config.clobWsUrl || existingConfig.clobWsUrl,
            usdcContractAddress: config.usdcContractAddress || existingConfig.usdcContractAddress || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',

            // API settings with defaults
            enableApi: config.enableApi ?? existingConfig.enableApi ?? true,
            apiPort: config.apiPort || existingConfig.apiPort || 3001,
            apiHost: config.apiHost || existingConfig.apiHost || 'localhost',
            jwtSecret: config.jwtSecret || existingConfig.jwtSecret || 'your-super-secret-jwt-key-change-in-production',
            corsOrigin: config.corsOrigin || existingConfig.corsOrigin || 'http://localhost:3000',

            // Bot settings with defaults
            enableTrading: config.enableTrading ?? existingConfig.enableTrading ?? true,
            copyStrategy: config.copyStrategy || existingConfig.copyStrategy || 'proportional',

            // Metadata
            lastUpdated: new Date().toISOString(),
            updatedBy
        };

        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(fullConfig, null, 2));
        Logger.info(`Configuration saved to ${CONFIG_FILE_PATH}`);
    } catch (error) {
        Logger.error(`Failed to save persistent config: ${error}`);
        throw new Error('Failed to persist configuration');
    }
}

function updateEnvironmentFromConfig(): void {
    const config = loadPersistentConfig();

    // Update process.env with persisted values
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
    if (config.tradeAggregationEnabled !== undefined) process.env.TRADE_AGGREGATION_ENABLED = config.tradeAggregationEnabled.toString();
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
}

// Load persisted configuration on startup
updateEnvironmentFromConfig();

// ============================================================================
// Types & Interfaces
// ============================================================================


interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: number;
}

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

        let userData: any = {};
        let token: string;

        // Method 1: Traditional wallet signature (for direct Polycopy users)
        if (address && signature) {
            // TODO: Implement proper wallet signature verification
            // For now, accept any address
            userData = {
                address: address.toLowerCase(),
                role: 'user' // Default role, can be upgraded to admin
            };
        }
        // Method 2: Moniqo token exchange (for Moniqo-integrated users)
        else if (moniqoToken || moniqoId) {
            // Accept Moniqo authentication
            userData = {
                moniqoId: moniqoId,
                email: email,
                address: address, // Optional wallet address from Moniqo
                role: 'user' // Moniqo users start as regular users
            };
        } else {
            return res.status(400).json({
                success: false,
                error: 'Either wallet signature (address + signature) or Moniqo token required',
                timestamp: Date.now()
            });
        }

        // Generate Polycopy JWT token
        token = jwt.sign(userData, ENV.JWT_SECRET, { expiresIn: '24h' });

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
    // TODO: Implement actual status tracking
    res.json({
        success: true,
        data: {
            isRunning: true, // Placeholder
            uptime: process.uptime(),
            lastActivity: new Date().toISOString()
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
        // TODO: Implement bot start logic
        Logger.info('Trading bot started via API');

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
app.post('/api/trading/stop', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        // Stop the trading executor
        stopTradeExecutor();
        stopTradeMonitor();

        Logger.info('Trading bot stopped via API');

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
        const wallet = ENV.PROXY_WALLET;
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
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        // Get trades from all configured users
        const allTrades: any[] = [];
        const addresses = ENV.USER_ADDRESSES || [];

        if (addresses.length === 0) {
            return res.json({
                success: true,
                data: { trades: [], count: 0, offset, limit },
                message: 'No trader addresses configured. Add traders via /api/config/user-addresses',
                timestamp: Date.now()
            } as ApiResponse);
        }

        for (const address of addresses) {
            const UserActivity = getUserActivityModel(address);
            const trades = await UserActivity.find()
                .sort({ timestamp: -1 })
                .limit(limit)
                .skip(offset)
                .exec();

            allTrades.push(...trades.map(trade => ({
                ...trade.toObject(),
                userAddress: address
            })));
        }

        // Sort by timestamp and limit
        allTrades.sort((a, b) => b.timestamp - a.timestamp);
        const limitedTrades = allTrades.slice(0, limit);

        res.json({
            success: true,
            data: {
                trades: limitedTrades,
                count: limitedTrades.length,
                offset,
                limit
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
app.get('/api/config', authenticateToken, (req: AuthRequest, res: Response) => {
    try {
        // Load current persisted configuration
        const persistedConfig = loadPersistentConfig();

        // Return safe configuration (exclude sensitive data)
        const safeConfig = {
            // User addresses
            userAddresses: persistedConfig.userAddresses || ENV.USER_ADDRESSES || [],

            // Trading settings
            tradeMultiplier: persistedConfig.tradeMultiplier || ENV.TRADE_MULTIPLIER,
            maxOrderSizeUsd: persistedConfig.maxOrderSizeUsd || ENV.MAX_ORDER_SIZE_USD,
            minOrderSizeUsd: persistedConfig.minOrderSizeUsd || ENV.MIN_ORDER_SIZE_USD,
            fetchInterval: persistedConfig.fetchInterval || ENV.FETCH_INTERVAL,
            retryLimit: persistedConfig.retryLimit || ENV.RETRY_LIMIT,

            // Risk management
            maxSlippageBps: persistedConfig.maxSlippageBps || ENV.MAX_SLIPPAGE_BPS,
            tradeAggregationEnabled: persistedConfig.tradeAggregationEnabled ?? ENV.TRADE_AGGREGATION_ENABLED,

            // API settings
            enableApi: persistedConfig.enableApi ?? ENV.ENABLE_API,
            apiPort: persistedConfig.apiPort || ENV.API_PORT,
            apiHost: persistedConfig.apiHost || ENV.API_HOST,
            corsOrigin: persistedConfig.corsOrigin || ENV.CORS_ORIGIN,

            // Bot status
            enabled: persistedConfig.enableTrading ?? ENV.ENABLE_TRADING,
            copyStrategy: persistedConfig.copyStrategy || ENV.COPY_STRATEGY,

            // Network settings
            rpcUrl: persistedConfig.rpcUrl || ENV.RPC_URL,
            clobHttpUrl: persistedConfig.clobHttpUrl || ENV.CLOB_HTTP_URL,
            usdcContractAddress: persistedConfig.usdcContractAddress || ENV.USDC_CONTRACT_ADDRESS,

            // Wallet info (mask sensitive data)
            proxyWallet: persistedConfig.proxyWallet ? `${persistedConfig.proxyWallet.slice(0, 6)}...${persistedConfig.proxyWallet.slice(-4)}` : (ENV.PROXY_WALLET ? `${ENV.PROXY_WALLET.slice(0, 6)}...${ENV.PROXY_WALLET.slice(-4)}` : null),
            hasPrivateKey: !!(persistedConfig.privateKey || ENV.PRIVATE_KEY),
            hasApiKeys: !!(persistedConfig.clobApiKey || (ENV.CLOB_API_KEY && ENV.CLOB_SECRET && ENV.CLOB_PASS_PHRASE)),

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

        // Persist configuration changes
        const configUpdates: Partial<PersistentConfig> = {};
        if (updates.tradeMultiplier !== undefined) configUpdates.tradeMultiplier = updates.tradeMultiplier;
        if (updates.maxOrderSizeUsd !== undefined) configUpdates.maxOrderSizeUsd = updates.maxOrderSizeUsd;
        if (updates.minOrderSizeUsd !== undefined) configUpdates.minOrderSizeUsd = updates.minOrderSizeUsd;
        if (updates.fetchInterval !== undefined) configUpdates.fetchInterval = updates.fetchInterval;
        if (updates.retryLimit !== undefined) configUpdates.retryLimit = updates.retryLimit;
        if (updates.maxSlippageBps !== undefined) configUpdates.maxSlippageBps = updates.maxSlippageBps;
        if (updates.tradeAggregationEnabled !== undefined) configUpdates.tradeAggregationEnabled = updates.tradeAggregationEnabled;
        if (updates.enableApi !== undefined) configUpdates.enableApi = updates.enableApi;
        if (updates.corsOrigin !== undefined) configUpdates.corsOrigin = updates.corsOrigin;
        if (updates.enabled !== undefined) configUpdates.enableTrading = updates.enabled;

        savePersistentConfig(configUpdates, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Configuration updated by ${req.user?.address}`);

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
app.get('/api/config/user-addresses', authenticateToken, (req: AuthRequest, res: Response) => {
    try {
        const persistedConfig = loadPersistentConfig();
        const addresses = persistedConfig.userAddresses || ENV.USER_ADDRESSES || [];

        res.json({
            success: true,
            data: addresses,
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

app.post('/api/config/user-addresses', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
    try {
        const { address } = req.body;

        if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Ethereum address format',
                timestamp: Date.now()
            });
        }

        const currentAddresses = ENV.USER_ADDRESSES || [];

        if (currentAddresses.includes(address.toLowerCase())) {
            return res.status(400).json({
                success: false,
                error: 'Address already exists',
                timestamp: Date.now()
            });
        }

        currentAddresses.push(address.toLowerCase());

        // Persist the updated addresses
        savePersistentConfig({ userAddresses: currentAddresses }, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Added trader address ${address} by ${req.user?.address}`);

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

app.delete('/api/config/user-addresses/:address', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
    try {
        const { address } = req.params;
        const currentAddresses = ENV.USER_ADDRESSES || [];

        const filteredAddresses = currentAddresses.filter(addr => addr.toLowerCase() !== address.toLowerCase());

        if (filteredAddresses.length === currentAddresses.length) {
            return res.status(404).json({
                success: false,
                error: 'Address not found',
                timestamp: Date.now()
            });
        }

        // Persist the updated addresses
        savePersistentConfig({ userAddresses: filteredAddresses }, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Removed trader address ${address} by ${req.user?.address}`);

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
app.get('/api/config/wallet', authenticateToken, (req: AuthRequest, res: Response) => {
    try {
        const persistedConfig = loadPersistentConfig();
        const proxyWallet = persistedConfig.proxyWallet || ENV.PROXY_WALLET;
        const hasPrivateKey = !!(persistedConfig.privateKey || ENV.PRIVATE_KEY);

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

app.post('/api/config/wallet', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
    try {
        const { proxyWallet, privateKey } = req.body;

        // Validate proxy wallet address
        if (proxyWallet && !proxyWallet.match(/^0x[a-fA-F0-9]{40}$/)) {
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
        if (proxyWallet) walletUpdates.proxyWallet = proxyWallet;
        if (privateKey) walletUpdates.privateKey = privateKey;

        savePersistentConfig(walletUpdates, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Wallet credentials updated by ${req.user?.address}`);

        res.json({
            success: true,
            data: {
                message: 'Wallet credentials updated successfully',
                proxyWallet: proxyWallet ? `${proxyWallet.slice(0, 6)}...${proxyWallet.slice(-4)}` : null,
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
app.get('/api/config/api-keys', authenticateToken, (req: AuthRequest, res: Response) => {
    try {
        const persistedConfig = loadPersistentConfig();
        const hasApiKey = !!(persistedConfig.clobApiKey || ENV.CLOB_API_KEY);
        const hasSecret = !!(persistedConfig.clobSecret || ENV.CLOB_SECRET);
        const hasPassphrase = !!(persistedConfig.clobPassPhrase || ENV.CLOB_PASS_PHRASE);

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

app.post('/api/config/api-keys', authenticateToken, requireAdmin, (req: AuthRequest, res: Response) => {
    try {
        const { apiKey, secret, passphrase } = req.body;

        if (!apiKey || !secret || !passphrase) {
            return res.status(400).json({
                success: false,
                error: 'API key, secret, and passphrase are all required',
                timestamp: Date.now()
            });
        }

        // Persist API credentials
        savePersistentConfig({
            clobApiKey: apiKey,
            clobSecret: secret,
            clobPassPhrase: passphrase
        }, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Polymarket API credentials updated by ${req.user?.address}`);

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

        // Validate required fields
        if (!moniqoId) {
            return res.status(400).json({
                success: false,
                error: 'moniqoId is required',
                timestamp: Date.now()
            });
        }

        // Check if user already exists
        const existingConfig = loadPersistentConfig();
        const existingUsers = existingConfig.userAddresses || [];

        // Create user configuration
        const userConfig: Partial<PersistentConfig> = {
            moniqoId,
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

        // If this is the first user, set them as admin
        const isFirstUser = !existingUsers.length;
        if (isFirstUser) {
            userConfig.role = 'admin';
        }

        // Save user configuration
        savePersistentConfig(userConfig, `moniqo-integration-${moniqoId}`);

        Logger.info(`Moniqo user ${moniqoId} linked to Polycopy account`);

        res.json({
            success: true,
            data: {
                message: 'User account created/linked successfully',
                userId: moniqoId,
                isAdmin: isFirstUser,
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

app.get('/api/moniqo/user', authenticateToken, (req: AuthRequest, res: Response) => {
    try {
        const moniqoId = req.user?.moniqoId;

        if (!moniqoId) {
            return res.status(400).json({
                success: false,
                error: 'No Moniqo user ID found in token',
                timestamp: Date.now()
            });
        }

        // Load user configuration
        const config = loadPersistentConfig();

        // Find user-specific data (you might want to store per-user configs)
        const userData = {
            moniqoId,
            email: config.email,
            walletAddress: config.proxyWallet,
            isConfigured: !!(config.proxyWallet && config.userAddresses?.length),
            tradingEnabled: config.enableTrading || false,
            userAddresses: config.userAddresses || [],
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
        const setupData = req.body;

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
        if (!setupData.proxyWallet.match(/^0x[a-fA-F0-9]{40}$/)) {
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

        for (const addr of setupData.userAddresses) {
            if (!addr.match(/^0x[a-fA-F0-9]{40}$/)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid trader address: ${addr}`,
                    timestamp: Date.now()
                });
            }
        }

        // Prepare configuration for persistence
        const setupConfig: Partial<PersistentConfig> = {
            proxyWallet: setupData.proxyWallet,
            privateKey: setupData.privateKey,
            userAddresses: setupData.userAddresses,
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
        if (setupData.maxSlippageBps) setupConfig.maxSlippageBps = setupData.maxSlippageBps;

        // Persist complete setup
        savePersistentConfig(setupConfig, req.user!.address || req.user!.moniqoId || 'unknown');

        // Update runtime environment
        updateEnvironmentFromConfig();

        Logger.info(`Complete bot setup completed by ${req.user?.address}`);

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