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

import assert from 'node:assert/strict';
import { type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import { expect } from '@jest/globals';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { type DebugProtocol } from '@vscode/debugprotocol';
import { CudaDebugProtocol } from '../debugger/cudaDebugProtocol';

export interface StopLocationInfo {
    threadId: number;
    frameId: number;
}

export class CudaDebugClient extends DebugClient {
    public capabilities: DebugProtocol.Capabilities;

    constructor(debugAdapterPath: string, spawnOptions?: SpawnOptions) {
        expect(fs.existsSync(debugAdapterPath)).toBeTrue();

        super('node', debugAdapterPath, 'cuda-gdb', spawnOptions);

        this.capabilities = {};
    }

    public async changeCudaFocusRequest(args: CudaDebugProtocol.ChangeCudaFocusArguments): Promise<CudaDebugProtocol.ChangeCudaFocusResponse> {
        return (await this.send(CudaDebugProtocol.Request.changeCudaFocus, args)) as CudaDebugProtocol.ChangeCudaFocusResponse;
    }

    public async expectStopped(reason: string, file: string, line: number, event: DebugProtocol.Event): Promise<StopLocationInfo> {
        expect(event).toEqual(
            expect.objectContaining({
                event: 'stopped',
                body: expect.objectContaining({
                    reason,
                    threadId: expect.any(Number)
                })
            })
        );

        const stoppedEvent = event as DebugProtocol.StoppedEvent;
        const { threadId } = stoppedEvent.body;
        assert(threadId !== undefined);

        const {
            body: { stackFrames }
        } = await this.stackTraceRequest({
            threadId
        });

        expect(stackFrames).toBeArray();
        expect(stackFrames).not.toBeEmpty();
        expect(stackFrames[0]).toEqual(
            expect.objectContaining({
                line,
                source: expect.objectContaining({
                    path: expect.toEndWith(file)
                })
            })
        );

        return { threadId, frameId: stackFrames[0].id };
    }

    public async expectToStopAt(reason: string, file: string, line: number, timeout: number | undefined, body: () => Promise<void>): Promise<StopLocationInfo> {
        const stoppedEvent = this.waitForEvent('stopped', timeout);
        await body();
        return await this.expectStopped(reason, file, line, await stoppedEvent);
    }
}
