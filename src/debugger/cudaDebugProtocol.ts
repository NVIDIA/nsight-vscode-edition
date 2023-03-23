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

/* eslint-disable max-classes-per-file */
import { DebugProtocol } from '@vscode/debugprotocol';
import * as types from './types';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace CudaDebugProtocol {
    export abstract class Request {
        static readonly changeCudaFocus: string = 'changeCudaFocus';

        static readonly systemInfo: string = 'systemInfo';
    }

    export abstract class Event {
        static readonly changedCudaFocus: string = 'changedCudaFocus';
    }

    export interface ChangeCudaFocusRequest extends DebugProtocol.Request {
        // command: 'changeCudaFocus' (Request.changeCudaFocus)
        arguments: ChangeCudaFocusArguments;
    }

    export interface ChangeCudaFocusArguments {
        focus?: types.CudaFocus;
    }

    export interface ChangeCudaFocusResponse extends DebugProtocol.Response {
        body: {
            focus?: types.CudaFocus;
        };
    }

    export interface ChangedCudaFocusEvent extends DebugProtocol.Event {
        // event: 'changedCudaFocus' (Event.changedCudaFocus)
        body: {
            focus?: types.CudaFocus;
        };
    }

    export interface SystemInfoRequest extends DebugProtocol.Request {
        // command: 'systemInfo' (Request.systemInfo)

        arguments?: SystemInfoArguments;
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface SystemInfoArguments {}

    export interface SystemInfoResponse extends DebugProtocol.Response {
        body: {
            systemInfo?: types.SystemInfo;
        };
    }
}

/* eslint-enable max-classes-per-file */
