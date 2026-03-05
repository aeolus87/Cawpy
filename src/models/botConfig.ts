import mongoose, { Schema } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import Logger from '../utils/logger';

const LEGACY_CONFIG_ID = 'default';
const CONFIG_FILE_PATH = path.join(process.cwd(), 'config.json');

export interface PersistentConfig {
    // User identification
    moniqoId?: string;
    email?: string;
    role?: string;

    // User addresses
    userAddresses?: string[];

    // Wallet credentials
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
    tooOldTimestampHours?: number;
    tradeAggregationEnabled?: boolean;
    tradeAggregationWindowSeconds?: number;

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
    lastUpdated?: string;
    updatedBy?: string;
}

type BotConfigDocument = PersistentConfig & {
    tenantId: string;
    configId?: string;
};

const botConfigSchema = new Schema<BotConfigDocument>(
    {
        tenantId: { type: String, required: false, unique: true, sparse: true, index: true },
        configId: { type: String, required: false, index: true },
        moniqoId: { type: String, required: false },
        email: { type: String, required: false },
        role: { type: String, required: false },
        userAddresses: { type: [String], required: false, default: [] },
        proxyWallet: { type: String, required: false },
        privateKey: { type: String, required: false },
        clobApiKey: { type: String, required: false },
        clobSecret: { type: String, required: false },
        clobPassPhrase: { type: String, required: false },
        tradeMultiplier: { type: Number, required: false },
        maxOrderSizeUsd: { type: Number, required: false },
        minOrderSizeUsd: { type: Number, required: false },
        fetchInterval: { type: Number, required: false },
        retryLimit: { type: Number, required: false },
        maxSlippageBps: { type: Number, required: false },
        tooOldTimestampHours: { type: Number, required: false },
        tradeAggregationEnabled: { type: Boolean, required: false },
        tradeAggregationWindowSeconds: { type: Number, required: false },
        mongoUri: { type: String, required: false },
        rpcUrl: { type: String, required: false },
        clobHttpUrl: { type: String, required: false },
        clobWsUrl: { type: String, required: false },
        usdcContractAddress: { type: String, required: false },
        enableApi: { type: Boolean, required: false },
        apiPort: { type: Number, required: false },
        apiHost: { type: String, required: false },
        jwtSecret: { type: String, required: false },
        corsOrigin: { type: String, required: false },
        enableTrading: { type: Boolean, required: false },
        copyStrategy: { type: String, required: false },
        lastUpdated: { type: String, required: false },
        updatedBy: { type: String, required: false },
    },
    {
        collection: 'bot_configs',
        versionKey: false,
    }
);

const BotConfigModel =
    (mongoose.models.BotConfig as mongoose.Model<BotConfigDocument> | undefined) ||
    mongoose.model<BotConfigDocument>('BotConfig', botConfigSchema);

const toPersistentConfig = (doc: (BotConfigDocument & { _id?: unknown }) | null): Partial<PersistentConfig> => {
    if (!doc) return {};
    const { tenantId, configId, ...config } = doc;
    return config;
};

const normalizeTenantId = (tenantId: string): string => tenantId.trim();

const readLegacyConfigFile = (): Partial<PersistentConfig> => {
    try {
        if (!fs.existsSync(CONFIG_FILE_PATH)) {
            return {};
        }

        const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistentConfig>;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        Logger.error(`Failed to read legacy config.json: ${error}`);
        return {};
    }
};

const hasConfigValues = (config: Partial<PersistentConfig>): boolean => {
    return Object.keys(config).length > 0;
};

const findLegacyMongoConfig = async (): Promise<(BotConfigDocument & { _id: mongoose.Types.ObjectId }) | null> => {
    const legacyDoc = await BotConfigModel.findOne({ configId: LEGACY_CONFIG_ID })
        .lean<BotConfigDocument & { _id: mongoose.Types.ObjectId }>()
        .exec();

    return legacyDoc || null;
};

const migrateLegacyDocToTenant = async (
    tenantId: string,
    legacyDoc: BotConfigDocument & { _id: mongoose.Types.ObjectId }
): Promise<Partial<PersistentConfig>> => {
    await BotConfigModel.findByIdAndUpdate(
        legacyDoc._id,
        {
            $set: { tenantId },
            $unset: { configId: '' },
        },
        { new: true }
    ).exec();

    Logger.info(`Migrated legacy default config document to tenant ${tenantId}`);

    const migrated = {
        ...legacyDoc,
        tenantId,
    };

    return toPersistentConfig(migrated);
};

