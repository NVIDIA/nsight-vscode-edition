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

import { afterEach, beforeEach, describe, expect, test, jest } from '@jest/globals';

const vscode = (() => {
    const statusBarItems: Array<{
        command?: string;
        text: string;
        show: jest.Mock<(...args: any[]) => any>;
        hide: jest.Mock<(...args: any[]) => any>;
        dispose: jest.Mock<(...args: any[]) => any>;
    }> = [];
    const trackerFactories = new Map<
        string,
        { createDebugAdapterTracker(session: unknown): unknown }
    >();
    const disposable = (): { dispose: jest.Mock<(...args: any[]) => any> } => ({
        dispose: jest.fn()
    });
    return {
        Disposable: {
            from: (...items: Array<{ dispose(): void }>) => ({
                dispose: () => {
                    for (const item of items) item.dispose();
                }
            })
        },
        StatusBarAlignment: { Right: 2 },
        statusBarItems,
        window: {
            createStatusBarItem: jest.fn(() => {
                const item = {
                    text: '',
                    show: jest.fn(),
                    hide: jest.fn(),
                    dispose: jest.fn()
                };
                statusBarItems.push(item);
                return item;
            })
        },
        debug: {
            activeDebugSession: undefined as DebugSession | undefined,
            activeDebugConsole: { appendLine: jest.fn() },
            onDidChangeActiveDebugSession:
                jest.fn<
                    (
                        listener: (session: DebugSession | undefined) => void
                    ) => ReturnType<typeof disposable>
                >(disposable),
            onDidStartDebugSession:
                jest.fn<
                    (listener: (session: DebugSession) => void) => ReturnType<typeof disposable>
                >(disposable),
            onDidTerminateDebugSession:
                jest.fn<
                    (listener: (session: DebugSession) => void) => ReturnType<typeof disposable>
                >(disposable),
            registerDebugAdapterDescriptorFactory: jest.fn(disposable),
            registerDebugAdapterTrackerFactory: jest.fn(
                (
                    type: string,
                    factory: { createDebugAdapterTracker(session: unknown): unknown }
                ) => {
                    trackerFactories.set(type, factory);
                    return disposable();
                }
            )
        },
        commands: {
            registerCommand: jest.fn(disposable)
        },
        trackerFactories
    };
})();

jest.unstable_mockModule('vscode', () => vscode);
// These tests exercise controller/tracker wiring, not server startup or SSH.
for (const name of ['CudaGdbServerSession', 'CudaQnxGdbServerSession']) {
    const file = name[0].toLowerCase() + name.slice(1);
    jest.unstable_mockModule(
        new URL(`../../src/debugger/${file}.ts`, import.meta.url).pathname,
        () => ({
            [name]: jest.fn()
        })
    );
}

const { activateDebugController, createCudaRequestSender } = await import(
    '../../src/debugController'
);
const { getCudaFocus, resetDebugSessionStateForTesting, setCudaFocus } = await import(
    '../../src/debugSessionState'
);
import { CudaDebugProtocol } from '../../src/debugger/cudaDebugProtocol';
import {
    CudaDebugSessionMonitor,
    type DebugSessionIdentity
} from '../../src/debugger/cudaDebugSessionMonitor';

interface DebugSession extends DebugSessionIdentity {
    readonly name: string;
    readonly configuration: Record<string, unknown>;
    customRequest(command: string, args?: unknown): Promise<unknown>;
}

interface TestTracker {
    onWillStartSession(): void;
    onWillStopSession(): void;
    onWillReceiveMessage(message: unknown): void;
    onDidSendMessage(message: unknown): void;
}

function session(id: string): DebugSession {
    return {
        id,
        type: 'cuda-gdb',
        name: id,
        configuration: { request: 'launch', dapLogFilePath: '/dev/null' },
        customRequest: async () => undefined
    };
}

