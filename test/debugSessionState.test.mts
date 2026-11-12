import { jest } from '@jest/globals';

import type * as types from '../src/debugger/types.ts';
import {
    clearDebugSessionState,
    getCudaFocus,
    onDidChangeDebugSessionState,
    resetDebugSessionStateForTesting,
    setCudaFocus
} from '../src/debugSessionState.ts';

const focusA: types.CudaFocus = { type: 'software', blockIdx: { x: 1, y: 0, z: 0 } };
const focusB: types.CudaFocus = { type: 'software', blockIdx: { x: 2, y: 0, z: 0 } };

beforeEach(() => {
    resetDebugSessionStateForTesting();
});

describe('debugSessionState', () => {
    test('keeps sessions apart', () => {
        setCudaFocus('a', focusA);
        setCudaFocus('b', focusB);

        expect(getCudaFocus('a')).toEqual(focusA);
        expect(getCudaFocus('b')).toEqual(focusB);
        expect(getCudaFocus('c')).toBeUndefined();
    });

    test('notifies listeners with the session id until disposed', () => {
        const listener = jest.fn();
        const subscription = onDidChangeDebugSessionState(listener);

        setCudaFocus('a', focusA);
        setCudaFocus('b', focusB);
        expect(listener.mock.calls).toEqual([['a'], ['b']]);

        subscription.dispose();
        setCudaFocus('a', focusB);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('clearing removes the entry and notifies once', () => {
        const listener = jest.fn();
        onDidChangeDebugSessionState(listener);
        setCudaFocus('a', focusA);

        clearDebugSessionState('a');
        clearDebugSessionState('a');

        expect(getCudaFocus('a')).toBeUndefined();
        expect(listener.mock.calls).toEqual([['a'], ['a']]);
    });
});
