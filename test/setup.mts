import { jest, expect } from '@jest/globals';
import jestExtended from 'jest-extended';

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
    console.info('Debugger detected; disabling test timeout.');
    jest.setTimeout(1_000_000_000);
}

expect.extend(jestExtended);
