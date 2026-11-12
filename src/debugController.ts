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

import { CudaDebugProtocol } from './debugger/cudaDebugProtocol';
import type { CudaDebugSessionMonitor } from './debugger/cudaDebugSessionMonitor';
import { CudaGdbSession } from './debugger/cudaGdbSession';
import { CudaGdbServerSession } from './debugger/cudaGdbServerSession';
import { CudaQnxGdbServerSession } from './debugger/cudaQnxGdbServerSession';
import { generateDapLogFilePath } from './debugger/dapMessageLogger';
import { CudaDebugAdapterTrackerFactory } from './debugAdapterTracker';
import { getCudaFocus, onDidChangeDebugSessionState } from './debugSessionState';
import {
    cudaGdbDebugType,
    cudaGdbServerType,
    cudaQnxGdbServerType,
    isCudaDebugSession
} from './debugTypes';
import * as utils from './debugger/utils';
import { pickProcess } from './debugger/processList';

const cudaChangeDebugFocus = 'cuda.changeDebugFocus';
const cudaPickProcess = 'cuda.pickProcess';

function printHelpMessage(session: vscode.DebugSession): void {
    const logFile = session.configuration.dapLogFilePath as string | undefined;

    const helpMsg = logFile
        ? `\nTo troubleshoot your debug session, read the DAP log file:\n${logFile}\n`
        : '\nDebug session started without DAP log file, please file a bug with us.\n';

    const separator = '='.repeat(80); // long enough for the help msg above
    for (const element of ['\n', separator, helpMsg, separator]) {
        vscode.debug.activeDebugConsole.appendLine(element);
    }
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // Create dap log file path and put it in the debug configuration as source of truth
        session.configuration['dapLogFilePath'] = generateDapLogFilePath(session.id);

        if (session.type === cudaGdbServerType) {
            const debugServerSession = new CudaGdbServerSession();
            return new vscode.DebugAdapterInlineImplementation(debugServerSession);
        } else if (session.type === cudaQnxGdbServerType) {
            const debugQNXServerSession = new CudaQnxGdbServerSession();
            return new vscode.DebugAdapterInlineImplementation(debugQNXServerSession);
        } else {
            const debugSession = new CudaGdbSession();
            return new vscode.DebugAdapterInlineImplementation(debugSession);
        }
    }
}

/*
 * The extension side of CUDA debug sessions: the CUDA focus status bar item, the help message
 * printed to the Debug Console, and the commands that talk to the adapter. Everything it
 * shows or checks concerns the *active* session only, so two concurrent sessions never see
 * each other's focus or paused state.
 */
class CudaDebugController implements vscode.Disposable {
    private readonly focusStatusBarItem: vscode.StatusBarItem;

    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.focusStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right
        );
        this.focusStatusBarItem.command = cudaChangeDebugFocus;
        this.refreshFocusStatusBar();

        this.disposables.push(
            this.focusStatusBarItem,
            vscode.debug.onDidStartDebugSession((session) => this.onDidStartDebugSession(session)),
            vscode.debug.onDidChangeActiveDebugSession((session) =>
                this.onDidChangeActiveDebugSession(session)
            ),
            onDidChangeDebugSessionState((id) => this.onDidChangeSessionState(id))
        );
    }

    dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose();
    }

    // The active session when it is one of ours, which is also where commands send requests.
    private static activeCudaSession(): vscode.DebugSession | undefined {
        const session = vscode.debug.activeDebugSession;
        return session && isCudaDebugSession(session.type) ? session : undefined;
    }

    // A session we no longer have state for has ended; treat it like one that never started.
    /*
     * The session the user is looking at, paused. vscode.debug.activeStackItem is a stack
     * frame only while the focused session is stopped and its call stack has been fetched,
     * which is exactly when a request that needs a paused debuggee can be sent.
     */
    private static pausedCudaSession(): vscode.DebugSession | undefined {
        const item = vscode.debug.activeStackItem;
        return item instanceof vscode.DebugStackFrame && isCudaDebugSession(item.session.type)
            ? item.session
            : undefined;
    }

    private refreshFocusStatusBar(): void {
        const session = CudaDebugController.activeCudaSession();
        this.focusStatusBarItem.text = utils.formatCudaFocus(
            session ? getCudaFocus(session.id) : undefined
        );
        if (session) {
            this.focusStatusBarItem.show();
        } else {
            this.focusStatusBarItem.hide();
        }
    }

    private onDidChangeSessionState(sessionId: string): void {
        if (vscode.debug.activeDebugSession?.id === sessionId) {
            this.refreshFocusStatusBar();
        }
    }

    private onDidChangeActiveDebugSession(session: vscode.DebugSession | undefined): void {
        this.refreshFocusStatusBar();
        // Print the help msg to DEBUG CONSOLE if this debug session hasn't been focused
        if (session && isCudaDebugSession(session.type) && session.configuration.queuedHelpMsg) {
            printHelpMessage(session);
            session.configuration.queuedHelpMsg = false;
        }
    }

    private onDidStartDebugSession(session: vscode.DebugSession): void {
        if (!isCudaDebugSession(session.type)) {
            return;
        }
        // VSCode may not focus on the newly started session, queue the help msg until focus
        // changes
        if (vscode.debug.activeDebugSession?.id !== session.id) {
            session.configuration['queuedHelpMsg'] = true;
            return;
        }
        printHelpMessage(session);
    }

    async changeDebugFocus(): Promise<void> {
        // Pinned before prompting: the user may focus another session while a prompt is open,
        // and the request must go to the one they were looking at. If that session has resumed
        // or ended meanwhile, the adapter rejects the request and the wrapper reports it.
        const session = this.requireStoppedSession('set the debug focus');

        // Closes on focus loss; dismissing is a cancellation.
        const input = await vscode.window.showInputBox({
            placeHolder: 'Set debug focus: block (?, ?, ?) thread (?, ?, ?)',
            // Same parser as below, so the box only accepts input the command can use.
            validateInput: (value) =>
                utils.parseCudaSwFocus(value)
                    ? undefined
                    : 'Specify a block and/or thread, e.g. block (1, 0, 0) thread (32, 0, 0)'
        });
        if (!input) {
            throw new CommandCanceled();
        }

        const focus = utils.parseCudaSwFocus(input);
        if (!focus) {
            throw new CommandFailure(
                'No block or thread was specified to switch the CUDA debug focus to.'
            );
        }

        await session.customRequest(CudaDebugProtocol.Request.changeCudaFocus, { focus });
    }

    // Focus changes require a paused CUDA session.
    private requireStoppedSession(action: string): vscode.DebugSession {
        const session = CudaDebugController.pausedCudaSession();
        if (!session) {
            throw new CommandFailure(`The debugger must be stopped in order to ${action}.`);
        }
        return session;
    }
}

