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
import { DebugProtocol } from 'vscode-debugprotocol';
import { TestUtils } from './testUtils';

describe('Register tests', async () => {
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

        let registersScope: DebugProtocol.Scope | undefined;

        scopes.forEach((s) => {
            if (s.name === 'Registers') {
                registersScope = s;
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(registersScope).exist;

        if (!registersScope) {
            await dc.stop();
            return;
        }

        let variablesResp = await dc.variablesRequest({ variablesReference: registersScope?.variablesReference });
        let { variables } = variablesResp.body;

        let sassRegGroup: DebugProtocol.Variable | undefined;

        variables.forEach((v) => {
            if (v.name === 'SASS') {
                sassRegGroup = v;
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(sassRegGroup).exist;

        if (!sassRegGroup) {
            await dc.stop();
            return;
        }

        variablesResp = await dc.variablesRequest({ variablesReference: sassRegGroup?.variablesReference });

        variables = variablesResp.body.variables;

        let r0Found = false;

        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < variables.length; i += 1) {
            if (variables[i].name === 'R0') {
                r0Found = true;
                break;
            }
        }

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

        let registersScope: DebugProtocol.Scope | undefined;

        scopes.forEach((s) => {
            if (s.name === 'Registers') {
                registersScope = s;
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(registersScope).exist;

        if (!registersScope) {
            return;
        }

        const variablesResp = await dc.variablesRequest({ variablesReference: registersScope?.variablesReference });
        const { variables } = variablesResp.body;

        const registersMap = new Map<string, string>();
        variables.forEach((v) => registersMap.set(v.name, v.value));

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(Number.parseInt(registersMap.get('rcx')!)).eq(21);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(Number.parseInt(registersMap.get('rdx')!)).eq(13);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(Number.parseInt(registersMap.get('dx')!)).eq(13);

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(Number.parseInt(registersMap.get('dh')!)).eq(0);

        await dc.stop();
    });
});
