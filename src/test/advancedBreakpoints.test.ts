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

describe('Advanced Breakpoint tests', async () => {
    let dc: CudaDebugClient;

    afterEach(async () => {
        await dc?.stop();
    });

    it('Breakpoints on kernel loaded using driver APIs work', async () => {
        const pathToFatbin = TestUtils.resolveTestPath('driverApis/kernel.fatbin');
        dc = await TestUtils.launchDebugger('driverApis/driverApis', pathToFatbin);

        const bpLine = 28;

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('driverApis/kernel.cu'),
            breakpoints: [
                {
                    line: bpLine
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'kernel.cu', bpLine);
    });
});
