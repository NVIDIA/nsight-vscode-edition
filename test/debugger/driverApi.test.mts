/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import { type DebugProtocol } from '@vscode/debugprotocol';
import waitForExpect from 'wait-for-expect';
import { usingWorkspace } from './test-client.mts';

describe('Driver API breakpoints', () => {
    test('Breakpoints on kernel loaded using driver APIs work', () =>
        usingWorkspace(async (ws) => {
            const src = ws.file('driverApis/kernel.cu');
            const bp = await src.createBreakpoint({ line: '📍kernel' });

            // Not ws.startDebugging(), which also sends configurationDone() and would let
            // the breakpoint resolve before it can be observed as pending.
            const session = await ws.createDebugSession('driverApis:launch');
            await session.startDebugging();

            // The kernel is loaded via cuModuleLoadData at runtime, so until the program
            // runs and the module is loaded, gdb has no address for this line and the
            // breakpoint is pending.
            bp.expectToBePending();

            await session.configurationDone();
            await waitForExpect(() => bp.expectToBeVerified());

            await bp.waitForBreakCount(1);

            const frame = await session.lastStopStackFrame();
            expect(frame.name).toBe('kernel');
        }));

    test('Function breakpoints on kernel loaded using driver APIs work', () =>
        usingWorkspace(async (ws) => {
            const src = ws.file('driverApis/kernel.cu');
            const fnBp = await src.createFunctionBreakpoint({ name: 'kernel' });

            // Not ws.startDebugging(), which also sends configurationDone() and would let
            // the breakpoint resolve before it can be observed as pending.
            const session = await ws.createDebugSession('driverApis:launch');
            await session.startDebugging();

            // The kernel is loaded via cuModuleLoadData at runtime, so until the program
            // runs and the module is loaded, gdb has no address for this function and the
            // breakpoint is pending.
            fnBp.expectToBePending();

            await session.configurationDone();
            await waitForExpect(() => fnBp.expectToBeVerified());

            await fnBp.waitForBreakCount(1);
        }));

    // VSCode sends one setBreakpoints request per source, so a request for another
    // source must not drop the log message of a logpoint in this one.
    test('Pending logpoint survives setBreakpoints for another source', () =>
        usingWorkspace(async (ws) => {
            const kernelSrc = ws.file('driverApis/kernel.cu');
            const hostSrc = ws.file('driverApis/driverApis.cpp');
            const logpoint = await kernelSrc.createBreakpoint({
                line: '📍kernel',
                logMessage: 'kernel logpoint idx={idx}'
            });

            const session = await ws.createDebugSession('driverApis:launch');
            const outputs: string[] = [];
            session.dap.on('output', (event: DebugProtocol.OutputEvent) =>
                outputs.push(event.body.output)
            );
            let terminated = false;
            session.dap.on('terminated', () => (terminated = true));

            await session.startDebugging();
            logpoint.expectToBePending();

            await session.reapplyBreakpoints(hostSrc.path);

            await session.configurationDone();
            await waitForExpect(() => expect(terminated || logpoint.breakCount > 0).toBeTrue());

            expect(logpoint.breakCount).toBe(0);
            expect(outputs).toContain('kernel logpoint idx=0');
        }));
});
