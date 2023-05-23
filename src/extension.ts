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

import * as fse from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';

import { activateDebugController } from './debugController';
import { OsInfo } from './debugger/types';
import { readOsInfo } from './debugger/utils';
import { TelemetryService } from './telemetryService';
import { AutoStartTaskProvider } from './autoStartTaskProvider';


const UA_TELEMETRY_ID = 'UA-59254929-59';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const packagePath: string = path.resolve(context.extensionPath, 'package.json');
    const packageJson = await fse.readJson(packagePath);
    const telemetry: TelemetryService = new TelemetryService(context, UA_TELEMETRY_ID, packageJson.name, packageJson.version);

    if (telemetry.isEnabled) {
        const hostOsInfo: OsInfo = await readOsInfo();
        telemetry.trackSystemInfo('host', 'activate', { os: hostOsInfo });
    }

    context.subscriptions.push(vscode.tasks.registerTaskProvider('Autostart' , new AutoStartTaskProvider()));

    activateDebugController(context, telemetry);
}

export function deactivate(): void {}
