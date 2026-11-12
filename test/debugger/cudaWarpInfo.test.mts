import { test, jest } from '@jest/globals';
import { GDBBackend } from 'cdt-gdb-adapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { CudaGdbSession, CudaGdbBackend } from '../../src/debugger/cudaGdbSession.ts';
import {
    mapLaneRow,
    mapWarpRow,
    parseHexAddress,
    parseLaneMask
} from '../../src/debugger/cudaWarpInfo.ts';
import type * as types from '../../src/debugger/types.ts';

describe('cudaWarpInfo parsers', () => {
    test('parseLaneMask accepts unsigned 32-bit masks only', () => {
        expect(parseLaneMask('0xffffffff')).toBe(0xff_ff_ff_ff);
        expect(parseLaneMask('0x0000ffff')).toBe(0x00_00_ff_ff);
        expect(parseLaneMask('0x100000000')).toBeUndefined();
        expect(parseLaneMask('-1')).toBeUndefined();
        expect(parseLaneMask('')).toBeUndefined();
        expect(parseLaneMask('?')).toBeUndefined();
    });

    test('parseHexAddress preserves precision and produces canonical lowercase text', () => {
        expect(parseHexAddress('0X0020000000000001')).toBe('0x20000000000001');
        expect(parseHexAddress('0x00007BC1C776A650')).toBe('0x7bc1c776a650');
        expect(parseHexAddress('0x0000')).toBe('0x0');
        expect(parseHexAddress('0x00000000000000000001')).toBe('0x1');
        expect(parseHexAddress('0x10000000000000000')).toBeUndefined();
        expect(parseHexAddress(`0x${'0'.repeat(65)}`)).toBeUndefined();
        expect(parseHexAddress('not-an-address')).toBeUndefined();
        expect(parseHexAddress('?')).toBeUndefined();
    });

    test('mapWarpRow builds overview warp without losing address precision', () => {
        const warp = mapWarpRow(
            {
                current: '*',
                warp: '0',
                active_lanes_mask: '0x0000ffff',
                divergent_lanes_mask: '0xffff0000',
                active_physical_pc: '0X0020000000000001',
                kernel: '0',
                blockIdx: '(0,0,0)',
                threadIdx: '(0,0,0)'
            },
            { device: 0, sm: 0 }
        );

        expect(warp).toEqual(
            expect.objectContaining({
                device: 0,
                sm: 0,
                warp: 0,
                kernelId: '0',
                blockIdx: { x: 0, y: 0, z: 0 },
                pc: '0x20000000000001',
                activeMask: 0x00_00_ff_ff,
                divergentMask: 0xff_ff_00_00,
                lanes: [],
                isFocusWarp: true
            })
        );
    });

    test('lane mapping preserves participation independently of reported exceptions', () => {
        const lanes = [
            mapLaneRow({
                current: '*',
                lane: '0',
                state: 'active',
                physical_pc: '0X0020000000000001',
                threadIdx: '(0,0,0)',
                exception: '-'
            }),
            mapLaneRow({
                current: ' ',
                lane: '1',
                state: 'divergent',
                physical_pc: '0x20',
                threadIdx: '(1,0,0)',
                exception: '-'
            }),
            mapLaneRow({
                current: ' ',
                lane: '2',
                state: 'active',
                physical_pc: '0x10',
                threadIdx: '(2,0,0)',
                exception: 'WarpIllegalAddress'
            })
        ];

        expect(lanes[0]).toEqual(
            expect.objectContaining({
                lane: 0,
                state: 'active',
                pc: '0x20000000000001',
                threadIdx: { x: 0, y: 0, z: 0 },
                isFocus: true
            })
        );
        expect(lanes[1].state).toBe('divergent');
        expect(lanes[2]).toEqual(
            expect.objectContaining({
                state: 'active',
                exceptionDetails: 'WarpIllegalAddress'
            })
        );
        expect(mapLaneRow({ lane: '3' }).state).toBeUndefined();
    });

    test.each([
        { thread: '(40,0,0)', blockDim: undefined, expected: 40 },
        { thread: '(3,2,0)', blockDim: { x: 8, y: 4, z: 1 }, expected: 19 },
        { thread: '(0,0,1)', blockDim: { x: 8, y: 4, z: 2 }, expected: 32 },
        { thread: '(7,3,1)', blockDim: { x: 8, y: 4, z: 2 }, expected: 63 },
        { thread: '(0,0,1)', blockDim: undefined, expected: undefined },
        { thread: '(3,2,0)', blockDim: { x: 0, y: 4, z: 1 }, expected: undefined },
        { thread: '?', blockDim: { x: 8, y: 4, z: 2 }, expected: undefined }
    ])(
        'flattens $thread with block dimensions $blockDim to $expected',
        ({ thread, blockDim, expected }) => {
            expect(mapLaneRow({ lane: '0', threadIdx: thread }, blockDim).flatThreadIdx).toBe(
                expected
            );
        }
    );
});

