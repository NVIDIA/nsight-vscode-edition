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

describe('Stepping tests', async () => {
    let dc: CudaDebugClient;

    const programName = 'variables';
    const programExe = `${programName}/${programName}`;
    const programSrc = `${programName}.cu`;

    beforeEach(async () => {
        dc = await TestUtils.launchDebugger(programExe);
    });

    afterEach(async () => {
        await dc.stop();
    });

    it('Can step (in & out) of device function', async () => {
        const deviceCallSite = 113;
        const nextLineAfterCallSite = 114;
        const deviceEntry = 87;

        const bpResponse = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(`${programName}/${programSrc}`),
            breakpoints: [
                {
                    line: deviceCallSite
                }
            ]
        });

        expect(bpResponse.body.breakpoints.length).eq(1);
        expect(bpResponse.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        const stopLocation = await TestUtils.assertStoppedLocation(dc, 'breakpoint', programSrc, deviceCallSite);

        await dc.stepInRequest({ threadId: stopLocation.threadId });
        await TestUtils.assertStoppedLocation(dc, 'step', programSrc, deviceEntry);

        await dc.stepOutRequest({ threadId: stopLocation.threadId });
        await TestUtils.assertStoppedLocation(dc, 'step', programSrc, nextLineAfterCallSite);
    });
});
