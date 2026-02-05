module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },
    // Transform ES modules in node_modules that Jest can't handle
    transformIgnorePatterns: ['node_modules/(?!chalk|ora|#ansi-styles)/'],
    // Mock chalk to avoid ES module issues
    moduleNameMapper: {
        '^chalk$': '<rootDir>/__mocks__/chalk.js',
    },
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/test/**', '!src/scripts/**'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    verbose: true,
};