function createWarpDetailSession(sendCommand: (command: string) => Promise<unknown>): {
    getCudaWarpDetails(selection: types.CudaWarpSelection): Promise<types.CudaWarpInfo>;
} {
    return Object.assign(Object.create(CudaGdbSession.prototype), {
        gdb: { sendCommand },
        queryHardwareFocus: () => Promise.resolve({ device: 0, sm: 0, warp: 0, lane: 0 })
    }) as {
        getCudaWarpDetails(selection: types.CudaWarpSelection): Promise<types.CudaWarpInfo>;
    };
}

describe('CUDA warp detail reads', () => {
    const selection = { device: 1, sm: 7, warp: 3 };
    const warp = { warp: '3', kernel: '9' };

    test('queries the selected GPU and SM without switching focus or padding valid lanes', async () => {
        const commands: string[] = [];
        const session = createWarpDetailSession(async (command) => {
            commands.push(command);
            switch (command) {
                case '-cuda-info-warps device 1 sm 7': {
                    return { InfoCudaWarpsTable: { body: [warp] } };
                }
                case '-cuda-info-lanes device 1 sm 7 warp 3 lane all': {
                    return {
                        InfoCudaLanesTable: {
                            body: [
                                {
                                    lane: '0',
                                    state: 'active',
                                    threadIdx: '(0,0,1)',
                                    exception: 'Warp Assert'
                                },
                                { lane: '1', state: 'divergent', threadIdx: '(1,0,1)' }
                            ]
                        }
                    };
                }
                case '-cuda-info-kernels kernel 9': {
                    return {
                        InfoCudaKernelsTable: { body: [{ kernel: '9', blockDim: '(8,4,2)' }] }
                    };
                }
                default: {
                    throw new Error(`Unexpected command: ${command}`);
                }
            }
        });

        const result = await session.getCudaWarpDetails(selection);
        expect(result).toMatchObject({ device: 1, sm: 7, warp: 3, isFocusWarp: false });
        expect(result.lanes).toHaveLength(2);
        expect(result.lanes[0]).toMatchObject({
            state: 'active',
            exceptionDetails: 'Warp Assert',
            flatThreadIdx: 32,
            isFocus: false
        });
        expect(commands).toEqual([
            '-cuda-info-warps device 1 sm 7',
            '-cuda-info-lanes device 1 sm 7 warp 3 lane all',
            '-cuda-info-kernels kernel 9'
        ]);
    });

    test('a failed lane read issues no focus change or restore command', async () => {
        const commands: string[] = [];
        const session = createWarpDetailSession(async (command) => {
            commands.push(command);
            if (command.startsWith('-cuda-info-warps '))
                return { InfoCudaWarpsTable: { body: [warp] } };
            throw new Error('lane query failed');
        });
        await expect(session.getCudaWarpDetails(selection)).rejects.toThrow('lane query failed');
        expect(commands).toEqual([
            '-cuda-info-warps device 1 sm 7',
            '-cuda-info-lanes device 1 sm 7 warp 3 lane all'
        ]);
    });

    test('a missing selected warp cannot fall back to the focused warp', async () => {
        const commands: string[] = [];
        const session = createWarpDetailSession(async (command) => {
            commands.push(command);
            return { InfoCudaWarpsTable: { body: [{ current: '*', warp: '0' }] } };
        });
        await expect(session.getCudaWarpDetails(selection)).rejects.toThrow('no longer present');
        expect(commands).toEqual(['-cuda-info-warps device 1 sm 7']);
    });
});