export const loadPersistedConfigByLegacyId = async (): Promise<{
    tenantId: string;
    config: Partial<PersistentConfig>;
} | null> => {
    if (mongoose.connection.readyState !== 1) {
        return null;
    }

    try {
        const legacyDoc = await findLegacyMongoConfig();
        if (!legacyDoc) {
            return null;
        }

        const config = toPersistentConfig(legacyDoc);
        const tenantId =
            typeof config.moniqoId === 'string' && config.moniqoId.trim().length > 0
                ? config.moniqoId.trim()
                : LEGACY_CONFIG_ID;

        return { tenantId, config };
    } catch (error) {
        Logger.error(`Failed to load legacy default config from MongoDB: ${error}`);
        return null;
    }
};

export const loadPersistedConfig = async (tenantId: string): Promise<Partial<PersistentConfig>> => {
    const normalizedTenantId = normalizeTenantId(tenantId || '');
    if (!normalizedTenantId) {
        return {};
    }

    const legacyConfigFile = readLegacyConfigFile();

    if (mongoose.connection.readyState !== 1) {
        const legacyMoniqoId =
            typeof legacyConfigFile.moniqoId === 'string' ? legacyConfigFile.moniqoId.trim() : '';

        if (hasConfigValues(legacyConfigFile) && legacyMoniqoId === normalizedTenantId) {
            Logger.warning('MongoDB unavailable, using legacy config.json fallback in memory');
            return legacyConfigFile;
        }

        Logger.warning(`MongoDB unavailable, returning empty persisted config for tenant ${normalizedTenantId}`);
        return {};
    }

    try {
        const tenantDoc = await BotConfigModel.findOne({ tenantId: normalizedTenantId })
            .lean<BotConfigDocument>()
            .exec();

        if (tenantDoc) {
            return toPersistentConfig(tenantDoc);
        }

        const legacyDoc = await findLegacyMongoConfig();
        const legacyMoniqoId =
            typeof legacyDoc?.moniqoId === 'string' ? legacyDoc.moniqoId.trim() : '';

        if (legacyDoc && legacyMoniqoId === normalizedTenantId) {
            return migrateLegacyDocToTenant(normalizedTenantId, legacyDoc);
        }

        return {};
    } catch (error) {
        Logger.error(`Failed to load persisted config from MongoDB for tenant ${normalizedTenantId}: ${error}`);
        return {};
    }
};

export const savePersistedConfig = async (
    tenantId: string,
    config: Partial<PersistentConfig>,
    updatedBy: string
): Promise<void> => {
    const normalizedTenantId = normalizeTenantId(tenantId || '');
    if (!normalizedTenantId) {
        Logger.warning('Cannot save persisted config without tenantId');
        return;
    }

    if (mongoose.connection.readyState !== 1) {
        Logger.warning(`MongoDB unavailable, skipping persisted config save for tenant ${normalizedTenantId}`);
        return;
    }

    try {
        let existingDoc = await BotConfigModel.findOne({ tenantId: normalizedTenantId })
            .lean<BotConfigDocument & { _id?: mongoose.Types.ObjectId }>()
            .exec();

        if (!existingDoc) {
            const legacyDoc = await findLegacyMongoConfig();
            const legacyMoniqoId =
                typeof legacyDoc?.moniqoId === 'string' ? legacyDoc.moniqoId.trim() : '';

            if (legacyDoc && legacyMoniqoId === normalizedTenantId) {
                const migratedConfig = await migrateLegacyDocToTenant(normalizedTenantId, legacyDoc);
                existingDoc = {
                    ...(migratedConfig as BotConfigDocument),
                    tenantId: normalizedTenantId,
                };
            }
        }

        const existingConfig = toPersistentConfig(existingDoc || null);

        const mergedConfig: BotConfigDocument = {
            ...(existingConfig as BotConfigDocument),
            ...config,
            tenantId: normalizedTenantId,
            lastUpdated: new Date().toISOString(),
            updatedBy,
        };

        await BotConfigModel.findOneAndUpdate(
            { tenantId: normalizedTenantId },
            {
                $set: mergedConfig,
                $unset: { configId: '' },
            },
            { upsert: true, setDefaultsOnInsert: true }
        ).exec();

        Logger.info(`Configuration saved to MongoDB for tenant ${normalizedTenantId}`);
    } catch (error) {
        Logger.error(`Failed to save persisted config to MongoDB for tenant ${normalizedTenantId}: ${error}`);
    }
};
