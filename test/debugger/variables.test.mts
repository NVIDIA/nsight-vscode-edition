//import 'jest-extended';
import { test } from '@jest/globals';
import { type DebugProtocol } from '@vscode/debugprotocol';
import { usingWorkspace, type DebugSession, type StackFrame } from './test-client.mts';

const WARP_SIZE = 32;

interface PrimitiveCase {
    category: string;
    local: string;
    global?: string;
    typePattern: RegExp;
    stepMarker: string;
    checkBefore: (value: string) => void;
    checkAfter: (value: string) => void;
    // Extra semantic checks run in the frame after the value checks (e.g. pointer targets).
    verifyBefore?: (frame: StackFrame) => Promise<void>;
    verifyAfter?: (frame: StackFrame) => Promise<void>;
}

const exactMatch = (expected: string) => (value: string) => expect(value).toEqual(expected);

// Whole-string match (optionally with an exponent, e.g. 1.23e+10) so malformed values fail.
const NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

const numericMatch = (expected: number, precision?: number) => (value: string) => {
    expect(value).toMatch(NUMBER_PATTERN);
    if (precision === undefined) {
        expect(Number(value)).toEqual(expected);
    } else {
        expect(Number(value)).toBeCloseTo(expected, precision);
    }
};

// gdb formats char types as `<code> '<glyph>'`; the glyph rendering (ASCII vs octal escape)
// isn't load-bearing, so only the code is compared.
const charMatch = (expected: number) => (value: string) => {
    const match = value.match(/^(-?\d+) '.*'$/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toEqual(expected);
};

const pointerMatch = (value: string): void =>
    expect(value).toMatch(/^(\([^)]*\*\)\s*)?0x[0-9a-f]+(\s.*)?$/i);

async function expectEvaluates(
    frame: StackFrame,
    expression: string,
    expected: string
): Promise<void> {
    expect((await frame.evaluate(expression, 'watch')).result).toEqual(expected);
}

// Each category's local is reassigned (and, except for the pointer, mirrored into a
// same-named global) on the source line marked by `stepMarker`, in the order below.
function primitiveCases(frameKind: 'host' | 'device'): PrimitiveCase[] {
    const g = (suffix: string): string => `g_${frameKind}${suffix}`;
    return [
        {
            category: 'bool',
            local: 'b',
            global: g('Bool'),
            typePattern: /bool/i,
            stepMarker: `📍${frameKind}PrimitivesStepBool`,
            checkBefore: exactMatch('false'),
            checkAfter: exactMatch('true')
        },
        {
            category: 'int',
            local: 'i',
            global: g('Int'),
            typePattern: /^int$/,
            stepMarker: `📍${frameKind}PrimitivesStepInt`,
            checkBefore: exactMatch('-7'),
            checkAfter: exactMatch('55')
        },
        {
            category: 'float',
            local: 'f',
            global: g('Float'),
            typePattern: /^float$/,
            stepMarker: `📍${frameKind}PrimitivesStepFloat`,
            checkBefore: numericMatch(1.25, 3),
            checkAfter: numericMatch(9.5, 3)
        },
        {
            category: 'double',
            local: 'd',
            global: g('Double'),
            typePattern: /^double$/,
            stepMarker: `📍${frameKind}PrimitivesStepDouble`,
            checkBefore: numericMatch(2.5, 6),
            checkAfter: numericMatch(12.75, 6)
        },
        {
            category: 'char',
            local: 'c',
            global: g('Char'),
            typePattern: /^char$/,
            stepMarker: `📍${frameKind}PrimitivesStepChar`,
            checkBefore: charMatch(120), // 'x'
            checkAfter: charMatch(122) // 'z'
        },
        {
            category: 'unsigned int',
            local: 'ui',
            global: g('UInt'),
            typePattern: /^unsigned int$/,
            stepMarker: `📍${frameKind}PrimitivesStepUInt`,
            checkBefore: exactMatch('4000000000'),
            checkAfter: exactMatch('4200000000')
        },
        {
            category: 'unsigned char',
            local: 'uc',
            global: g('UChar'),
            typePattern: /^unsigned char$/,
            stepMarker: `📍${frameKind}PrimitivesStepUChar`,
            checkBefore: charMatch(200),
            checkAfter: charMatch(250)
        },
        {
            category: 'unsigned long',
            local: 'ul',
            global: g('ULong'),
            // GCC/nvcc's DWARF output commonly reorders this to "long unsigned int".
            typePattern: /^(unsigned long|long unsigned int)$/,
            stepMarker: `📍${frameKind}PrimitivesStepULong`,
            checkBefore: exactMatch('100000'),
            checkAfter: exactMatch('200000')
        },
        {
            category: 'pointer',
            local: 'p',
            typePattern: /\*/,
            stepMarker: `📍${frameKind}PrimitivesStepPointer`,
            checkBefore: pointerMatch,
            checkAfter: pointerMatch,
            // `p` starts at arr[0] ({1,2,3}) and is reassigned to &arr[2]. Check what it points
            // to and its position via relative indexing (comparing against `&arr[N]` is
            // unreliable on the device, where locals and generic pointers differ in address space).
            verifyBefore: async (frame) => {
                await expectEvaluates(frame, '*p', '1');
                await expectEvaluates(frame, 'p[2]', '3');
            },
            verifyAfter: async (frame) => {
                await expectEvaluates(frame, '*p', '3');
                await expectEvaluates(frame, 'p[-2]', '1');
            }
        }
    ];
}

