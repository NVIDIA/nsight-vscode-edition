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

describe('Breakpoint tests', async () => {
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
        TestUtils.ensure(dc.capabilities.supportsFunctionBreakpoints);

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

        const expectedLineNumbers = [88, 90, 92, 93];

        // We use a for-loop here because:
        // -- forEach will run the iterations in parallel
        // -- for-of will require regenerating iterators, which results in a different eslint warning.
        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < expectedLineNumbers.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await dc.nextRequest({ threadId });
            // eslint-disable-next-line no-await-in-loop
            threadId = (await TestUtils.assertStoppedLocation(dc, 'step', 'variables/variables.cu', expectedLineNumbers[i])).threadId;
        }
    });
});
