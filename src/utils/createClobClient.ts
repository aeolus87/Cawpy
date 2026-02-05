import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;

const GNOSIS_SAFE_ABI = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
];

/**
 * Determines if a wallet is a Gnosis Safe by calling Safe methods.
 * (Many Polymarket proxy wallets are contracts too, so "has bytecode" is not enough.)
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);
        if (!code || code === '0x') {
            return false;
        }

        const safe = new ethers.Contract(address, GNOSIS_SAFE_ABI, provider);
        const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);

        if (!Array.isArray(owners) || owners.length === 0) {
            return false;
        }

        // threshold is a BigNumber in ethers v5
        if (
            !threshold ||
            typeof threshold.gt !== 'function' ||
            typeof threshold.lte !== 'function'
        ) {
            return false;
        }

        return threshold.gt(0) && threshold.lte(owners.length);
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);
    const signerAddress = wallet.address.toLowerCase();

    // Detect if the proxy wallet is a Gnosis Safe or Polymarket Proxy
    const isProxySafe = await isGnosisSafe(PROXY_WALLET as string);
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.POLY_PROXY;

    Logger.info(`Wallet type detected: ${isProxySafe ? 'Gnosis Safe' : 'Polymarket Proxy Wallet'}`);
    Logger.info(
        `Signer address: ${signerAddress}, Proxy wallet: ${(PROXY_WALLET as string).toLowerCase()}`
    );

    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        signatureType,
        PROXY_WALLET as string
    );

    // Suppress console output during API key creation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    let creds;

    // For Gnosis Safe, always ensure API key is created with correct signature type
    // by deleting any existing key and recreating it
    if (isProxySafe) {
        try {
            Logger.info('Gnosis Safe detected - ensuring API key uses correct signature type...');
            // Try to derive existing key first
            const derivedCreds = await clobClient.deriveApiKey();
            if (derivedCreds?.key) {
                Logger.info(
                    'Found existing API key, deleting to recreate with correct signature type...'
                );
                // Create a temporary client with derived creds to delete the old key
                const tempClient = new ClobClient(
                    host,
                    chainId,
                    wallet,
                    derivedCreds,
                    signatureType,
                    PROXY_WALLET as string
                );
                try {
                    await tempClient.deleteApiKey();
                    Logger.info('Old API key deleted successfully');
                } catch (deleteError: any) {
                    const deleteMsg =
                        deleteError?.response?.data?.error || deleteError?.message || '';
                    // If deletion fails because key doesn't exist, that's fine - continue to create
                    if (!deleteMsg.includes('not found') && !deleteMsg.includes('does not exist')) {
                        Logger.warning(`Failed to delete old API key: ${deleteMsg}`);
                    }
                }
            }
        } catch (deriveError: any) {
            // If derivation fails, key might not exist - that's fine, we'll create one
            const deriveMsg = deriveError?.response?.data?.error || deriveError?.message || '';
            if (!deriveMsg.includes('not found') && !deriveMsg.includes('does not exist')) {
                Logger.info(`No existing API key found or derivation failed: ${deriveMsg}`);
            }
        }

        // Now create a new API key with the correct signature type
        try {
            creds = await clobClient.createApiKey();
            if (creds?.key) {
                Logger.info('API key created successfully with POLY_GNOSIS_SAFE signature type');
            }
        } catch (createError: any) {
            const errorMsg = createError?.response?.data?.error || createError?.message || '';
            Logger.error(`Failed to create API key: ${errorMsg}`);
            throw new Error(`Failed to create API key for Gnosis Safe: ${errorMsg}`);
        }
    } else {
        // For Polymarket Proxy wallets, use standard flow
        try {
            creds = await clobClient.createApiKey();
            if (creds?.key) {
                Logger.info('API key created successfully');
            }
        } catch (createError: any) {
            const errorMsg = createError?.response?.data?.error || createError?.message || '';
            Logger.warning(`API key creation failed: ${errorMsg}`);

            // If creation fails because key exists, try to derive it
            if (errorMsg.includes('already exists') || errorMsg.includes('exists')) {
                try {
                    Logger.info('Attempting to derive existing API key...');
                    creds = await clobClient.deriveApiKey();
                    if (creds?.key) {
                        Logger.info('API key derived successfully');
                    }
                } catch (deriveError: any) {
                    Logger.warning(
                        `API key derivation failed: ${deriveError?.response?.data?.error || deriveError?.message}`
                    );
                }
            }
        }

        if (!creds?.key) {
            try {
                Logger.info('Attempting to derive API key...');
                creds = await clobClient.deriveApiKey();
                if (creds?.key) {
                    Logger.info('API key derived successfully');
                }
            } catch (deriveError: any) {
                Logger.error(
                    `API key derivation failed: ${deriveError?.response?.data?.error || deriveError?.message}`
                );
                throw new Error(
                    'Failed to obtain Polymarket API credentials. Please check your wallet and try again.'
                );
            }
        }
    }

    if (!creds?.key) {
        throw new Error('Failed to obtain Polymarket API credentials');
    }

    clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        signatureType,
        PROXY_WALLET as string
    );

    // Restore console functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

export default createClobClient;