function overviewSession(
    failSm = false,
    knownDevice = true,
    gridId = '9007199254740995'
): {
    value: {
        getCudaWarpsSnapshot(
            focusOnly?: boolean,
            includeLanes?: boolean
        ): Promise<types.CudaWarpSnapshot>;
    };
    commands: string[];
} {
    const commands: string[] = [];
    const value = Object.assign(Object.create(CudaGdbSession.prototype), {
        threads: [],
        queryHardwareFocus: async () =>
            knownDevice
                ? { type: 'hardware', device: 1, sm: 4, warp: 2, lane: 31 }
                : { type: 'hardware' },
        gdb: {
            sendCommand: async (command: string) => {
                commands.push(command);
                if (command === '-cuda-info-devices')
                    return {
                        InfoCudaDevicesTable: { body: [{ device: '1', name: 'GPU One' }] }
                    };
                if (command === '-cuda-info-sms device 1')
                    return {
                        InfoCudaSmsTable: {
                            body: [
                                { sm: '0', active_warps_mask: '0x1' },
                                { sm: '4', active_warps_mask: '0x4' },
                                { sm: '7', active_warps_mask: '0x0' }
                            ]
                        }
                    };
                if (command === '-cuda-info-kernels device 1')
                    return {
                        InfoCudaKernelsTable: {
                            body: [
                                {
                                    kernel: '9007199254740993',
                                    device: '1',
                                    grid: gridId,
                                    invocation: 'kernel<int>(,args=[])',
                                    blockDim: '(8,4,2)'
                                }
                            ]
                        }
                    };
                if (command.startsWith('-cuda-info-lanes'))
                    return {
                        InfoCudaLanesTable: {
                            body: [
                                {
                                    lane: '31',
                                    state: 'active',
                                    threadIdx: '(7,3,1)',
                                    exception: 'Warp Assert'
                                }
                            ]
                        }
                    };
                if (command === '-cuda-info-warps device 1 sm 4' && failSm) return {};
                if (command.startsWith('-cuda-info-warps'))
                    return {
                        InfoCudaWarpsTable: {
                            body: [
                                {
                                    current: ' ',
                                    warp: '2',
                                    kernel: '9007199254740993',
                                    active_lanes_mask: '0x80000000',
                                    divergent_lanes_mask: '0x1'
                                }
                            ]
                        }
                    };
                throw new Error(command);
            }
        }
    }) as {
        getCudaWarpsSnapshot(
            focusOnly?: boolean,
            includeLanes?: boolean
        ): Promise<types.CudaWarpSnapshot>;
    };
    return { value, commands };
}

describe('GPU-wide CUDA warp inventory', () => {
    test('joins lossless metadata across occupied SMs and maps confirmed focus without row stars', async () => {
        const { value, commands } = overviewSession();
        const result = await value.getCudaWarpsSnapshot();
        expect(result.deviceName).toBe('GPU One');
        expect(result.warps.map((warp) => warp.sm)).toEqual([0, 4]);
        expect(result.warps[1]).toMatchObject({
            kernelId: '9007199254740993',
            gridId: '9007199254740995',
            kernelName: 'kernel<int>',
            isFocusWarp: true
        });
        expect(result.warps[0].isFocusWarp).toBe(false);
        expect(commands).toEqual([
            '-cuda-info-devices',
            '-cuda-info-sms device 1',
            '-cuda-info-kernels device 1',
            '-cuda-info-warps device 1 sm 0',
            '-cuda-info-warps device 1 sm 4'
        ]);
    });
    test('preserves a negative device-launched Grid ID beyond safe integer precision', async () => {
        const { value } = overviewSession(false, true, '-9007199254740995');
        const result = await value.getCudaWarpsSnapshot();
        expect(result.warps.map((warp) => warp.gridId)).toEqual([
            '-9007199254740995',
            '-9007199254740995'
        ]);
        expect(result.warps[0].kernelId).toBe('9007199254740993');
    });
    test('an SM query without its table fails the complete overview', async () => {
        const { value } = overviewSession(true);
        await expect(value.getCudaWarpsSnapshot()).rejects.toThrow('SM 4');
    });
    test('unknown GPU does not default to zero; focus-only reads do not enumerate warps', async () => {
        const missing = overviewSession(false, false);
        expect(await missing.value.getCudaWarpsSnapshot()).toMatchObject({
            warps: [],
            unavailableReason: expect.any(String)
        });
        expect(missing.commands).toEqual([]);
        const focused = overviewSession();
        expect(await focused.value.getCudaWarpsSnapshot(true)).toMatchObject({
            device: 1,
            focus: { lane: 31 }
        });
        expect(focused.commands).toEqual([]);
    });
});

