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

/* eslint @typescript-eslint/no-unused-expressions: off */
/* eslint @typescript-eslint/no-non-null-assertion: off */
// Rationale: these don't play well with Chai assertions.

import assert from 'node:assert/strict';
import { expect } from 'chai';
import { type DebugProtocol } from '@vscode/debugprotocol';
import { type StoppedContext, TestUtils } from './testUtils';

import { CudaDebugClient } from './cudaDebugClient';

describe('Locals and watches tests', () => {
    const framesSource = 'frames/frames.cpp';
    const variablesSource = 'variables/variables.cu';

    const concurrentProgram = 'concurrent/concurrent';
    const concurrentSource = `${concurrentProgram}.cu`;

    let dc: CudaDebugClient;

    afterEach(async () => {
        if (dc) {
            await dc.stop();
        }
    });

    it('Shows correct value for locals (non-CUDA)', async () => {
        const expectedSequence = [
            {
                line: 96,
                expLocals: [
                    {
                        name: 'c',
                        value: '2'
                    }
                ]
            },
            {
                line: 24,
                expLocals: [
                    {
                        name: 'a',
                        value: '3'
                    },
                    {
                        name: 'b',
                        value: '5'
                    }
                ]
            },
            {
                line: 39,
                expLocals: [
                    {
                        name: 'a',
                        value: '8'
                    },
                    {
                        name: 'b',
                        value: '13'
                    },
                    {
                        name: 'c',
                        value: '21'
                    },
                    {
                        name: 'd',
                        value: '34'
                    }
                ]
            },
            {
                line: 50,
                expLocals: [
                    {
                        name: 'a',
                        value: '8'
                    }
                ]
            },
            {
                line: 66,
                expLocals: [
                    {
                        name: 'a'
                    }
                ],
                customTask: async (stoppedContext: StoppedContext): Promise<StoppedContext> => {
                    const { actLocals } = stoppedContext;
                    const varReference = actLocals.get('a')?.variablesReference;
                    const children = await TestUtils.getChildren(dc, varReference!);
                    expect(children.get('x')?.value).eq('55');
                    expect(children.get('y')?.value).eq('89');
                    expect(children.get('z')?.value).eq('144');

                    return stoppedContext;
                }
            },
            {
                line: 81,
                expLocals: [
                    {
                        name: 'a'
                    }
                ],
                customTask: async (stoppedContext: StoppedContext): Promise<StoppedContext> => {
                    const { actLocals } = stoppedContext;
                    const varReference = actLocals.get('a')?.variablesReference;
                    const children = await TestUtils.getChildren(dc, varReference!);
                    expect(children.get('x')?.value).eq('233');
                    expect(children.get('y')?.value).eq('89');
                    expect(children.get('z')?.value).eq('377');

                    return stoppedContext;
                }
            },
            {
                line: 90,
                expLocals: [
                    {
                        name: 'a',
                        value: '610'
                    }
                ]
            },
            {
                line: 97,
                expLocals: [
                    {
                        name: 'c',
                        value: '2'
                    }
                ]
            },
            {
                line: 104,
                expLocals: [
                    {
                        name: 'a',
                        value: '2'
                    },
                    {
                        name: 'b',
                        value: '3'
                    },
                    {
                        name: 'c',
                        value: '5'
                    }
                ]
            },
            {
                line: 111,
                expLocals: [
                    {
                        name: 'a',
                        value: '3'
                    },
                    {
                        name: 'b',
                        value: '3'
                    },
                    {
                        name: 'c',
                        value: "51 '3'"
                    }
                ],
                customTask: async (stoppedContext: StoppedContext): Promise<StoppedContext> => {
                    await dc.nextRequest({ threadId: stoppedContext.threadId });
                    const stoppedContextAt1stNext = await TestUtils.verifyLocalsOnStop(dc, framesSource, 112, 'step', [
                        {
                            name: 'a',
                            value: '3'
                        },
                        {
                            name: 'b',
                            value: '3'
                        },
                        {
                            name: 'c',
                            value: "52 '4'"
                        }
                    ]);

                    await dc.nextRequest({ threadId: stoppedContextAt1stNext.threadId });
                    const stoppedContextAt2ndtNext = await TestUtils.verifyLocalsOnStop(dc, framesSource, 113, 'step', [
                        {
                            name: 'a',
                            value: '2'
                        },
                        {
                            name: 'b',
                            value: '3'
                        },
                        {
                            name: 'c',
                            value: "52 '4'"
                        }
                    ]);

                    return stoppedContextAt2ndtNext;
                }
            },
            {
                line: 123,
                expLocals: [
                    {
                        name: 'a',
                        value: '1'
                    },
                    {
                        name: 'b'
                    },
                    {
                        name: 'c',
                        value: '2'
                    }
                ],
                customTask: async (stoppedContext: StoppedContext): Promise<StoppedContext> => {
                    const { actLocals } = stoppedContext;
                    const varReference = actLocals.get('b')?.variablesReference;
                    const children = await TestUtils.getChildren(dc, varReference!);
                    expect(children.get('x')?.value).eq('8');
                    expect(children.get('y')?.value).eq('13');

                    return stoppedContext;
                }
            }
        ];

        expectedSequence.push(expectedSequence.at(-2)!, expectedSequence.at(-3)!);

        dc = await TestUtils.launchDebugger('frames/frames');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(framesSource),
            breakpoints: [...new Set(expectedSequence.map((item) => item.line)).keys()].map((ln) => {
                return { line: ln };
            })
        });

        for (const bp of bpResp.body.breakpoints) {
            expect(bp.verified).eq(true);
        }

        await dc.configurationDoneRequest();

        for (const expectedBp of expectedSequence) {
            let stoppedContext = await TestUtils.verifyLocalsOnStop(dc, framesSource, expectedBp.line, 'breakpoint', expectedBp.expLocals);

            if (expectedBp.customTask) {
                stoppedContext = await expectedBp.customTask(stoppedContext);
            }

            console.log(`Verification successful at line ${expectedBp.line}.`);

            await dc.continueRequest({ threadId: stoppedContext.threadId });
        }
    });

    it('Shows correct value for locals (CUDA)', async () => {
        dc = await TestUtils.launchDebugger('variables/variables');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(variablesSource),
            breakpoints: [{ line: 90 }]
        });

        for (const bp of bpResp.body.breakpoints) {
            expect(bp.verified).eq(true);
        }

        await dc.configurationDoneRequest();

        const getChildren = (vars: Map<string, DebugProtocol.Variable>, varName: string): Promise<Map<string, DebugProtocol.Variable>> => {
            const myInputRef = vars.get(varName)?.variablesReference;
            return TestUtils.getChildren(dc, myInputRef!);
        };

        const verifyEntry = async (variableReference: number, slot: number): Promise<void> => {
            const children = await TestUtils.getChildren(dc, variableReference);
            const takeYourPickChildren = await getChildren(children, 'takeYourPick');
            const halfAndHalfChildren = await getChildren(takeYourPickChildren, 'halfAndHalf');
            expect(halfAndHalfChildren.get('lowHalf')?.value).eq((slot + 1).toString());
            expect(halfAndHalfChildren.get('highHalf')?.value).eq((slot + 3).toString());
            const arrChildren = await getChildren(children, 'arr');

            for (let i = 0; i < 5; i += 1) {
                expect(Number.parseInt(arrChildren.get(i.toString())!.value)).eq(slot + i + 2);
            }
        };

        const stoppedContext = await TestUtils.verifyLocalsOnStop(dc, variablesSource, 90, 'breakpoint', [{ name: 'myInput' }]);
        const { actLocals } = stoppedContext;
        await verifyEntry(actLocals.get('myInput')!.variablesReference, 0);

        const idx = 19;
        const evaluateResp = await dc.evaluateRequest({ expression: `input + ${idx}`, frameId: stoppedContext.frameId });
        await verifyEntry(evaluateResp.body.variablesReference, idx);
    });

    it('Shows correct value for locals in non-CUDA frame when stopped on a CUDA breakpoint', async () => {
        const lineNumbers = TestUtils.getLineNumbersFromComments(concurrentSource);

        dc = await TestUtils.launchDebugger(concurrentProgram);

        const breakpoints = [{ line: lineNumbers.device2 }];
        const bpResp = await dc.setBreakpointsRequest({
            breakpoints,
            source: TestUtils.getTestSource(concurrentSource)
        });
        for (const [i, bp] of bpResp.body.breakpoints.entries()) {
            expect(bp, `breakpoints[${i}]`).property('verified', true);
        }

        await dc.configurationDoneRequest();
        const stoppedLocation = await TestUtils.assertStoppedLocation(dc, 'breakpoint', concurrentSource, lineNumbers.device2);

        let locals = await TestUtils.getLocals(dc, stoppedLocation.frameId);
        expect(locals, 'locals').not.has.key('argc');
        let threadNum = locals.get('threadNum');
        expect(threadNum, 'threadNum').exist.and.has.property('value').that.matches(/\d+/);
        const threadNumValue = threadNum!.value;

        // Switch to main CPU thread and inspect some vars.

        const { threads } = (await dc.threadsRequest()).body;
        expect(threads, 'threads').length.greaterThan(1);

        let { stackFrames } = (await dc.stackTraceRequest({ threadId: threads[0].id })).body;
        expect(stackFrames, 'host stackFrames').length.greaterThanOrEqual(1);
        let frame = stackFrames.at(-1);
        assert(frame);
        expect(frame, 'host frame').include({ name: 'main' });
        expect(frame.line, 'host frame.line').oneOf([lineNumbers.host1, lineNumbers.host2]);

        locals = await TestUtils.getLocals(dc, frame.id);
        expect(locals, 'host locals').not.has.key('threadNum');
        const argc = locals.get('argc');
        expect(argc, 'argc').exist.and.has.property('value', '1');

        // Switch back to CUDA and check that we're seeing the same vars as before.

        ({ stackFrames } = (await dc.stackTraceRequest({ threadId: stoppedLocation.threadId })).body);
        expect(stackFrames, 'device stackFrames').length.greaterThanOrEqual(1);
        [frame] = stackFrames;
        expect(frame, 'device frame').include({ name: 'kernelFunc', line: lineNumbers.device2 });

        locals = await TestUtils.getLocals(dc, frame.id);
        expect(locals, 'device locals').not.has.key('argc');
        threadNum = locals.get('threadNum');
        expect(threadNum, 'threadNum').exist.and.has.property('value').that.matches(/\d+/);
        expect(threadNum!.value, 'threadNum.value').eq(threadNumValue);
    });

    it('Shows correct value for locals in CUDA frame when stopped on a non-CUDA breakpoint', async () => {
        const lineNumbers = TestUtils.getLineNumbersFromComments(concurrentSource);

        dc = await TestUtils.launchDebugger(concurrentProgram);

        const breakpoints = [{ line: lineNumbers.host2 }];
        const bpResp = await dc.setBreakpointsRequest({
            breakpoints,
            source: TestUtils.getTestSource(concurrentSource)
        });
        for (const [i, bp] of bpResp.body.breakpoints.entries()) {
            expect(bp, `breakpoints[${i}]`).property('verified', true);
        }

        await dc.configurationDoneRequest();
        const stoppedLocation = await TestUtils.assertStoppedLocation(dc, 'breakpoint', concurrentSource, lineNumbers.host2);

        let locals = await TestUtils.getLocals(dc, stoppedLocation.frameId);
        expect(locals, 'host locals').not.has.key('threadNum');
        let argc = locals.get('argc');
        expect(argc, 'argc').exist.and.has.property('value', '1');

        // Switch to CUDA thread and inspect some vars.

        await dc.changeCudaFocusRequest({ focus: { type: 'software', blockIdx: { x: 0, y: 0, z: 0 }, threadIdx: { x: 0, y: 0, z: 0 } } });

        const { threads } = (await dc.threadsRequest()).body;
        expect(threads, 'threads').length.greaterThan(1);
        const cudaThread = threads.find((t) => t.name === '(CUDA)');
        assert(cudaThread);

        let { stackFrames } = (await dc.stackTraceRequest({ threadId: cudaThread.id })).body;
        expect(stackFrames, 'device stackFrames').length.greaterThanOrEqual(1);
        let frame = stackFrames.at(-1);
        expect(frame, 'device frame').exist.and.include({ name: 'kernelFunc' });
        expect(frame?.line, 'device frame.line').oneOf([lineNumbers.device1, lineNumbers.device2]);

        locals = await TestUtils.getLocals(dc, frame!.id);
        expect(locals, 'locals').not.has.key('argc');
        const threadNum = locals.get('threadNum');
        expect(threadNum, 'threadNum').exist.and.has.property('value').that.matches(/\d+/);

        // Switch back to main thread and check that we're seeing the same vars as before.

        ({ stackFrames } = (await dc.stackTraceRequest({ threadId: stoppedLocation.threadId })).body);
        expect(stackFrames, 'host stackFrames').length.greaterThanOrEqual(1);
        [frame] = stackFrames;
        expect(frame, 'host frame').include({ name: 'main', line: lineNumbers.host2 });

        locals = await TestUtils.getLocals(dc, frame.id);
        expect(locals, 'host locals').not.has.key('threadNum');
        argc = locals.get('argc');
        expect(argc, 'argc').exist.and.has.property('value', '1');
    });
});
