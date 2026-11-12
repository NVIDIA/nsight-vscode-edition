/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { beforeEach, describe, expect, test, jest } from '@jest/globals';
import waitForExpect from 'wait-for-expect';
import { CudaDebugProtocol } from '../../src/debugger/cudaDebugProtocol';
import { resetDebugSessionStateForTesting, setCudaFocus } from '../../src/debugSessionState';
import type { CudaWarpSnapshot, CudaWarpInfo } from '../../src/debugger/types';
import {
    CudaDebugSessionMonitor,
    type DebugSessionIdentity
} from '../../src/debugger/cudaDebugSessionMonitor';
import { WarpInfoController } from '../../src/webviews/warpInfo/integration/controller';
import type { WarpViewState } from '../../src/webviews/warpInfo/model';
import { readAdapterSnapshot } from '../../src/webviews/warpInfo/integration/acquisition';

const detail = (selection: {
    device: number;
    sm: number;
    warp: number;
}): { warp: CudaWarpInfo } => ({
    warp: {
        ...selection,
        lanes: [
            {
                lane: 0,
                state: 'active',
                exceptionDetails: 'Warp Assert',
                threadIdx: { x: 0, y: 0, z: 1 },
                pc: '0x20000000000001'
            }
        ]
    }
});
const overview = (device = 0, lane = 0): { snapshot: CudaWarpSnapshot } => ({
    snapshot: {
        device,
        deviceName: 'Test GPU',
        stopEpoch: 7,
        focus: { type: 'hardware', sm: 0, warp: 0, lane },
        warps: [0, 4].map((sm) => ({
            device,
            sm,
            warp: 0,
            kernelId: '8',
            gridId: '9007199254740993',
            kernelName: 'kernel',
            activeMask: 0xff_ff_ff_ff,
            divergentMask: 0,
            lanes: detail({ device, sm, warp: 0 }).warp.lanes
        }))
    }
});
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let complete!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        complete = resolve;
    });
    return { promise, resolve: complete };
}
function setup(handler?: (command: string, args: any) => Promise<unknown>): {
    sessionMonitor: CudaDebugSessionMonitor;
    calls: jest.Mock<
        (sessionId: string, command: CudaDebugProtocol.Request, args: any) => Promise<unknown>
    >;
    session: DebugSessionIdentity;
    states: WarpViewState[];
    controller: WarpInfoController;
} {
    const sessionMonitor = new CudaDebugSessionMonitor();
    const calls = jest.fn(
        async (_sessionId: string, command: CudaDebugProtocol.Request, args: any) => {
            if (command === 'cancelCudaWarps') return undefined;
            return handler
                ? handler(command, args)
                : command === 'cudaWarps'
                  ? overview()
                  : detail(args.selection);
        }
    );
    const session = { id: 'a', type: 'cuda-gdb' };
    setCudaFocus(session.id, overview().snapshot.focus);
    sessionMonitor.setActiveSession(session);
    sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 1, event: 'stopped' });
    const states: WarpViewState[] = [];
    const controller = new WarpInfoController(
        sessionMonitor,
        calls as CudaDebugProtocol.SendRequest,
        (value) => states.push(value)
    );
    return { sessionMonitor, calls, session, states, controller };
}
const settle = async (
    controller: WarpInfoController,
    kind: WarpViewState['kind'] = 'ready'
): Promise<void> => {
    await waitForExpect(() => expect(controller.state.kind).toBe(kind));
};

beforeEach(resetDebugSessionStateForTesting);

