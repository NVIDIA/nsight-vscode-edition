import { usingWorkspace } from './test-client.mts';

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
                const bp = await src.createFunctionBreakpoint({ name: 'cudaComputeHashInner', isEnabled: false });

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
                const bp = await src.createBreakpoint({ line: '📍loopIteration', condition: 'i == 3' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();
                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '3' }) }));
            }));

        test('Conditional breakpoint with comparison operator', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({ line: '📍loopIteration', condition: 'i > 2' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '3' }) }));
            }));

        test('Conditional breakpoint with range', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({ line: '📍loopIteration', condition: 'i >= 5 && i <= 7' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });
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
                const bp = await src.createBreakpoint({ line: '📍loopIteration', condition: 'i * 2 == 8' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '4' }) }));
            }));

        test('Conditional function breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'singleThreadKernel', condition: 'iterations == 10' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });
                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                const locals = await frame.locals();

                expect(locals).toEqual(expect.objectContaining({ iterations: expect.objectContaining({ value: '10' }) }));
            }));
    });

    // ===== HITCOUNT BREAKPOINTS =====
    describe('Hitcount breakpoints (single thread)', () => {
        test('Hitcount on device function ', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');

                const bp = await src.createBreakpoint({ line: '📍loopIteration', hitCondition: '3' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '2' }) }));
            }));

        test('Combined conditional and hitcount', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({ line: '📍loopIteration', condition: 'i == 5', hitCondition: '1' });
                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '5' }) }));
            }));

        test('Hitcount with greater than syntax', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');
                const bp = await src.createBreakpoint({ line: '📍loopIteration', hitCondition: '> 5' });
                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });

                await bp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('singleThreadKernel');
                expect(bp.breakCount).toBe(1);

                const locals = await frame.locals();
                expect(locals).toBeDefined();
                expect(locals).toEqual(expect.objectContaining({ i: expect.objectContaining({ value: '5' }) }));
            }));

        test('Hitcount with function breakpoint', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/single-thread.cu');

                const bp = await src.createFunctionBreakpoint({ name: 'singleThreadKernel', hitCondition: '1' });

                const session = await ws.startDebugging('default:launch', { args: ['single-thread-warp'] });

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

        test('Line breakpoint on empty line is moved to valid location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 25 });

                await src.startDebugging();
                bp.expectToBeVerified();
            }));

        test('Line breakpoint on include is moved to valid location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 26 });

                await src.startDebugging();
                bp.expectToBeVerified();
            }));

        test('Line breakpoint on nonexistant line is moved to valid location', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: 99_999_999 });

                await src.startDebugging();
                bp.expectToBeVerified();
            }));

        test('Function breakpoint on non-existent function does not hit', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createFunctionBreakpoint({ name: 'NonExistentFunction' });

                await src.startDebugging();
                expect(bp.breakCount).toBe(0);
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

                const [lineBp, fnBp] = await Promise.all([src.createBreakpoint({ line: '📍device1' }), src.createFunctionBreakpoint({ name: 'kernelFunc' })]);

                lineBp.expectToBeVerified();
                fnBp.expectToBeVerified();
            }));
    });
});
