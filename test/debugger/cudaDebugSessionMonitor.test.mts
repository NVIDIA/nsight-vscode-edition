/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import { describe, expect, test } from '@jest/globals';

import {
    CudaDebugSessionMonitor,
    type ActiveCudaContext,
    type DebugSessionIdentity
} from '../../src/debugger/cudaDebugSessionMonitor';

function session(id: string, type = 'cuda-gdb'): DebugSessionIdentity {
    return { id, type };
}

describe('CUDA debug session monitor', () => {
    test('creates exactly one stable stop ID for each stopped event', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        const observed: Array<ActiveCudaContext | undefined> = [];
        sessionMonitor.trackSession(firstSession);
        sessionMonitor.setActiveSession(firstSession);
        sessionMonitor.subscribe({ activeContextChanged: (context) => observed.push(context) });
        observed.length = 0;

        sessionMonitor.handleAdapterEvent('session-1', { type: 'event', seq: 1, event: 'stopped' });
        const firstStop = sessionMonitor.getActiveContext();
        sessionMonitor.handleAdapterEvent('session-1', { type: 'event', seq: 2, event: 'stopped' });
        const secondStop = sessionMonitor.getActiveContext();

        expect(firstStop).toMatchObject({ kind: 'stopped', sessionId: 'session-1' });
        expect(secondStop).toMatchObject({ kind: 'stopped', sessionId: 'session-1' });
        expect(firstStop?.kind === 'stopped' ? firstStop.stopId : undefined).toBeTruthy();
        expect(secondStop?.kind === 'stopped' ? secondStop.stopId : undefined).not.toBe(
            firstStop?.kind === 'stopped' ? firstStop.stopId : undefined
        );
        expect(observed).toEqual([firstStop, secondStop]);

        const replayed: Array<ActiveCudaContext | undefined> = [];
        sessionMonitor.subscribe({ activeContextChanged: (context) => replayed.push(context) });
        expect(replayed).toEqual([secondStop]);
    });

    test.each(['continue', 'next', 'stepIn', 'stepOut'] as const)(
        'moves to running after a successful correlated %s response',
        (command) => {
            const sessionMonitor = new CudaDebugSessionMonitor();
            const firstSession = session('session-1');
            sessionMonitor.trackSession(firstSession);
            sessionMonitor.setActiveSession(firstSession);
            sessionMonitor.handleAdapterEvent('session-1', {
                type: 'event',
                seq: 1,
                event: 'stopped'
            });

            sessionMonitor.handleClientRequest('session-1', {
                type: 'request',
                seq: 10,
                command
            });
            sessionMonitor.handleAdapterResponse('session-1', {
                type: 'response',
                seq: 11,
                request_seq: 10,
                success: true,
                command
            });

            expect(sessionMonitor.getActiveContext()).toEqual({
                kind: 'running',
                sessionId: 'session-1'
            });
        }
    );

    test.each(['pause', 'reverseContinue', 'restart'])(
        "does not treat %s as one of Rubicon's four resume requests",
        (command) => {
            const sessionMonitor = new CudaDebugSessionMonitor();
            const firstSession = session('session-1');
            sessionMonitor.trackSession(firstSession);
            sessionMonitor.setActiveSession(firstSession);
            sessionMonitor.handleAdapterEvent('session-1', {
                type: 'event',
                seq: 1,
                event: 'stopped'
            });
            const stopped = sessionMonitor.getActiveContext();

            sessionMonitor.handleClientRequest('session-1', {
                type: 'request',
                seq: 10,
                command
            });
            sessionMonitor.handleAdapterResponse('session-1', {
                type: 'response',
                seq: 11,
                request_seq: 10,
                success: true,
                command
            });

            expect(sessionMonitor.getActiveContext()).toBe(stopped);
        }
    );

    test('does not let a delayed resume response overwrite a newer stopped event', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        sessionMonitor.trackSession(firstSession);
        sessionMonitor.setActiveSession(firstSession);
        sessionMonitor.handleAdapterEvent('session-1', { type: 'event', seq: 1, event: 'stopped' });

        sessionMonitor.handleClientRequest('session-1', {
            type: 'request',
            seq: 10,
            command: 'next'
        });
        sessionMonitor.handleAdapterEvent('session-1', { type: 'event', seq: 2, event: 'stopped' });
        const newerStop = sessionMonitor.getActiveContext();
        sessionMonitor.handleAdapterResponse('session-1', {
            type: 'response',
            seq: 11,
            request_seq: 10,
            success: true,
            command: 'next'
        });

        expect(sessionMonitor.getActiveContext()).toBe(newerStop);
    });

    test('ignores a successful response whose command does not match the captured request', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        sessionMonitor.trackSession(firstSession);
        sessionMonitor.setActiveSession(firstSession);
        sessionMonitor.handleAdapterEvent('session-1', { type: 'event', seq: 1, event: 'stopped' });
        const stopped = sessionMonitor.getActiveContext();

        sessionMonitor.handleClientRequest('session-1', {
            type: 'request',
            seq: 10,
            command: 'continue'
        });
        sessionMonitor.handleAdapterResponse('session-1', {
            type: 'response',
            seq: 11,
            request_seq: 10,
            success: true,
            command: 'next'
        });

        expect(sessionMonitor.getActiveContext()).toBe(stopped);
    });

    test('tracks inactive sessions without letting them change active command context', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        const secondSession = session('session-2');
        sessionMonitor.trackSession(firstSession);
        sessionMonitor.trackSession(secondSession);
        sessionMonitor.setActiveSession(firstSession);
        const observed: Array<ActiveCudaContext | undefined> = [];
        sessionMonitor.subscribe({ activeContextChanged: (context) => observed.push(context) });
        observed.length = 0;

        sessionMonitor.handleAdapterEvent('session-2', { type: 'event', seq: 1, event: 'stopped' });

        expect(sessionMonitor.getActiveContext()).toEqual({
            kind: 'unavailable',
            sessionId: 'session-1'
        });
        expect(observed).toEqual([]);

        sessionMonitor.setActiveSession(secondSession);
        expect(sessionMonitor.getActiveContext()).toMatchObject({
            kind: 'stopped',
            sessionId: 'session-2'
        });
    });

    test.each(['trackSession', 'setActiveSession'] as const)(
        '%s preserves the stopped context when the session ID is unchanged',
        (refresh) => {
            const sessionMonitor = new CudaDebugSessionMonitor();
            const original = session('session-1');
            const replacement = session('session-1');
            sessionMonitor.trackSession(original);
            sessionMonitor.setActiveSession(original);
            sessionMonitor.handleAdapterEvent('session-1', {
                type: 'event',
                seq: 1,
                event: 'stopped'
            });
            const stopped = sessionMonitor.getActiveContext();

            sessionMonitor[refresh](replacement);

            expect(sessionMonitor.getActiveContext()).toBe(stopped);
        }
    );

    test('notifies focus changes by session and stops only the disposed subscription', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        sessionMonitor.trackSession(session('session-1'));
        const calls: Array<{ subscriber: string; sessionId: string }> = [];
        const first = sessionMonitor.subscribe({
            focusChanged(sessionId) {
                calls.push({ subscriber: 'first', sessionId });
            }
        });
        sessionMonitor.subscribe({
            focusChanged(sessionId) {
                calls.push({ subscriber: 'second', sessionId });
            }
        });

        sessionMonitor.handleAdapterEvent('session-1', {
            type: 'event',
            seq: 1,
            event: 'changedCudaFocus'
        });
        expect(calls).toEqual([
            { subscriber: 'first', sessionId: 'session-1' },
            { subscriber: 'second', sessionId: 'session-1' }
        ]);

        first.dispose();
        first.dispose();
        sessionMonitor.handleAdapterEvent('session-1', {
            type: 'event',
            seq: 2,
            event: 'changedCudaFocus'
        });
        expect(calls).toEqual([
            { subscriber: 'first', sessionId: 'session-1' },
            { subscriber: 'second', sessionId: 'session-1' },
            { subscriber: 'second', sessionId: 'session-1' }
        ]);
    });

    test('isolates throwing subscribers during active and focus fanout', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        const active: Array<ActiveCudaContext | undefined> = [];
        const focusNotifications: string[] = [];
        sessionMonitor.subscribe({
            activeContextChanged() {
                throw new Error('broken active subscriber');
            },
            focusChanged() {
                throw new Error('broken focus subscriber');
            }
        });
        sessionMonitor.subscribe({
            activeContextChanged: (context) => active.push(context),
            focusChanged: (sessionId) => focusNotifications.push(sessionId)
        });
        active.length = 0;

        sessionMonitor.trackSession(firstSession);
        sessionMonitor.setActiveSession(firstSession);
        sessionMonitor.handleAdapterEvent('session-1', {
            type: 'event',
            seq: 1,
            event: 'changedCudaFocus'
        });

        expect(active).toEqual([{ kind: 'unavailable', sessionId: 'session-1' }]);
        expect(focusNotifications).toEqual(['session-1']);
    });

    test('removes terminated sessions and publishes no active CUDA context', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const firstSession = session('session-1');
        sessionMonitor.trackSession(firstSession);
        sessionMonitor.setActiveSession(firstSession);
        const observed: Array<ActiveCudaContext | undefined> = [];
        sessionMonitor.subscribe({ activeContextChanged: (context) => observed.push(context) });
        observed.length = 0;

        sessionMonitor.removeSession('session-1');

        expect(sessionMonitor.getActiveContext()).toBeUndefined();
        expect(sessionMonitor.hasSession('session-1')).toBe(false);
        expect(observed).toEqual([undefined]);
    });

    test('discards inactive session state before same-ID reuse', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const active = session('session-a');
        const inactive = session('session-b');
        sessionMonitor.trackSession(active);
        sessionMonitor.trackSession(inactive);
        sessionMonitor.setActiveSession(active);
        sessionMonitor.handleAdapterEvent('session-b', { type: 'event', seq: 1, event: 'stopped' });

        sessionMonitor.removeSession('session-b');
        sessionMonitor.trackSession(session('session-b'));
        sessionMonitor.setActiveSession(session('session-b'));

        expect(sessionMonitor.getActiveContext()).toEqual({
            kind: 'unavailable',
            sessionId: 'session-b'
        });
    });

    test('ignores non-CUDA sessions and releases all state on disposal', () => {
        const sessionMonitor = new CudaDebugSessionMonitor();
        const javascriptSession = session('javascript-1', 'node');
        const cudaSession = session('cuda-1');
        const observed: Array<ActiveCudaContext | undefined> = [];
        sessionMonitor.subscribe({ activeContextChanged: (context) => observed.push(context) });
        observed.length = 0;

        sessionMonitor.trackSession(javascriptSession);
        sessionMonitor.setActiveSession(javascriptSession);
        expect(sessionMonitor.getActiveContext()).toBeUndefined();
        expect(sessionMonitor.hasSession('javascript-1')).toBe(false);

        sessionMonitor.trackSession(cudaSession);
        sessionMonitor.setActiveSession(cudaSession);
        sessionMonitor.dispose();
        sessionMonitor.handleAdapterEvent('cuda-1', { type: 'event', seq: 1, event: 'stopped' });

        expect(sessionMonitor.getActiveContext()).toBeUndefined();
        expect(sessionMonitor.hasSession('cuda-1')).toBe(false);
        expect(observed).toEqual([{ kind: 'unavailable', sessionId: 'cuda-1' }]);
    });
});
