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

import { activateDebugController, createCudaRequestSender } from './debugController';
import { CudaDebugSessionMonitor } from './debugger/cudaDebugSessionMonitor';
import { registerWarpInfoView } from './webviews/warpInfo/integration/warpInfoView';
import { AutoStartTaskProvider } from './autoStartTaskProvider';
import { activateLanguageSupport } from './languageSupportController';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('Nsight Visual Studio Code Edition');
    context.subscriptions.push(outputChannel);

    activateLanguageSupport(context, outputChannel);

    context.subscriptions.push(
        vscode.tasks.registerTaskProvider('Autostart', new AutoStartTaskProvider())
    );

    const sessionMonitor = new CudaDebugSessionMonitor();
    context.subscriptions.push(sessionMonitor);
    const sendRequest = createCudaRequestSender(context);
    activateDebugController(context, sessionMonitor);
    registerWarpInfoView(context, sessionMonitor, sendRequest);
}

export function deactivate(): void {}