test.each([
    ['-exec cuda thread (1,0,0)', 1, '(1,0,0)'],
    ['-exec cuda kernel 0', 1, '(0,0,0)'],
    ['-exec cuda thread', 0, '(0,0,0)'],
    ['-exec print t', 0, '(0,0,0)']
])(
    'console command %s invalidates the CUDA stack and variables %d time(s)',
    async (expression, count, threadIdx) => {
        const events: { event?: string }[] = [];
        const session = Object.assign(Object.create(CudaGdbSession.prototype), {
            _cudaFocus: {
                type: 'software',
                blockIdx: { x: 0, y: 0, z: 0 },
                threadIdx: { x: 0, y: 0, z: 0 }
            },
            cudaThread: { id: -1 },
            gdb: {
                sendCommand: async () => ({ CudaFocus: { blockIdx: '(0,0,0)', threadIdx } })
            },
            sendResponse: () => {},
            sendEvent: (event: { event?: string }) => events.push(event)
        });
        await session.evaluateRequest({}, { context: 'repl', expression });
        expect(events.filter((event) => event.event === 'invalidated')).toHaveLength(count);
    }
);

test('console focus refresh is emitted even when another GPU has identical logical coordinates', async () => {
    const focus: types.CudaFocus = {
        type: 'software',
        blockIdx: { x: 0, y: 0, z: 0 },
        threadIdx: { x: 0, y: 0, z: 0 }
    };
    const events: unknown[] = [];
    const session = Object.assign(Object.create(CudaGdbSession.prototype), {
        _cudaFocus: focus,
        cudaThread: { id: -1 },
        gdb: {
            sendCommand: async () => ({ CudaFocus: { blockIdx: '(0,0,0)', threadIdx: '(0,0,0)' } })
        },
        sendResponse: () => {},
        sendEvent: (event: unknown) => events.push(event)
    });
    await session.evaluateRequest({}, { context: 'repl', expression: '-exec cuda device 1' });
    expect(events).toEqual([
        expect.objectContaining({ event: 'changedCudaFocus', body: { focus } }),
        expect.objectContaining({
            event: 'invalidated',
            body: { areas: ['stacks', 'variables'], threadId: -1 }
        })
    ]);
});

test.each([
    ['-mi -no-such-command', 'Undefined MI command: no-such-command'],
    ['-mi no-such-command', 'Undefined command: "no-such-command".  Try "help".'],
    ['-exec print {_x}', "A syntax error in expression, near `{_x}'."],
    ['`no-such-command', 'Undefined command: "no-such-command".  Try "help".']
])(
    'a console command that gdb rejects is answered with its error: %s',
    async (expression, message) => {
        const responses: DebugProtocol.Response[] = [];
        const session = Object.assign(Object.create(CudaGdbSession.prototype), {
            gdb: {
                sendCommand: async () => {
                    throw new Error(message);
                }
            },
            sendResponse: (response: DebugProtocol.Response) => responses.push(response)
        });
        await session.evaluateRequest({}, { context: 'repl', expression });
        expect(responses).toEqual([expect.objectContaining({ success: false, message })]);
    }
);