// Thrown by a command handler when the user dismissed one of its prompts; nothing is shown.
class CommandCanceled extends Error {
    constructor() {
        super('The command was canceled.');
        this.name = 'CommandCanceled';
    }
}

// Thrown by a command handler for a failure the user can act on; shown as a warning.
// Anything else thrown (an adapter or debugger refusing a request) is shown as an error.
class CommandFailure extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CommandFailure';
    }
}

function registerCommand(
    command: string,
    failurePrefix: string,
    handler: () => Promise<void>
): vscode.Disposable {
    return vscode.commands.registerCommand(command, async () => {
        try {
            await handler();
        } catch (error) {
            if (error instanceof CommandCanceled) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof CommandFailure) {
                void vscode.window.showWarningMessage(message);
            } else {
                void vscode.window.showErrorMessage(`${failurePrefix}: ${message}`);
            }
        }
    });
}

export function activateDebugController(
    context: vscode.ExtensionContext,
    sessionMonitor: CudaDebugSessionMonitor
): void {
    const cudaGdbFactory: vscode.DebugAdapterDescriptorFactory = new InlineDebugAdapterFactory();
    const debugController = new CudaDebugController();
    const trackerFactory = new CudaDebugAdapterTrackerFactory(sessionMonitor);

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(cudaGdbDebugType, cudaGdbFactory),
        vscode.debug.registerDebugAdapterDescriptorFactory(cudaGdbServerType, cudaGdbFactory),
        vscode.debug.registerDebugAdapterDescriptorFactory(cudaQnxGdbServerType, cudaGdbFactory),
        debugController,
        vscode.debug.onDidStartDebugSession((session) => sessionMonitor.trackSession(session)),
        vscode.debug.onDidChangeActiveDebugSession((session) =>
            sessionMonitor.setActiveSession(session)
        ),
        // Adapter-requested restarts with a slow postDebugTask can deliver this event
        // after the session restarts with the same ID, removing its new state.
        // Rubicon does not request automatic restarts; revisit this cleanup if that changes.
        vscode.debug.onDidTerminateDebugSession((session) =>
            sessionMonitor.removeSession(session.id)
        ),
        vscode.debug.registerDebugAdapterTrackerFactory(cudaGdbDebugType, trackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory(cudaGdbServerType, trackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory(cudaQnxGdbServerType, trackerFactory),
        registerCommand(cudaChangeDebugFocus, 'Failed to change CUDA debug focus', () =>
            debugController.changeDebugFocus()
        ),
        vscode.commands.registerCommand(cudaPickProcess, async () => pickProcess())
    );
}

export function createCudaRequestSender(
    context: vscode.ExtensionContext
): CudaDebugProtocol.SendRequest {
    const sessions = new Map<string, vscode.DebugSession>();
    const rememberSession = (session: vscode.DebugSession | undefined): void => {
        if (session && isCudaDebugSession(session.type)) sessions.set(session.id, session);
    };

    context.subscriptions.push(
        { dispose: () => sessions.clear() },
        vscode.debug.onDidStartDebugSession(rememberSession),
        vscode.debug.onDidChangeActiveDebugSession(rememberSession),
        vscode.debug.onDidTerminateDebugSession((session) => sessions.delete(session.id))
    );

    return async (sessionId, command, args) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error('The CUDA debug session is no longer available.');
        return session.customRequest(command, args);
    };
}
