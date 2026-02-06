import mongoose from 'mongoose';
import { ENV } from './env';
import chalk from 'chalk';

const uri = ENV.MONGO_URI || 'mongodb://localhost:27017/polymarket_copytrading';

const connectDB = async () => {
    try {
        await mongoose.connect(uri);
        console.log(chalk.green('✓'), 'MongoDB connected');
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(chalk.red('✗'), 'MongoDB connection failed:', errorMessage);

        // In API-only mode, don't exit - just log and continue
        if (process.env.ENABLE_API === 'true') {
            console.log(chalk.yellow('⚠️'), 'Continuing in API-only mode without database');
            return false;
        }

        // In full trading mode, exit on database failure
        process.exit(1);
    }
};

/**
 * Close MongoDB connection gracefully
 */
export const closeDB = async (): Promise<void> => {
    try {
        await mongoose.connection.close();
        console.log(chalk.green('✓'), 'MongoDB connection closed');
    } catch (error) {
        console.log(chalk.red('✗'), 'Error closing MongoDB connection:', error);
    }
};

export default connectDB;
