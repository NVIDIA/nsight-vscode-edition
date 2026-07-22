import { type Config } from '@jest/types';

export default {
    testEnvironment: './jest.environment.mjs',
    testTimeout: 10_000,
    testMatch: ['<rootDir>/test/**/*.test.mts'],
    setupFilesAfterEnv: ['<rootDir>/test/setup.mts'],
    extensionsToTreatAsEsm: ['.ts', '.mts'],
    silent: true,
    transform: {
        '[.]m?[jt]sx?$': '<rootDir>/jest.transform.mts'
    },
    moduleNameMapper: {
        '^vscode$': '<rootDir>/test/mocks/vscode.mts'
    },
    // Force serial execution to avoid GPU driver contention between parallel cuda-gdb processes
    maxWorkers: 1
} satisfies Config.InitialOptions;
