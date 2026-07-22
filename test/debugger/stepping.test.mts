import { usingWorkspace } from './test-client.mts';

describe('Stepping', () => {
    // ===== BASIC STEPPING =====
    describe('Basic Stepping', () => {
        test('Step over device function call', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍deviceCall' });

                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);

                const initialLine = (await session.lastStopStackFrame()).location.lineNumber;

                await session.stepOverAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('cudaComputeHash');
                expect(frame.location.lineNumber).toBeGreaterThan(initialLine);
            }));

        test('Step into device function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍deviceCall' });

                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);

                await session.stepInAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(['cudaComputeHash', 'cudaComputeHashInner']).toContain(frame.name);
            }));

        test('Step out of device function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍cudaComputeHashInner' });

                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);

                await session.stepOutAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('cudaComputeHash');
            }));

        test('Multiple sequential steps in kernel', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍callingKernelStart' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-calling'] });
                await bp.waitForBreakCount(1);

                const lines: number[] = [];
                for (let i = 0; i < 3; i++) {
                    const frame = await session.lastStopStackFrame();
                    lines.push(frame.location.lineNumber);
                    expect(frame.name).toBe('callingKernel');

                    await session.stepOverAndExpect();
                }

                expect(lines[1]).toBeGreaterThan(lines[0]);
                expect(lines[2]).toBeGreaterThan(lines[1]);
            }));

        test('Step over function call in kernel', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const startBp = await src.createBreakpoint({ line: '📍stepOverBeforeCall' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepover'] });
                await startBp.waitForBreakCount(1);

                const initialLine = (await session.lastStopStackFrame()).location.lineNumber;

                await session.stepOverAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('stepOverTestKernel');
                expect(frame.location.lineNumber).toBeGreaterThan(initialLine);
            }));

        test('Step out of device function in kernel', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const startBp = await src.createBreakpoint({ line: '📍stepOutMiddle' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepout'] });
                await startBp.waitForBreakCount(1);

                await session.stepOutAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('stepOutTestKernel');
            }));

        test('Step over multiple function calls in expression', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍cudaComputeHashInner' });

                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);

                for (let i = 0; i < 3; i++) {
                    await session.stepOverAndExpect();
                }

                await session.stepOverAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(['cudaComputeHashInner', 'cudaComputeHash']).toContain(frame.name);
            }));

        test('Step into expression with multiple function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/variables.cu');
                const bp = await src.createBreakpoint({ line: '📍cudaComputeHashInner' });

                const session = await src.startDebugging();
                await bp.waitForBreakCount(1);

                for (let i = 0; i < 3; i++) {
                    await session.stepOverAndExpect();
                }

                await session.stepInAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(['addNums', 'cudaComputeHashInner', 'cudaComputeHash']).toContain(frame.name);
            }));

        test('Breakpoint hit while stepping over', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const innerBp = await src.createBreakpoint({ line: '📍helperBreakpoint' });
                const startBp = await src.createBreakpoint({ line: '📍stepOverBeforeCall' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepover'] });
                await startBp.waitForBreakCount(1);

                await session.stepOver();

                if (innerBp.breakCount > 0) {
                    const frame = await session.lastStopStackFrame();
                    expect(frame.name).toBe('helperWithBreakpoint');
                } else {
                    const frame = await session.lastStopStackFrame();
                    expect(frame.name).toBe('stepOverTestKernel');
                }
            }));

        test('Step into expression with no calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍callingKernelAssign' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-calling'] });
                await bp.waitForBreakCount(1);

                const initialLine = (await session.lastStopStackFrame()).location.lineNumber;

                await session.stepInAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('callingKernel');
                expect(frame.location.lineNumber).toBeGreaterThan(initialLine);
            }));

        test('Breakpoint hit while stepping out', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const callerBp = await src.createBreakpoint({ line: '📍stepOutCallerAfterCall' });
                const startBp = await src.createBreakpoint({ line: '📍stepOutMiddle' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepout'] });
                await startBp.waitForBreakCount(1);

                await session.stepOut();

                const frame = await session.lastStopStackFrame();
                if (callerBp.breakCount > 0) {
                    expect(frame.name).toBe('stepOutTestKernel');
                    expect(callerBp.breakCount).toBe(1);
                } else {
                    expect(frame.name).toBe('stepOutTestKernel');
                    expect(callerBp.breakCount).toBe(0);
                }
            }));

        test('Step into return statement', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍stepOutEnd' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepout'] });
                await bp.waitForBreakCount(1);

                await session.stepInAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(['stepOutHelper', 'stepOutTestKernel']).toContain(frame.name);
            }));

        test('Step out of nested device function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍helperBreakpoint' });

                const session = await ws.startDebugging('default:launch', { args: ['stepping-stepover'] });
                await bp.waitForBreakCount(1);

                await session.stepOutAndExpect();

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('stepOverTestKernel');
            }));
    });

    // ===== RECURSIVE STEPPING =====
    describe('Recursive Stepping', () => {
        test('Step into self-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const kernelBp = await src.createBreakpoint({ line: '📍selfRecKernelBeforeCall' });
                const deviceBp = await src.createBreakpoint({ line: '📍selfRecEntry' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-self'] });
                await kernelBp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('selfRecKernel');

                await session.stepIn();
                await deviceBp.waitForBreakCount(1);
                expect(deviceBp.breakCount).toBe(1);
            }));

        test('Step over self-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍selfRecKernelBeforeCall' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-self'] });
                await bp.waitForBreakCount(1);

                const initialFrame = await session.lastStopStackFrame();
                expect(initialFrame.name).toBe('selfRecKernel');
                const initialLine = initialFrame.location.lineNumber;

                await session.stepOverAndExpect();
                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('selfRecKernel');
                expect(frame.location.lineNumber).toBeGreaterThan(initialLine);
            }));

        test('Step out of self-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍selfRecKernelBeforeCall' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-self'] });
                await bp.waitForBreakCount(1);

                const initialFrame = await session.lastStopStackFrame();
                expect(initialFrame.name).toBe('selfRecKernel');

                await session.stepInAndExpect();
                await session.stepOutAndExpect();
                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('selfRecKernel');
            }));

        test('Hitcount breakpoint on self-recursive device function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍selfRecEntry', hitCondition: '2' });
                await ws.startDebugging('default:launch', { args: ['stepping-recursive-self'] });

                await bp.waitForBreakCount(1);
                expect(bp.breakCount).toBe(1);
            }));

        test('Step into mutually-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const kernelBp = await src.createBreakpoint({ line: '📍mutualRecKernelBeforeCall' });
                const deviceBp = await src.createBreakpoint({ line: '📍isEvenEntry' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-mutual'] });
                await kernelBp.waitForBreakCount(1);

                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('mutualRecKernel');

                await session.stepIn();
                await deviceBp.waitForBreakCount(1);
                expect(deviceBp.breakCount).toBe(1);
            }));

        test('Step over mutually-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍mutualRecKernelBeforeCall' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-mutual'] });
                await bp.waitForBreakCount(1);

                const initialFrame = await session.lastStopStackFrame();
                expect(initialFrame.name).toBe('mutualRecKernel');
                const initialLine = initialFrame.location.lineNumber;

                await session.stepOverAndExpect();
                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('mutualRecKernel');
                expect(frame.location.lineNumber).toBeGreaterThan(initialLine);
            }));

        test('Step out of mutually-recursive device function calls', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍mutualRecKernelBeforeCall' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-mutual'] });
                await bp.waitForBreakCount(1);

                const initialFrame = await session.lastStopStackFrame();
                expect(initialFrame.name).toBe('mutualRecKernel');

                await session.stepInAndExpect();
                await session.stepOutAndExpect();
                const frame = await session.lastStopStackFrame();
                expect(frame.name).toBe('mutualRecKernel');
            }));

        test('Hitcount breakpoint on mutually-recursive device function', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const bp = await src.createBreakpoint({ line: '📍isEvenEntry', hitCondition: '2' });
                await ws.startDebugging('default:launch', { args: ['stepping-recursive-mutual'] });

                await bp.waitForBreakCount(1);
                expect(bp.breakCount).toBe(1);
            }));

        test('Mutually-recursive function alternation', () =>
            usingWorkspace(async (ws) => {
                const src = ws.file('default/stepping.cu');
                const evenBp = await src.createBreakpoint({ line: '📍isEvenEntry' });
                const oddBp = await src.createBreakpoint({ line: '📍isOddEntry' });
                const session = await ws.startDebugging('default:launch', { args: ['stepping-recursive-mutual'] });

                await evenBp.waitForBreakCount(1);
                expect(evenBp.breakCount).toBe(1);
                expect(oddBp.breakCount).toBe(0);

                await session.continue();
                await oddBp.waitForBreakCount(1);
                expect(oddBp.breakCount).toBe(1);

                await session.continue();
                await evenBp.waitForBreakCount(2);
                expect(evenBp.breakCount).toBe(2);
            }));
    });
});
