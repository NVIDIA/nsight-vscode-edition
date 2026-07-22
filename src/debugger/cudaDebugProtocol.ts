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

import { type DebugProtocol } from '@vscode/debugprotocol';
import * as types from './types';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace CudaDebugProtocol {
    export enum Request {
        changeCudaFocus = 'changeCudaFocus'
    }

    export enum Event {
        changedCudaFocus = 'changedCudaFocus',
        systemInfo = 'systemInfo'
    }

    export interface ChangeCudaFocusArguments {
        focus?: types.CudaFocus;
    }

    export interface ChangeCudaFocusRequest extends DebugProtocol.Request {
        //command: Request.changeCudaFocus;
        arguments: ChangeCudaFocusArguments;
    }

    export interface ChangeCudaFocusResponse extends DebugProtocol.Response {
        body: {
            focus?: types.CudaFocus;
        };
    }

    export interface ChangedCudaFocusEvent extends DebugProtocol.Event {
        //event: Event.changedCudaFocus;
        body: {
            focus?: types.CudaFocus;
        };
    }

    export interface SystemInfoEvent extends DebugProtocol.Event {
        //event: Event.systemInfo;
        body: {
            systemInfo?: types.SystemInfo;
        };
    }
}
