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
/* eslint-disable class-methods-use-this */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as vscode from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';

import { CudaDebugProtocol } from './debugger/cudaDebugProtocol';
import { CudaGdbSession } from './debugger/cudaGdbSession';
import { CudaGdbServerSession } from './debugger/cudaGdbServerSession';
import { CudaQnxGdbServerSession } from './debugger/cudaQnxGdbServerSession';
import * as types from './debugger/types';
import { TelemetryService } from './telemetryService';
import * as utils from './debugger/utils';
import { pickProcess } from './debugger/processList';

const cudaGdbDebugType = 'cuda-gdb';
const cudaGdbServerType = 'cuda-gdbserver';
const cudaQnxGdbServerType = 'cuda-qnx-gdbserver';
const cudaChangeDebugFocus = 'cuda.changeDebugFocus';
const cudaPickProcess = 'cuda.pickProcess';

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        if (session.type === cudaGdbServerType) {
            const debugServerSession = new CudaGdbServerSession();
            return new vscode.DebugAdapterInlineImplementation(debugServerSession);
            // eslint-disable-next-line no-else-return
        } else if (session.type === cudaQnxGdbServerType) {
            const debugQNXServerSession = new CudaQnxGdbServerSession();
            return new vscode.DebugAdapterInlineImplementation(debugQNXServerSession);
        } else {
            const debugSession = new CudaGdbSession();
            return new vscode.DebugAdapterInlineImplementation(debugSession);
        }
    }
}

enum DebuggerMode {
    design,
    stopped,
    running
}

class CudaDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private static readonly SESSION_LABEL = 'debug-session';

    constructor(private debugController: CudaDebugController) {}

    onError(error: Error): void {
        // An error with the debug adapter has occurred.
        if (error) {
            this.debugController.telemetry.trackError(error.name, error.message);
        }
    }

    onExit(code: number | undefined, signal: string | undefined): void {
        // The debug adapter has exited with the given exit code or signal.
        if (code !== undefined || signal) {
            this.debugController.telemetry.trackExit(code, signal);
        }
    }

    onWillStartSession(): void {
        this.debugController.telemetry.startSession(CudaDebugAdapterTracker.SESSION_LABEL);
    }

    onWillStopSession(): void {
        this.debugController.updateDebuggerMode(DebuggerMode.design);
        this.debugController.telemetry.endSession(CudaDebugAdapterTracker.SESSION_LABEL);
    }

    onWillReceiveMessage(message: any): void {
        // The debug adapter is about to receive a Debug Adapter Protocol message from VS Code.
        // These are requests that are sent to the DA.
    }

    onDidSendMessage(message: any): void {
        // The debug adapter has sent a Debug Adapter Protocol message to VS Code.
        // These are responses and events that are received from the DA.

        const protocolMessage = message as DebugProtocol.ProtocolMessage;
        if (protocolMessage.type === 'event') {
            const eventMessage = message as DebugProtocol.Event;
            const messageName: string = eventMessage.event;

            switch (messageName) {
                case 'initialized':
                case 'continue':
                    this.debugController.updateDebuggerMode(DebuggerMode.running);
                    break;

                case 'stopped':
                    this.debugController.updateDebuggerMode(DebuggerMode.stopped);
                    break;

                case 'exited':
                case 'terminated':
                    this.debugController.updateDebuggerMode(DebuggerMode.design);
                    break;

                case CudaDebugProtocol.Event.changedCudaFocus: {
                    const typedEvent = eventMessage as CudaDebugProtocol.ChangedCudaFocusEvent;
                    this.debugController.setDebugFocus(typedEvent.body?.focus);
                    break;
                }

                case CudaDebugProtocol.Event.systemInfo: {
                    const typedEvent = eventMessage as CudaDebugProtocol.SystemInfoEvent;
                    this.debugController.telemetry.trackSystemInfo('debug-adapter', typedEvent?.body?.systemInfo);
                    break;
                }

                default:
                    break;
            }
        }
    }
}