describe('live Warp Info acquisition', () => {
    test('host stops skip loading and requests while preserving later CUDA focus changes', async () => {
        const { controller, sessionMonitor, calls, states } = setup();
        controller.setVisible(true);
        await settle(controller);
        const previousStop = sessionMonitor.getActiveContext();

        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 2, event: 'continued' });
        setCudaFocus('a', undefined);
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 3,
            event: 'changedCudaFocus',
            body: { focus: undefined }
        });
        calls.mockClear();
        states.length = 0;
        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 4, event: 'stopped' });

        expect(sessionMonitor.getActiveContext()).toMatchObject({ kind: 'stopped' });
        expect(sessionMonitor.getActiveContext()).not.toBe(previousStop);
        expect(controller.state).toMatchObject({
            kind: 'unavailable',
            message: 'No CUDA GPU is selected at this stop.'
        });
        expect(controller.state).not.toHaveProperty('snapshot');
        expect(states.some((state) => state.kind === 'loading')).toBe(false);
        controller.setVisible(false);
        controller.setVisible(true);
        expect(calls).not.toHaveBeenCalled();

        const focus = overview().snapshot.focus;
        setCudaFocus('a', focus);
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 5,
            event: 'changedCudaFocus',
            body: { focus }
        });
        await settle(controller);
        expect(calls).toHaveBeenCalledTimes(2);
        expect(calls).toHaveBeenNthCalledWith(1, 'a', CudaDebugProtocol.Request.cudaWarps, {
            focusOnly: true
        });
        expect(calls).toHaveBeenNthCalledWith(2, 'a', CudaDebugProtocol.Request.cudaWarps, {
            includeLanes: true,
            requestId: expect.any(String)
        });
        controller.dispose();
    });

    test('recreating the controller with unconfirmed focus still acquires data', async () => {
        const { controller: previous, sessionMonitor, calls } = setup();
        previous.dispose();
        setCudaFocus('a', undefined);
        const controller = new WarpInfoController(
            sessionMonitor,
            calls as CudaDebugProtocol.SendRequest,
            () => {}
        );
        controller.setVisible(true);
        await settle(controller);
        expect(calls).toHaveBeenCalledExactlyOnceWith('a', CudaDebugProtocol.Request.cudaWarps, {
            includeLanes: true,
            requestId: expect.any(String)
        });
        controller.dispose();
    });

    test('uses one request, retains per-warp errors, and retries only the failed warp', async () => {
        const pending = deferred<unknown>();
        const { controller, calls, states } = setup(async (command, args) =>
            command === 'cudaWarps' ? pending.promise : detail(args.selection)
        );
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledExactlyOnceWith('a', CudaDebugProtocol.Request.cudaWarps, {
            includeLanes: true,
            requestId: expect.any(String)
        });
        expect(states.some((state) => state.kind === 'ready')).toBe(false);
        const result = overview();
        result.snapshot.warps[0].gridId = '-9007199254740993';
        result.snapshot.warps[1].lanes = [];
        result.snapshot.warps[1].laneError = 'lane request failed';
        pending.resolve(result);
        await settle(controller);
        if (controller.state.kind !== 'ready') throw new Error('not ready');
        expect(controller.state.snapshot.warps[0].gridId).toBe('-9007199254740993');
        expect(controller.state.snapshot.warps[0].lanes?.[0]).toMatchObject({
            exception: 'Warp Assert',
            thread: [0, 0, 1],
            pc: '0x20000000000001'
        });
        expect(controller.state.snapshot.warps[1]).toMatchObject({
            lanes: null,
            laneError: 'lane request failed'
        });
        await controller.retry(controller.state.revision, { sm: 4, warp: 0 });
        expect(controller.state.snapshot.warps[1].laneError).toBeUndefined();
        expect(calls).toHaveBeenLastCalledWith('a', CudaDebugProtocol.Request.cudaWarpDetails, {
            selection: { device: 0, sm: 4, warp: 0 }
        });
        expect(calls).toHaveBeenCalledTimes(2);
        controller.dispose();
    });

    test.each([
        ['continued', 'running'],
        ['exited', 'unavailable'],
        ['terminated', 'unavailable'],
        ['removed', 'no-session']
    ] as const)(
        'clears on %s and ignores an outstanding inventory response',
        async (event, kind) => {
            const pending = deferred<unknown>();
            const { controller, sessionMonitor, calls } = setup(() => pending.promise);
            controller.setVisible(true);
            if (event === 'removed') sessionMonitor.removeSession('a');
            else sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 2, event });
            expect(controller.state.kind).toBe(kind);
            pending.resolve(overview());
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(controller.state.kind).toBe(kind);
            expect(calls).toHaveBeenCalledTimes(2);
            expect(calls).toHaveBeenLastCalledWith('a', CudaDebugProtocol.Request.cancelCudaWarps, {
                requestId: calls.mock.calls[0][2].requestId
            });
            controller.dispose();
        }
    );

    test('clears ready data on shutdown and waits for a new stop across same-ID restart', async () => {
        const { controller, sessionMonitor, session, calls } = setup();
        sessionMonitor.resetSession(session);
        controller.setVisible(true);
        expect(controller.state).toMatchObject({
            kind: 'unavailable',
            message: 'No stopped CUDA context is available.'
        });
        expect(calls).not.toHaveBeenCalled();

        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 2, event: 'stopped' });
        await settle(controller);
        const revision = controller.state.revision;

        sessionMonitor.invalidateStoppedContext('a');
        expect(controller.state).toMatchObject({
            kind: 'unavailable',
            message: 'No stopped CUDA context is available.'
        });
        expect(controller.state).not.toHaveProperty('snapshot');
        expect(sessionMonitor.hasSession('a')).toBe(true);
        await controller.focusLane(revision, { sm: 0, warp: 0, lane: 0 });
        await controller.retry(controller.state.revision);
        sessionMonitor.resetSession(session);
        expect(calls).toHaveBeenCalledTimes(1);

        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 3, event: 'stopped' });
        await settle(controller);
        expect(calls).toHaveBeenCalledTimes(2);
        controller.dispose();
    });

    test('ignores late lane results after a session switch', async () => {
        const pending = deferred<unknown>();
        const { controller, sessionMonitor, calls } = setup(() => pending.promise);
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledTimes(1);
        sessionMonitor.setActiveSession({
            id: 'b',
            type: 'cuda-gdb'
        });
        pending.resolve(overview());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.state).toMatchObject({ kind: 'unavailable', sessionId: 'b' });
        expect(calls).toHaveBeenCalledTimes(2);
        expect(calls).toHaveBeenLastCalledWith('a', CudaDebugProtocol.Request.cancelCudaWarps, {
            requestId: calls.mock.calls[0][2].requestId
        });
        controller.dispose();
    });

    test('hiding stops further queries, revealing restarts incomplete work and reuses a complete snapshot', async () => {
        const pending = deferred<unknown>();
        let slow = true;
        const { controller, calls } = setup(async () => (slow ? pending.promise : overview()));
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledTimes(1);
        controller.setVisible(false);
        pending.resolve(overview());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toHaveBeenLastCalledWith('a', CudaDebugProtocol.Request.cancelCudaWarps, {
            requestId: calls.mock.calls[0][2].requestId
        });
        slow = false;
        controller.setVisible(true);
        await settle(controller);
        const count = calls.mock.calls.length;
        controller.setVisible(false);
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledTimes(count);
        controller.dispose();
    });

    test('focus-only changes do not reacquire lanes; GPU changes do', async () => {
        let device = 0,
            lane = 0;
        const { controller, sessionMonitor, calls } = setup(async (command, args) =>
            command === 'cudaWarps'
                ? args.focusOnly
                    ? { snapshot: { ...overview(device, lane).snapshot, warps: [] } }
                    : overview(device, lane)
                : detail(args.selection)
        );
        controller.setVisible(true);
        await settle(controller);
        lane = 1;
        const focus = (): void =>
            sessionMonitor.handleAdapterEvent('a', {
                type: 'event',
                seq: 2,
                event: 'changedCudaFocus',
                body: { focus: { type: 'hardware', sm: 0, warp: 0, lane } }
            });
        focus();
        await waitForExpect(() =>
            expect(controller.state.kind === 'ready' && controller.state.snapshot.focus?.lane).toBe(
                1
            )
        );
        expect(
            calls.mock.calls.filter(
                ([, command, args]) => command === 'cudaWarps' && args.includeLanes
            )
        ).toHaveLength(1);
        device = 1;
        focus();
        await waitForExpect(() =>
            expect(controller.state.kind === 'ready' && controller.state.snapshot.device.id).toBe(1)
        );
        expect(
            calls.mock.calls.filter(
                ([, command, args]) => command === 'cudaWarps' && args.includeLanes
            )
        ).toHaveLength(2);
        controller.dispose();
    });

    test('publishes a confirmed GPU change even if that GPU inventory fails', async () => {
        let device = 0;
        const { controller, sessionMonitor, states } = setup(async (_command, args) => {
            if (args.focusOnly) return { snapshot: { ...overview(device).snapshot, warps: [] } };
            if (device === 1) throw new Error('GPU inventory failed');
            return overview(device);
        });
        controller.setVisible(true);
        await settle(controller);
        device = 1;
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 2,
            event: 'changedCudaFocus',
            body: { focus: { type: 'hardware', sm: 0, warp: 0, lane: 0 } }
        });
        await settle(controller, 'error');
        expect(states).toContainEqual(expect.objectContaining({ kind: 'loading', deviceId: 1 }));
        expect(controller.state).toMatchObject({ kind: 'error', deviceId: 1 });
        controller.dispose();
    });

    test('hiding during focus resolution cannot reuse a snapshot from the previous GPU', async () => {
        const pending = deferred<unknown>();
        let device = 0;
        const { controller, sessionMonitor } = setup(async (command, args) =>
            command === 'cudaWarps'
                ? args.focusOnly
                    ? pending.promise
                    : overview(device)
                : detail(args.selection)
        );
        controller.setVisible(true);
        await settle(controller);
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 2,
            event: 'changedCudaFocus',
            body: { focus: { type: 'hardware', sm: 0, warp: 0, lane: 0 } }
        });
        controller.setVisible(false);
        device = 1;
        pending.resolve({ snapshot: { ...overview(1).snapshot, warps: [] } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.state.kind).toBe('loading');
        controller.setVisible(true);
        await settle(controller);
        expect(controller.state.kind === 'ready' && controller.state.snapshot.device.id).toBe(1);
        controller.dispose();
    });

    test('newer confirmed focus wins over a snapshot still collecting lanes', async () => {
        const pending = deferred<unknown>();
        const { controller, sessionMonitor, calls } = setup(async (command, args) =>
            command === 'cudaWarps'
                ? args.focusOnly
                    ? { snapshot: { ...overview(0, 31).snapshot, warps: [] } }
                    : pending.promise
                : detail(args.selection)
        );
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledTimes(1);
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 2,
            event: 'changedCudaFocus',
            body: { focus: { type: 'hardware', sm: 0, warp: 0, lane: 31 } }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        pending.resolve(overview());
        await settle(controller);
        expect(controller.state.kind === 'ready' && controller.state.snapshot.focus?.lane).toBe(31);
        controller.dispose();
    });

    test('overview failure exposes retry; unavailable GPU never falls back to device zero', async () => {
        let fail = true;
        const { controller, calls } = setup(async () => {
            if (fail) throw new Error('SM 4 failed');
            return { snapshot: { warps: [], unavailableReason: 'No CUDA GPU is selected.' } };
        });
        controller.setVisible(true);
        await settle(controller, 'error');
        fail = false;
        await controller.retry(controller.state.revision);
        expect(controller.state).toMatchObject({
            kind: 'unavailable',
            message: 'No CUDA GPU is selected.'
        });
        expect(calls).toHaveBeenCalledTimes(2);
        controller.dispose();
    });

    test('background session termination leaves the active data intact; disposal ignores later events', async () => {
        const { controller, sessionMonitor, calls } = setup();
        controller.setVisible(true);
        await settle(controller);
        sessionMonitor.trackSession({
            id: 'b',
            type: 'cuda-gdb'
        });
        sessionMonitor.removeSession('b');
        expect(controller.state.kind).toBe('ready');
        controller.dispose();
        const count = calls.mock.calls.length;
        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 3, event: 'stopped' });
        expect(calls).toHaveBeenCalledTimes(count);
    });

    test('invalid identities and duplicate warps fail the whole inventory', () => {
        expect(() =>
            readAdapterSnapshot({
                snapshot: { device: 0, warps: [{ device: 0, sm: '4', warp: 0 }] }
            })
        ).toThrow('identity');
        const value = overview();
        value.snapshot.warps.push(value.snapshot.warps[0]);
        expect(() => readAdapterSnapshot(value)).toThrow('duplicate');
    });
});

