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
import { DebugProtocol } from '@vscode/debugprotocol';
import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';

describe('Locals and watches tests', async () => {
    let dc: CudaDebugClient;

    const framesSource = 'frames/frames.cpp';
    const variablesSource = 'variables/variables.cu';

    type StoppedContext = {
        threadId: number;
        frameId: number;
        actLocals: Map<string, DebugProtocol.Variable>;
    };

    const verifyLocalsOnStop = async (
        source: string,
        line: number,
        stopReason: string,
        expLocals: {
            name: string;
            value?: string;
        }[],
        allowOthers?: boolean | undefined
    ): Promise<StoppedContext> => {
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, stopReason, source, line, 120000);

        const actual = await TestUtils.getLocals(dc, frameId);

        if (allowOthers === false) {
            expect(actual.size).eq(expLocals.length);
        }

        expLocals.forEach((v) => {
            const local = actual.get(v.name);
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(local).exist;
            if (v.value) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                expect(local!.value).eq(v.value);
            }
        });

        return { threadId, frameId, actLocals: actual };
    };

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
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
                    const stoppedContextAt1stNext = await verifyLocalsOnStop(framesSource, 112, 'step', [
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
                    const stoppedContextAt2ndtNext = await verifyLocalsOnStop(framesSource, 113, 'step', [
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
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    const children = await TestUtils.getChildren(dc, varReference!);
                    expect(children.get('x')?.value).eq('8');
                    expect(children.get('y')?.value).eq('13');

                    return stoppedContext;
                }
            }
        ];

        expectedSequence.push(expectedSequence[expectedSequence.length - 2]);
        expectedSequence.push(expectedSequence[expectedSequence.length - 4]);

        dc = await TestUtils.launchDebugger('frames/frames');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(framesSource),
            breakpoints: [...new Set(expectedSequence.map((item) => item.line)).keys()].map((ln) => {
                return { line: ln };
            })
        });

        bpResp.body.breakpoints.forEach((bp) => {
            expect(bp.verified).eq(true);
        });

        await dc.configurationDoneRequest();

        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < expectedSequence.length; i += 1) {
            const expectedBp = expectedSequence[i];

            // eslint-disable-next-line no-await-in-loop
            let stoppedContext = await verifyLocalsOnStop(framesSource, expectedBp.line, 'breakpoint', expectedBp.expLocals);

            if (expectedBp.customTask) {
                // eslint-disable-next-line no-await-in-loop
                stoppedContext = await expectedBp.customTask(stoppedContext);
            }

            console.log(`Verification successful at line ${expectedBp.line}.`);

            // eslint-disable-next-line no-await-in-loop
            await dc.continueRequest({ threadId: stoppedContext.threadId });
        }
    });

    it('Shows correct value for locals (CUDA)', async () => {
        dc = await TestUtils.launchDebugger('variables/variables');

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource(variablesSource),
            breakpoints: [{ line: 90 }]
        });

        bpResp.body.breakpoints.forEach((bp) => {
            expect(bp.verified).eq(true);
        });

        await dc.configurationDoneRequest();

        const getChildren = (vars: Map<string, DebugProtocol.Variable>, varName: string): Promise<Map<string, DebugProtocol.Variable>> => {
            const myInputRef = vars.get(varName)?.variablesReference;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                expect(Number.parseInt(arrChildren.get(i.toString())?.value!)).eq(slot + i + 2);
            }
        };

        const stoppedContext = await verifyLocalsOnStop(variablesSource, 90, 'breakpoint', [{ name: 'myInput' }]);
        const { actLocals } = stoppedContext;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await verifyEntry(actLocals.get('myInput')?.variablesReference!, 0);

        const idx = 12345678;
        const evaluateResp = await dc.evaluateRequest({ expression: `input + ${idx}`, frameId: stoppedContext.frameId });
        await verifyEntry(evaluateResp.body.variablesReference, idx);
    });
});