class CudaDebugController implements vscode.Disposable, vscode.DebugAdapterTrackerFactory {
    private focusStatusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);

    private debuggerMode: DebuggerMode = DebuggerMode.design;

    telemetry: TelemetryService;

    constructor(context: vscode.ExtensionContext, telemetry: TelemetryService) {
        this.telemetry = telemetry;

        context.subscriptions.push(this.focusStatusBarItem);
        this.focusStatusBarItem.command = cudaChangeDebugFocus;
        this.focusStatusBarItem.text = utils.formatCudaFocus();
        this.focusStatusBarItem.hide();

        vscode.debug.onDidChangeActiveDebugSession((session: vscode.DebugSession | undefined) => {
            if (session === undefined) {
                this.focusStatusBarItem.hide();
            } else if (session.type === cudaGdbDebugType || session.type === cudaGdbServerType || session.type === cudaQnxGdbServerType) {
                this.focusStatusBarItem.show();
            }
        });
    }

    dispose(): void {
        // Deactivation
    }

    createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        return new CudaDebugAdapterTracker(this);
    }

    setDebugFocus(focus?: types.CudaFocus): void {
        const formattedFocus: string = utils.formatCudaFocus(focus);
        this.focusStatusBarItem.text = formattedFocus;
    }

    async changeDebugFocus(): Promise<void> {
        const tracker = this.telemetry.trackCommand(cudaChangeDebugFocus);
        try {
            if (this.debuggerMode !== DebuggerMode.stopped) {
                tracker.cancel('stopped debugger');
                vscode.window.showWarningMessage('The debugger must be stopped in order to set the debug focus.');
                return;
            }

            const newDebugFocus: string | undefined = await vscode.window.showInputBox({
                ignoreFocusOut: true,
                placeHolder: 'Set debug focus: block (?, ?, ?) thread (?, ?, ?)',
                prompt: '',
                validateInput(value: string): string | undefined | null | Thenable<string | undefined | null> {
                    // Validate that focus is set with the expected syntax
                    return '';
                }
            });

            if (!newDebugFocus) {
                tracker.cancel('input dismissed');
                return;
            }

            const typedDebugFocus: types.CudaFocus | undefined = utils.parseCudaSwFocus(newDebugFocus);
            if (!typedDebugFocus) {
                tracker.cancel('input invalid');
                vscode.window.showWarningMessage('No block or thread was specified to switch the CUDA debug focus to.');
            } else {
                await vscode.debug.activeDebugSession?.customRequest(CudaDebugProtocol.Request.changeCudaFocus, { focus: typedDebugFocus });
                tracker.complete();
            }
        } finally {
            tracker.dispose();
        }
    }

    updateDebuggerMode(mode: DebuggerMode): void {
        if (this.debuggerMode === mode) {
            return;
        }

        this.debuggerMode = mode;

        if (this.debuggerMode === DebuggerMode.design) {
            // Reset the label when the debug session ends.
            this.focusStatusBarItem.text = utils.formatCudaFocus();
        }
    }
}

export function activateDebugController(context: vscode.ExtensionContext, telemetry: TelemetryService): void {
    const cudaGdbFactory: vscode.DebugAdapterDescriptorFactory = new InlineDebugAdapterFactory();

    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(cudaGdbDebugType, cudaGdbFactory));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(cudaGdbServerType, cudaGdbFactory));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(cudaQnxGdbServerType, cudaGdbFactory));

    const debugController: CudaDebugController = new CudaDebugController(context, telemetry);
    context.subscriptions.push(debugController);

    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(cudaGdbDebugType, debugController));
    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(cudaGdbServerType, debugController));
    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(cudaQnxGdbServerType, debugController));

    // eslint-disable-next-line no-return-await
    context.subscriptions.push(vscode.commands.registerCommand(cudaChangeDebugFocus, async () => await debugController.changeDebugFocus()));
    context.subscriptions.push(vscode.commands.registerCommand(cudaPickProcess, async () => pickProcess()));
}

/* eslint-enable @typescript-eslint/no-unused-vars */
/* eslint-enable class-methods-use-this */
/* eslint-enable max-classes-per-file */
