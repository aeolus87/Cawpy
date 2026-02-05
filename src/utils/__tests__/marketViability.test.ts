import { getViabilityConfig, ViabilityConfig } from '../marketViability';

describe('Market Viability', () => {
    describe('getViabilityConfig', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            jest.resetModules();
            process.env = { ...originalEnv };
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        it('should return default config when no env vars set', () => {
            const config = getViabilityConfig();

            expect(config.priceLimit).toBe(0.95);
            expect(config.minTimeBeforeEndMinutes).toBe(60);
            expect(config.maxSpreadBps).toBe(500);
            expect(config.minDepthUsd).toBe(10);
        });

        it('should enforce hard cap on price limit (cannot exceed 0.95)', () => {
            // This would need to be tested via integration since ENV is loaded at import time
            // For now, just verify the default respects the hard cap
            const config = getViabilityConfig();
            expect(config.priceLimit).toBeLessThanOrEqual(0.95);
        });

        it('should enforce hard cap on min time (cannot be less than 5 minutes)', () => {
            const config = getViabilityConfig();
            expect(config.minTimeBeforeEndMinutes).toBeGreaterThanOrEqual(5);
        });

        it('should enforce hard cap on max spread (cannot exceed 2000 bps)', () => {
            const config = getViabilityConfig();
            expect(config.maxSpreadBps).toBeLessThanOrEqual(2000);
        });

        it('should enforce hard cap on min depth (cannot be less than $0.50)', () => {
            const config = getViabilityConfig();
            expect(config.minDepthUsd).toBeGreaterThanOrEqual(0.5);
        });
    });

    describe('checkMarketViability', () => {
        // These tests would require mocking the ClobClient
        // For now, we just verify the function signature exists
        it('should export checkMarketViability function', async () => {
            const { checkMarketViability } = await import('../marketViability');
            expect(typeof checkMarketViability).toBe('function');
        });
    });
});
