import { jest } from '@jest/globals';
import path from 'node:path';

import { generateDapLogFilePath } from '../../src/debugger/dapMessageLogger.ts';

describe('generateDapLogFilePath', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('gives sessions started in the same millisecond different files', () => {
        jest.useFakeTimers({ now: new Date('2026-11-02T14:02:08.157Z') });

        const first = generateDapLogFilePath('2631e06f-4855-41c7-b42d-729eff998186');
        const second = generateDapLogFilePath('2ab85154-d532-42c5-ad60-ae1d1b59ae6a');

        expect(first).not.toBe(second);
        expect(path.basename(first)).toBe('2026-11-02T14-02-08-157Z-2631e06f.log');
    });
});
