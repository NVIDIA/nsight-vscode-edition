import { type DebugProtocol } from '@vscode/debugprotocol';
import waitForExpect from 'wait-for-expect';
import { type DebugSession, type Workspace, usingWorkspace } from './test-client.mts';

// default.cu has no markers; its dispatch line runs before the selected test prop.
async function dispatchLine(ws: Workspace): Promise<number> {
    const lines = await ws.file('default/default.cu').readAllLines();
    const index = lines.findIndex((line) => line.includes('return it->second();'));
    expect(index).toBeGreaterThanOrEqual(0);
    return index + 1;
}

function captureOutputs(session: DebugSession): string[] {
    const outputs: string[] = [];
    session.dap.on('output', (event: DebugProtocol.OutputEvent) => outputs.push(event.body.output));
    return outputs;
}

function trackTermination(session: DebugSession): () => boolean {
    let terminated = false;
    session.dap.on('terminated', () => (terminated = true));
    return () => terminated;
}

describe('Breakpoints', () => {
    // ===== LINE-BASED BREAKPOINTS =====
    describe('Line-based breakpoints', () => {
        test('Set line breakpoint on __global__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍cudaComputeHash' });

                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Set line breakpoint on __device__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍cudaComputeHashInner' });

                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Set line breakpoint on __device__ __host__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍addNums' });
                const session = await src.startDebugging();

                // First hit (from host code)
                await bp.waitForBreakCount(1);

                // Continue to get second hit (from device code)
                await session.continue();
                await bp.waitForBreakCount(2);

                // Once the device code is loaded this breakpoint has two locations, which GDB
                // reports with a different MI shape; it must still be tracked and verified.
                bp.expectToBeVerified();
            }));

        test('Set line breakpoint while program is running', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                await src.startDebugging();

                const bp = await src.createBreakpoint({ line: '📍device1' });

                await bp.waitForBreakCount(1);
            }));

        test('Set line breakpoint while program is paused', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp1 = await src.createBreakpoint({ line: '📍cudaComputeHashInner' });

                const session = await src.startDebugging();
                await bp1.waitForBreakCount(1);

                const bp2 = await src.createBreakpoint({ line: '📍loopInside' });

                await session.continue();

                await bp2.waitForBreakCount(1);
            }));

        test('Continue resumes execution after hitting a breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍addNums' });
                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);
                await session.continue();
                await bp.waitForBreakCount(2);
            }));

        test('Remove line breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bpInside = await src.createBreakpoint({ line: '📍loopInside' });
                const bpAfter = await src.createBreakpoint({ line: '📍loopAfter' });

                const session = await src.startDebugging();
                await bpInside.waitForBreakCount(1);
                await bpInside.remove();

                await session.continue();
                await bpAfter.waitForBreakCount(1);
                expect(bpInside.breakCount).toBe(1);
                expect(bpAfter.breakCount).toBe(1);
            }));

        test('Duplicate line breakpoints at same location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');

                const bp1 = await src.createBreakpoint({ line: '📍addNums' });
                const bp2 = await src.createBreakpoint({ line: '📍addNums' });

                await src.startDebugging();
                await bp1.waitForBreakCount(1);
                await bp2.waitForBreakCount(1);
            }));

        test('Remove breakpoint before starting debugging', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');

                const bp = await src.createBreakpoint({ line: '📍addNums' });
                await bp.remove();

                await src.startDebugging();
                expect(bp.breakCount).toBe(0);
            }));

        test('Breakpoint after loop can be hit alone', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍loopAfter' });
                await src.startDebugging();
                await bp.waitForBreakCount(1);
                expect(bp.breakCount).toBe(1);
            }));
    });

    // ===== FUNCTION BREAKPOINTS =====
    describe('Function breakpoints', () => {
        test('Set function breakpoint on __global__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'cudaComputeHash' });

                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Set function breakpoint on __device__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'cudaComputeHashInner' });

                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Set function breakpoint on __device__ __host__ function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'addNums' });
                const session = await src.startDebugging();

                // First hit (from device code)
                await bp.waitForBreakCount(1);

                // Continue to get second hit (from host code)
                await session.continue();
                await bp.waitForBreakCount(2);
            }));

        test('Set function breakpoint on class method', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'Multiplier::mul' });

                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Set function breakpoint while program is running', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                await src.startDebugging();

                const bp = await src.createFunctionBreakpoint({ name: 'kernelFunc' });
                await bp.waitForBreakCount(1);
            }));

        test('Enable/disable function breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({
                    name: 'cudaComputeHashInner',
                    isEnabled: false
                });

                await src.startDebugging();
                expect(bp.breakCount).toBe(0);

                await bp.enable();
                await src.startDebugging();
                await bp.waitForBreakCount(1);
            }));

        test('Replace function breakpoint while program is paused', async () => {
            await usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');

                const bp1 = await src.createFunctionBreakpoint({ name: 'cudaComputeHashInner' });

                const session = await src.startDebugging();

                await bp1.waitForBreakCount(1);

                await bp1.remove();
                const src2 = ws.file('default/variables.cu');
                const bp2 = await src2.createFunctionBreakpoint({ name: 'addNums' });

                await session.continue();
                await bp2.waitForBreakCount(1);

                expect(bp1.breakCount).toBe(1);
                expect(bp2.breakCount).toBe(1);
            });
        });

        test('Duplicate function breakpoints at same location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp1 = await src.createFunctionBreakpoint({ name: 'addNums' });
                const bp2 = await src.createFunctionBreakpoint({ name: 'addNums' });

                await src.startDebugging();
                await bp1.waitForBreakCount(1);
                await bp2.waitForBreakCount(1);
            }));

        test('Mixed line and function breakpoints', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');

                const lineNumber = await src.lineNumber('📍cudaComputeHashInner');
                const bp1 = await src.createBreakpoint({ line: lineNumber });

                await src.startDebugging();
                await bp1.waitForBreakCount(1);

                await bp1.remove();
                const src2 = ws.file('default/variables.cu');
                const bp2 = await src2.createFunctionBreakpoint({ name: 'addNums' });

                await src.startDebugging();
                await bp2.waitForBreakCount(1);

                expect(bp1.breakCount).toBe(1);
                expect(bp2.breakCount).toBe(1);
            }));
    });

    // ===== CONDITIONAL BREAKPOINTS =====
    describe('Conditional breakpoints', () => {
        test('Conditional breakpoint with equality', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    condition: 'i == 3'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();
                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '3' }) })
                );
            }));

        test('Conditional breakpoint with comparison operator', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    condition: 'i > 2'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '3' }) })
                );
            }));

        test('Conditional breakpoint with range', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    condition: 'i >= 5 && i <= 7'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                const i = Number(locals.i?.value);
                expect(i).toBeGreaterThanOrEqual(5);
                expect(i).toBeLessThanOrEqual(7);
            }));

        test('Conditional breakpoint with arithmetic expression', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    condition: 'i * 2 == 8'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '4' }) })
                );
            }));

        test('Conditional function breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createFunctionBreakpoint({
                    name: 'singleThreadKernel',
                    condition: 'iterations == 10'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(
                    expect.objectContaining({
                        iterations: expect.objectContaining({ value: '10' })
                    })
                );
            }));
    });

    // ===== HITCOUNT BREAKPOINTS =====
    describe('Hitcount breakpoints (single thread)', () => {
        test('Hitcount on device function ', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');

                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    hitCondition: '3'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '2' }) })
                );
            }));

        test('Combined conditional and hitcount', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    condition: 'i == 5',
                    hitCondition: '1'
                });
                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '5' }) })
                );
            }));

        test('Hitcount with greater than syntax', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({
                    line: '📍loopIteration',
                    hitCondition: '> 5'
                });
                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(
                    expect.objectContaining({ i: expect.objectContaining({ value: '5' }) })
                );
            }));

        test('Hitcount with function breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');

                const bp = await src.createFunctionBreakpoint({
                    name: 'singleThreadKernel',
                    hitCondition: '1'
                });

                const session = await ws.startDebugging('default:launch', {
                    args: ['single-thread-warp']
                });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);
            }));
    });

    // ===== BREAKPOINT VERIFICATION AND PLACEMENT =====
    describe('Breakpoint verification and placement', () => {
        test('Line breakpoint on comment line is moved to valid location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 1 });

                await src.startDebugging();
                bp.expectToBeVerified();
            }));

        test('Line breakpoint on empty line stays pending', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 25 });

                await src.startDebugging();
                bp.expectToBePending();
            }));

        test('Line breakpoint on include stays pending', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 26 });

                await src.startDebugging();
                bp.expectToBePending();
            }));

        test('Line breakpoint on nonexistant line stays pending', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 99_999_999 });

                await src.startDebugging();
                bp.expectToBePending();
            }));

        test('Function breakpoint on non-existent function does not hit', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'NonExistentFunction' });

                await src.startDebugging();
                expect(bp.breakCount).toBe(0);
            }));

        // The adapter inserts breakpoints with -f, so a name that gdb can resolve later
        // becomes a genuine pending breakpoint rather than an error.
        test('expectToBePending accepts a non-existent but parseable function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'NonExistentFunction' });

                await src.startDebugging();
                bp.expectToBePending();
            }));

        // A name gdb cannot parse as a location fails -break-insert outright, and the
        // adapter reports that as verified: false with a message and no id.
        test('expectToBePending rejects a failed insertion', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'no such fn' });

                await src.startDebugging();

                expect(bp.dap).toEqual(
                    expect.objectContaining({
                        verified: false,
                        message: expect.any(String)
                    })
                );
                expect(bp.dap).not.toHaveProperty('id');

                expect(() => bp.expectToBePending()).toThrow();
            }));
    });

    // ===== LOGPOINTS =====
    // VSCode sends one setBreakpoints request per source, so a request for one source must
    // leave the logpoints of every other source intact. These use host lines so that the
    // breakpoints are verified, not pending, when they are set.
    describe('Logpoints', () => {
        const logPrefix = 'hostCall logpoint';

        test('Logpoint survives setBreakpoints for another source (empty list)', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const otherSrc = ws.file('default/default.cu');
                const logpoint = await src.createBreakpoint({
                    line: '📍hostCall',
                    logMessage: `${logPrefix} hostSum={hostSum}`
                });

                const session = await ws.createDebugSession('default:launch');
                const outputs = captureOutputs(session);
                const isTerminated = trackTermination(session);
                await session.startDebugging();
                logpoint.expectToBeVerified();

                await session.reapplyBreakpoints(otherSrc.path);

                await session.configurationDone();
                await waitForExpect(() =>
                    expect(isTerminated() || logpoint.breakCount > 0).toBeTrue()
                );

                expect(logpoint.breakCount).toBe(0);
                expect(outputs.some((o) => o.startsWith(logPrefix))).toBeTrue();
            }));

        test('Logpoint survives setBreakpoints for another source (with breakpoint)', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const logpoint = await src.createBreakpoint({
                    line: '📍hostCall',
                    logMessage: `${logPrefix} hostSum={hostSum}`
                });
                // Created after the logpoint, so its source's request is sent second.
                const otherBp = await ws
                    .file('default/default.cu')
                    .createBreakpoint({ line: await dispatchLine(ws) });

                const session = await ws.createDebugSession('default:launch');
                const outputs = captureOutputs(session);
                const isTerminated = trackTermination(session);
                await session.startDebugging();
                logpoint.expectToBeVerified();
                otherBp.expectToBeVerified();

                await session.configurationDone();
                await otherBp.waitForBreakCount(1);

                await session.continue();
                await waitForExpect(() =>
                    expect(isTerminated() || logpoint.breakCount > 0).toBeTrue()
                );

                expect(logpoint.breakCount).toBe(0);
                expect(otherBp.breakCount).toBe(1);
                expect(outputs.some((o) => o.startsWith(logPrefix))).toBeTrue();
            }));

        test('Logpoint turned into a plain breakpoint stops again', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const logpoint = await src.createBreakpoint({
                    line: '📍hostCall',
                    logMessage: `${logPrefix} hostSum={hostSum}`
                });

                const session = await ws.createDebugSession('default:launch');
                const outputs = captureOutputs(session);
                await session.startDebugging();
                logpoint.expectToBeVerified();

                // Re-send the same line without logMessage in a single request, as VSCode does
                // when the log message is cleared. GDB keeps the same breakpoint number, so only
                // clearing this source's entries turns it back into a stopping breakpoint.
                await session.dap.send('setBreakpoints', {
                    source: { path: src.path },
                    breakpoints: [{ line: logpoint.line }]
                });

                await session.configurationDone();
                await logpoint.waitForBreakCount(1);

                expect(outputs.some((o) => o.startsWith(logPrefix))).toBeFalse();
            }));
    });

    // ===== ASYNC BREAKS =====
    describe('Async Breaks', () => {
        test('Async break running infinite loop', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                const setupBp = await src.createBreakpoint({ line: '📍device2' });
                const session = await ws.startDebugging('default:launch', { args: ['concurrent'] });

                await setupBp.waitForBreakCount(1);
                await setupBp.remove();
                await session.continue();

                const pauseEvent = await session.expectEvent('stopped', async () => {
                    await session.pause();
                });

                expect(pauseEvent.body.reason).toBe('SIGINT');
                await session.continue();
            }));

        test('Set new breakpoint during async break', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                const setupBp = await src.createBreakpoint({ line: '📍device1' });
                const session = await ws.startDebugging('default:launch', { args: ['concurrent'] });

                await setupBp.waitForBreakCount(1);
                await session.continue();

                await session.expectEvent('stopped', async () => {
                    await session.pause();
                });

                const newBp = await src.createBreakpoint({ line: '📍device2' });
                newBp.expectToBeVerified();

                await session.continue();
            }));

        test('Remove existing breakpoint during async break', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                const targetBp = await src.createBreakpoint({ line: '📍device2' });
                const setupBp = await src.createBreakpoint({ line: '📍device1' });
                const session = await ws.startDebugging('default:launch', { args: ['concurrent'] });

                await setupBp.waitForBreakCount(1);
                await session.continue();

                await session.expectEvent('stopped', async () => {
                    await session.pause();
                });

                await targetBp.remove();
                await session.continue();

                expect(targetBp.breakCount).toBe(0);
            }));

        // setBreakpoints, setFunctionBreakpoints and setInstructionBreakpoints
        // share a single waitPaused resolver. Before the mutex fix, concurrent
        // invocations overwrote each other and all but the last hung forever.
        test('Concurrent line and function breakpoint requests while program is running', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/concurrent.cu');
                await src.startDebugging();

                const [lineBp, fnBp] = await Promise.all([
                    src.createBreakpoint({ line: '📍device1' }),
                    src.createFunctionBreakpoint({ name: 'kernelFunc' })
                ]);

                lineBp.expectToBeVerified();
                fnBp.expectToBeVerified();
            }));
    });
});