// Checks a local's value on the Variables panel, via a Watch-style evaluate, and via a
// hover-style (data tip) evaluate, all three of which must agree.
async function expectLocalAcrossSurfaces(
    frame: StackFrame,
    name: string,
    check: (value: string) => void
): Promise<void> {
    const variable = await frame.local(name);
    check(variable.dap.value);

    const watch = await frame.evaluate(name, 'watch');
    check(watch.result);

    const hover = await frame.evaluate(name, 'hover');
    check(hover.result);
}

// Globals have no dedicated Variables-panel scope in this adapter, so they're only
// reachable (and thus only checked) via Watch and hover evaluation.
async function expectGlobalAcrossSurfaces(
    frame: StackFrame,
    name: string,
    check: (value: string) => void
): Promise<void> {
    const watch = await frame.evaluate(name, 'watch');
    check(watch.result);

    const hover = await frame.evaluate(name, 'hover');
    check(hover.result);
}

// `DebugSession.lastStopStackFrame()` returns the *outermost* frame (e.g. `main`), which
// only ever coincides with the frame we want here because every other caller in this
// file happens to stop on single-frame (CUDA kernel) stacks. Our host breakpoints sit
// several frames deep, so fetch the innermost frame of the last-stopped thread directly
// instead of relying on that helper.
async function innermostFrame(session: DebugSession): Promise<StackFrame> {
    const thread = await session.thread(session.lastStop.threadId!);
    const callStack = await thread.callStack();
    expect(callStack).not.toBeEmpty();
    return callStack[0]!;
}

