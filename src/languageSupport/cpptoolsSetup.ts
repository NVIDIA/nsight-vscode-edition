/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import path from 'node:path';
import * as vscode from 'vscode';

function hasConfiguredValue<T>(configuration: vscode.WorkspaceConfiguration, section: string): boolean {
    const inspectedSetting = configuration.inspect<T>(section);
    return inspectedSetting?.workspaceFolderValue !== undefined || inspectedSetting?.workspaceValue !== undefined || inspectedSetting?.globalValue !== undefined;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type CpptoolsSetupOptions = {
    compileCommandsPath?: string;
};

export type CpptoolsSetupResult = {
    failedSettings: string[];
};

function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
}

function formatCompileCommandsPath(workspaceFolder: vscode.WorkspaceFolder, compileCommandsPath: string): string {
    const relativePath = path.relative(workspaceFolder.uri.fsPath, compileCommandsPath);

    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return `\${workspaceFolder}/${normalizePath(relativePath)}`;
    }

    return normalizePath(compileCommandsPath);
}

// Prefer the project's compilation database when available. Leave compilerPath
// alone so user-owned C/C++ configuration keeps its existing compiler model.
export async function setupCpptools(workspaceFolder: vscode.WorkspaceFolder, options: CpptoolsSetupOptions): Promise<CpptoolsSetupResult> {
    const configuration = vscode.workspace.getConfiguration('C_Cpp', workspaceFolder.uri);
    const pendingWrites: Array<{ section: string; value: string }> = [];
    const hasCompileCommands = hasConfiguredValue<string>(configuration, 'default.compileCommands');

    if (options.compileCommandsPath && !hasCompileCommands) {
        pendingWrites.push({ section: 'default.compileCommands', value: formatCompileCommandsPath(workspaceFolder, options.compileCommandsPath) });
    }

    const failedSettings: string[] = [];

    for (const write of pendingWrites) {
        try {
            await configuration.update(write.section, write.value, vscode.ConfigurationTarget.WorkspaceFolder);
        } catch (error) {
            failedSettings.push(`C_Cpp.${write.section}: ${getErrorMessage(error)}`);
        }
    }

    return { failedSettings };
}