test('only absent CUDA coordinates become unavailable; focus-query failures remain errors', async () => {
    let message = 'No CUDA coordinates found.';
    const session = Object.assign(Object.create(CudaGdbSession.prototype), {
        gdb: {
            sendCommand: async () => {
                throw new Error(message);
            }
        }
    });
    expect(await session.getCudaWarpsSnapshot()).toMatchObject({
        unavailableReason: expect.any(String)
    });
    message = 'Backend connection failed';
    await expect(session.getCudaWarpsSnapshot()).rejects.toThrow(message);
});

describe('queued CUDA focus changes', () => {
    test('checks context after reaching the MI queue and does not execute a stale action', async () => {
        const commands: string[] = [];
        let finish!: (value: unknown) => void;
        const pending = new Promise((resolve) => {
            finish = resolve;
        });
        const send = jest
            .spyOn(GDBBackend.prototype, 'sendCommand')
            .mockImplementation(async (command) => {
                commands.push(command);
                return pending;
            });
        try {
            const backend = new CudaGdbBackend(Object.create(CudaGdbSession.prototype));
            const first = backend.sendCommand('-first');
            let stale = false;
            const focus = backend.changeFocus(
                '-cuda-focus-switch sm 1 warp 0 lane 2',
                0,
                () => {
                    if (stale) throw new Error('stale stop');
                },
                () => {}
            );
            stale = true;
            finish({});
            await first;
            await expect(focus).rejects.toThrow('stale stop');
            expect(commands).toEqual(['-first']);
        } finally {
            send.mockRestore();
        }
    });

    test('GPU validation, switch and confirmation cannot interleave with another MI command', async () => {
        const commands: string[] = [];
        const send = jest
            .spyOn(GDBBackend.prototype, 'sendCommand')
            .mockImplementation(async (command) => {
                commands.push(command);
                return { CudaFocus: { device: '0', sm: '1', warp: '2', lane: '3' } };
            });
        try {
            const backend = new CudaGdbBackend(Object.create(CudaGdbSession.prototype));
            const focus = backend.changeFocus(
                '-cuda-focus-switch device 0 sm 1 warp 2 lane 3',
                0,
                () => {},
                () => {
                    commands.push('confirmed');
                }
            );
            const other = backend.sendCommand('-other');
            await Promise.all([focus, other]);
            expect(commands).toEqual([
                '-cuda-focus-query device',
                '-cuda-focus-switch device 0 sm 1 warp 2 lane 3',
                '-cuda-focus-query device sm warp lane block thread',
                'confirmed',
                '-other'
            ]);
            commands.length = 0;
            await expect(
                backend.changeFocus(
                    '-cuda-focus-switch device 1 sm 1 warp 2 lane 3',
                    1,
                    () => {},
                    () => {}
                )
            ).rejects.toThrow('GPU changed');
            expect(commands).toEqual(['-cuda-focus-query device']);
        } finally {
            send.mockRestore();
        }
    });
});

