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

// ============================================================================
// Types & Interfaces
// ============================================================================

interface AuthRequest extends Request {
    user?: {
        address: string;
        role: 'admin' | 'user';
    };
}

interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    timestamp: number;
}

// ============================================================================
// Authentication Middleware
// ============================================================================

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Access token required',
            timestamp: Date.now()
        } as ApiResponse);
    }

    jwt.verify(token, ENV.JWT_SECRET, (err: any, user: any) => {
        if (err) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token',
                timestamp: Date.now()
            } as ApiResponse);
        }
        req.user = user;
        next();
    });
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({
            success: false,
            error: 'Admin access required',
            timestamp: Date.now()
        } as ApiResponse);
    }
    next();
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

// Security middleware
app.use(helmet());
app.use(cors({
    origin: ENV.CORS_ORIGIN,
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
        const { address, signature } = req.body;

        // TODO: Implement proper wallet signature verification
        // For now, accept any address with admin role for configured addresses

        const isAdmin = ENV.USER_ADDRESSES.includes(address.toLowerCase());
        const role = isAdmin ? 'admin' : 'user';

        const token = jwt.sign(
            { address: address.toLowerCase(), role },
            ENV.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            data: {
                token,
                user: {
                    address: address.toLowerCase(),
                    role
                }
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
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
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

        for (const address of ENV.USER_ADDRESSES) {
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

const PORT = ENV.API_PORT;
const HOST = ENV.API_HOST;

app.listen(PORT, HOST, () => {
    Logger.success(`🚀 PolyCopy API server running on http://${HOST}:${PORT}`);
    Logger.info(`📚 API docs available at http://${HOST}:${PORT}/api-docs (if enabled)`);
    Logger.info(`🔐 JWT Secret: ${ENV.JWT_SECRET.substring(0, 8)}...`);
    Logger.info(`⚡ Rate limit: ${ENV.API_RATE_LIMIT_MAX_REQUESTS} requests per ${ENV.API_RATE_LIMIT_WINDOW_MS / 1000}s`);
});

export default app;