describe('Variables', () => {
    test('Shows correct value for locals in non-CUDA frame when stopped on a CUDA breakpoint', () =>
        usingWorkspace(async (workspace) => {
            const source = workspace.file('default/concurrent.cu');
            const bp = await source.createBreakpoint({ line: '📍device2' });

            await workspace.startDebugging('default:launch', { args: ['concurrent'] });
            const debug = workspace.debugSession;

            // Hit a breakpoint in the CUDA kernel.
            await bp.waitForBreakCount(1);
            let deviceStackFrame = await debug.lastStopStackFrame();
            await deviceStackFrame.expectNoLocal('argc');
            await deviceStackFrame.expectLocation({ name: 'kernelFunc' });
            const { value: threadNum1 } = await deviceStackFrame.expectLocal(
                'threadNum',
                expect.stringMatching(/\d+/)
            );

            // Switch to main CPU thread and inspect some vars.
            const mainThread = await debug.mainThread();
            const callStack = await mainThread.callStack();
            const concurrentFrame = callStack.find((frame) =>
                frame.location.fileName?.includes('concurrent.cu')
            );
            expect(concurrentFrame).toBeDefined();
            await concurrentFrame!.expectLocation({ file: source, line: ['📍host1', '📍host2'] });
            await concurrentFrame!.expectNoLocal('threadNum');
            await concurrentFrame!.expectLocal('numHostThreads', '1');

            // Verify that argc is available in the actual main frame (but not threadNum)
            const mainFrame = callStack.find((frame) =>
                frame.location.fileName?.includes('default.cu')
            );
            expect(mainFrame).toBeDefined();
            await mainFrame!.expectNoLocal('threadNum');
            await mainFrame!.expectLocal('argc', '2');

            // Switch back to CUDA and check that we're seeing the same vars as before.
            const deviceThread = deviceStackFrame.thread;
            deviceThread.clearCaches();
            deviceStackFrame = await deviceThread.currentStackFrame();
            await deviceStackFrame.expectLocation({ file: source, line: '📍device2' });
            await deviceStackFrame.expectNoLocal('argc');
            const { value: threadNum2 } = await deviceStackFrame.expectLocal(
                'threadNum',
                expect.stringMatching(/\d+/)
            );
            expect(threadNum2).toEqual(threadNum1);
        }));

    describe('CUDA Built-ins', () => {
        test('Scope is absent in host frames', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const cpuBp = await source.createBreakpoint({ line: '📍hostCall' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await cpuBp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const mainThread = await debug.mainThread();
                const frame = await mainThread.currentStackFrame();
                const scopes = await frame.scopes();
                const scopeNames = Object.keys(scopes);
                expect(scopeNames).not.toContain('CUDA Built-ins');
            }));

        test('Scope is present in device frames', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const deviceBp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await deviceBp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const deviceFrame = await debug.lastStopStackFrame();
                const scopes = await deviceFrame.scopes();
                const scopeNames = Object.keys(scopes);
                expect(scopeNames).toContain('CUDA Built-ins');
            }));

        test('Shows all CUDA built-in variables', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await bp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const frame = await debug.lastStopStackFrame();
                const scopes = await frame.scopes();
                const builtins = scopes['CUDA Built-ins'];
                expect(builtins).toBeDefined();

                const variables = await builtins.children();
                const variableNames = Object.keys(variables);
                expect(variableNames).toIncludeAllMembers([
                    'gridDim',
                    'blockIdx',
                    'blockDim',
                    'threadIdx',
                    'warpSize',
                    'PTX Special Registers'
                ]);
            }));

        test('Shows correct values for vector-type built-in variables', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await bp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const frame = await debug.lastStopStackFrame();
                const scopes = await frame.scopes();
                const builtins = scopes['CUDA Built-ins'];
                expect(builtins).toBeDefined();

                const threadIdx = await builtins.var('threadIdx');
                // threadIdx shows formatted value like (0,0,0) and is also expandable
                expect(threadIdx.dap.value).toMatch(/^\(\d+,\d+,\d+\)$/);

                const threadIdxX = await threadIdx.var('x');
                const threadIdxY = await threadIdx.var('y');
                const threadIdxZ = await threadIdx.var('z');
                expect(threadIdxX.dap.value).toMatch(/\d+/);
                expect(threadIdxY.dap.value).toMatch(/\d+/);
                expect(threadIdxZ.dap.value).toMatch(/\d+/);
            }));

        test('Shows correct values for scalar-type built-in variables', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await bp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const frame = await debug.lastStopStackFrame();
                const scopes = await frame.scopes();
                const builtins = scopes['CUDA Built-ins'];
                expect(builtins).toBeDefined();

                const warpSize = await builtins.var('warpSize');
                expect(warpSize.dap.value).toEqual(String(WARP_SIZE));
            }));

        test('Keeps the stopped frame selected after showing built-in variables', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await bp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const outputs: string[] = [];
                debug.dap.on('output', (event: DebugProtocol.OutputEvent) =>
                    outputs.push(event.body.output)
                );
                const frame = await debug.lastStopStackFrame();
                const { Local: local, 'CUDA Built-ins': builtins } = await frame.scopes();
                expect(builtins).toBeDefined();

                // VS Code requests both scopes at once, so their cuda-gdb commands interleave.
                const [locals] = await Promise.all([local.children(), builtins.children()]);
                expect(locals).toContainKey('idx');

                const threadIdx = await builtins.var('threadIdx');
                await threadIdx.var('x');

                // Debug Console commands run in cuda-gdb's selected frame.
                await frame.evaluate('-exec print idx', 'repl');
                expect(outputs).toContainEqual(expect.stringMatching(/^\$\d+ = /));
            }));

        describe('PTX Special Registers', () => {
            test('Subgroup exists and is expandable', () =>
                usingWorkspace(async (workspace) => {
                    const source = workspace.file('default/variables.cu');
                    const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                    await workspace.startDebugging('default:launch', { args: ['variables'] });
                    await bp.waitForBreakCount(1);

                    const debug = workspace.debugSession;
                    const frame = await debug.lastStopStackFrame();
                    const scopes = await frame.scopes();
                    const builtins = scopes['CUDA Built-ins'];
                    const ptxRegisters = await builtins.var('PTX Special Registers');

                    // Check that it's a container by seeing if it has children
                    const ptxChildren = await ptxRegisters.children();
                    expect(Object.keys(ptxChildren).length).toBeGreaterThan(0);
                }));

            test('Shows correct PTX registers and values', () =>
                usingWorkspace(async (workspace) => {
                    const source = workspace.file('default/variables.cu');
                    const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                    await workspace.startDebugging('default:launch', { args: ['variables'] });
                    await bp.waitForBreakCount(1);

                    const debug = workspace.debugSession;
                    const frame = await debug.lastStopStackFrame();
                    const scopes = await frame.scopes();
                    const builtins = scopes['CUDA Built-ins'];
                    const ptxRegisters = await builtins.var('PTX Special Registers');
                    const ptxChildren = await ptxRegisters.children();

                    const laneId = ptxChildren['%laneid'];
                    expect(laneId).toBeDefined();
                    const laneIdValue = Number(laneId.dap.value.match(/\d+/)?.[0]);
                    expect(laneIdValue).toBeGreaterThanOrEqual(0);
                    expect(laneIdValue).toBeLessThan(WARP_SIZE);

                    const smId = ptxChildren['%smid'];
                    expect(smId).toBeDefined();
                    expect(smId.dap.value).toMatch(/\d+/);
                }));
        });

        test('Evaluates variables on hover', () =>
            usingWorkspace(async (workspace) => {
                const source = workspace.file('default/variables.cu');
                const bp = await source.createBreakpoint({ line: '📍cudaComputeHash' });

                await workspace.startDebugging('default:launch', { args: ['variables'] });
                await bp.waitForBreakCount(1);

                const debug = workspace.debugSession;
                const frame = await debug.lastStopStackFrame();
                const scopes = await frame.scopes();
                const builtins = scopes['CUDA Built-ins'];

                // Test a standard built-in
                const blockIdx = await builtins.var('blockIdx');
                const blockIdxY = await blockIdx.var('y');
                const blockIdxYValue = blockIdxY.dap.value;

                const evalBlockIdxY = await debug.dap.send('evaluate', {
                    expression: 'blockIdx.y',
                    frameId: frame.dap.id,
                    context: 'hover'
                });
                expect(evalBlockIdxY.body.result).toEqual(blockIdxYValue);
            }));
    });

    describe('Primitive Types', () => {
        test.each([
            ['host', 'variables-primitives-host'],
            ['device', 'variables-primitives-device']
        ] as const)(
            'Shows correct names, types, and values for %s locals and globals',
            (frameKind, testProp) =>
                usingWorkspace(async (workspace) => {
                    const source = workspace.file('default/variables.cu');
                    const entryBp = await source.createBreakpoint({
                        line: `📍${frameKind}PrimitivesEntry`
                    });

                    const session = await workspace.startDebugging('default:launch', {
                        args: [testProp]
                    });
                    await entryBp.waitForBreakCount(1);

                    const cases = primitiveCases(frameKind);

                    let frame = await innermostFrame(session);

                    // Nothing has been reassigned yet: every local and global should still hold its
                    // initial value, with the type reported for each local matching its declaration.
                    for (const c of cases) {
                        const variable = await frame.local(c.local);
                        expect(variable.dap.type).toMatch(c.typePattern);

                        await expectLocalAcrossSurfaces(frame, c.local, c.checkBefore);
                        if (c.global !== undefined) {
                            await expectGlobalAcrossSurfaces(frame, c.global, c.checkBefore);
                        }
                        await c.verifyBefore?.(frame);
                    }

                    // Consume the entry marker's no-op line so the next step lands on the first
                    // category's assignment (about to execute, not yet executed).
                    await session.stepOverAndExpect();
                    frame = await innermostFrame(session);

                    // Step through each category's assignment in turn. Stepping over category N's
                    // line executes its reassignment and lands on category N+1's line, so we assert
                    // category N's new value (local and mirrored global) right after that step.
                    for (const c of cases) {
                        // Sanity-check alignment between the case table and the source markers
                        // before relying on it to interpret the step we're about to take.
                        await frame.expectLocation({ file: source, line: c.stepMarker });

                        await session.stepOverAndExpect();
                        frame = await innermostFrame(session);

                        await expectLocalAcrossSurfaces(frame, c.local, c.checkAfter);
                        if (c.global !== undefined) {
                            await expectGlobalAcrossSurfaces(frame, c.global, c.checkAfter);
                        }
                        await c.verifyAfter?.(frame);
                    }
                })
        );
    });
});
