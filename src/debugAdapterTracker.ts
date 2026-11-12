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

import * as vscode from 'vscode';
import { type DebugProtocol } from '@vscode/debugprotocol';

import { CudaDebugProtocol } from './debugger/cudaDebugProtocol';
import type { CudaDebugSessionMonitor } from './debugger/cudaDebugSessionMonitor';
import { DapMessageDirection, DapMessageLogger } from './debugger/dapMessageLogger';
import { clearDebugSessionState, setCudaFocus } from './debugSessionState';

/*
 * One per debug session. Mirrors DAP traffic to the DAP log file, publishes the session's
 * CUDA focus to debugSessionState, and feeds the session monitor behind the Warp Info view.
 */
export class CudaDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private readonly debugSessionId: string;

    private readonly dapMessageLogger: DapMessageLogger;

    constructor(
        private readonly session: vscode.DebugSession,
        private readonly sessionMonitor: CudaDebugSessionMonitor
    ) {
        const filePath = session.configuration.dapLogFilePath as string;
        this.dapMessageLogger = new DapMessageLogger(session.id, session.name, filePath);
        this.debugSessionId = session.id;
    }

    onError(error: Error): void {
        // An error with the debug adapter has occurred. VS Code raises this only for a
        // spawned adapter's process/stream faults, never for a failed DAP response and
        // never for the inline adapter, which has no process or streams. VS Code already
        // notifies the user, so this just leaves a trace in the DAP log.
        this.dapMessageLogger.logNote(`Adapter error: ${error.stack ?? error.message}`);
    }

    onExit(code: number | undefined, signal: string | undefined): void {
        // The debug adapter has exited with the given exit code or signal. Not all adapters
        // reliably invoke this (the inline adapter doesn't).
        this.dapMessageLogger.logNote(
            `Adapter exited: code=${code ?? 'none'} signal=${signal ?? 'none'}`
        );
    }

    onWillStartSession(): void {
        this.sessionMonitor.resetSession(this.session);
        this.dapMessageLogger.start();
    }

    onWillStopSession(): void {
        this.sessionMonitor.invalidateStoppedContext(this.debugSessionId);
        this.dapMessageLogger.end();
        clearDebugSessionState(this.debugSessionId);
    }

    onWillReceiveMessage(message: any): void {
        // The debug adapter is about to receive a Debug Adapter Protocol message from VS Code.
        // These are requests that are sent to the DA.
        this.dapMessageLogger.logMessage(DapMessageDirection.toAdapter, message);

        const protocolMessage = message as DebugProtocol.ProtocolMessage;
        if (protocolMessage.type !== 'request') {
            return;
        }

        const requestMessage = message as DebugProtocol.Request;
        this.sessionMonitor.handleClientRequest(this.debugSessionId, requestMessage);
    }

    onDidSendMessage(message: any): void {
        // The debug adapter has sent a Debug Adapter Protocol message to VS Code.
        // These are responses and events that are received from the DA.
        this.dapMessageLogger.logMessage(DapMessageDirection.fromAdapter, message);

        const protocolMessage = message as DebugProtocol.ProtocolMessage;
        if (protocolMessage.type === 'event') {
            const eventMessage = message as DebugProtocol.Event;
            const messageName: string = eventMessage.event;

            switch (messageName) {
                case CudaDebugProtocol.Event.changedCudaFocus: {
                    const typedEvent = eventMessage as CudaDebugProtocol.ChangedCudaFocusEvent;
                    setCudaFocus(this.debugSessionId, typedEvent.body?.focus);
                    break;
                }

                case CudaDebugProtocol.Event.invalidBreakpointCondition: {
                    const typedEvent =
                        eventMessage as CudaDebugProtocol.InvalidBreakpointConditionEvent;
                    const bpId = typedEvent.body?.breakpointId;
                    const detail =
                        typedEvent.body?.message?.replace(/^warning:\s*/i, '') ??
                        `Breakpoint ${bpId} details unavailable.`;
                    void vscode.window.showWarningMessage(
                        `Breakpoint condition is invalid and will be ignored — it will trigger unconditionally. ${detail}`
                    );
                    break;
                }

                default: {
                    break;
                }
            }
            this.sessionMonitor.handleAdapterEvent(this.debugSessionId, eventMessage);
        } else if (protocolMessage.type === 'response') {
            const responseMessage = message as DebugProtocol.Response;
            this.sessionMonitor.handleAdapterResponse(this.debugSessionId, responseMessage);
        }
    }
}

export class CudaDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(private readonly sessionMonitor: CudaDebugSessionMonitor) {}

    createDebugAdapterTracker(
        session: vscode.DebugSession
    ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        // VSCode uses the same session.id if user "restart" the debug session.
        // In the case of inline debug adapter it will always restart the adapter.
        // However, if we are using cuda-dap/cuda-lldb, VSCode won't and the debug adapter
        // tracker should represent the life time of the adapter process
        // TODO: Make a global registry to return the tracker for each session.id
        this.sessionMonitor.trackSession(session);
        return new CudaDebugAdapterTracker(session, this.sessionMonitor);
    }
}
