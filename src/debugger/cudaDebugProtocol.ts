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
        changeCudaFocus = 'changeCudaFocus',
        cudaWarps = 'cudaWarps',
        cancelCudaWarps = 'cancelCudaWarps',
        cudaWarpDetails = 'cudaWarpDetails'
    }

    export enum Event {
        changedCudaFocus = 'changedCudaFocus',
        invalidBreakpointCondition = 'invalidBreakpointCondition'
    }

    export interface ChangeCudaFocusArguments {
        focus?: types.CudaFocus;
        /**
         * View actions supply the snapshot's GPU and stop epoch.
         * Invalidating the view cannot retract an already-sent focus request;
         * console commands can also resume execution without the pending-resume guard.
         * Validate inside the MI queue before changing focus.
         * Optional for manual focus commands, which use the current context.
         */
        expectedContext?: { device: number; stopEpoch: number };
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

    export interface CancelCudaWarpsArguments {
        requestId: string;
    }

    export interface CudaWarpsArguments {
        /** Collect every warp's lanes in the adapter before returning. */
        includeLanes?: boolean;
        /** Client token for cancellation of an in-progress collection. */
        requestId?: string;
        /** Read confirmed hardware focus without reacquiring the warp inventory. */
        focusOnly?: boolean;
    }

    export interface CudaWarpsRequest extends DebugProtocol.Request {
        arguments?: CudaWarpsArguments;
    }

    export interface CudaWarpsResponse extends DebugProtocol.Response {
        body: {
            snapshot?: types.CudaWarpSnapshot;
        };
    }

    export interface CudaWarpDetailsArguments {
        selection: types.CudaWarpSelection;
    }

    export interface CudaWarpDetailsRequest extends DebugProtocol.Request {
        arguments: CudaWarpDetailsArguments;
    }

    export interface CudaWarpDetailsResponse extends DebugProtocol.Response {
        body: {
            warp?: types.CudaWarpInfo;
        };
    }

    export interface InvalidBreakpointConditionEvent extends DebugProtocol.Event {
        //event: Event.invalidBreakpointCondition;
        body: {
            breakpointId: number;
            message: string;
        };
    }

    /** Arguments and response bodies exposed by VS Code's customRequest API. */
    export interface RequestTypes {
        [Request.changeCudaFocus]: {
            arguments: ChangeCudaFocusArguments;
            body: ChangeCudaFocusResponse['body'];
        };
        [Request.cudaWarps]: {
            arguments: CudaWarpsRequest['arguments'];
            body: CudaWarpsResponse['body'];
        };
        [Request.cancelCudaWarps]: {
            arguments: CancelCudaWarpsArguments;
            body: undefined;
        };
        [Request.cudaWarpDetails]: {
            arguments: CudaWarpDetailsArguments;
            body: CudaWarpDetailsResponse['body'];
        };
    }

    export type SendRequest = <Command extends Request>(
        sessionId: string,
        command: Command,
        args: RequestTypes[Command]['arguments']
    ) => Promise<RequestTypes[Command]['body']>;
}
