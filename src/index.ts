import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import { startTrading, stopTrading } from './services/runtimeManager';
import Logger from './utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        const stopResult = stopTrading();
        if (!stopResult.success && stopResult.error !== 'Not running') {
            Logger.warning(`Trading stop request returned: ${stopResult.error}`);
        }

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
            green: '\x1b[32m',
        };

        console.log(`\n${colors.yellow}🚀 Polymarket Copy Trading Bot${colors.reset}`);

        const dbConnected = await connectDB();

        // Check if we should start API-only mode (for web deployments)
        const isApiMode = ENV.ENABLE_API === true && (
            !USER_ADDRESSES.length ||
            !PROXY_WALLET ||
            !ENV.PRIVATE_KEY ||
            !dbConnected // Database not connected
        );

        if (isApiMode) {
            console.log(`\n${colors.green}🌐 API-Only Mode${colors.reset}`);
            if (!dbConnected) {
                console.log(`   ${colors.yellow}⚠️ Database not connected - using in-memory storage${colors.reset}`);
            }
            console.log(`   User configuration will be managed through web interface`);
            console.log(`   Configure your bot at: ${colors.cyan}http://localhost:${ENV.API_PORT}/api-docs${colors.reset}\n`);

            // Start API server only
            Logger.info('Starting API server...');
            await import('./server/api');
            return;
        }

        // Full trading bot mode
        console.log(`\n${colors.green}🤖 Full Trading Bot Mode${colors.reset}`);
        console.log(`   Traders to copy: ${USER_ADDRESSES.length}`);
        console.log(`   Wallet: ${PROXY_WALLET ? PROXY_WALLET.slice(0, 6) + '...' + PROXY_WALLET.slice(-4) : 'Not set'}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);

        const { performHealthCheck, logHealthCheck } = await import('./utils/healthCheck');

        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        const startResult = await startTrading('boot');
        if (!startResult.success) {
            Logger.error(`Trading runtime failed to start in boot mode: ${startResult.error}`);
        }

        // Start API server if enabled
        if (process.env.ENABLE_API === 'true') {
            Logger.info('Starting API server...');
            import('./server/api').then(({ default: startApiServer }) => {
                // API server handles its own startup
                Logger.success('API server started');
            }).catch(error => {
                Logger.error(`Failed to start API server: ${error}`);
            });
        }

        // test(clobClient);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