const subscriptions: Array<{ dispose(): void }> = [];
function activated(): {
    sessionMonitor: CudaDebugSessionMonitor;
    tracker(handle: DebugSession): TestTracker;
} {
    const sessionMonitor = new CudaDebugSessionMonitor();
    subscriptions.push(sessionMonitor);
    createCudaRequestSender({ subscriptions } as never);
    activateDebugController({ subscriptions } as never, sessionMonitor);
    return {
        sessionMonitor,
        tracker: (handle: DebugSession): TestTracker =>
            vscode.trackerFactories
                .get('cuda-gdb')!
                .createDebugAdapterTracker(handle) as TestTracker
    };
}

function activateSession(handle: DebugSession | undefined): void {
    vscode.debug.activeDebugSession = handle;
    for (const [listener] of vscode.debug.onDidChangeActiveDebugSession.mock.calls)
        listener(handle);
}

function dispose(): void {
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
}

beforeEach(() => {
    jest.clearAllMocks();
    resetDebugSessionStateForTesting();
    vscode.debug.activeDebugSession = undefined;
    vscode.statusBarItems.length = 0;
    vscode.trackerFactories.clear();
});
afterEach(dispose);

describe('debug controller CUDA session integration', () => {
    test('forwards tracker stop events and matching resume requests/responses to the monitor', () => {
        const { sessionMonitor, tracker } = activated();
        const handle = session('session-1');
        const adapter = tracker(handle);
        adapter.onWillStartSession();
        activateSession(handle);
        adapter.onDidSendMessage({ type: 'event', seq: 1, event: 'stopped' });
        expect(sessionMonitor.getActiveContext()).toMatchObject({
            kind: 'stopped',
            sessionId: handle.id
        });

        adapter.onWillReceiveMessage({ type: 'request', seq: 10, command: 'continue' });
        expect(sessionMonitor.isResumePending(handle.id)).toBe(true);
        adapter.onDidSendMessage({
            type: 'response',
            seq: 11,
            request_seq: 10,
            command: 'continue',
            success: true
        });
        expect(sessionMonitor.getActiveContext()).toEqual({
            kind: 'running',
            sessionId: handle.id
        });
        expect(sessionMonitor.isResumePending(handle.id)).toBe(false);

        adapter.onDidSendMessage({ type: 'event', seq: 12, event: 'stopped' });
        adapter.onDidSendMessage({ type: 'event', seq: 13, event: 'continued' });
        expect(sessionMonitor.getActiveContext()?.kind).toBe('running');
        adapter.onWillStopSession();
    });

    test.each(['terminated', 'exited'] as const)(
        'preserves active identity across DAP %s and same-ID adapter restart',
        (event) => {
            const { sessionMonitor, tracker } = activated();
            const handle = session('session-1');
            const adapter = tracker(handle);
            activateSession(handle);
            adapter.onWillStartSession();
            adapter.onDidSendMessage({ type: 'event', seq: 1, event: 'stopped' });
            const stopped = sessionMonitor.getActiveContext();
            adapter.onDidSendMessage({
                type: 'event',
                seq: 2,
                event: 'changedCudaFocus',
                body: { focus: { type: 'hardware', sm: 7, warp: 3, lane: 11 } }
            });

            adapter.onDidSendMessage({ type: 'event', seq: 3, event });
            expect(sessionMonitor.getActiveContext()).toEqual({
                kind: 'unavailable',
                sessionId: handle.id
            });
            adapter.onWillStopSession();
            expect(getCudaFocus(handle.id)).toBeUndefined();
            const restarted = tracker(handle);
            restarted.onWillStartSession();
            expect(sessionMonitor.getActiveContext()).toEqual({
                kind: 'unavailable',
                sessionId: handle.id
            });
            restarted.onDidSendMessage({ type: 'event', seq: 1, event: 'stopped' });
            expect(sessionMonitor.getActiveContext()).toMatchObject({
                kind: 'stopped',
                sessionId: handle.id
            });
            expect(sessionMonitor.getActiveContext()).not.toEqual(stopped);
            restarted.onWillStopSession();
        }
    );

    test('shares focus with the active status bar and wires VS Code lifecycle subscriptions/disposal', () => {
        const { sessionMonitor, tracker } = activated();
        const first = session('first'),
            second = session('second');
        for (const [listener] of vscode.debug.onDidStartDebugSession.mock.calls) {
            listener(first);
            listener(second);
        }
        expect(sessionMonitor.hasSession(second.id)).toBe(true);
        activateSession(first);
        const firstTracker = tracker(first),
            secondTracker = tracker(second);
        const focus = { type: 'hardware', sm: 7, warp: 3, lane: 11 } as const;
        const observed = jest.fn((id: string) => getCudaFocus(id));
        sessionMonitor.subscribe({ focusChanged: observed });
        secondTracker.onDidSendMessage({
            type: 'event',
            seq: 1,
            event: 'changedCudaFocus',
            body: { focus }
        });
        expect(observed).toHaveBeenCalledWith(second.id);
        expect(observed.mock.results[0].value).toEqual(focus);
        const item = vscode.statusBarItems[0];
        expect(item.text).toBe('CUDA: (?, ?, ?) (?, ?, ?)');
        activateSession(second);
        expect(item.text).toBe('CUDA: sm 7 warp 3 lane 11');
        expect(item.show).toHaveBeenCalled();

        for (const [listener] of vscode.debug.onDidTerminateDebugSession.mock.calls)
            listener(first);
        expect(sessionMonitor.hasSession(first.id)).toBe(false);
        expect(sessionMonitor.getActiveContext()?.sessionId).toBe(second.id);
        for (const [listener] of vscode.debug.onDidTerminateDebugSession.mock.calls)
            listener(second);
        expect(sessionMonitor.getActiveContext()).toBeUndefined();
        activateSession(undefined);
        expect(item.hide).toHaveBeenCalled();
        firstTracker.onWillStopSession();
        secondTracker.onWillStopSession();
        dispose();
        expect(item.dispose).toHaveBeenCalledTimes(1);
        for (const event of [
            vscode.debug.onDidStartDebugSession,
            vscode.debug.onDidChangeActiveDebugSession,
            vscode.debug.onDidTerminateDebugSession
        ]) {
            for (const result of event.mock.results)
                expect((result.value as { dispose: jest.Mock }).dispose).toHaveBeenCalledTimes(1);
        }
        const text = item.text;
        vscode.debug.activeDebugSession = second;
        setCudaFocus(second.id, focus);
        expect(item.text).toBe(text);
        expect(sessionMonitor.hasSession(second.id)).toBe(false);
    });

    test('routes requests by session ID across selection changes and releases ended sessions', async () => {
        const sendRequest = createCudaRequestSender({ subscriptions } as never);
        const first = session('first'),
            second = session('second');
        const body = { snapshot: { device: 0, warps: [] } };
        const firstRequest = jest.spyOn(first, 'customRequest').mockResolvedValue(body);
        const secondRequest = jest.spyOn(second, 'customRequest');
        activateSession(first);
        activateSession(second);

        const args = { includeLanes: true, requestId: 'first-read' };
        await expect(
            sendRequest(first.id, CudaDebugProtocol.Request.cudaWarps, args)
        ).resolves.toBe(body);
        expect(firstRequest).toHaveBeenCalledExactlyOnceWith(
            CudaDebugProtocol.Request.cudaWarps,
            args
        );
        expect(secondRequest).not.toHaveBeenCalled();

        const replacement = session(first.id);
        const replacementRequest = jest.spyOn(replacement, 'customRequest');
        for (const [listener] of vscode.debug.onDidStartDebugSession.mock.calls)
            listener(replacement);
        await sendRequest(first.id, CudaDebugProtocol.Request.cancelCudaWarps, {
            requestId: 'first-read'
        });
        expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
            CudaDebugProtocol.Request.cancelCudaWarps,
            { requestId: 'first-read' }
        );
        expect(firstRequest).toHaveBeenCalledTimes(1);
        expect(secondRequest).not.toHaveBeenCalled();

        for (const [listener] of vscode.debug.onDidTerminateDebugSession.mock.calls)
            listener(replacement);
        await expect(
            sendRequest(first.id, CudaDebugProtocol.Request.cudaWarps, {})
        ).rejects.toThrow('no longer available');
        dispose();
        await expect(
            sendRequest(second.id, CudaDebugProtocol.Request.cudaWarps, {})
        ).rejects.toThrow('no longer available');
    });
});