test.each([
    { switchFails: true, confirmationFails: false },
    { switchFails: true, confirmationFails: true },
    { switchFails: false, confirmationFails: true }
])(
    'focus failure reconciles without a view (switchFails=$switchFails, confirmationFails=$confirmationFails)',
    async ({ switchFails, confirmationFails }) => {
        const originalFocus: types.CudaFocus = {
            type: 'software',
            blockIdx: { x: 0, y: 0, z: 0 },
            threadIdx: { x: 0, y: 0, z: 0 }
        };
        const events: DebugProtocol.Event[] = [];
        const errors: string[] = [];
        const responses: unknown[] = [];
        const commands: string[] = [];
        const send = jest
            .spyOn(GDBBackend.prototype, 'sendCommand')
            .mockImplementation(async (command) => {
                commands.push(command);
                if (command.includes('block (999,') && switchFails)
                    throw new Error('Invalid focus coordinates');
                if (command.includes('focus-query')) {
                    if (confirmationFails) throw new Error('Lost confirmation');
                    return {
                        CudaFocus: {
                            device: '0',
                            sm: '1',
                            warp: '2',
                            lane: '3',
                            blockIdx: '(0,0,0)',
                            threadIdx: '(0,0,0)'
                        }
                    };
                }
                return {};
            });
        try {
            const session = Object.assign(Object.create(CudaGdbSession.prototype), {
                _cudaFocus: originalFocus,
                warpReadEpoch: 7,
                isRunning: false,
                cudaThread: { id: -1 },
                sendEvent: (event: DebugProtocol.Event) => events.push(event),
                sendErrorResponse: (_response: unknown, error: DebugProtocol.Message) =>
                    errors.push(error.format),
                sendResponse: (response: unknown) => responses.push(response)
            });
            session.gdb = new CudaGdbBackend(session);
            await session.changeCudaFocusRequest(
                {},
                {
                    focus: { ...originalFocus, blockIdx: { x: 999, y: 0, z: 0 } }
                }
            );
            expect(errors).toEqual([
                switchFails ? 'Invalid focus coordinates' : 'Lost confirmation'
            ]);
            expect(responses).toEqual([]);
            expect(commands).toEqual([
                '-cuda-focus-switch block (999, 0, 0) thread (0, 0, 0)',
                '-cuda-focus-query device sm warp lane block thread'
            ]);
            if (confirmationFails) {
                expect(session.cudaFocus).toBeUndefined();
                expect(events).toEqual([
                    expect.objectContaining({
                        event: 'changedCudaFocus',
                        body: { focus: undefined }
                    }),
                    expect.objectContaining({ event: 'invalidated' })
                ]);
                await expect(
                    session.gdb.sendCommand('-stack-list-frames --thread -1')
                ).rejects.toThrow('No CUDA thread in focus');
                // A later successful read still recovers from genuinely unknown focus.
                confirmationFails = false;
                await session.queryHardwareFocus();
                expect(session.cudaFocus).toEqual({ type: 'hardware', sm: 1, warp: 2, lane: 3 });
            } else {
                expect(session.cudaFocus).toEqual(originalFocus);
                expect(events.map((event) => event.event)).toEqual(['invalidated']);
                await expect(
                    session.gdb.sendCommand('-stack-list-frames --thread -1')
                ).resolves.toEqual({});
            }
        } finally {
            send.mockRestore();
        }
    }
);

test.each([
    {
        focus: { type: 'software', blockIdx: { x: 999 }, threadIdx: { x: 0 } },
        message: 'Invalid coordinates requested. CUDA focus unchanged.'
    },
    {
        focus: { type: 'software', threadIdx: { x: 5 } },
        message: 'Mixing hardware and software coordinates to change focus is not supported.'
    }
])('a rejected focus change is answered without showUser: $message', async ({ focus, message }) => {
    const responses: DebugProtocol.ErrorResponse[] = [];
    const session = Object.assign(Object.create(CudaGdbSession.prototype), {
        gdb: {
            changeFocus: async () => {
                throw new Error(message);
            }
        },
        sendResponse: (response: DebugProtocol.ErrorResponse) => responses.push(response)
    });
    await session.changeCudaFocusRequest({}, { focus });
    expect(responses).toEqual([expect.objectContaining({ success: false, message })]);
    expect(responses[0].body.error?.showUser).toBeUndefined();
});

