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

import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';
import { CudaDebugProtocol } from '../debugger/cudaDebugProtocol';

describe('CUDA focus tests', () => {
    let dc: CudaDebugClient;

    const programName = 'variables';
    const programExe = `${programName}/${programName}`;
    const programSrc = `${programExe}.cu`;

    beforeEach(async () => {
        dc = await TestUtils.launchDebugger(programExe);
    });

    afterEach(async () => {
        await dc.stop();
    });

    it('Notifies about focus change when switching focus via gdb commmands', async () => {
        const lineNumbers = TestUtils.getLineNumbersFromComments(programSrc);

        dc = await TestUtils.launchDebugger(programExe);

        const breakpoints = [{ line: lineNumbers.deviceCall }];
        const bpResp = await dc.setBreakpointsRequest({
            breakpoints,
            source: TestUtils.getTestSource(programSrc)
        });
        expect(bpResp).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    breakpoints: [
                        expect.objectContaining({
                            verified: true,
                            line: lineNumbers.deviceCall
                        })
                    ]
                })
            })
        );

        const stopInfo = await dc.expectToStopAt(
            'breakpoint',
            programSrc,
            lineNumbers.deviceCall,
            undefined,
            async () => {
                await dc.configurationDoneRequest();
            }
        );

        const changedCudaFocusPromise = dc.waitForEvent('changedCudaFocus');
        await dc.evaluateRequest({
            expression: '`cuda thread 1',
            context: 'repl',
            frameId: stopInfo.frameId
        });
        const changedCudaFocusEvent =
            (await changedCudaFocusPromise) as CudaDebugProtocol.ChangedCudaFocusEvent;
        expect(changedCudaFocusEvent).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    focus: {
                        type: 'software',
                        blockIdx: { x: 0, y: 0, z: 0 },
                        threadIdx: { x: 1, y: 0, z: 0 }
                    }
                })
            })
        );
    });
});