describe('Warp Info focus and preferences', () => {
    test('uses confirmed responses without an event and allows only one pending focus action', async () => {
        const pending = deferred<unknown>();
        let sm = 0;
        const { controller, calls } = setup(async (command, args) => {
            if (command === 'changeCudaFocus') {
                await pending.promise;
                sm = 4;
                return { focus: { type: 'hardware', sm, warp: 0, lane: 0 } };
            }
            if (command === 'cudaWarpDetails') return detail(args.selection);
            const value = overview();
            value.snapshot.focus = { type: 'hardware', sm, warp: 0, lane: 0 };
            return value;
        });
        controller.setVisible(true);
        await settle(controller);
        const revision = controller.state.revision;
        await controller.focusLane(revision, { sm: 0, warp: 0, lane: 31 });
        expect(calls).toHaveBeenCalledTimes(1);
        const change = controller.focusLane(revision, { sm: 4, warp: 0, lane: 0 });
        expect(controller.state).toMatchObject({
            pendingFocus: { sm: 4 },
            focusBlocked: true,
            snapshot: { focus: { sm: 0 } }
        });
        await controller.focusLane(revision, { sm: 0, warp: 0, lane: 0 });
        expect(
            calls.mock.calls.filter(([, command]) => command === 'changeCudaFocus')
        ).toHaveLength(1);
        expect(calls).toHaveBeenCalledWith('a', CudaDebugProtocol.Request.changeCudaFocus, {
            focus: { type: 'hardware', sm: 4, warp: 0, lane: 0 },
            expectedContext: { device: 0, stopEpoch: 7 }
        });
        pending.resolve({});
        await change;
        expect(controller.state).toMatchObject({
            kind: 'ready',
            pendingFocus: undefined,
            focusBlocked: false,
            snapshot: { focus: { sm: 4 } }
        });
        expect(calls).toHaveBeenCalledTimes(2);
        // Selecting the same lane can succeed without emitting a focus event.
        await controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        expect(calls).toHaveBeenCalledTimes(3);
        controller.dispose();
    });

    test.each([false, true])(
        'reuses event confirmation when it finishes before the action response: %s',
        async (confirmBeforeResponse) => {
            const response = deferred<unknown>();
            const confirmation = deferred<unknown>();
            const { controller, sessionMonitor, calls } = setup(async (command, args) => {
                if (command === 'changeCudaFocus') {
                    sessionMonitor.handleAdapterEvent('a', {
                        type: 'event',
                        seq: 2,
                        event: 'changedCudaFocus',
                        body: { focus: { type: 'hardware', sm: 4, warp: 0, lane: 0 } }
                    });
                    return response.promise;
                }
                return args.focusOnly ? confirmation.promise : overview();
            });
            controller.setVisible(true);
            await settle(controller);
            const change = controller.focusLane(controller.state.revision, {
                sm: 4,
                warp: 0,
                lane: 0
            });
            const value = overview();
            value.snapshot.focus = { type: 'hardware', sm: 4, warp: 0, lane: 0 };
            if (confirmBeforeResponse) {
                confirmation.resolve(value);
                await waitForExpect(() =>
                    expect(controller.state).toMatchObject({
                        pendingFocus: { sm: 4 },
                        snapshot: { focus: { sm: 4 } }
                    })
                );
                response.resolve({ focus: overview().snapshot.focus });
            } else {
                response.resolve({ focus: overview().snapshot.focus });
                await new Promise((resolve) => setTimeout(resolve, 0));
                expect(controller.state.pendingFocus).toBeDefined();
                confirmation.resolve(value);
            }
            await change;
            expect(controller.state).toMatchObject({
                kind: 'ready',
                pendingFocus: undefined,
                snapshot: { focus: { sm: 4 } }
            });
            expect(calls.mock.calls.filter((call) => call[2].focusOnly)).toHaveLength(1);
            controller.dispose();
        }
    );

    test.each([undefined, { focus: { type: 'hardware', sm: 4, warp: 0, lane: 32 } }])(
        'queries focus when the successful response is unusable: %j',
        async (response) => {
            const { controller, calls } = setup(async (command) =>
                command === 'changeCudaFocus' ? response : overview()
            );
            controller.setVisible(true);
            await settle(controller);
            await controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
            expect(calls).toHaveBeenCalledTimes(3);
            expect(calls).toHaveBeenLastCalledWith('a', CudaDebugProtocol.Request.cudaWarps, {
                focusOnly: true
            });
            expect(controller.state).toMatchObject({
                kind: 'ready',
                pendingFocus: undefined,
                snapshot: { focus: { sm: 0, warp: 0, lane: 0 } }
            });
            controller.dispose();
        }
    );

    test('an older focus read cannot overwrite the confirmed action response', async () => {
        const older = deferred<unknown>();
        const { controller, sessionMonitor, calls } = setup(async (command, args) => {
            if (command === 'changeCudaFocus')
                return { focus: { type: 'hardware', sm: 4, warp: 0, lane: 0 } };
            return args.focusOnly ? older.promise : overview();
        });
        controller.setVisible(true);
        await settle(controller);
        sessionMonitor.handleAdapterEvent('a', {
            type: 'event',
            seq: 2,
            event: 'changedCudaFocus'
        });
        await controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        older.resolve(overview());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.state).toMatchObject({ snapshot: { focus: { sm: 4 } } });
        controller.setVisible(false);
        controller.setVisible(true);
        expect(calls).toHaveBeenCalledTimes(3);
        controller.dispose();
    });

    test('blocks focus during a pending resume and re-enables it after rejection', async () => {
        const { controller, calls, sessionMonitor } = setup();
        controller.setVisible(true);
        await settle(controller);
        const stopped = sessionMonitor.getActiveContext();
        sessionMonitor.handleClientRequest('a', { type: 'request', seq: 5, command: 'next' });
        expect(controller.state.focusBlocked).toBe(true);
        await controller.focusLane(controller.state.revision, { sm: 0, warp: 0, lane: 0 });
        expect(calls).toHaveBeenCalledTimes(1);
        sessionMonitor.handleAdapterResponse('a', {
            type: 'response',
            seq: 6,
            request_seq: 5,
            command: 'next',
            success: false
        });
        expect(controller.state.focusBlocked).toBe(false);
        expect(sessionMonitor.getActiveContext()).toBe(stopped);
        controller.dispose();
    });

    test('reconciles rejected focus without discarding the usable table; unknown focus clears its arrow', async () => {
        let unknown = false;
        const { controller } = setup(async (command, args) => {
            if (command === 'changeCudaFocus') throw new Error('Focus rejected');
            if (command === 'cudaWarpDetails') return detail(args.selection);
            if (args.focusOnly && unknown) throw new Error('Focus query failed');
            return overview();
        });
        controller.setVisible(true);
        await settle(controller);
        await controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        expect(controller.state).toMatchObject({
            kind: 'ready',
            focusError: 'Focus rejected',
            snapshot: { focus: { sm: 0 } }
        });
        unknown = true;
        setCudaFocus('a', undefined);
        await controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        expect(controller.state).toMatchObject({
            kind: 'ready',
            pendingFocus: undefined,
            snapshot: { focus: null }
        });
        controller.dispose();
    });

    test('late focus completion cannot repopulate a resumed context', async () => {
        const pending = deferred<unknown>();
        const { controller, sessionMonitor } = setup(async (command, args) =>
            command === 'changeCudaFocus'
                ? pending.promise
                : command === 'cudaWarps'
                  ? overview()
                  : detail(args.selection)
        );
        controller.setVisible(true);
        await settle(controller);
        const action = controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 4, event: 'continued' });
        pending.resolve({ focus: { type: 'hardware', sm: 4, warp: 0, lane: 0 } });
        await action;
        expect(controller.state).toMatchObject({ kind: 'running', pendingFocus: undefined });
        controller.dispose();
    });

    test('recreation cancels pending view intent and requires fresh confirmation', async () => {
        const pending = deferred<unknown>();
        const { controller } = setup(async (command, args) =>
            command === 'changeCudaFocus'
                ? pending.promise
                : command === 'cudaWarps'
                  ? overview()
                  : detail(args.selection)
        );
        controller.setVisible(true);
        await settle(controller);
        const action = controller.focusLane(controller.state.revision, { sm: 4, warp: 0, lane: 0 });
        controller.setVisible(false);
        controller.resetView();
        expect(controller.state).toMatchObject({ kind: 'loading', pendingFocus: undefined });
        pending.resolve({ focus: { type: 'hardware', sm: 4, warp: 0, lane: 0 } });
        await action;
        expect(controller.state.kind).toBe('loading');
        controller.setVisible(true);
        await settle(controller);
        controller.dispose();
    });

    test('preferences survive recreation and stepping, validate input, and remain session-local', async () => {
        const { controller, sessionMonitor, session, states } = setup();
        controller.setVisible(true);
        await settle(controller);
        const publicationCount = states.length;
        const preferences = { filter: 'kernel', sort: { column: 'pc', direction: 'descending' } };
        controller.savePreferences('a', preferences);
        controller.savePreferences('a', { ...preferences, filter: '[' });
        expect(states).toHaveLength(publicationCount);
        expect(controller.state.preferences).toEqual(preferences);
        controller.setVisible(false);
        controller.resetView();
        controller.setVisible(true);
        expect(states.at(-1)?.preferences).toEqual(preferences);
        sessionMonitor.handleAdapterEvent('a', { type: 'event', seq: 4, event: 'continued' });
        expect(controller.state.preferences).toEqual(preferences);
        sessionMonitor.setActiveSession({
            id: 'b',
            type: 'cuda-gdb'
        });
        expect(controller.state.preferences).toMatchObject({ filter: '', sort: { column: 'sm' } });
        controller.savePreferences('a', { ...preferences, filter: 'stale' });
        sessionMonitor.setActiveSession(session);
        expect(controller.state.preferences).toEqual(preferences);
        controller.dispose();
    });
});
