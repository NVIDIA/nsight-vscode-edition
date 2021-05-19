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

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { expect } from 'chai';
import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';

describe('Variable assignment tests', async () => {
    let dc: CudaDebugClient;

    const varAssignSource = 'varAssign/varAssign.cpp';

    afterEach(async () => {
        if (dc) {
            await dc.stop();
        }
    });

    it('Variable assignment works for scalar values', async () => {
        dc = await TestUtils.launchDebugger('varAssign/varAssign');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(varAssignSource),
            breakpoints: [37, 42].map((ln) => {
                return { line: ln };
            })
        });

        bpResp.body.breakpoints.forEach((bp) => {
            expect(bp.verified).eq(true);
        });

        await dc.configurationDoneRequest();
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', varAssignSource, 37);

        const localsScopeReference = await TestUtils.getLocalsScopeReference(dc, frameId);
        const locals = await TestUtils.getChildren(dc, localsScopeReference);
        const varX = locals.get('x')!;
        expect(varX.value).eq('2');

        const setVarResp = await dc.setVariableRequest({
            name: 'x',
            value: '3',
            variablesReference: localsScopeReference
        });

        expect(setVarResp.body.value).eq('3');

        await dc.continueRequest({ threadId });

        await TestUtils.assertStoppedLocation(dc, 'breakpoint', varAssignSource, 42);

        const locals2 = await TestUtils.getLocals(dc, frameId);
        const varResult = locals2.get('result')!;
        expect(varResult.value).eq('12');
    });

    it('Variable assignment works for structs', async () => {
        const verifyStructs = async (frameId: number, values: string[]): Promise<number[]> => {
            const localsScopeReference = await TestUtils.getLocalsScopeReference(dc, frameId);
            const locals = await TestUtils.getChildren(dc, localsScopeReference);

            const a1VarRef = locals.get('a1')!.variablesReference;
            const a1Children = await TestUtils.getChildren(dc, a1VarRef);
            expect(a1Children.get('alpha')!.value).eq(values[0]);
            expect(a1Children.get('beta')!.value).eq(values[1]);

            const a2VarRef = locals.get('a2')!.variablesReference;
            const a2Children = await TestUtils.getChildren(dc, a2VarRef);
            expect(a2Children.get('alpha')!.value).eq(values[2]);
            expect(a2Children.get('beta')!.value).eq(values[3]);

            const aVarRef = locals.get('a')!.variablesReference;
            const aChildren = await TestUtils.getChildren(dc, aVarRef);
            expect(aChildren.get('alpha')!.value).eq(values[4]);
            expect(aChildren.get('beta')!.value).eq(values[5]);

            return [localsScopeReference, a1VarRef, a2VarRef, aVarRef];
        };

        dc = await TestUtils.launchDebugger('varAssign/varAssign');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(varAssignSource),
            breakpoints: [{ line: 28 }]
        });

        bpResp.body.breakpoints.forEach((bp) => {
            expect(bp.verified).eq(true);
        });

        await dc.configurationDoneRequest();
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', varAssignSource, 28);

        const [localsRef0] = await verifyStructs(frameId, ['1', '1', '2', '2', '1', '1']);
        const locals0 = await TestUtils.getChildren(dc, localsRef0);

        const a2Value = locals0.get('a2')!.value;
        const setVarResp0 = await dc.setVariableRequest({
            name: 'a',
            value: a2Value,
            variablesReference: localsRef0
        });

        expect(setVarResp0.body.value).eq(a2Value);
        const aChildren = await TestUtils.getChildren(dc, setVarResp0.body.variablesReference!);
        expect(aChildren.get('alpha')!.value).eq('2');
        expect(aChildren.get('beta')!.value).eq('2');

        await dc.setVariableRequest({
            name: 'alpha',
            value: '3',
            variablesReference: setVarResp0.body.variablesReference!
        });

        await verifyStructs(frameId, ['1', '1', '3', '2', '3', '2']);
    });

    const verifyAndManipulateLocals = async (frameId: number): Promise<void> => {
        const localsRef = await TestUtils.getLocalsScopeReference(dc, frameId);

        const locals = await TestUtils.getChildren(dc, localsRef);
        const myInputChildren = await TestUtils.getChildren(dc, locals.get('myInput')!.variablesReference);
        const takeYourPickReference = myInputChildren.get('takeYourPick')!.variablesReference;
        const takeYourPickChildren = await TestUtils.getChildren(dc, takeYourPickReference);
        const halfAndHalfChildren = await TestUtils.getChildren(dc, takeYourPickChildren.get('halfAndHalf')!.variablesReference);
        expect(halfAndHalfChildren.get('lowHalf')?.value).eq('1');
        expect(halfAndHalfChildren.get('highHalf')?.value).eq('3');

        const setVarResp0 = await dc.setVariableRequest({
            name: 'myResult',
            value: '1',
            variablesReference: localsRef
        });

        expect(setVarResp0.body.value).eq('1');

        await dc.setVariableRequest({
            name: 'whole',
            value: '17179869188',
            variablesReference: takeYourPickReference
        });
    };

    it('Variable assignment works when in device code', async () => {
        dc = await TestUtils.launchDebugger('variables/variables');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('variables/variables.cu'),
            breakpoints: [{ line: 92 }, { line: 107 }]
        });

        bpResp.body.breakpoints.forEach((bp) => {
            expect(bp.verified).eq(true);
        });

        await dc.configurationDoneRequest();
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables/variables.cu', 92);

        await verifyAndManipulateLocals(frameId);

        await dc.continueRequest({ threadId });
        const stoppedAtRet = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables/variables.cu', 107);

        const localsRef = await TestUtils.getLocals(dc, stoppedAtRet.frameId);
        expect(localsRef.get('myResult')!.value).eq('74');
    });
});

/* eslint-enable @typescript-eslint/no-non-null-assertion */
