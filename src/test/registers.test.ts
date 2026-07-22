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

describe('Register tests', () => {
    it('Device registers are shown correctly', async () => {
        const dc = await TestUtils.launchDebugger('variables/variables');

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
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables.cu', 87);

        const scopesResp = await dc.scopesRequest({ frameId });
        const { scopes } = scopesResp.body;

        const registersScope = scopes.find((s) => s.name === 'Registers');

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(registersScope).exist;

        if (!registersScope) {
            await dc.stop();
            return;
        }

        let variablesResp = await dc.variablesRequest({ variablesReference: registersScope?.variablesReference });
        let { variables } = variablesResp.body;

        const sassRegGroup = variables.find((v) => v.name === 'SASS');

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(sassRegGroup).exist;

        if (!sassRegGroup) {
            await dc.stop();
            return;
        }

        variablesResp = await dc.variablesRequest({ variablesReference: sassRegGroup?.variablesReference });

        variables = variablesResp.body.variables;

        const r0Found = variables.some((v) => v.name === 'R0');

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(r0Found).true;

        await dc.stop();
    });

    it('Machine registers are shown correctly', async () => {
        const dc = await TestUtils.launchDebugger('registers/registers_test');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('registers/registers_test.c'),
            breakpoints: [
                {
                    line: 16
                }
            ]
        });

        expect(bpResp.body.breakpoints.length).eq(1);
        expect(bpResp.body.breakpoints[0].verified).eq(true);

        await dc.configurationDoneRequest();
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'registers_test.c', 16);

        const scopesResp = await dc.scopesRequest({ frameId });
        const { scopes } = scopesResp.body;

        const registersScope = scopes.find((s) => s.name === 'Registers');

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(registersScope).exist;

        if (!registersScope) {
            return;
        }

        const variablesResp = await dc.variablesRequest({ variablesReference: registersScope?.variablesReference });
        const { variables } = variablesResp.body;

        const registersMap = new Map<string, string>(variables.map((v) => [v.name, v.value]));

        expect(Number.parseInt(registersMap.get('rcx')!)).eq(21);
        expect(Number.parseInt(registersMap.get('rdx')!)).eq(13);
        expect(Number.parseInt(registersMap.get('dx')!)).eq(13);
        expect(Number.parseInt(registersMap.get('dh')!)).eq(0);

        await dc.stop();
    });
});
