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

import { expect } from 'chai';
import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';

describe('Breakpoint tests', () => {
    let dc: CudaDebugClient;

    beforeEach(async () => {
        dc = await TestUtils.launchDebugger('variables/variables');
    });

    afterEach(async () => {
        await dc.stop();
    });

    it('Breakpoints on kernel source work', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('variables/variables.cu'),
            breakpoints: [
                {
                    line: 87
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables.cu', 87);
    });

    it('Breakpoints on kernel functions work', async () => {
        expect(dc.capabilities.supportsFunctionBreakpoints).eq(true);

        const bpResp = await dc.setFunctionBreakpointsRequest({
            breakpoints: [
                {
                    name: 'cudaComputeHash'
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        await TestUtils.assertStoppedLocation(dc, 'function breakpoint', 'variables.cu', 112);
    });

    it('Can step (over) through source lines', async () => {
        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('variables/variables.cu'),
            breakpoints: [
                {
                    line: 87
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();

        let { threadId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables/variables.cu', 87);

        for (const expectedLineNumber of [88, 90, 92, 93]) {
            await dc.nextRequest({ threadId });
            ({ threadId } = await TestUtils.assertStoppedLocation(dc, 'step', 'variables/variables.cu', expectedLineNumber));
        }
    });

    it('Conditional breakpoints work', async () => {
        const variablesSource = 'variables/variables.cu';
        const bpLine = 102;

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(variablesSource),
            breakpoints: [
                {
                    line: bpLine,
                    condition: 'i == 2'
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        await TestUtils.verifyLocalsOnStop(dc, variablesSource, bpLine, 'breakpoint', [{ name: 'i', value: '2' }]);
    });
});
