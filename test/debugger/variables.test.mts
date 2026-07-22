//import 'jest-extended';
import { usingWorkspace } from './test-client.mts';

const WARP_SIZE = 32;

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
            const { value: threadNum1 } = await deviceStackFrame.expectLocal('threadNum', expect.stringMatching(/\d+/));

            // Switch to main CPU thread and inspect some vars.
            const mainThread = await debug.mainThread();
            const callStack = await mainThread.callStack();
            const concurrentFrame = callStack.find((frame) => frame.location.fileName?.includes('concurrent.cu'));
            expect(concurrentFrame).toBeDefined();
            await concurrentFrame!.expectLocation({ file: source, line: ['📍host1', '📍host2'] });
            await concurrentFrame!.expectNoLocal('threadNum');
            await concurrentFrame!.expectLocal('numHostThreads', '1');

            // Verify that argc is available in the actual main frame (but not threadNum)
            const mainFrame = callStack.find((frame) => frame.location.fileName?.includes('default.cu'));
            expect(mainFrame).toBeDefined();
            await mainFrame!.expectNoLocal('threadNum');
            await mainFrame!.expectLocal('argc', '2');

            // Switch back to CUDA and check that we're seeing the same vars as before.
            const deviceThread = deviceStackFrame.thread;
            deviceThread.clearCaches();
            deviceStackFrame = await deviceThread.currentStackFrame();
            await deviceStackFrame.expectLocation({ file: source, line: '📍device2' });
            await deviceStackFrame.expectNoLocal('argc');
            const { value: threadNum2 } = await deviceStackFrame.expectLocal('threadNum', expect.stringMatching(/\d+/));
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
                expect(variableNames).toIncludeAllMembers(['gridDim', 'blockIdx', 'blockDim', 'threadIdx', 'warpSize', 'PTX Special Registers']);
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
});