describe('eager lane collection in the adapter', () => {
    test('reuses inventory metadata and isolates lane failures without redundant queries', async () => {
        const { value, commands } = overviewSession();
        const session = value as any;
        const original = session.gdb.sendCommand;
        session.gdb.sendCommand = async (command: string) => {
            const result = await original(command);
            if (command === '-cuda-info-lanes device 1 sm 0 warp 2 lane all')
                throw new Error('Lane query failed');
            return result;
        };
        const result = await value.getCudaWarpsSnapshot(false, true);
        expect(commands).toEqual([
            '-cuda-info-devices',
            '-cuda-info-sms device 1',
            '-cuda-info-kernels device 1',
            '-cuda-info-warps device 1 sm 0',
            '-cuda-info-warps device 1 sm 4',
            '-cuda-info-lanes device 1 sm 0 warp 2 lane all',
            '-cuda-info-lanes device 1 sm 4 warp 2 lane all'
        ]);
        expect(result.warps[0]).toMatchObject({
            kernelName: 'kernel<int>',
            lanes: [],
            laneError: 'Lane query failed'
        });
        expect(result.warps[1]).toMatchObject({
            gridId: '9007199254740995',
            lanes: [{ lane: 31, flatThreadIdx: 63, exceptionDetails: 'Warp Assert' }]
        });
    });

    test('uses each kernel block size and refreshes metadata on the next acquisition', async () => {
        const { value } = overviewSession();
        const session = value as any;
        const original = session.gdb.sendCommand;
        let blockDim = '(8,4,2)';
        session.gdb.sendCommand = async (command: string) => {
            const result = await original(command);
            if (command === '-cuda-info-kernels device 1') {
                result.InfoCudaKernelsTable.body[0].blockDim = blockDim;
                result.InfoCudaKernelsTable.body.push({ kernel: '9', blockDim: '(8,8,2)' });
            }
            if (command === '-cuda-info-warps device 1 sm 4')
                result.InfoCudaWarpsTable.body[0].kernel = '9';
            return result;
        };
        const first = await value.getCudaWarpsSnapshot(false, true);
        expect(first.warps.map((warp) => warp.lanes[0].flatThreadIdx)).toEqual([63, 95]);
        blockDim = '(8,12,2)';
        const second = await value.getCudaWarpsSnapshot(false, true);
        expect(second.warps.map((warp) => warp.lanes[0].flatThreadIdx)).toEqual([127, 95]);
    });

    test.each([undefined, 'invalid'])(
        'keeps lane details when block dimensions are %s',
        async (blockDim) => {
            const { value } = overviewSession();
            const session = value as any;
            const original = session.gdb.sendCommand;
            session.gdb.sendCommand = async (command: string) => {
                const result = await original(command);
                if (command === '-cuda-info-kernels device 1')
                    result.InfoCudaKernelsTable.body[0].blockDim = blockDim;
                return result;
            };
            const result = await value.getCudaWarpsSnapshot(false, true);
            for (const warp of result.warps) {
                expect(warp.laneError).toBeUndefined();
                expect(warp.lanes).toHaveLength(1);
                expect(warp.lanes[0].threadIdx).toEqual({ x: 7, y: 3, z: 1 });
                expect(warp.lanes[0].flatThreadIdx).toBeUndefined();
            }
        }
    );

    test.each(['cancel', 'resume'])(
        '%s during a read stops subsequent MI queries and rejects the snapshot',
        async (reason) => {
            const { value, commands } = overviewSession();
            const responses: unknown[] = [],
                errors: string[] = [];
            const session = value as any;
            const original = session.gdb.sendCommand;
            let release!: () => void, entered!: () => void;
            const blocked = new Promise<void>((resolve) => {
                release = resolve;
            });
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            Object.assign(session, {
                warpReadEpoch: 1,
                sendResponse: (response: unknown) => responses.push(response),
                sendErrorResponse: (_response: unknown, _code: number, message: string) =>
                    errors.push(message)
            });
            session.gdb.sendCommand = async (command: string) => {
                if (command === '-cuda-info-lanes device 1 sm 0 warp 2 lane all') {
                    entered();
                    await blocked;
                }
                return original(command);
            };
            const read = session.cudaWarpsRequest({}, { includeLanes: true, requestId: 'read' });
            await started;
            if (reason === 'cancel') {
                session.customRequest(
                    'cancelCudaWarps',
                    { command: 'cancelCudaWarps' },
                    { requestId: 'other' }
                );
                expect(session.warpReadOperation.requestId).toBe('read');
                session.customRequest(
                    'cancelCudaWarps',
                    { command: 'cancelCudaWarps' },
                    { requestId: 'read' }
                );
            } else session.warpReadEpoch++;
            release();
            await read;
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatch(/cancelled|context changed/);
            expect(responses).not.toContainEqual(
                expect.objectContaining({ body: expect.anything() })
            );
            expect(commands.filter((command) => command.startsWith('-cuda-info-lanes'))).toEqual([
                '-cuda-info-lanes device 1 sm 0 warp 2 lane all'
            ]);
        }
    );

    test('checks cancellation after a queued read reaches the backend', async () => {
        const commands: string[] = [];
        let finish!: (value: unknown) => void;
        const pending = new Promise((resolve) => {
            finish = resolve;
        });
        const send = jest
            .spyOn(GDBBackend.prototype, 'sendCommand')
            .mockImplementation(async (command) => {
                commands.push(command);
                return pending;
            });
        try {
            const backend = new CudaGdbBackend(Object.create(CudaGdbSession.prototype));
            const first = backend.sendCommand('-first');
            let cancelled = false;
            const read = backend.sendCommand('-cuda-info-lanes', () => {
                if (cancelled) throw new Error('cancelled');
            });
            cancelled = true;
            finish({});
            await first;
            await expect(read).rejects.toThrow('cancelled');
            expect(commands).toEqual(['-first']);
        } finally {
            send.mockRestore();
        }
    });
});

