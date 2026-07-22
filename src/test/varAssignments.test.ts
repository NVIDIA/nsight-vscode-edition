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
import { type DebugProtocol } from '@vscode/debugprotocol';
import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';

describe('Variable assignment tests', () => {
    const varAssignSource = 'varAssign/varAssign.cpp';

    let dc: CudaDebugClient;

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

        for (const bp of bpResp.body.breakpoints) {
            expect(bp.verified).eq(true);
        }

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
        const verifyStructs = async (locals: Map<string, DebugProtocol.Variable>, values: string[]): Promise<void> => {
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
        };

        dc = await TestUtils.launchDebugger('varAssign/varAssign');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(varAssignSource),
            breakpoints: [{ line: 28 }]
        });

        for (const bp of bpResp.body.breakpoints) {
            expect(bp.verified).eq(true);
        }

        await dc.configurationDoneRequest();
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', varAssignSource, 28);

        let localsScopeReference = await TestUtils.getLocalsScopeReference(dc, frameId);
        let locals = await TestUtils.getChildren(dc, localsScopeReference);

        await verifyStructs(locals, ['1', '1', '2', '2', '1', '1']);

        const a2Value = locals.get('a2')!.value;

        const invalidatedPromise = dc.waitForEvent('invalidated');
        const setVarResp0 = await dc.setVariableRequest({
            name: 'a',
            value: a2Value,
            variablesReference: localsScopeReference
        });
        expect(setVarResp0.body.value).eq(a2Value);
        const invalidatedEvent = await invalidatedPromise;
        expect(invalidatedEvent.body.areas).to.include('variables');

        // All existing variable references are invalid after InvalidatedEvent.
        localsScopeReference = await TestUtils.getLocalsScopeReference(dc, frameId);
        locals = await TestUtils.getChildren(dc, localsScopeReference);

        const aVarRef = locals.get('a')!.variablesReference;
        const aChildren = await TestUtils.getChildren(dc, aVarRef);
        expect(aChildren.get('alpha')!.value).eq('2');
        expect(aChildren.get('beta')!.value).eq('2');

        const setVariableResponse = await dc.setVariableRequest({
            name: 'alpha',
            value: '3',
            variablesReference: aVarRef
        });
        expect(setVariableResponse.body.value).eq('3');
    });

    const verifyAndManipulateLocals = async (frameId: number): Promise<void> => {
        let localsRef = await TestUtils.getLocalsScopeReference(dc, frameId);
        let locals = await TestUtils.getChildren(dc, localsRef);
        let myInputChildren = await TestUtils.getChildren(dc, locals.get('myInput')!.variablesReference);
        let takeYourPickReference = myInputChildren.get('takeYourPick')!.variablesReference;
        let takeYourPickChildren = await TestUtils.getChildren(dc, takeYourPickReference);
        const halfAndHalfChildren = await TestUtils.getChildren(dc, takeYourPickChildren.get('halfAndHalf')!.variablesReference);

        expect(halfAndHalfChildren.get('lowHalf')).property('value').eq('1');
        expect(halfAndHalfChildren.get('highHalf')).property('value').eq('3');

        let invalidatedPromise = dc.waitForEvent('invalidated');
        const setVarResp0 = await dc.setVariableRequest({
            name: 'myResult',
            value: '1',
            variablesReference: localsRef
        });
        expect(setVarResp0).nested.property('body.value').eq('1');

        let invalidatedEvent = await invalidatedPromise;
        expect(invalidatedEvent).nested.property('body.areas').to.include('variables');

        localsRef = await TestUtils.getLocalsScopeReference(dc, frameId);
        locals = await TestUtils.getChildren(dc, localsRef);
        myInputChildren = await TestUtils.getChildren(dc, locals.get('myInput')!.variablesReference);
        takeYourPickReference = myInputChildren.get('takeYourPick')!.variablesReference;

        // The variable needs to be expanded before its children can be assigned.
        takeYourPickChildren = await TestUtils.getChildren(dc, takeYourPickReference);
        expect(takeYourPickChildren.get('whole')).property('value').not.undefined.and.not.eq('17179869188');

        invalidatedPromise = dc.waitForEvent('invalidated');
        await dc.setVariableRequest({
            name: 'whole',
            value: '17179869188',
            variablesReference: takeYourPickReference
        });

        invalidatedEvent = await invalidatedPromise;
        expect(invalidatedEvent).nested.property('body.areas').to.include('variables');
    };

    it('Variable assignment works when in device code', async () => {
        dc = await TestUtils.launchDebugger('variables/variables');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('variables/variables.cu'),
            breakpoints: [{ line: 92 }, { line: 107 }]
        });

        for (const bp of bpResp.body.breakpoints) {
            expect(bp.verified).eq(true);
        }

        await dc.configurationDoneRequest();
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables/variables.cu', 92);

        await verifyAndManipulateLocals(frameId);

        await dc.continueRequest({ threadId });
        const stoppedAtRet = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'variables/variables.cu', 107);

        const localsRef = await TestUtils.getLocals(dc, stoppedAtRet.frameId);
        expect(localsRef.get('myResult')!.value).eq('74');
    });
});
