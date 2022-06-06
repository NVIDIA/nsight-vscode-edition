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

describe('Launch argument tests', async () => {
    let dc: CudaDebugClient;

    afterEach(async () => {
        await dc.stop();
    });

    it('Launch environment variables work', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.envFile = TestUtils.resolveTestPath('launchEnvVars/launchEnvVars.txt');

        await dc.launchRequest(launchArguments);

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('launchEnvVars/launchEnvVars.cpp'),
            breakpoints: [
                {
                    line: 28
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 28);

        const locals = await TestUtils.getLocals(dc, frameId);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(locals.get('success')).exist;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const { value } = locals.get('success')!;
        expect(value).eq('true');
    });

    it('stopAtEntry works', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;

        await dc.launchRequest(launchArguments);

        await dc.configurationDoneRequest();
        await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);
    });
});