test('publishes changed focus before stopped, including GPU-to-host transitions, without repeating unchanged focus', async () => {
    const events: DebugProtocol.Event[] = [];
    const session = new CudaGdbSession() as any;
    Object.assign(session, {
        threads: [{ id: 1, running: true }],
        isRunning: true,
        isInitialized: true,
        sendEvent: (event: DebugProtocol.Event) => events.push(event)
    });
    const focus = {
        blockIdx: '(1,2,3)',
        threadIdx: '(4,5,6)'
    };
    for (const [gpuStop, focusChanged] of [
        [true, true],
        [true, false],
        [false, true]
    ]) {
        events.length = 0;
        session.focusNeedsConfirmation = true;
        await session.handleGDBAsync('stopped', {
            reason: 'end-stepping-range',
            'thread-id': '1',
            ...(gpuStop ? { CudaFocus: focus } : {})
        });
        expect(events.map((event) => event.event)).toEqual(
            focusChanged ? ['changedCudaFocus', 'stopped'] : ['stopped']
        );
        const expectedFocus = gpuStop
            ? {
                  type: 'software',
                  blockIdx: { x: 1, y: 2, z: 3 },
                  threadIdx: { x: 4, y: 5, z: 6 }
              }
            : undefined;
        if (focusChanged) expect(events[0].body.focus).toEqual(expectedFocus);
        expect(session.cudaFocus).toEqual(expectedFocus);
        expect(session.focusNeedsConfirmation).toBe(false);
        await session.handleGDBAsync('running', { 'thread-id': 'all' });
        expect(events.at(-1)?.event).toBe('continued');
    }
});

test.each([true, false])(
    'standalone lane Retry stops after resume even when stillRunning=%s',
    async (stillRunning) => {
        const commands: string[] = [],
            errors: string[] = [];
        const responses: unknown[] = [];
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const session = Object.assign(Object.create(CudaGdbSession.prototype), {
            warpReadEpoch: 1,
            isRunning: false,
            gdb: {
                sendCommand: async (command: string) => {
                    commands.push(command);
                    entered();
                    await blocked;
                    return { InfoCudaWarpsTable: { body: [{ warp: '3', kernel: '9' }] } };
                }
            },
            sendResponse: (response: unknown) => responses.push(response),
            sendErrorResponse: (_response: unknown, _code: number, message: string) =>
                errors.push(message)
        });
        const read = session.cudaWarpDetailsRequest(
            {},
            { selection: { device: 1, sm: 7, warp: 3 } }
        );
        await started;
        session.warpReadEpoch++;
        session.isRunning = stillRunning;
        release();
        await read;
        expect(commands).toEqual(['-cuda-info-warps device 1 sm 7']);
        expect(responses).toEqual([]);
        expect(errors).toEqual(['The debugger stop changed while reading lane details.']);
    }
);
