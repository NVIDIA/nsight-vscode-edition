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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

import { activateDebugController } from './debugController';
import { type OsInfo } from './debugger/types';
import { readOsInfo } from './debugger/utils';
import { TelemetryService } from './telemetryService';
import { AutoStartTaskProvider } from './autoStartTaskProvider';
import { activateLanguageSupport } from './languageSupportController';

const GA4_API_SECRET = 'VaT67ILSRsGM10lr8Dut7A';
const GA4_MEASUREMENT_ID = 'G-VELYBBB7X1';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('Nsight Visual Studio Code Edition');
    context.subscriptions.push(outputChannel);

    activateLanguageSupport(context, outputChannel);

    const packagePath: string = path.resolve(context.extensionPath, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));

    const telemetry: TelemetryService = new TelemetryService(context, GA4_API_SECRET, GA4_MEASUREMENT_ID, packageJson.version);

    if (telemetry.isEnabled) {
        const hostOsInfo: OsInfo = await readOsInfo();
        telemetry.trackSystemInfo('host', { os: hostOsInfo });
    }

    context.subscriptions.push(vscode.tasks.registerTaskProvider('Autostart', new AutoStartTaskProvider()));

    activateDebugController(context, telemetry);
}

export function deactivate(): void {}
